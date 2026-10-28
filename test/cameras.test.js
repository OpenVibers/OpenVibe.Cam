'use strict';
/**
 * Pairing: a camera is a person's, a Live stream id is read from Live and must be on the caller's channel, the
 * slot defaults to the stream's managed slot, and only the owner can read, change or unpair it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    try {
        let camera = null;

        await check('a camera pairs without a stream, private and owned by the caller', async () => {
            const r = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Front door', source: 'phone' } });
            assert.strictEqual(r.status, 201, r.text);
            camera = r.json();
            assert.match(camera.id, /^cam_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(camera.owner_username, 'alice');
            assert.strictEqual(camera.source, 'phone');
            assert.strictEqual(camera.status, 'paired');
            assert.strictEqual(camera.slot, null);
            assert.strictEqual(r.headers.get('location'), `/api/v1/cameras/${camera.id}`);
        });

        await check('a Live stream id is read from Live and its managed slot becomes the camera slot', async () => {
            const r = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Desk cam', source: 'browser', stream_id: 1234 } });
            assert.strictEqual(r.status, 201, r.text);
            const c = r.json();
            assert.strictEqual(c.stream_id, 1234);
            assert.strictEqual(c.slot, 'whip');
            assert.match(c.frame_url, /\/live\/whip\/frame\.jpg\?w=640$/);
            assert.ok(t.upstreams.requestsFor('/api/streams/1234').length >= 1);
        });

        await check('somebody else\'s stream is refused; an unknown stream is 404', async () => {
            const other = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Not mine', stream_id: 2222 } });
            assert.strictEqual(other.status, 403);
            assert.strictEqual(other.json().code, 'cam.not_your_stream');
            const missing = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Nowhere', stream_id: 9999 } });
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(missing.json().code, 'cam.stream_not_found');
        });

        await check('a name, a source and a slot are validated; a repeated stream is a 409', async () => {
            const noName = await t.get('/api/v1/cameras', { as: alice, json: { source: 'phone' } });
            assert.strictEqual(noName.status, 400);
            const badSource = await t.get('/api/v1/cameras', { as: alice, json: { name: 'X', source: 'webcam' } });
            assert.strictEqual(badSource.status, 400);
            const badSlot = await t.get('/api/v1/cameras', { as: alice, json: { name: 'X', slot: 'not a slot!' } });
            assert.strictEqual(badSlot.status, 400);
            const again = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Desk again', stream_id: 1234 } });
            assert.strictEqual(again.status, 409);
            assert.strictEqual(again.json().code, 'cam.camera_exists');
        });

        await check('the list is the caller\'s own; another person sees none', async () => {
            const mine = await t.get('/api/v1/cameras', { as: alice });
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.json().count, 2);
            assert.ok(mine.json().cameras.every((c) => c.owner_username === 'alice'));
            const theirs = await t.get('/api/v1/cameras', { as: bob });
            assert.strictEqual(theirs.json().count, 0);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}`, { as: bob })).status, 404);
        });

        await check('the owner can rename, set the slot and the status; another person cannot', async () => {
            const r = await t.get(`/api/v1/cameras/${camera.id}`, { as: alice, method: 'PATCH', json: { name: 'Porch', status: 'offline', slot: '@alice' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().name, 'Porch');
            assert.strictEqual(r.json().status, 'offline');
            assert.strictEqual(r.json().slot, '@alice');
            const no = await t.get(`/api/v1/cameras/${camera.id}`, { as: bob, method: 'PATCH', json: { name: 'Stolen' } });
            assert.strictEqual(no.status, 404);
            const unknown = await t.get(`/api/v1/cameras/${camera.id}`, { as: alice, method: 'PATCH', json: { owner: bob.subject } });
            assert.strictEqual(unknown.status, 400);
        });

        await check('anonymous, cross-site and app-token writes are refused', async () => {
            const anon = await t.get('/api/v1/cameras', { json: { name: 'Anon' } });
            assert.strictEqual(anon.status, 401);
            assert.strictEqual(anon.json().code, 'cam.sign_in_required');
            const cross = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Cross' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(cross.json().code, 'cam.cross_site');
        });

        await check('unpairing removes it and its wall; the owner only', async () => {
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}`, { as: bob, method: 'DELETE' })).status, 404);
            const r = await t.get(`/api/v1/cameras/${camera.id}`, { as: alice, method: 'DELETE' });
            assert.strictEqual(r.status, 204);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}`, { as: alice })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: alice })).status, 404);
        });
    } finally {
        await t.close();
    }
    done();
})();
