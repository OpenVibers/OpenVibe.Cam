'use strict';
/**
 * F1: familiar faces and the event timeline.
 *
 * The camera owner turns the setting on, names a face through Vision's library (Cam stores no template or crop),
 * and a detection becomes one event: person/package/vehicle/animal/loiter/door, a 10 s-before / 20 s-after clip
 * reference, a still, away-mode priority, a Network notification (held for a muted name or quiet hours), a private
 * share link and the police export. Vision is the test fixture in test/helpers/upstreams.js.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const DATA_URL = `data:image/png;base64,${Buffer.from('not-a-real-png').toString('base64')}`;

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    try {
        let camera = null;
        let libraryId = null;
        let person = null;
        let personEvent = null;

        await check('a camera pairs and Familiar faces creates the owner\'s own Vision library', async () => {
            const r = await t.get('/api/v1/cameras', { as: alice, json: { name: 'Front door', source: 'phone' } });
            assert.strictEqual(r.status, 201, r.text);
            camera = r.json();
            const on = await t.get(`/api/v1/cameras/${camera.id}/familiar-faces`, { as: alice, method: 'PUT', json: { enabled: true, region: 'US-IL' } });
            assert.strictEqual(on.status, 200, on.text);
            libraryId = on.json().library.id;
            assert.strictEqual(on.json().enabled, true);
            assert.strictEqual(on.json().region, 'US-IL');
            assert.strictEqual(on.json().region_mode, 'strict');
            assert.ok(t.upstreams.visionLibrary(libraryId), 'Vision library exists');
            const call = t.upstreams.visionCalls().find((c) => c.method === 'POST' && c.path === '/api/v1/faces/libraries');
            assert.ok(call, 'create call');
            assert.deepStrictEqual(call.body.camera_ids, [camera.id]);
            assert.match(call.auth, /^Bearer /, 'the owner\'s own token is forwarded');
        });

        await check('naming a face goes through Vision and keeps no crop in Cam', async () => {
            const r = await t.get(`/api/v1/cameras/${camera.id}/familiar-faces/enroll`, {
                as: alice, json: { name: 'Mom', image: DATA_URL },
            });
            assert.strictEqual(r.status, 201, r.text);
            person = r.json().person;
            assert.match(person.id, /^flp_/);
            assert.strictEqual(person.status, 'pending_consent');
            assert.strictEqual(r.json().camera_id, camera.id);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='cam_cameras' AND column_name LIKE '%image%'")), 0);
            const people = await t.get(`/api/v1/cameras/${camera.id}/familiar-faces/people`, { as: alice });
            assert.strictEqual(people.status, 200);
            assert.strictEqual(people.json().people.length, 1);
        });

        await check('the owner mutes a name and another person cannot read the setting', async () => {
            const muted = await t.get(`/api/v1/cameras/${camera.id}/familiar-faces/people/${person.id}`, { as: alice, method: 'PATCH', json: { muted: true } });
            assert.strictEqual(muted.status, 200, muted.text);
            assert.strictEqual(muted.json().muted, true);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/familiar-faces`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/familiar-faces/enroll`, { as: bob, json: { name: 'x', image: DATA_URL } })).status, 404);
        });

        await check('away mode says away from the phone, and a known face is one event with a 10/20 clip', async () => {
            const away = await t.get('/api/v1/presence', { as: alice, method: 'PUT', json: { state: 'away', source: 'phone' } });
            assert.strictEqual(away.status, 200, away.text);
            assert.strictEqual(away.json().presence.state, 'away');
            t.upstreams.setVisionMatch({ match: true, label: 'Mom', name: 'Mom', person_id: person.id, muted: false, score: 0.88, threshold: 0.363 });
            const r = await t.get(`/api/v1/cameras/${camera.id}/events`, {
                as: alice,
                json: {
                    kind: 'person', still_url: 'https://openvibe.pics/i/still1.jpg', clip_url: 'https://openvibe.media/clip1.mp4',
                    face_image: DATA_URL, place: '12 Oak Street', lat: 41.88, lng: -87.63,
                },
            });
            assert.strictEqual(r.status, 201, r.text);
            personEvent = r.json().event;
            assert.strictEqual(personEvent.title, 'Mom is at the Front door');
            assert.strictEqual(personEvent.known, true);
            assert.strictEqual(personEvent.away, true);
            assert.strictEqual(personEvent.priority, 'normal', 'a known face is not the louder unknown-person alert');
            assert.deepStrictEqual(personEvent.clip, { url: 'https://openvibe.media/clip1.mp4', before_seconds: 10, after_seconds: 20 });
            assert.strictEqual(personEvent.still_url, 'https://openvibe.pics/i/still1.jpg');
            assert.strictEqual(personEvent.location.place, '12 Oak Street');
            assert.strictEqual(r.json().notification.sent, true, 'the Network notification went out');
            assert.ok(t.network.requests.filter((r) => r.path === '/internal/notifications/push').length >= 1);
            const matchCall = t.upstreams.visionCalls().filter((c) => c.path.endsWith('/match')).pop();
            assert.ok(matchCall, 'the face crop was matched in the camera library');
            assert.strictEqual(matchCall.body.image, DATA_URL);
        });

        await check('an unknown person while away is unknown and louder; package and loitering need no face', async () => {
            t.upstreams.setVisionMatch({ match: false, label: 'unknown person', name: null, person_id: null, muted: false, score: 0.12, threshold: 0.363 });
            const before = t.upstreams.visionCalls().filter((c) => c.path.endsWith('/match')).length;
            const unknown = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'person', face_image: DATA_URL } });
            assert.strictEqual(unknown.status, 201, unknown.text);
            assert.strictEqual(unknown.json().event.title, 'Unknown person at the Front door');
            assert.strictEqual(unknown.json().event.known, false);
            assert.strictEqual(unknown.json().event.priority, 'high');
            const pkg = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'package' } });
            assert.strictEqual(pkg.status, 201, pkg.text);
            assert.strictEqual(pkg.json().event.title, 'Package left');
            const afterPackage = t.upstreams.visionCalls().filter((c) => c.path.endsWith('/match')).length;
            assert.strictEqual(afterPackage, before + 1, 'only the person event asked Vision');
            const loiter = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'loiter', linger_seconds: 134 } });
            assert.strictEqual(loiter.json().event.title, 'Someone lingered 2 min');
            const door = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'door' } });
            assert.strictEqual(door.json().event.title, "The door opened while you're away");
            assert.strictEqual(door.json().event.priority, 'high');
            const car = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'vehicle' } });
            assert.strictEqual(car.json().event.title, 'Car at the Front door');
            const animal = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'animal' } });
            assert.strictEqual(animal.json().event.title, 'Animal at the Front door');
        });

        await check('a muted name still matches but its notification is held', async () => {
            t.upstreams.setVisionMatch({ match: true, label: 'Mom', name: 'Mom', person_id: person.id, muted: true, score: 0.9, threshold: 0.363 });
            const r = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'person', face_image: DATA_URL } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().event.muted, true);
            assert.strictEqual(r.json().notification.sent, false);
            assert.strictEqual(r.json().notification.skipped, 'muted');
        });

        await check('quiet hours hold the notification, not the event', async () => {
            const quiet = await t.get(`/api/v1/cameras/${camera.id}/familiar-faces`, {
                as: alice, method: 'PUT', json: { enabled: true, quiet_hours: { enabled: true, start: '00:00', end: '23:59', tz: 'UTC' } },
            });
            assert.strictEqual(quiet.status, 200, quiet.text);
            const r = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice, json: { kind: 'package' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().notification.sent, false);
            assert.strictEqual(r.json().notification.skipped, 'quiet_hours');
        });

        await check('the timeline is the owner\'s and a viewer or another person sees none', async () => {
            const list = await t.get(`/api/v1/cameras/${camera.id}/events`, { as: alice });
            assert.strictEqual(list.status, 200, list.text);
            assert.ok(list.json().count >= 6);
            assert.strictEqual(list.json().events[0].camera_id, camera.id);
            const all = await t.get('/api/v1/events', { as: alice });
            assert.ok(all.json().count >= 6);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/events`, { as: bob })).status, 404);
            assert.strictEqual((await t.get('/api/v1/events', { as: bob })).json().count, 0);
            const grant = await t.get(`/api/v1/cameras/${camera.id}/grants`, { as: alice, json: { viewer_username: 'bob' } });
            assert.strictEqual(grant.status, 201, grant.text);
            assert.strictEqual((await t.get(`/api/v1/cameras/${camera.id}/events`, { as: bob })).status, 404);
            const wall = await t.get(`/api/v1/cameras/${camera.id}/wall`, { as: bob });
            assert.strictEqual(wall.status, 200);
            assert.strictEqual(wall.json().camera.familiar_faces, undefined);
            assert.strictEqual(wall.json().camera.vision_library_id, undefined);
        });

        await check('marking "this is X" changes the event label and leaves the camera library alone', async () => {
            const r = await t.get(`/api/v1/events/${personEvent.id}`, { as: alice, method: 'PATCH', json: { person_name: 'Mom (visitor)' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().event.person_name, 'Mom (visitor)');
            assert.strictEqual(r.json().event.known, true);
            assert.strictEqual((await t.get(`/api/v1/events/${personEvent.id}`, { as: bob, method: 'PATCH', json: { person_name: 'x' } })).status, 404);
        });

        await check('a private share link returns the event once and a bad token is 404', async () => {
            const r = await t.get(`/api/v1/events/${personEvent.id}/share`, { as: alice, json: { purpose: 'link', days: 2 } });
            assert.strictEqual(r.status, 201, r.text);
            const token = r.json().token;
            assert.ok(token && r.json().url.includes(`/e/${token}`));
            assert.strictEqual(r.json().share.purpose, 'link');
            const shared = await t.get(`/api/v1/events/shared/${token}`);
            assert.strictEqual(shared.status, 200, shared.text);
            assert.strictEqual(shared.json().event.id, personEvent.id);
            assert.strictEqual((await t.get('/api/v1/events/shared/not-a-real-token-000000')).status, 404);
        });

        await check('the police export is a file with time and place', async () => {
            const r = await t.get(`/api/v1/events/${personEvent.id}/export`, { as: alice });
            assert.strictEqual(r.status, 200, r.text);
            assert.match(r.headers.get('content-disposition'), /^attachment; filename="cam-event-/);
            const file = r.json();
            assert.strictEqual(file.kind, 'cam.event.police-export');
            assert.strictEqual(file.event.time, personEvent.at);
            assert.strictEqual(file.event.place.place, '12 Oak Street');
            assert.strictEqual(file.event.clip.url, 'https://openvibe.media/clip1.mp4');
            assert.strictEqual(file.camera.name, 'Front door');
            const police = await t.get(`/api/v1/events/${personEvent.id}/police`, { as: alice, method: 'POST' });
            assert.strictEqual(police.status, 200, police.text);
            assert.strictEqual(police.json().purpose, 'police');
            assert.match(police.json().download_url, /\/api\/v1\/events\/cev_/);
        });

        await check('ADR-033 export and erasure cover the timeline and presence', async () => {
            const part = await t.ctx.accountData.exportPart(alice.subject);
            const files = part.files.map((f) => f.name);
            for (const f of ['events.json', 'event-shares.json', 'presence.json']) assert.ok(files.includes(f), f);
            const erased = await t.ctx.accountData.erase([alice.subject]);
            assert.ok(erased.erased.cam_events >= 1);
            assert.ok(erased.erased.cam_presence >= 1);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM cam_events WHERE owner=$1', [alice.subject])), 0);
        });

        await check('unpairing deletes the camera\'s Vision library', async () => {
            const c = (await t.get('/api/v1/cameras', { as: alice, json: { name: 'Back door' } })).json();
            const on = await t.get(`/api/v1/cameras/${c.id}/familiar-faces`, { as: alice, method: 'PUT', json: { enabled: true, region: 'US-CA' } });
            assert.strictEqual(on.status, 200, on.text);
            const lib = on.json().library.id;
            assert.ok(t.upstreams.visionLibrary(lib));
            const del = await t.get(`/api/v1/cameras/${c.id}`, { as: alice, method: 'DELETE' });
            assert.strictEqual(del.status, 204, del.text);
            assert.strictEqual(t.upstreams.visionLibrary(lib), undefined);
        });
    } finally {
        await t.close();
    }
    done();
})();
