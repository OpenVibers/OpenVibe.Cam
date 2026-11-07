'use strict';
/**
 * The <ov-camera> element's pure helpers: the attribute parsing the page and the element share, the filter table
 * (the same list the API accepts as X-Filter), and the same-origin rule that decides whether upload="openvibe" may
 * post. No DOM and no database: public/embed/ov-camera.js is a UMD file so this test can require it in Node.
 */
const assert = require('assert');
const core = require('../public/embed/ov-camera.js');
const { FILTERS: API_FILTERS } = require('../server/store');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); }
    catch (err) { failures += 1; console.error(`  FAIL ${name}\n${err && err.stack ? err.stack : err}`); }
}

check('the element is framework-free and Node can require it without a DOM', () => {
    assert.strictEqual(typeof core.parseAttrs, 'function');
    assert.strictEqual(typeof core.drawTo, 'function');
    assert.strictEqual(typeof core.define, 'function');
    assert.ok(!/require\(|import\s/.test(require('fs').readFileSync(require.resolve('../public/embed/ov-camera.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), 'no bundler or runtime import');
});

check('the filter table is exactly the API X-Filter list', () => {
    assert.deepStrictEqual(core.FILTER_NAMES, API_FILTERS);
    assert.strictEqual(core.parseFilters('none, mono, WARM, cool, fade, vivid, blur').join(','), 'none,mono,warm,cool,fade,vivid,blur');
});

check('filters: a comma list, names lower-cased, unknown dropped, duplicates once, soft is blur, empty is none', () => {
    assert.deepStrictEqual(core.parseFilters(null), ['none']);
    assert.deepStrictEqual(core.parseFilters('  '), ['none']);
    assert.deepStrictEqual(core.parseFilters('warm, nope, warm, SOFT'), ['warm', 'blur']);
    assert.deepStrictEqual(core.parseFilters('nope'), ['none']);
});

check('timer is 0, 3 or 10; facing is user or environment; mode is photo or burst; upload is off or openvibe', () => {
    assert.strictEqual(core.parseTimer('0'), 0);
    assert.strictEqual(core.parseTimer('3'), 3);
    assert.strictEqual(core.parseTimer('10'), 10);
    assert.strictEqual(core.parseTimer('5'), 0);
    assert.strictEqual(core.parseTimer(undefined), 0);
    assert.strictEqual(core.parseFacing('environment'), 'environment');
    assert.strictEqual(core.parseFacing('rear'), 'environment');
    assert.strictEqual(core.parseFacing('user'), 'user');
    assert.strictEqual(core.parseFacing('front'), 'user');
    assert.strictEqual(core.parseFacing('sideways'), 'user');
    assert.strictEqual(core.parseMode('burst'), 'burst');
    assert.strictEqual(core.parseMode('video'), 'photo');
    assert.strictEqual(core.parseUpload('openvibe'), 'openvibe');
    assert.strictEqual(core.parseUpload('s3'), 'off');
});

check('parseAttrs reads all five at once from a getAttribute-style function or a plain object', () => {
    const attrs = { facing: 'environment', filters: 'warm, mono', timer: '10', mode: 'burst', upload: 'openvibe' };
    const fromObject = core.parseAttrs(attrs);
    const fromGetter = core.parseAttrs((name) => (name in attrs ? attrs[name] : null));
    assert.deepStrictEqual(fromObject, fromGetter);
    assert.deepStrictEqual(fromObject, {
        facing: 'environment', filters: ['warm', 'mono'], timer: 10, mode: 'burst', upload: 'openvibe',
    });
    assert.deepStrictEqual(core.parseAttrs(null), { facing: 'user', filters: ['none'], timer: 0, mode: 'photo', upload: 'off' });
});

check('the same-origin rule: upload="openvibe" may post only from the script origin', () => {
    assert.strictEqual(core.isSameOrigin('https://openvibe.cam/app', 'https://openvibe.cam/embed/ov-camera.js?v=abc'), true);
    assert.strictEqual(core.isSameOrigin('https://openvibe.cam', 'https://openvibe.network/embed/ov-camera.js'), false);
    assert.strictEqual(core.isSameOrigin('', 'https://openvibe.cam/embed/ov-camera.js'), false);
});

if (failures) { console.error(`\n${failures} failed\n`); process.exit(1); }
console.log('\nall passed\n');
