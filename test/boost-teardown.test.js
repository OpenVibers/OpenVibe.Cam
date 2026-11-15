'use strict';
// The release check's navigation test (11-15): every visit to /app swapped in by boost added a document
// visibilitychange listener that held the old camera page (+431 nodes a lap on production). What one wiring adds to
// document is removed on ov:boost:before; a document-level listener inside wire() must be removable.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'cam.js'), 'utf8');
const wireBody = js.slice(js.indexOf('function wire() {'), js.indexOf("document.addEventListener('ov:boost:load', wire);"));
assert.ok(wireBody.length > 1000, 'wire() found');
// Inside wire(), document and window listeners are named, so they can be taken off again.
const anonymous = wireBody.match(/(document|window)\.addEventListener\('[a-z]+', function/g) || [];
assert.deepStrictEqual(anonymous, [], 'a document or window listener added inside wire() is a named function');
assert.match(wireBody, /document\.addEventListener\('visibilitychange', onVisible\);/);
assert.match(wireBody, /unwire = function \(\) \{ document\.removeEventListener\('visibilitychange', onVisible\); \};/);
assert.match(js, /document\.addEventListener\('ov:boost:before', function \(\) \{ if \(unwire\) \{ unwire\(\); unwire = null; \} \}\);/);
console.log('boost-teardown: what wire() adds to document comes off when boost swaps the page out');
