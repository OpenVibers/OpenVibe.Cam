'use strict';

/**
 * Cam's data: paired cameras, revocable viewer grants, photos and stills.
 *
 * A camera is private. Its owner sees it; anybody else needs a grant that is not revoked and has not expired, and
 * the check runs on every read, so a revocation takes effect at once. A photo or a still is never bytes here: the
 * picture went to OpenVibe.Pics and this row keeps the Pics slug and links.
 */
const SOURCES = Object.freeze(['browser', 'phone', 'pi', 'ip']);
const STATUSES = Object.freeze(['paired', 'live', 'offline']);
const FILTERS = Object.freeze(['none', 'mono', 'warm', 'cool', 'fade', 'vivid', 'blur']);
const STILL_VISIBILITIES = Object.freeze(['unlisted', 'private']);
const PHOTO_VISIBILITIES = Object.freeze(['private', 'unlisted']);
const CAPTION_MAX = 280;
const NAME_MAX = 80;
const NOTES_MAX = 500;
const SLOT_RE = /^@?[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const BLOCKED_WORDS = Object.freeze(['nigger', 'faggot', 'retard', 'kys', 'rape', 'pedo', 'nazi']);

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const nOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const refusal = (status, code, message, field) => ({ ok: false, status, code, message, ...(field ? { field } : {}) });

function cleanLine(v, max) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function controlChars(v) {
    return /[\u0000-\u001f\u007f]/.test(String(v == null ? '' : v));
}

function blocked(text) {
    return BLOCKED_WORDS.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i').test(String(text)));
}

/** A caption is plain text: 0–280 characters, no control characters, the short blocked-word list. */
function caption(raw) {
    if (raw == null || raw === '') return { ok: true, value: null };
    if (controlChars(raw)) return refusal(400, 'cam.invalid', 'A caption is plain text: no control characters', 'caption');
    const value = cleanLine(raw, CAPTION_MAX + 1);
    if (value.length > CAPTION_MAX) return refusal(400, 'cam.invalid', `A caption is at most ${CAPTION_MAX} characters`, 'caption');
    if (blocked(value)) return refusal(400, 'cam.blocked_words', 'That wording is not allowed here', 'caption');
    return { ok: true, value: value || null };
}

function toSubject(raw) {
    const v = String(raw == null ? '' : raw).trim();
    return SUBJECT_RE.test(v) ? v : null;
}

function wireCamera(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        source: row.source,
        status: row.status,
        stream_id: nOrNull(row.stream_id),
        slot: row.slot == null ? null : row.slot,
        notes: row.notes == null ? null : row.notes,
        owner_username: row.owner_username == null ? null : row.owner_username,
        paired_at: iso(row.paired_at),
        last_seen_at: iso(row.last_seen_at),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        ...(row.active_grants != null ? { active_grants: Number(row.active_grants) || 0 } : {}),
    };
}

function wireGrant(row, { now = Date.now() } = {}) {
    if (!row) return null;
    const revoked = row.revoked_at != null;
    const expired = Date.parse(row.expires_at) <= now;
    return {
        id: row.id,
        camera_id: row.camera_id,
        viewer_subject: row.viewer_subject,
        viewer_username: row.viewer_username == null ? null : row.viewer_username,
        granted_at: iso(row.granted_at),
        expires_at: iso(row.expires_at),
        revoked_at: iso(row.revoked_at),
        active: !revoked && !expired,
    };
}

function wirePhoto(row, { owner = false } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        camera_id: row.camera_id == null ? null : row.camera_id,
        filter: row.filter || 'none',
        caption: row.caption == null ? null : row.caption,
        visibility: row.visibility,
        pics_slug: row.pics_slug,
        pics_url: row.pics_url,
        pics_direct: row.pics_direct,
        created_at: iso(row.created_at),
        ...(owner ? { subject: row.subject } : {}),
    };
}

function wireStill(row, { owner = false } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        stream_id: nOrNull(row.stream_id),
        slot: row.slot,
        caption: row.caption == null ? null : row.caption,
        visibility: row.visibility,
        pics_slug: row.pics_slug,
        pics_url: row.pics_url,
        pics_direct: row.pics_direct,
        created_at: iso(row.created_at),
        ...(owner ? { subject: row.subject } : {}),
    };
}

