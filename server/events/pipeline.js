'use strict';
/**
 * F1's event pipeline: a motion/detection report becomes one timeline event, and only a person event with a face
 * crop asks Vision to match inside that camera's own library.
 *
 *   detect (the camera) → kind and a 10 s-before / 20 s-after clip and still → (person) face crop → Vision
 *   library match → event → Notification (held while the name is muted or quiet hours are on) → timeline
 *
 * Detection without identity never needs a face: package, vehicle, animal, loitering and door events are stored
 * as they arrive. A Vision refusal or outage is not an error the camera has to retry: the event is kept as an
 * unknown person and the metadata says the match did not run.
 */
const { refusal } = require('../cameras');

const KIND_LABEL = Object.freeze({
    person: 'person', package: 'package', vehicle: 'vehicle', animal: 'animal', loiter: 'someone lingering', door: 'door',
});

function parseQuietTime(v) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minutesInZone(atMs, tz) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false })
            .formatToParts(new Date(atMs));
        const h = Number(parts.find((p) => p.type === 'hour').value);
        const m = Number(parts.find((p) => p.type === 'minute').value);
        return (h % 24) * 60 + m;
    } catch {
        return null;
    }
}

/** The camera's own quiet window; a malformed one never holds an alert. */
function inQuietHours(quiet, atMs) {
    if (!quiet || quiet.enabled !== true) return false;
    const start = parseQuietTime(quiet.start), end = parseQuietTime(quiet.end);
    if (start == null || end == null || start === end) return false;
    const mins = minutesInZone(atMs, quiet.tz);
    if (mins == null) return false;
    return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

function titleFor(kind, camera, { personName = null, away = false, lingerSeconds = null } = {}) {
    const place = String(camera.name || 'camera').replace(/\s+/g, ' ').trim();
    if (kind === 'person') return personName ? `${personName} is at the ${place}` : `Unknown person at the ${place}`;
    if (kind === 'package') return 'Package left';
    if (kind === 'vehicle') return /driveway|garage|parking|car park/i.test(place) ? `Car in the ${place.toLowerCase()}` : `Car at the ${place}`;
    if (kind === 'animal') return `Animal at the ${place}`;
    if (kind === 'loiter') {
        const n = Math.max(1, Math.round((Number(lingerSeconds) || 120) / 60));
        return `Someone lingered ${n} min`;
    }
    if (kind === 'door') return away ? "The door opened while you're away" : 'The door opened';
    return `Movement at the ${place}`;
}

function createEventPipeline({ cameras, upstreams, config, now = () => Date.now() }) {
    const clock = () => new Date(now()).toISOString();

    async function ingest({ owner, token, camera, body = {} }) {
        const kind = String(body.kind || '').trim();
        if (!cameras.EVENT_KINDS.includes(kind)) return refusal(400, 'cam.invalid', `kind must be one of ${cameras.EVENT_KINDS.join(', ')}`, 'kind');

        let atMs = now();
        if (body.at != null && body.at !== '') {
            atMs = Date.parse(String(body.at));
            if (!Number.isFinite(atMs)) return refusal(400, 'cam.invalid', 'at must be an ISO date-time', 'at');
            if (atMs > now() + 5 * 60_000 || atMs < now() - 7 * 86_400_000) return refusal(400, 'cam.invalid', 'at is outside the last 7 days', 'at');
        }
        const at = new Date(atMs).toISOString();

        let personId = null, personName = null, known = false, muted = false, matchNote = null;
        const faceImage = body.face_image != null ? String(body.face_image) : body.face_image_url != null ? String(body.face_image_url) : null;
        if (kind === 'person' && faceImage && camera.familiar_faces && camera.vision_library_id) {
            if (body.face_image != null && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(faceImage)) {
                return refusal(400, 'cam.invalid', 'face_image must be a JPEG, PNG or WebP data URL', 'face_image');
            }
            if (body.face_image_url != null && !/^https?:\/\//.test(faceImage)) return refusal(400, 'cam.invalid', 'face_image_url must be an http(s) URL', 'face_image_url');
            try {
                const got = await upstreams.vision.match({ token, libraryId: camera.vision_library_id, image: faceImage });
                if (got && got.match === true) {
                    personId = got.person_id; personName = got.name; known = true; muted = Boolean(got.muted);
                }
            } catch (err) {
                // The event still exists: an unknown person is honest, and the camera must not lose the clip.
                matchNote = err && err.code ? String(err.code).slice(0, 80) : 'match_unavailable';
            }
        }
        if (known === false && body.person_name != null && body.person_name !== '') {
            // The owner can correct the label later through PATCH; an event may also arrive already named by the
            // owner's own device. No name from another library is ever used here.
            personName = String(body.person_name).replace(/\s+/g, ' ').trim().slice(0, 80) || null;
            personId = body.person_id == null ? null : String(body.person_id).slice(0, 40);
            known = Boolean(personName);
        }

        const presence = await cameras.presenceOf(owner);
        const away = presence.state === 'away';
        const priority = away && ((kind === 'person' && !known) || kind === 'door') ? 'high' : 'normal';
        const title = titleFor(kind, camera, { personName, away, lingerSeconds: body.linger_seconds });
        const quiet = inQuietHours(camera.quiet_hours, atMs);
        const notifyAllowed = body.notify !== false;

        let notification = { sent: false, skipped: 'not_requested' };
        if (notifyAllowed && muted) notification = { sent: false, skipped: 'muted' };
        else if (notifyAllowed && quiet) notification = { sent: false, skipped: 'quiet_hours' };
        else if (notifyAllowed) {
            notification = await upstreams.pushNotification({
                subject: owner, title, message: title, priority,
                url: `${String(config.baseUrl).replace(/\/+$/, '')}/my/cameras/${camera.id}`,
                type: 'CAM_EVENT', category: 'cam',
            });
        }

        const metadata = {};
        if (body.linger_seconds != null) metadata.linger_seconds = Math.max(1, Math.min(86_400, Number(body.linger_seconds) || 0));
        if (body.motion === true) metadata.motion = true;
        if (matchNote) metadata.face_match = matchNote;
        if (body.metadata && typeof body.metadata === 'object') Object.assign(metadata, body.metadata);

        const created = await cameras.createEvent({
            cameraId: camera.id, owner, kind, at, title,
            detail: body.detail == null ? null : String(body.detail),
            personId, personName, known, muted, away, priority,
            stillUrl: body.still_url == null ? null : String(body.still_url),
            clipUrl: body.clip_url == null ? null : String(body.clip_url),
            clipBefore: body.clip_before_seconds == null ? config.timeline.clipBeforeSeconds : Number(body.clip_before_seconds),
            clipAfter: body.clip_after_seconds == null ? config.timeline.clipAfterSeconds : Number(body.clip_after_seconds),
            place: body.place == null ? null : String(body.place),
            lat: body.lat == null ? null : Number(body.lat),
            lng: body.lng == null ? null : Number(body.lng),
            metadata, notified: notification.sent === true,
        });
        if (!created.ok) return created;
        return { ok: true, event: created.event, notification };
    }

    return { ingest, titleFor, inQuietHours };
}

module.exports = { createEventPipeline, titleFor, inQuietHours, KIND_LABEL };
