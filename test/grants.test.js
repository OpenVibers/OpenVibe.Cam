'use strict';
/**
 * Viewer grants: one person, one expiry, one revocation. A wall opens for the owner and an active grantee only; a
 * stranger and even a global moderator without a grant get the same 404. A revoked or expired grant is refused on
 * the next read, with no cached copy in between. A grant by @username is resolved through Network; a subject works
 * without Network. Notes on the camera are the owner's and never appear on a grantee's wall.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    const mod = t.network.addUser('mod', { role: 'global_mod' });
    let camera = null;
    let firstGrant = null;
    try {
        await check('the owner pairs a camera and grants @bob for seven days', async () => {
            camera = (await t.get('/api/v1/cameras', { as: alice, json: { name: 'Front door', slot: 'whip', notes: 'the gate code is not in here' } })).json();
            const r = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'bob' } });
            assert.strictEqual(r.status, 201, r.text);
            firstGrant = r.json();
            assert.match(firstGrant.id, /^cmg_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(firstGrant.viewer_subject, bob.subject);
            assert.strictEqual(firstGrant.viewer_username, 'bob');
            assert.strictEqual(firstGrant.active, true);
            const days = Math.round((Date.parse(firstGrant.expires_at) - Date.parse(firstGrant.granted_at)) / 86400000);
            assert.strictEqual(days, 7);
            assert.ok(t.network.tokenRequests.some((x) => x.grant_type === 'client_credentials'));
            assert.ok(t.network.requests.some((x) => x.path === '/internal/identity/resolve'));
        });

        await check('bob sees the private wall; alice sees it as owner; carol and a moderator do not', async () => {
            const b = await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob });
            assert.strictEqual(b.status, 200, b.text);
            assert.strictEqual(b.json().owner, false);
            assert.strictEqual(b.json().grant.id, firstGrant.id);
            assert.match(b.json().frame_url, /\/live\/whip\/frame\.jpg/);
            assert.ok(!('notes' in b.json().camera), 'the owner\'s note is not a viewer\'s');
            const a = await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: alice });
            assert.strictEqual(a.status, 200);
            assert.strictEqual(a.json().owner, true);
            assert.strictEqual(a.json().camera.notes, 'the gate code is not in here');
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: carol })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: mod })).status, 404, 'staff have no bypass');
        });

        await check('a second grant extends the active one instead of making a second row', async () => {
            const r = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: '@bob', days: 30 } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().id, firstGrant.id);
            const rows = await t.ctx.s.db.many('SELECT * FROM cam_grants WHERE camera_id = $1', [camera.id]);
            assert.strictEqual(rows.length, 1);
            const days = Math.round((Date.parse(rows[0].expires_at) - Date.parse(rows[0].granted_at)) / 86400000);
            assert.strictEqual(days, 30);
        });

        await check('the owner lists the grants; nobody else can', async () => {
            const mine = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice });
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.json().count, 1);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: bob })).status, 404);
        });

        await check('revoking refuses the very next wall request', async () => {
            const r = await t.get(`/api/v1/cameras/${camera.id}/grants/${firstGrant.id}`, { as: alice, method: 'DELETE' });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().revoked, true);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob })).status, 404);
            const again = await t.get(`/api/v1/cameras/${camera.id}/grants/${firstGrant.id}`, { as: alice, method: 'DELETE' });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().revoked, false);
            assert.strictEqual(again.json().already, true);
        });

        await check('a grant that has expired is refused, even though it was never revoked', async () => {
            const second = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'bob', days: 1 } });
            assert.strictEqual(second.status, 201);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob })).status, 200);
            await t.ctx.s.db.exec("UPDATE cam_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [second.json().id]);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob })).status, 404);
            const list = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice });
            assert.strictEqual(list.json().grants.find((g) => g.id === second.json().id).active, false);
        });

        await check('a subject grant needs no Network; an unknown name is 404; a bad number of days is 400', async () => {
            t.network.setResolveDown(true);
            const bySubject = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_subject: carol.subject, days: 2 } });
            assert.strictEqual(bySubject.status, 201, bySubject.text);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: carol })).status, 200);
            t.network.setResolveDown(false);
            const unknown = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'nobody' } });
            assert.strictEqual(unknown.status, 404);
            assert.strictEqual(unknown.json().code, 'cam.viewer_not_found');
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'bob', days: 0 } })).status, 400);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_subject: alice.subject } })).json().code, 'cam.invalid');
        });

        await check('a grant is refused anonymously, cross-site, and for somebody else\'s camera', async () => {
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/grants`, { json: { viewer_username: 'bob' } })).status, 401);
            const cross = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'bob' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(cross.json().code, 'cam.cross_site');
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: bob, json: { viewer_username: 'alice' } })).status, 404);
        });
    } finally {
        await t.close();
    }
    done();
})();
