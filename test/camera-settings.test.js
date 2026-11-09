'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    try {
        await check('camera choices have safe defaults and belong to one person', async () => {
            const r = await t.get('/api/v1/me/camera-settings', { as: alice });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json(), { facing: 'user', lens: 'main', mic: 'default', resolution: '720', mirror: true, updated_at: null });
        });
        await check('partial settings persist and do not leak to another person', async () => {
            const r = await t.get('/api/v1/me/camera-settings', { as: alice, method: 'PUT', json: { facing: 'environment', resolution: '1080', mirror: false } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().facing, 'environment');
            assert.strictEqual(r.json().lens, 'main');
            assert.strictEqual(r.json().mirror, false);
            assert.strictEqual((await t.get('/api/v1/me/camera-settings', { as: alice })).json().resolution, '1080');
            assert.strictEqual((await t.get('/api/v1/me/camera-settings', { as: bob })).json().facing, 'user');
        });
        await check('invalid settings and an anonymous write are refused', async () => {
            assert.strictEqual((await t.get('/api/v1/me/camera-settings', { as: alice, method: 'PUT', json: { resolution: '4096' } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/me/camera-settings', { method: 'PUT', json: { mirror: false } })).status, 401);
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
