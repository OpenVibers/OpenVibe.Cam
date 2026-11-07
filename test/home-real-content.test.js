'use strict';
// Cam's home scenes are illustrations on the sample picture: the camera list and grants are private to their owner, so
// the public page must label them Example and never print a written-in viewer, camera name or count.
const assert = require('assert');
const views = require('../server/views');

const page = views.home({});
assert.ok(page.includes('Live · example'), 'the live frame says Example');
assert.ok(page.includes('Example grant'), 'the grant says Example');
assert.ok(page.includes('Example · Warm · saved to Pics'), 'the filter strip says Example');
assert.ok(page.includes('a still is posted to the stream'), 'the chat line describes the action, not a person');
assert.ok(!/@ada|\bada\b|Back garden|5 of 7 days|sun just touched the ridge/.test(page), 'no written-in viewer, camera name or count');

// The signed-in flag only changes the link in the privacy rules; it must not put any camera or grant on the public page.
const signedIn = views.home({ signedIn: true });
assert.ok(signedIn.includes('href="/my"'), 'a signed-in owner gets the way to their cameras');
assert.ok(!/Back garden|@ada|5 of 7 days/.test(signedIn), 'and still no private camera or grant is drawn');
console.log('cam home: every scene is labelled Example and no written-in person, camera or count remains');
