'use strict';
/**
 * ADR-033: Cam's part of an account export (cameras, grants given and received, photos, stills) and of a deletion,
 * applied through /internal/events with a stand-in Network. Deleting a camera's owner removes the camera and its
 * grants; deleting a viewer removes the grants naming them and leaves the owner's camera. Another person's rows stay.
 * A redelivery changes nothing; a bad signature and a proxied request are refused.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const A = ids.newId('user');
const B = ids.newId('user');
const EXP = `exp_${ids.ulid()}`;
const DEL = `del_${ids.ulid()}`;
const SECRET = `fixture_${'account'.repeat(6)}`;
const WRONG = `fixture_${'mismatch'.repeat(6)}`;

const exportEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_cam', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'cam', clientSecret: 'cam-secret' });
    const t = await boot({ env: { CAM_EVENTS_SECRET: SECRET }, accountSend: sender });
    try {
        const db = t.ctx.s.db;
        const at = new Date().toISOString();
        const camA = `cam_${ids.ulid()}`;
        const camB = `cam_${ids.ulid()}`;
        await db.exec(`INSERT INTO cam_cameras (id, owner, owner_username, name, paired_at, created_at, updated_at) VALUES
            ($1, $2, 'a', 'A camera', $4, $4, $4), ($3, $5, 'b', 'B camera', $4, $4, $4)`, [camA, A, camB, at, B]);
        const grantAB = `cmg_${ids.ulid()}`;  // A gave B
        const grantBA = `cmg_${ids.ulid()}`;  // B gave A
        await db.exec(`INSERT INTO cam_grants (id, camera_id, owner, viewer_subject, granted_at, expires_at, created_at) VALUES
            ($1, $2, $3, $5, $7, $8, $7), ($4, $6, $5, $3, $7, $8, $7)`, [grantAB, camA, A, grantBA, B, camB, at, new Date(Date.now() + 86400000).toISOString()]);
        const photoA = `cmp_${ids.ulid()}`;
        const photoB = `cmp_${ids.ulid()}`;
        await db.exec(`INSERT INTO cam_photos (id, subject, filter, visibility, pics_slug, pics_url, pics_direct, created_at) VALUES
            ($1, $2, 'warm', 'private', 'picA1234', 'https://openvibe.pics/i/picA1234', 'https://openvibe.pics/i/picA1234.jpg', $4),
            ($3, $5, 'mono', 'private', 'picB1234', 'https://openvibe.pics/i/picB1234', 'https://openvibe.pics/i/picB1234.jpg', $4)`, [photoA, A, photoB, at, B]);
        const stillA = `cms_${ids.ulid()}`;
        const stillB = `cms_${ids.ulid()}`;
        await db.exec(`INSERT INTO cam_stills (id, subject, slot, visibility, pics_slug, pics_url, pics_direct, created_at) VALUES
            ($1, $2, 'whip', 'unlisted', 'picC1234', 'https://openvibe.pics/i/picC1234', 'https://openvibe.pics/i/picC1234.jpg', $4),
            ($3, $5, 'whip', 'unlisted', 'picD1234', 'https://openvibe.pics/i/picD1234', 'https://openvibe.pics/i/picD1234.jpg', $4)`, [stillA, A, stillB, at, B]);

        await check('an export carries only A\'s cameras, grants, photos and stills', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'exported');
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_cam');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['cameras.json', 'grants-given.json', 'grants-received.json', 'photos.json', 'stills.json']);
            const all = JSON.stringify(part.body);
            assert.ok(all.includes('A camera'));
            assert.ok(!all.includes('B camera'), 'nobody else\'s camera');
            assert.ok(all.includes('picA1234'));
            assert.ok(!all.includes('picB1234'), 'nobody else\'s photo');
            assert.ok(all.includes('picC1234'));
            assert.ok(!all.includes('picD1234'), 'nobody else\'s still');
            const cameras = part.body.files.find((f) => f.name === 'cameras.json').content;
            assert.deepStrictEqual(cameras.map((c) => c.id), [camA]);
            const given = part.body.files.find((f) => f.name === 'grants-given.json').content;
            assert.deepStrictEqual(given.map((g) => g.id), [grantAB]);
            const received = part.body.files.find((f) => f.name === 'grants-received.json').content;
            assert.deepStrictEqual(received.map((g) => g.id), [grantBA]);
        });

        await check('a deletion erases A\'s rows and confirms with counts; B and B\'s camera stay', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_cameras WHERE owner = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_photos WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_stills WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_cameras WHERE owner = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_photos WHERE subject = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_stills WHERE subject = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_grants')), 0, 'both grants named A');
            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.ok(confirmation.body.erased.cam_cameras >= 1);
            assert.ok(confirmation.body.erased.cam_photos >= 1);
            assert.ok(confirmation.body.erased.cam_stills >= 1);
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));
        });

        await check('a redelivery changes nothing', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'unchanged');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_photos WHERE subject = $1', [A])), 0);
        });

        await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);
            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
