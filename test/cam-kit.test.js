'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../public/embed/cam-kit.js'), 'utf8');
const window = { document: { currentScript: { src: 'https://openvibe.cam/embed/cam-kit.js' } }, navigator: { mediaDevices: {} }, URL };
vm.runInNewContext(source, { window, URL, Blob, File, Promise, Number, String, Date, setTimeout, clearTimeout, setInterval, clearInterval });

assert.strictEqual(typeof window.OpenVibeCam.open, 'function');
assert.strictEqual(typeof window.OpenVibeCam.core.open, 'function');
assert.strictEqual(typeof window.OpenVibeCam.core.devices, 'function');
assert.strictEqual(typeof window.OpenVibeCam.core.meter, 'function');
assert.strictEqual(window.OpenVibeCam.core.constraints({ facing: 'environment', resolution: '1080', audio: false }).video.height.ideal, 1080);
assert(Object.isFrozen(window.OpenVibeCam));
assert.throws(() => window.OpenVibeCam.open({ mode: 'invalid' }), /mode must be/);
assert(!/\brequire\(|\bimport\s/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')));
assert(!/mediaDevices\.getUserMedia\s*\(/.test(source), 'the kit opens cameras through OVCapture, never its own getUserMedia');
assert(!/mediaDevices\.getDisplayMedia\s*\(/.test(source), 'the kit opens screens through OVCapture, never its own getDisplayMedia');
console.log('cam-kit API shape and standalone script: ok');

// ── The kit against a fake OVCapture: the same public API, all opens through the core. ──────────────────────────
(async () => {
    const calls = { open: [], save: [], use: [], add: [] };
    const parts = {
        constraints: (o) => {
            o = o || {};
            const height = Number(o.resolution) || 720;
            return {
                video: {
                    facingMode: { ideal: o.facing || 'user' },
                    ...(o.lens && o.lens !== 'main' && o.lens !== 'default' ? { deviceId: { ideal: o.lens } } : {}),
                    width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height },
                },
                audio: o.audio === false ? false : true,
            };
        },
        getUserMedia: (constraints) => { calls.gum = constraints; return Promise.resolve({ getTracks: () => [] }); },
    };
    const strategies = [];
    const fake = {
        version: 2,
        open: (o) => { calls.open.push(o); return Promise.resolve({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] }); },
        devices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'cam-9' }]),
        meter: () => () => {},
        network: () => 'good',
        part: (name) => parts[name],
        use: (name, impl) => { calls.use.push(name); const before = parts[name]; parts[name] = impl; return before; },
        strategies: {
            list: () => strategies.map((s) => ({ name: s.name })),
            add: (strategy) => { calls.add.push(strategy.name); strategies.push(strategy); },
        },
        settings: {
            load: () => ({ facing: 'environment', lens: 'applied-lens', resolution: '1080', mirror: false }),
            save: (values) => { calls.save.push(values); return values; },
        },
        on: () => () => {},
        explain: (err, mode) => ({ title: `explained ${mode}`, steps: ['Tap Allow.', 'Try again.'] }),
    };
    const win = {
        document: { currentScript: { src: 'https://openvibe.cam/embed/cam-kit.js' } },
        navigator: { mediaDevices: { getUserMedia: () => { throw new Error('the kit must not call getUserMedia itself'); } } },
        location: { href: 'https://openvibe.network/page' },
        OVCapture: fake,
    };
    vm.runInNewContext(source, { window: win, URL, Blob, File, Promise, Number, String, Date, setTimeout, clearTimeout, setInterval, clearInterval });
    const kit = win.OpenVibeCam;
    assert.strictEqual(typeof kit.open, 'function');
    assert.strictEqual(typeof kit.core.open, 'function');
    assert.deepStrictEqual(parts.constraints({ lens: 'cam-9' }).video.deviceId, { ideal: 'cam-9' });
    assert.deepStrictEqual(await kit.core.devices(), [{ kind: 'videoinput', deviceId: 'cam-9' }]);
    await kit.core.open({ mode: 'video', facing: 'environment' });
    assert.deepStrictEqual(calls.open, [{ mode: 'video', facing: 'environment' }], 'the open is OVCapture.open');
    assert(calls.use.includes('constraints'), 'the chosen lens becomes an exact constraint');
    assert.strictEqual(parts.constraints({ lens: 'cam-9' }).video.deviceId.exact, 'cam-9');
    assert.deepStrictEqual(calls.add, ['side'], 'the exact-side strategy is added');
    assert.strictEqual(strategies[0].name, 'side');
    await strategies[0].open({ facing: 'environment', mode: 'camera_only' }, fake);
    assert.strictEqual(calls.gum.video.facingMode.exact, 'environment', 'the side is asked for exactly');
    console.log('cam-kit fake OVCapture: all opens through the shared core');
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exitCode = 1; });
