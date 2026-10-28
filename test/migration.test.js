'use strict';
/**
 * The expand migration applies in one pass and creates exactly Cam's tables plus the SDK's account receipts and
 * telemetry. No Cam table has a column for picture bytes; a picture is a Pics slug and two links.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('0001_initial.sql applies and creates the Cam tables', async () => {
            const names = (await t.ctx.s.db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).map((r) => r.name);
            for (const table of ['cam_cameras', 'cam_grants', 'cam_photos', 'cam_stills', 'account_data_events', 'telemetry_samples']) {
                assert.ok(names.includes(table), `missing ${table}`);
            }
        });

        await check('no Cam table has a picture, blob or byte column', async () => {
            const cols = (await t.ctx.s.db.many("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name LIKE 'cam_%'")).map((r) => `${r.table_name}.${r.column_name}`);
            assert.ok(!cols.some((c) => /(^|\.)(image|photo|blob|bytes|data)$/i.test(c)), cols.join(','));
            for (const table of ['cam_photos', 'cam_stills']) {
                const names = cols.filter((c) => c.startsWith(`${table}.`));
                assert.ok(names.some((c) => c.endsWith('.pics_slug')), `${table} keeps a Pics slug`);
                assert.ok(names.some((c) => c.endsWith('.pics_url')), `${table} keeps a Pics link`);
            }
        });

        await check('a camera refuses a bad id, source, status or slot, and a duplicate stream', async () => {
            const db = t.ctx.s.db;
            const at = new Date().toISOString();
            const owner = ids.newId('user');
            const bad = (fields) => db.exec(`INSERT INTO cam_cameras (id, owner, name, source, status, slot, paired_at, created_at, updated_at)
                VALUES ($1, $2, 'A camera', $3, $4, $5, $6, $6, $6)`, [fields.id || `cam_${ids.ulid()}`, owner, fields.source || 'phone', fields.status || 'paired', fields.slot || null, at]);
            await assert.rejects(bad({ id: 'bad' }), /cam_cameras_id/);
            await assert.rejects(bad({ source: 'webcam' }), /cam_cameras_source/);
            await assert.rejects(bad({ status: 'on' }), /cam_cameras_status/);
            await assert.rejects(bad({ slot: 'not a slot!' }), /cam_cameras_slot/);
            await db.exec("INSERT INTO cam_cameras (id, owner, name, stream_id, paired_at, created_at, updated_at) VALUES ($1, $2, 'Once', 42, $3, $3, $3)", [`cam_${ids.ulid()}`, owner, at]);
            await assert.rejects(db.exec("INSERT INTO cam_cameras (id, owner, name, stream_id, paired_at, created_at, updated_at) VALUES ($1, $2, 'Twice', 42, $3, $3, $3)", [`cam_${ids.ulid()}`, owner, at]), /duplicate key|unique/i);
        });

        await check('one active grant per camera and viewer; a revoked one may be followed by a new one', async () => {
            const db = t.ctx.s.db;
            const at = new Date().toISOString();
            const owner = ids.newId('user');
            const viewer = ids.newId('user');
            const cameraId = `cam_${ids.ulid()}`;
            await db.exec("INSERT INTO cam_cameras (id, owner, name, paired_at, created_at, updated_at) VALUES ($1, $2, 'Door', $3, $3, $3)", [cameraId, owner, at]);
            const grant = (id, revoke = null) => db.exec(`INSERT INTO cam_grants (id, camera_id, owner, viewer_subject, granted_at, expires_at, revoked_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $5)`, [id, cameraId, owner, viewer, at, new Date(Date.now() + 86400000).toISOString(), revoke]);
            await grant(`cmg_${ids.ulid()}`);
            await assert.rejects(grant(`cmg_${ids.ulid()}`), /duplicate key|unique/i);
            const revoked = `cmg_${ids.ulid()}`;
            await db.exec('UPDATE cam_grants SET revoked_at = $2 WHERE camera_id = $1', [cameraId, at]);
            await grant(revoked, at);
        });

        await check('an unknown source, filter or still visibility is refused by the tables', async () => {
            const db = t.ctx.s.db;
            const at = new Date().toISOString();
            const subject = ids.newId('user');
            await assert.rejects(db.exec(`INSERT INTO cam_photos (id, subject, filter, visibility, pics_slug, pics_url, pics_direct, created_at)
                VALUES ($1, $2, 'sepia', 'private', 'abc12345', 'https://openvibe.pics/i/abc12345', 'https://openvibe.pics/i/abc12345.jpg', $3)`, [`cmp_${ids.ulid()}`, subject, at]), /cam_photos_filter/);
            await assert.rejects(db.exec(`INSERT INTO cam_stills (id, subject, slot, visibility, pics_slug, pics_url, pics_direct, created_at)
                VALUES ($1, $2, 'whip', 'public', 'abc12345', 'https://openvibe.pics/i/abc12345', 'https://openvibe.pics/i/abc12345.jpg', $3)`, [`cms_${ids.ulid()}`, subject, at]), /cam_stills_visibility/);
        });
    } finally {
        await t.close();
    }
    done();
})();
