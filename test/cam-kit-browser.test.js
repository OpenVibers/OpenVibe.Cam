'use strict';
/**
 * The kit in a real browser: OVCapture comes from the page's own /shared/ov-capture.js, and the person's saved
 * camera choices reach navigator.mediaDevices.getUserMedia as exact constraints — Front/Back as facingMode exact
 * when the "ideal" ask is refused, a chosen lens as deviceId exact. Cam's settings API is a small local fixture.
 *
 * The browser is the workstation's Chrome; where it is missing (a CI image without Chrome) the test skips.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const KIT = path.join(ROOT, 'public/embed/cam-kit.js');
const CAPTURE = path.join(ROOT, 'node_modules/openvibe-shared/ov-capture.js');

function page(settings, failIdeal) {
    return `<!doctype html><meta charset="utf-8"><title>cam-kit</title>
<script>
window.__calls = [];
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async function (constraints) {
    window.__calls.push(JSON.parse(JSON.stringify(constraints || {})));
    if (${failIdeal ? 'true' : 'false'} && constraints && constraints.video && constraints.video.facingMode && constraints.video.facingMode.ideal) {
        var e = new Error('the ideal ask was refused'); e.name = 'OverconstrainedError'; throw e;
    }
    var track = { stop: function () {}, addEventListener: function () {}, getSettings: function () { return { facingMode: 'environment' }; },
        getCapabilities: function () { return {}; }, applyConstraints: function () { return Promise.resolve(); } };
    return { getVideoTracks: function () { return [track]; }, getAudioTracks: function () { return []; }, getTracks: function () { return [track]; } };
} });
</script>
<script src="/embed/cam-kit.js"></script>
<script>
(async function () {
    try { await OpenVibeCam.core.open({ mode: 'camera_only' }); }
    catch (e) { window.__error = String((e && e.message) || e); }
    document.body.setAttribute('data-calls', btoa(JSON.stringify(window.__calls)));
    document.body.setAttribute('data-error', btoa(window.__error || ''));
})();
</script>
<body></body>`;
}

function serve(settings) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname === '/embed/cam-kit.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
                return fs.createReadStream(KIT).pipe(res);
            }
            if (url.pathname === '/shared/ov-capture.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
                return fs.createReadStream(CAPTURE).pipe(res);
            }
            if (url.pathname === '/api/v1/me/camera-settings') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(settings));
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(page(settings, url.searchParams.get('ideal') === 'fail'));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function chrome(url) {
    return new Promise((resolve, reject) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-kit-chrome-'));
        execFile(CHROME, [
            '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
            `--user-data-dir=${dir}`, '--virtual-time-budget=6000', '--dump-dom', url,
        ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* a temp profile */ }
            if (err) return reject(Object.assign(err, { stderr }));
            resolve(stdout);
        });
    });
}

function callsOf(dom) {
    const match = /data-calls="([^"]*)"/.exec(dom);
    assert(match, 'the page reported its getUserMedia calls');
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

(async () => {
    if (!fs.existsSync(CHROME)) { console.log(`  skip  ${CHROME} is not installed`); return; }
    assert(fs.existsSync(CAPTURE), 'the pinned openvibe-shared serves ov-capture.js');
    const cases = [
        {
            name: 'Front/Back reaches getUserMedia as facingMode exact',
            settings: { facing: 'environment', lens: 'main', resolution: '1080', mirror: false, updated_at: null },
            ideal: 'fail',
            check(calls) { return calls.some((c) => c.video && c.video.facingMode && c.video.facingMode.exact === 'environment'); },
        },
        {
            name: 'a chosen lens reaches getUserMedia as deviceId exact',
            settings: { facing: 'environment', lens: 'cam-back-2', resolution: '1080', mirror: false, updated_at: null },
            ideal: 'ok',
            check(calls) { return calls.some((c) => c.video && c.video.deviceId && c.video.deviceId.exact === 'cam-back-2'); },
        },
    ];
    for (const test of cases) {
        const server = await serve(test.settings);
        try {
            const base = `http://127.0.0.1:${server.address().port}/?ideal=${test.ideal}`;
            const dom = await chrome(base);
            const error = /data-error="([^"]*)"/.exec(dom);
            const said = error ? Buffer.from(error[1], 'base64').toString('utf8') : '';
            assert.strictEqual(said, '', `${test.name}: ${said}`);
            assert(test.check(callsOf(dom)), test.name);
            console.log(`  ok  ${test.name}`);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }
    console.log('\nall passed\n');
})().catch((err) => {
    if (err && err.code === 'ENOENT') { console.log(`  skip  ${CHROME} could not start`); return; }
    console.error(err && err.stack ? err.stack : err);
    if (err && err.stderr) console.error(String(err.stderr).slice(-2000));
    process.exitCode = 1;
});
