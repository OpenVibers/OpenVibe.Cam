'use strict';

/**
 * Pairing and sharing, shared by the JSON API and the plain forms so the two cannot drift.
 *
 *   pairCamera({ cameras, upstreams, principal, body })
 *       Validates a camera and, when a Live stream id is given, reads it from OpenVibe.Live and refuses one on
 *       somebody else's channel. The slot defaults to the stream's managed slot slug, its managed id, or @username.
 *
 *   resolveViewer({ upstreams, body })
 *       A viewer is a canonical subject, or an @username resolved through Network (identity.subject.resolve) with
 *       Cam's service token. A grant is never made against a name Cam did not resolve.
 *
 * A refusal is { ok: false, status, code, message } and the caller turns it into problem+json or a page message.
 */
const { toSubject } = require('./store');

const refusal = (status, code, message) => ({ ok: false, status, code, message });

async function pairCamera({ cameras, upstreams, principal, body }) {
    const b = body && typeof body === 'object' ? body : {};
    const streamId = b.stream_id == null || b.stream_id === '' ? null : Number(b.stream_id);
    let slot = b.slot == null || b.slot === '' ? null : String(b.slot);
    let ownerUsername = principal.username || null;

    if (streamId != null) {
        if (!Number.isInteger(streamId) || streamId <= 0) return refusal(400, 'cam.invalid', 'stream_id must be a positive whole number');
        let stream;
        try { stream = await upstreams.liveStream(streamId); } catch (err) {
            return { ok: false, status: err.status || 502, code: err.code || 'cam.live.unavailable', message: err.message || 'OpenVibe.Live did not answer' };
        }
        if (!stream) return refusal(404, 'cam.stream_not_found', 'No such live stream.');
        const channelName = String((stream.channel && stream.channel.username) || stream.username || '');
        if (!principal.username || channelName.toLowerCase() !== String(principal.username).toLowerCase()) {
            return refusal(403, 'cam.not_your_stream', 'That Live stream is not on your channel.');
        }
        ownerUsername = channelName || ownerUsername;
        if (!slot) slot = stream.managed_stream_slug || (stream.managed_stream_id != null ? String(stream.managed_stream_id) : `@${ownerUsername}`);
    }

    return await cameras.createCamera({
        owner: principal.subject, ownerUsername, name: b.name, source: b.source || 'phone',
        streamId, slot, notes: b.notes,
    });
}

async function resolveViewer({ upstreams, body }) {
    const b = body && typeof body === 'object' ? body : {};
    let subject = b.viewer_subject == null || b.viewer_subject === '' ? null : toSubject(b.viewer_subject);
    let username = b.viewer_username == null || b.viewer_username === '' ? null : String(b.viewer_username).trim().replace(/^@/, '');
    if (subject) return { ok: true, subject, username };
    if (!username) return refusal(400, 'cam.invalid', 'viewer_username or viewer_subject is required');
    const got = await upstreams.resolveUsername(username);
    if (!got.ok) {
        if (got.code === 'invalid') return refusal(400, 'cam.invalid', 'viewer_username is not a Network username');
        if (got.code === 'not_found') return refusal(404, 'cam.viewer_not_found', 'Nobody holds that OpenVibe username.');
        return refusal(503, 'cam.identity_unavailable', 'OpenVibe.Network could not resolve that username just now; send viewer_subject instead.');
    }
    return { ok: true, subject: got.subject, username: got.username || username };
}

module.exports = { pairCamera, resolveViewer, refusal };
