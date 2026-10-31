'use strict';
// Cam's home shows the real thing (the owner, 10-31: placeholder pictures made the rooms look unfinished): a live frame
// with the cam button's flash and the chat line it posts, a camera's one grant, and one picture through every filter the
// camera app has, with the same CSS as the app, so the home can never show a filter the camera does not apply.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const views = require('../server/views');

const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/cam.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public/js/cam.js'), 'utf8');
const sample = fs.readFileSync(path.join(__dirname, '..', 'public/img/cam-sample.svg'), 'utf8');

const block = js.slice(js.indexOf('var FILTERS = {'), js.indexOf('};', js.indexOf('var FILTERS = {')));
const app = Object.fromEntries([...block.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
assert.ok(Object.keys(app).length >= 7, 'the camera app\'s filters were read');
for (const [id, filter] of Object.entries(app)) {
    const m = css.match(new RegExp(`\\.cm-f-${id} \\{ filter: ([^;]+); \\}`));
    assert.ok(m, `cam.css draws the ${id} filter`);
    assert.strictEqual(m[1], filter, `the home's ${id} is the camera's ${id}`);
}

const home = views.home({ signedIn: false });
assert.ok(home.includes('class="cm-demo-live"') && home.includes('class="cm-live-flash"') && home.includes('caught a still'), 'a live still, shown');
assert.ok(home.includes('class="cm-demo-grant"') && home.includes('can watch') && home.includes('Revoke'), 'a grant, shown');
assert.ok(home.includes('class="cm-demo-filters"'), 'the filters, shown');
for (const id of Object.keys(app)) assert.ok(home.includes(`class="cm-f-${id}"`), `the ${id} filter is in the strip`);
assert.ok(!/<img src="\/img\/cam-shutter\.svg"/.test(home), 'no placeholder picture in a scene');
assert.ok(!/<script/i.test(sample) && !/href=|xlink:/i.test(sample), 'the sample picture is a plain drawing');
console.log(`cam home scenes: ${Object.keys(app).length} filters equal to the camera's, three real scenes`);
