'use strict';
/**
 * The still Live's cam button takes: Cam reads Media's public GET /live/:slot/frame.jpg, uploads the JPEG to
 * OpenVibe.Pics with the viewer's own Network token, records the Pics slug and links, and returns the line Live
 * posts in chat. An offline slot, a non-JPEG card, a busy frame and a Pics refusal are distinct problems. A still is
 * unlisted by default (the chat link opens it) and private when its owner says so.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    let still = null;
    try {
        await check('a still fetches the Media frame and saves it to Pics as the viewer', async () => {
            const r = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', stream_id: 1234, caption: 'the exact second the robot fell over' } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            still = b.still;
            assert.match(still.id, /^cms_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(still.slot, 'whip');
            assert.strictEqual(still.stream_id, 1234);
            assert.strictEqual(still.visibility, 'unlisted');
            assert.strictEqual(still.caption, 'the exact second the robot fell over');
            assert.match(still.pics_slug, /^pic\d+abcd$/);
            assert.match(still.pics_url, /^https:\/\/openvibe\.pics\/i\//);
            assert.strictEqual(r.headers.get('location'), `/api/v1/stills/${still.id}`);
            assert.strictEqual(b.share.url, `https://openvibe.cam/s/${still.id}`);
            assert.strictEqual(b.share.text, `the exact second the robot fell over — https://openvibe.cam/s/${still.id}`);

            const frameReq = t.upstreams.lastFor('/live/whip/frame.jpg');
            assert.ok(frameReq, 'Media frame was read');
            assert.strictEqual(frameReq.query.w, '640');
            const upload = t.upstreams.uploads()[0];
            assert.match(upload.auth, /^Bearer /);
            assert.strictEqual(upload.contentType, 'image/jpeg');
            assert.strictEqual(upload.title, encodeURIComponent('the exact second the robot fell over'));
            assert.match(upload.filename, /^still-whip-\d+\.jpg$/);
            assert.ok(upload.bytes > 0);
        });

        await check('the still row holds a Pics slug and links, never the picture bytes', async () => {
            const cols = (await t.ctx.s.db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'cam_stills'")).map((r) => r.column_name);
            assert.ok(!cols.some((c) => /image|blob|bytes|photo|data/i.test(c)), cols.join(','));
            const row = await t.ctx.s.db.maybe('SELECT pics_slug, pics_url, pics_direct FROM cam_stills WHERE id = $1', [still.id]);
            assert.strictEqual(row.pics_slug, still.pics_slug);
            assert.ok(row.pics_url.startsWith('https://openvibe.pics/'));
        });

        await check('an unlisted still opens by its link, with no author; a private one is its owner\'s only', async () => {
            const anon = await t.get(`/api/v1/stills/${still.id}`);
            assert.strictEqual(anon.status, 200);
            assert.strictEqual(anon.json().mine, false);
            assert.ok(!('subject' in anon.json()));
            const mine = await t.get(`/api/v1/stills/${still.id}`, { as: alice });
            assert.strictEqual(mine.json().mine, true);
            assert.strictEqual(mine.json().subject, alice.subject);

            const priv = (await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', caption: 'only me', visibility: 'private' } })).json().still;
            assert.strictEqual((await t.get(`/api/v1/stills/${priv.id}`)).status, 404);
            assert.strictEqual((await t.get(`/api/v1/stills/${priv.id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/stills/${priv.id}`, { as: alice })).status, 200);
        });

        await check('an offline slot is 404 and nothing is uploaded to Pics', async () => {
            const before = t.upstreams.uploads().length;
            t.upstreams.setFrame('whip', { status: 404 });
            const r = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip' } });
            assert.strictEqual(r.status, 404);
            assert.strictEqual(r.json().code, 'cam.stream_offline');
            assert.strictEqual(t.upstreams.uploads().length, before);
            t.upstreams.setFrame('whip', { status: 200 });
        });

        await check('an SVG offline card served with 200 is not a picture; a busy frame is 429', async () => {
            t.upstreams.setFrame('whip', { status: 200, type: 'image/svg+xml' });
            const svg = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip' } });
            assert.strictEqual(svg.status, 502);
            assert.strictEqual(svg.json().code, 'cam.frame_unavailable');
            t.upstreams.setFrame('whip', { status: 429 });
            const busy = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip' } });
            assert.strictEqual(busy.status, 429);
            assert.strictEqual(busy.json().code, 'cam.frame_busy');
            t.upstreams.setFrame('whip', { status: 200, type: 'image/jpeg' });
        });

        await check('a Pics refusal is a problem, not a still', async () => {
            t.upstreams.setPics(401);
            const r = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip' } });
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.json().code, 'cam.pics.refused');
            t.upstreams.setPics(201);
        });

        await check('slot, caption, width and visibility are validated; anonymous is refused', async () => {
            assert.strictEqual((await t.get('/api/v1/stills', { json: { slot: 'whip' } })).status, 401);
            assert.strictEqual((await t.get('/api/v1/stills', { as: alice, json: { slot: 'not a slot!' } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', w: 4000 } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', visibility: 'public' } })).status, 400);
            const blocked = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', caption: 'this is kys' } });
            assert.strictEqual(blocked.status, 400);
            assert.strictEqual(blocked.json().code, 'cam.blocked_words');
            const long = await t.get('/api/v1/stills', { as: alice, json: { slot: 'whip', caption: 'x'.repeat(281) } });
            assert.strictEqual(long.status, 400);
        });

        await check('your stills are listed; another person\'s are not', async () => {
            const mine = await t.get('/api/v1/stills', { as: alice });
            assert.strictEqual(mine.status, 200);
            assert.ok(mine.json().count >= 2);
            assert.ok(mine.json().stills.every((s) => s.id.startsWith('cms_')));
            assert.strictEqual((await t.get('/api/v1/stills', { as: bob })).json().count, 0);
        });
    } finally {
        await t.close();
    }
    done();
})();
