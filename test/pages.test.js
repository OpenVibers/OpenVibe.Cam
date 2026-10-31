'use strict';
/**
 * Server-rendered pages: the home and its privacy rules, the camera app, My cameras, one camera's owner page, the
 * private wall, a still, developers, 404, the cache headers, the permissions policy and the discovery artifacts.
 * Public pages are public, max-age=60; every wall, still and signed-in page is private, no-store.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assetVersion } = require('../server/render/layout');

function jsonLd(html) {
    return [...String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    let camera = null;
    let grant = null;
    let still = null;
    try {
        await check('home: semantic, the privacy rules, a public cache and Vary: Cookie', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            assert.strictEqual(r.headers.get('vary'), 'Cookie');
            for (const marker of ['id="cm-home"', 'class="sc-room', 'id="cm-rules"', 'Nothing public without its owner', 'No face recognition', '/img/cam-sample.svg', 'href="/app"']) assert.ok(r.text.includes(marker), marker);
            assert.match(r.text, /<main id="main"/);
            assert.match(r.text, /<footer id="ov-footer"/);
            const types = jsonLd(r.text).map((x) => x['@type']);
            assert.ok(types.includes('WebSite'), types.join(','));
            assert.ok(types.includes('WebApplication'), types.join(','));
        });

        await check('a page drawn for a signed-in person is private, no-store; the permissions policy allows only the camera', async () => {
            const r = await t.get('/', { as: alice });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.strictEqual(r.headers.get('vary'), 'Cookie');
            assert.strictEqual(r.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=(), payment=()');
        });

        await check('/app has the camera controls and the gallery', async () => {
            const r = await t.get('/app');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            for (const marker of ['id="cm-app"', 'id="cm-camera"', 'id="cm-gallery"', 'data-cm-preview', 'data-cm-shoot', 'data-cm-timer', 'data-cm-burst', 'data-cm-filter', 'data-cm-file', 'data-cm-grid']) assert.ok(r.text.includes(marker), marker);
            assert.ok(r.text.includes('Sign in'));
        });

        await check('/my needs an account; signed in it has the pair form and no camera yet', async () => {
            const anon = await t.get('/my');
            assert.strictEqual(anon.status, 401);
            assert.ok(anon.text.includes('Sign in with OpenVibe'));
            const mine = await t.get('/my', { as: alice });
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.headers.get('cache-control'), 'private, no-store');
            for (const marker of ['id="cm-my"', 'id="cm-pair"', 'action="/my/cameras"', 'name="stream_id"', 'id="cm-cameras"', 'id="cm-photos"', 'id="cm-stills"']) assert.ok(mine.text.includes(marker), marker);
        });

        await check('the pair form creates a camera and redirects to its owner page', async () => {
            const r = await t.get('/my/cameras', { as: alice, form: { name: 'Front door', source: 'phone', slot: 'whip' } });
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.headers.get('location'), /^\/my\/cameras\/cam_/);
            camera = (await t.get('/api/v1/cameras', { as: alice })).json().cameras[0];
            assert.strictEqual(camera.name, 'Front door');
            assert.strictEqual(camera.slot, 'whip');
        });

        await check('the owner page shows the frame, the edit form and the grant form; a stranger gets 404', async () => {
            const r = await t.get(`/my/cameras/${camera.id}`, { as: alice });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            for (const marker of ['id="cm-camera-owner"', 'id="cm-edit"', 'id="cm-grants"', `action="/my/cameras/${camera.id}/grants"`, `action="/my/cameras/${camera.id}/delete"`, '/live/whip/frame.jpg']) assert.ok(r.text.includes(marker), marker);
            assert.strictEqual((await t.get(`/my/cameras/${camera.id}`, { as: carol })).status, 404);
        });

        await check('the grant form resolves @bob; the wall opens for bob and not for carol', async () => {
            const r = await t.get(`/my/cameras/${camera.id}/grants`, { as: alice, form: { viewer_username: 'bob', days: '7' } });
            assert.strictEqual(r.status, 303, r.text);
            assert.strictEqual(r.headers.get('location'), `/my/cameras/${camera.id}?granted=1`);
            grant = (await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice })).json().grants[0];
            const wall = await t.get(`/w/${camera.id}`, { as: bob });
            assert.strictEqual(wall.status, 200);
            assert.strictEqual(wall.headers.get('cache-control'), 'private, no-store');
            for (const marker of ['id="cm-wall"', 'id="cm-wall-frame"', 'Shared by @alice', '/live/whip/frame.jpg', 'id="cm-wall-photos"']) assert.ok(wall.text.includes(marker), marker);
            assert.strictEqual((await t.get(`/w/${camera.id}`, { as: carol })).status, 404);
            assert.strictEqual((await t.get(`/w/${camera.id}`)).status, 401);
        });

        await check('revoking from the owner page refuses the wall at once', async () => {
            const r = await t.get(`/my/cameras/${camera.id}/grants/${grant.id}/revoke`, { as: alice, method: 'POST' });
            assert.strictEqual(r.status, 303);
            assert.strictEqual(r.headers.get('location'), `/my/cameras/${camera.id}?revoked=1`);
            assert.strictEqual((await t.get(`/w/${camera.id}`, { as: bob })).status, 404);
        });

        await check('one still page shows the picture and its caption; a private one is 404', async () => {
            still = (await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', caption: 'the robot fell over' } })).json().still;
            const r = await t.get(`/s/${still.id}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            for (const marker of ['id="cm-still"', 'the robot fell over', still.pics_direct, '/app']) assert.ok(r.text.includes(marker), marker);
            const priv = (await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', visibility: 'private' } })).json().still;
            assert.strictEqual((await t.get(`/s/${priv.id}`)).status, 404);
            assert.strictEqual((await t.get(`/s/${priv.id}`, { as: alice })).status, 200);
        });

        await check('/developers names the API and the Live cam button contract', async () => {
            const r = await t.get('/developers');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            for (const marker of ['id="cm-developers"', 'POST /api/v1/stills', 'POST /api/v1/photos', '/live/:slot/frame.jpg', 'openvibe.pics/api/v1/images', 'id="cm-live-button"', '/api/v1/cameras/:id/grants']) assert.ok(r.text.includes(marker), marker);
        });

        await check('a cross-site form is refused; the 404 page is semantic', async () => {
            const cross = await t.get('/my/cameras', { as: alice, form: { name: 'Cross' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            const nf = await t.get('/no/such/page');
            assert.strictEqual(nf.status, 404);
            assert.match(nf.headers.get('content-type'), /^text\/html/);
            assert.ok(nf.text.includes('id="cm-not-found"'));
        });

        await check('assets are content-hashed; robots keeps the walls and stills out; the sitemap lists only public pages', async () => {
            const v = assetVersion('css/cam.css');
            const hashed = await t.get(`/css/cam.css?v=${v}`);
            assert.strictEqual(hashed.status, 200);
            assert.strictEqual(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
            const wrong = await t.get('/css/cam.css?v=deadbeefdeadbeef');
            assert.strictEqual(wrong.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
            const js = await t.get('/js/cam.js');
            assert.strictEqual(js.status, 200);
            assert.match(js.headers.get('content-type'), /javascript/);
            const robots = await t.get('/robots.txt');
            assert.match(robots.text, /Disallow: \/w\//);
            assert.match(robots.text, /Disallow: \/s\//);
            assert.match(robots.text, /Disallow: \/api\//);
            const map = await t.get('/sitemap.xml');
            assert.strictEqual(map.status, 200);
            assert.ok(map.text.includes('https://openvibe.cam/app'));
            assert.ok(!map.text.includes('/w/'));
            assert.ok(!map.text.includes('/s/'));
            const llms = await t.get('/llms.txt');
            assert.strictEqual(llms.status, 200);
            assert.ok(llms.text.includes('OpenVibe.Cam'));
        });
    } finally {
        await t.close();
    }
    done();
})();
