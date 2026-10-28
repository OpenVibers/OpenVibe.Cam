'use strict';
/**
 * The camera app's photo: the raw picture is the request body, Cam forwards it to OpenVibe.Pics with the person's
 * own Network token, and stores the Pics slug, links, filter and caption. A photo without a camera is private; a
 * photo on a camera wall is unlisted and an active grantee sees it. The image bytes are never stored in Cam.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { JPEG } = require('./helpers/upstreams');

(async () => {
    const t = await boot({ env: { CAM_PHOTO_MAX_BYTES: '64' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    try {
        let photo = null;
        let camera = null;

        await check('a photo uploads to Pics and is recorded with its filter and caption', async () => {
            const r = await t.get('/api/v1/photos', {
                as: alice, body: JPEG,
                headers: { 'content-type': 'image/jpeg', 'x-filter': 'warm', 'x-caption': encodeURIComponent('a warm porch') },
            });
            assert.strictEqual(r.status, 201, r.text);
            photo = r.json();
            assert.match(photo.id, /^cmp_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(photo.filter, 'warm');
            assert.strictEqual(photo.caption, 'a warm porch');
            assert.strictEqual(photo.visibility, 'private');
            assert.strictEqual(photo.camera_id, null);
            assert.strictEqual(photo.subject, alice.subject);
            const upload = t.upstreams.uploads()[0];
            assert.match(upload.auth, /^Bearer /);
            assert.strictEqual(upload.contentType, 'image/jpeg');
            assert.strictEqual(upload.bytes, JPEG.length);
            assert.strictEqual(upload.title, encodeURIComponent('a warm porch'));
        });

        await check('the photo row has no bytes; the picture lives in Pics', async () => {
            const cols = (await t.ctx.s.db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'cam_photos'")).map((r) => r.column_name);
            assert.ok(!cols.some((c) => /image|blob|bytes|photo|data/i.test(c)), cols.join(','));
            const row = await t.ctx.s.db.maybe('SELECT pics_slug, pics_url, pics_direct FROM cam_photos WHERE id = $1', [photo.id]);
            assert.ok(row.pics_slug);
            assert.ok(row.pics_url.startsWith('https://openvibe.pics/'));
        });

        await check('your photos are yours; another person gets 404', async () => {
            const mine = await t.get('/api/v1/photos', { as: alice });
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.json().count, 1);
            assert.strictEqual((await t.get(`/api/v1/photos/${photo.id}`, { as: alice })).status, 200);
            assert.strictEqual((await t.get(`/api/v1/photos/${photo.id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get('/api/v1/photos', { as: bob })).json().count, 0);
        });

        await check('a photo attached to a camera is unlisted and appears on the wall for an active grantee', async () => {
            camera = (await t.get('/api/v1/cameras', { as: alice, json: { name: 'Front door', slot: 'whip' } })).json();
            const r = await t.get('/api/v1/photos', {
                as: alice, body: JPEG,
                headers: { 'content-type': 'image/jpeg', 'x-filter': 'none', 'x-camera': camera.id },
            });
            assert.strictEqual(r.status, 201, r.text);
            const attached = r.json();
            assert.strictEqual(attached.camera_id, camera.id);
            assert.strictEqual(attached.visibility, 'unlisted');

            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob })).status, 404);
            const grant = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'bob' } });
            assert.strictEqual(grant.status, 201);
            const wall = await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob });
            assert.strictEqual(wall.status, 200);
            assert.strictEqual(wall.json().photos.length, 1);
            assert.strictEqual(wall.json().photos[0].id, attached.id);
            assert.ok(!('subject' in wall.json().photos[0]));
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: carol })).status, 404);
        });

        await check('a photo cannot be attached to somebody else\'s camera', async () => {
            const r = await t.get('/api/v1/photos', {
                as: bob, body: JPEG,
                headers: { 'content-type': 'image/jpeg', 'x-camera': camera.id },
            });
            assert.strictEqual(r.status, 404);
            assert.strictEqual(r.json().code, 'cam.not_found');
        });

        await check('the content type, filter, caption, size and sign-in are enforced', async () => {
            const notImage = await t.get('/api/v1/photos', { as: alice, body: JPEG, headers: { 'content-type': 'text/plain' } });
            assert.strictEqual(notImage.status, 415);
            assert.strictEqual(notImage.json().code, 'cam.not_an_image');
            const badFilter = await t.get('/api/v1/photos', { as: alice, body: JPEG, headers: { 'content-type': 'image/jpeg', 'x-filter': 'sepia' } });
            assert.strictEqual(badFilter.status, 400);
            const blocked = await t.get('/api/v1/photos', { as: alice, body: JPEG, headers: { 'content-type': 'image/jpeg', 'x-caption': encodeURIComponent('kys') } });
            assert.strictEqual(blocked.status, 400);
            assert.strictEqual(blocked.json().code, 'cam.blocked_words');
            const tooLarge = await t.get('/api/v1/photos', { as: alice, body: Buffer.alloc(100, 1), headers: { 'content-type': 'image/jpeg' } });
            assert.strictEqual(tooLarge.status, 413);
            const anonymous = await t.get('/api/v1/photos', { body: JPEG, headers: { 'content-type': 'image/jpeg' } });
            assert.strictEqual(anonymous.status, 401);
            const cross = await t.get('/api/v1/photos', { as: alice, body: JPEG, headers: { 'content-type': 'image/jpeg' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(cross.json().code, 'cam.cross_site');
        });

        await check('a Pics refusal is a problem, not a photo', async () => {
            t.upstreams.setPics(401);
            const r = await t.get('/api/v1/photos', { as: alice, body: JPEG, headers: { 'content-type': 'image/jpeg' } });
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.json().code, 'cam.pics.refused');
            t.upstreams.setPics(201);
        });
    } finally {
        await t.close();
    }
    done();
})();