function createStore(s, { config }) {
    const db = s.db;
    const q = (t) => t || db;
    const clock = () => s.iso();
    const daysFromNow = (days) => new Date(s.now() + Number(days) * 86_400_000).toISOString();

    async function cameraById(id, t) {
        return await q(t).maybe('SELECT * FROM cam_cameras WHERE id = $1', [String(id || '')]);
    }

    async function camerasOf(owner) {
        const rows = await db.many(
            `SELECT c.*,
                    (SELECT COUNT(*)::int FROM cam_grants g
                      WHERE g.camera_id = c.id AND g.revoked_at IS NULL AND g.expires_at > $2::timestamptz) AS active_grants
               FROM cam_cameras c WHERE c.owner = $1 ORDER BY c.created_at DESC, c.id DESC`,
            [owner, clock()],
        );
        return rows.map(wireCamera);
    }

    async function createCamera({ owner, ownerUsername = null, name, source = 'phone', streamId = null, slot = null, notes = null }) {
        if (!SUBJECT_RE.test(String(owner || ''))) return refusal(400, 'cam.invalid', 'A camera belongs to a signed-in person', 'owner');
        const cleanName = cleanLine(name, NAME_MAX + 1);
        if (!cleanName) return refusal(400, 'cam.invalid', 'Give the camera a name', 'name');
        if (cleanName.length > NAME_MAX) return refusal(400, 'cam.invalid', `A name is at most ${NAME_MAX} characters`, 'name');
        if (controlChars(name)) return refusal(400, 'cam.invalid', 'A name is plain text: no control characters', 'name');
        if (!SOURCES.includes(source)) return refusal(400, 'cam.invalid', `source must be one of ${SOURCES.join(', ')}`, 'source');
        if (streamId != null && (!Number.isInteger(Number(streamId)) || Number(streamId) <= 0)) return refusal(400, 'cam.invalid', 'stream_id must be a positive whole number', 'stream_id');
        if (slot != null && !SLOT_RE.test(String(slot))) return refusal(400, 'cam.invalid', 'slot must be a Live slot id, slug or @username', 'slot');
        const cleanNotes = notes == null || notes === '' ? null : cleanLine(notes, NOTES_MAX + 1);
        if (cleanNotes && cleanNotes.length > NOTES_MAX) return refusal(400, 'cam.invalid', `Notes are at most ${NOTES_MAX} characters`, 'notes');
        if (cleanNotes && controlChars(notes)) return refusal(400, 'cam.invalid', 'Notes are plain text: no control characters', 'notes');

        const count = Number(await db.value('SELECT COUNT(*)::int AS n FROM cam_cameras WHERE owner = $1', [owner]));
        if (count >= config.cameras.maxPerOwner) return refusal(409, 'cam.camera_limit', `You can pair ${config.cameras.maxPerOwner} cameras; unpair one first.`);

        const id = s.newId('cam');
        try {
            const row = await db.maybe(
                `INSERT INTO cam_cameras (id, owner, owner_username, name, source, status, stream_id, slot, notes, paired_at, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'paired', $6, $7, $8, $9::timestamptz, $9::timestamptz, $9::timestamptz)
                 RETURNING *`,
                [id, owner, ownerUsername == null ? null : String(ownerUsername).slice(0, 64), cleanName, source, streamId == null ? null : Number(streamId), slot == null ? null : String(slot), cleanNotes, clock()],
            );
            return { ok: true, camera: wireCamera(row) };
        } catch (err) {
            if (err && err.code === '23505') return refusal(409, 'cam.camera_exists', 'That Live stream is already paired.');
            throw err;
        }
    }

    async function patchCamera(id, owner, body) {
        const row = await cameraById(id);
        if (!row || row.owner !== owner) return refusal(404, 'cam.not_found', 'No such camera.');
        const b = body && typeof body === 'object' ? body : {};
        const allowed = ['name', 'source', 'slot', 'notes', 'status'];
        const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
        if (unknown.length) return refusal(400, 'cam.invalid', `Unknown field: ${unknown[0]}`, unknown[0]);
        const sets = [];
        const args = [id];
        if (b.name !== undefined) {
            const name = cleanLine(b.name, NAME_MAX + 1);
            if (!name || name.length > NAME_MAX || controlChars(b.name)) return refusal(400, 'cam.invalid', `name must be 1 to ${NAME_MAX} characters`, 'name');
            args.push(name); sets.push(`name = $${args.length}`);
        }
        if (b.source !== undefined) {
            if (!SOURCES.includes(b.source)) return refusal(400, 'cam.invalid', `source must be one of ${SOURCES.join(', ')}`, 'source');
            args.push(b.source); sets.push(`source = $${args.length}`);
        }
        if (b.status !== undefined) {
            if (!STATUSES.includes(b.status)) return refusal(400, 'cam.invalid', `status must be one of ${STATUSES.join(', ')}`, 'status');
            args.push(b.status); sets.push(`status = $${args.length}`);
        }
        if (b.slot !== undefined) {
            if (b.slot != null && b.slot !== '' && !SLOT_RE.test(String(b.slot))) return refusal(400, 'cam.invalid', 'slot must be a Live slot id, slug or @username', 'slot');
            args.push(b.slot == null || b.slot === '' ? null : String(b.slot)); sets.push(`slot = $${args.length}`);
        }
        if (b.notes !== undefined) {
            const notes = b.notes == null || b.notes === '' ? null : cleanLine(b.notes, NOTES_MAX + 1);
            if (notes && (notes.length > NOTES_MAX || controlChars(b.notes))) return refusal(400, 'cam.invalid', `Notes are at most ${NOTES_MAX} characters`, 'notes');
            args.push(notes); sets.push(`notes = $${args.length}`);
        }
        if (!sets.length) return refusal(400, 'cam.invalid', 'Send a name, source, status, slot or notes', null);
        args.push(clock());
        const updated = await db.maybe(`UPDATE cam_cameras SET ${sets.join(', ')}, updated_at = $${args.length}::timestamptz WHERE id = $1 RETURNING *`, args);
        return { ok: true, camera: wireCamera(updated) };
    }

    async function removeCamera(id, owner) {
        const row = await cameraById(id);
        if (!row || row.owner !== owner) return refusal(404, 'cam.not_found', 'No such camera.');
        await db.exec('DELETE FROM cam_cameras WHERE id = $1', [row.id]);
        return { ok: true, id: row.id };
    }

    /** A new grant, or a longer one when this viewer already has an active grant. */
    async function grantCamera(cameraId, { owner, viewerSubject, viewerUsername = null, days = null }) {
        const camera = await cameraById(cameraId);
        if (!camera || camera.owner !== owner) return refusal(404, 'cam.not_found', 'No such camera.');
        const wanted = toSubject(viewerSubject);
        if (!wanted) return refusal(400, 'cam.invalid', 'viewer_subject must be a person\'s canonical subject (usr_…)', 'viewer_subject');
        if (wanted === owner) return refusal(400, 'cam.invalid', 'A camera cannot be granted to its owner.', 'viewer_subject');
        const n = days == null || days === '' ? config.cameras.grantDays : Number(days);
        if (!Number.isInteger(n) || n < 1 || n > config.cameras.grantMaxDays) return refusal(400, 'cam.invalid', `days must be a whole number from 1 to ${config.cameras.grantMaxDays}`, 'days');

        const activeCount = Number(await db.value(
            'SELECT COUNT(*)::int AS n FROM cam_grants WHERE camera_id = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz',
            [camera.id, clock()],
        ));
        const existing = await db.maybe(
            'SELECT * FROM cam_grants WHERE camera_id = $1 AND viewer_subject = $2 AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1',
            [camera.id, wanted],
        );
        if (!existing && activeCount >= config.cameras.grantsPerCamera) {
            return refusal(409, 'cam.grant_limit', `A camera can have ${config.cameras.grantsPerCamera} viewers at once.`);
        }
        const expiresAt = daysFromNow(n);
        const username = viewerUsername == null ? null : cleanLine(viewerUsername, 64) || null;
        const wasActive = Boolean(existing && Date.parse(existing.expires_at) > s.now());
        let row;
        try {
            row = existing
                ? await db.maybe('UPDATE cam_grants SET expires_at = $2::timestamptz, viewer_username = COALESCE($3, viewer_username) WHERE id = $1 RETURNING *', [existing.id, expiresAt, username])
                : await db.maybe(
                    `INSERT INTO cam_grants (id, camera_id, owner, viewer_subject, viewer_username, granted_at, expires_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $6::timestamptz) RETURNING *`,
                    [s.newId('cmg'), camera.id, owner, wanted, username, clock(), expiresAt],
                );
        } catch (err) {
            // Two tabs granting the same viewer at once: the partial unique index picks one; the caller sees the grant.
            if (err && err.code === '23505') {
                const found = await db.maybe('SELECT * FROM cam_grants WHERE camera_id = $1 AND viewer_subject = $2 AND revoked_at IS NULL', [camera.id, wanted]);
                if (found) return { ok: true, grant: wireGrant(found, { now: s.now() }), changed: false, days: n };
            }
            throw err;
        }
        return { ok: true, grant: wireGrant(row, { now: s.now() }), changed: !wasActive, days: n };
    }

    async function grantsOf(cameraId, owner) {
        const camera = await cameraById(cameraId);
        if (!camera || camera.owner !== owner) return refusal(404, 'cam.not_found', 'No such camera.');
        const rows = await db.many('SELECT * FROM cam_grants WHERE camera_id = $1 ORDER BY granted_at DESC, id DESC', [camera.id]);
        return { ok: true, grants: rows.map((r) => wireGrant(r, { now: s.now() })) };
    }

    async function revokeGrant(cameraId, grantId, { owner }) {
        const camera = await cameraById(cameraId);
        if (!camera || camera.owner !== owner) return refusal(404, 'cam.not_found', 'No such camera.');
        const row = await db.maybe('SELECT * FROM cam_grants WHERE id = $1 AND camera_id = $2', [String(grantId || ''), camera.id]);
        if (!row) return refusal(404, 'cam.grant_not_found', 'No such viewer grant.');
        if (row.revoked_at != null) return { ok: true, revoked: false, already: true, grant: wireGrant(row, { now: s.now() }) };
        const updated = await db.maybe('UPDATE cam_grants SET revoked_at = $2::timestamptz, revoked_by = $3 WHERE id = $1 RETURNING *', [row.id, clock(), owner]);
        return { ok: true, revoked: true, already: false, grant: wireGrant(updated, { now: s.now() }) };
    }

    async function activeGrant(cameraId, subject) {
        if (!SUBJECT_RE.test(String(subject || ''))) return null;
        return await db.maybe(
            'SELECT * FROM cam_grants WHERE camera_id = $1 AND viewer_subject = $2 AND revoked_at IS NULL AND expires_at > $3::timestamptz ORDER BY granted_at DESC LIMIT 1',
            [String(cameraId), subject, clock()],
        );
    }

    /** Owner or an active viewer; null means "not found" to the caller, never "forbidden". */
    async function accessTo(cameraId, subject) {
        const camera = await cameraById(cameraId);
        if (!camera) return null;
        if (camera.owner === subject) return { camera, owner: true, grant: null };
        const grant = await activeGrant(camera.id, subject);
        return grant ? { camera, owner: false, grant: wireGrant(grant, { now: s.now() }) } : null;
    }

    async function wall(cameraId, subject) {
        const access = await accessTo(cameraId, subject);
        if (!access) return null;
        const rows = await db.many(
            `SELECT * FROM cam_photos WHERE camera_id = $1 ${access.owner ? '' : "AND visibility = 'unlisted'"} ORDER BY created_at DESC, id DESC LIMIT 60`,
            [access.camera.id],
        );
        return { ...access, photos: rows.map((r) => wirePhoto(r, { owner: access.owner })) };
    }

    /** A photo row after its bytes have gone to Pics. A photo on a camera wall is unlisted; otherwise it is private. */
    async function createPhoto({ subject, cameraId = null, filter = 'none', caption: rawCaption = null, pics }) {
        if (!SUBJECT_RE.test(String(subject || ''))) return refusal(400, 'cam.invalid', 'A photo belongs to a signed-in person', 'subject');
        let camera = null;
        if (cameraId != null && cameraId !== '') {
            camera = await cameraById(cameraId);
            if (!camera || camera.owner !== subject) return refusal(404, 'cam.not_found', 'No such camera of yours.');
        }
        const cleanFilter = FILTERS.includes(filter) ? filter : 'none';
        const cap = caption(rawCaption);
        if (!cap.ok) return cap;
        if (!pics || !pics.slug || !pics.page) return refusal(400, 'cam.invalid', 'The picture was not stored', 'pics');
        const row = await db.maybe(
            `INSERT INTO cam_photos (id, subject, camera_id, filter, caption, visibility, pics_slug, pics_url, pics_direct, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz) RETURNING *`,
            [s.newId('cmp'), subject, camera ? camera.id : null, cleanFilter, cap.value, camera ? 'unlisted' : 'private', pics.slug, pics.page, pics.direct || pics.page, clock()],
        );
        return { ok: true, photo: wirePhoto(row, { owner: true }) };
    }

    async function photoById(id) {
        return wirePhoto(await db.maybe('SELECT * FROM cam_photos WHERE id = $1', [String(id || '')]), { owner: true });
    }

    async function photosOf(subject, { limit = 60 } = {}) {
        const rows = await db.many('SELECT * FROM cam_photos WHERE subject = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
            [subject, Math.min(200, Math.max(1, Number(limit) || 60))]);
        return rows.map((r) => wirePhoto(r, { owner: true }));
    }

    /** A still's bytes also went to Pics; a still is unlisted by default so the link in chat opens it. */
    async function createStill({ subject, streamId = null, slot, caption: rawCaption = null, visibility = 'unlisted', pics }) {
        if (!SUBJECT_RE.test(String(subject || ''))) return refusal(400, 'cam.invalid', 'A still belongs to a signed-in person', 'subject');
        if (!SLOT_RE.test(String(slot || ''))) return refusal(400, 'cam.invalid', 'slot must be a Live slot id, slug or @username', 'slot');
        if (streamId != null && (!Number.isInteger(Number(streamId)) || Number(streamId) <= 0)) return refusal(400, 'cam.invalid', 'stream_id must be a positive whole number', 'stream_id');
        if (!STILL_VISIBILITIES.includes(visibility)) return refusal(400, 'cam.invalid', `visibility must be one of ${STILL_VISIBILITIES.join(', ')}`, 'visibility');
        const cap = caption(rawCaption);
        if (!cap.ok) return cap;
        if (!pics || !pics.slug || !pics.page) return refusal(400, 'cam.invalid', 'The picture was not stored', 'pics');
        const row = await db.maybe(
            `INSERT INTO cam_stills (id, subject, stream_id, slot, caption, visibility, pics_slug, pics_url, pics_direct, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz) RETURNING *`,
            [s.newId('cms'), subject, streamId == null ? null : Number(streamId), String(slot), cap.value, visibility, pics.slug, pics.page, pics.direct || pics.page, clock()],
        );
        return { ok: true, still: wireStill(row, { owner: true }) };
    }

    async function stillById(id) {
        return wireStill(await db.maybe('SELECT * FROM cam_stills WHERE id = $1', [String(id || '')]), { owner: true });
    }

    async function stillsOf(subject, { limit = 60 } = {}) {
        const rows = await db.many('SELECT * FROM cam_stills WHERE subject = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
            [subject, Math.min(200, Math.max(1, Number(limit) || 60))]);
        return rows.map((r) => wireStill(r, { owner: true }));
    }

    async function countsFor(subject) {
        const row = await db.maybe(
            `SELECT
                (SELECT COUNT(*)::int FROM cam_cameras WHERE owner = $1) AS cameras,
                (SELECT COUNT(*)::int FROM cam_photos WHERE subject = $1) AS photos,
                (SELECT COUNT(*)::int FROM cam_stills WHERE subject = $1) AS stills`,
            [subject],
        );
        return { cameras: Number(row.cameras) || 0, photos: Number(row.photos) || 0, stills: Number(row.stills) || 0 };
    }

    return {
        wireCamera, wireGrant, wirePhoto, wireStill,
        cameraById, camerasOf, createCamera, patchCamera, removeCamera,
        grantCamera, grantsOf, revokeGrant, activeGrant, accessTo, wall,
        createPhoto, photoById, photosOf,
        createStill, stillById, stillsOf,
        countsFor,
        SOURCES, STATUSES, FILTERS, STILL_VISIBILITIES, PHOTO_VISIBILITIES, CAPTION_MAX, NAME_MAX, SLOT_RE, SUBJECT_RE, BLOCKED_WORDS,
    };
}

module.exports = {
    createStore, caption, toSubject, wireCamera, wireGrant, wirePhoto, wireStill,
    SOURCES, STATUSES, FILTERS, STILL_VISIBILITIES, PHOTO_VISIBILITIES, BLOCKED_WORDS, SLOT_RE, SUBJECT_RE,
};
