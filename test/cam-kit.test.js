'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../public/embed/cam-kit.js'), 'utf8');
const window = { document: { currentScript: { src: 'https://openvibe.cam/embed/cam-kit.js' } }, navigator: { mediaDevices: {} }, URL };
vm.runInNewContext(source, { window, URL, Blob, File, Promise, Number, String, Date, setTimeout, clearTimeout, setInterval, clearInterval });

assert.strictEqual(typeof window.OpenVibeCam.open, 'function');
assert(Object.isFrozen(window.OpenVibeCam));
assert.throws(() => window.OpenVibeCam.open({ mode: 'invalid' }), /mode must be/);
assert(!/\brequire\(|\bimport\s/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')));
console.log('cam-kit API shape and standalone script: ok');
