'use strict';

/**
 * The existing APIs Cam uses. No picture bytes are stored here and no service grant is needed to read a frame:
 *
 *   OpenVibe.Media  GET  /live/:sel/frame.jpg?w=640   the public, CORS-open near-realtime JPEG of a live slot
 *   OpenVibe.Live   GET  /api/streams/:id             the public stream row and its channel (to check ownership)
 *   OpenVibe.Pics   POST /api/v1/images               with the signed-in person's own Network token as the body
 *   OpenVibe.Network GET /internal/identity/resolve   with Cam's service token (identity.subject.resolve) only when
 *                                                     the owner shares a camera with @username
 *
 * A 404 from Live means no such stream. Media answers an offline card (SVG) with a 404 for a slot that is not live:
 * that is never uploaded to Pics. A failed call is not cached and no token or body is logged.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;

class UpstreamError extends Error {
    constructor(code, detail, { status = 502, cause = null } = {}) { super(detail); this.code = code; this.status = status; this.cause = cause; }
}

function createUpstreams({ config, fetchImpl = globalThis.fetch, log = console }) {
    const { media, live, pics, timeoutMs } = config.upstreams;
    const base = (u) => String(u).replace(/\/+$/, '');
    const ua = () => `OpenVibe.Cam/0.1 (+${config.baseUrl})`;

    async function call(url, { method = 'GET', headers = {}, body = null, timeout = timeoutMs, redirect = 'follow' } = {}) {
        try {
            return await fetchImpl(url, {
                method, redirect, headers: { Accept: 'application/json', 'User-Agent': ua(), ...headers }, body,
                signal: AbortSignal.timeout(timeout),
            });
        } catch (err) {
            throw new UpstreamError('cam.upstream.unreachable', 'the upstream service did not answer', { cause: err });
        }
    }

    /** The public Live stream row, or null when it does not exist. */
    async function liveStream(id) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0) throw new UpstreamError('cam.live.invalid', 'stream_id must be a positive whole number', { status: 400 });
        const res = await call(`${base(live)}/api/streams/${n}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new UpstreamError('cam.live.unavailable', `OpenVibe.Live answered ${res.status}`);
        const data = await res.json().catch(() => null);
        if (!data || !data.stream) throw new UpstreamError('cam.live.unavailable', 'OpenVibe.Live answered no stream');
        return data.stream;
    }

    /** Media's live frame. Only image/jpeg is returned; an offline card or an HTML error is never a picture. */
    async function liveFrame({ slot, w, maxBytes }) {
        const sel = String(slot || '');
        const q = new URLSearchParams();
        if (w != null) q.set('w', String(w));
        const url = `${base(media)}/live/${encodeURIComponent(sel)}/frame.jpg${q.toString() ? `?${q.toString()}` : ''}`;
        let res;
        try {
            res = await call(url, { headers: { Accept: 'image/jpeg' } });
        } catch (err) {
            throw new UpstreamError('cam.frame_unavailable', 'OpenVibe.Media did not answer', { cause: err });
        }
        if (res.status === 404 || res.status === 410) return { ok: false, code: 'offline', status: res.status };
        if (res.status === 429) return { ok: false, code: 'busy', status: 429 };
        if (!res.ok) return { ok: false, code: 'status', status: res.status };
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (type !== 'image/jpeg') return { ok: false, code: 'not_jpeg', status: res.status, type };
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) return { ok: false, code: 'empty', status: res.status };
        if (buf.length > maxBytes) return { ok: false, code: 'too_large', status: res.status, bytes: buf.length };
        return { ok: true, bytes: buf, contentType: 'image/jpeg', bytes_length: buf.length };
    }

    /**
     * Upload a picture to OpenVibe.Pics as the person. `token` is the person's Network token from their Cam session;
     * it is sent only here and is never stored. Pics re-encodes the picture and strips its metadata.
     */
    async function picsUpload({ token, bytes, contentType, title = null, filename = null }) {
        if (!token) throw new UpstreamError('cam.pics.refused', 'a person\'s Network token is needed to save a picture', { status: 401 });
        const headers = { 'Content-Type': String(contentType || 'image/jpeg'), Accept: 'application/json', Authorization: `Bearer ${token}` };
        if (title) headers['X-Title'] = encodeURIComponent(String(title).slice(0, 200));
        if (filename) headers['X-Filename'] = encodeURIComponent(String(filename).slice(0, 200));
        let res;
        try {
            res = await call(`${base(pics)}/api/v1/images`, { method: 'POST', headers, body: bytes, timeout: Math.max(timeoutMs, 15_000) });
        } catch (err) {
            throw new UpstreamError('cam.pics.unavailable', 'OpenVibe.Pics did not answer', { cause: err });
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.slug) {
            const code = res.status === 401 || res.status === 403 ? 'cam.pics.refused'
                : res.status === 413 ? 'cam.pics.too_large'
                    : res.status === 415 ? 'cam.pics.not_an_image' : 'cam.pics.unavailable';
            throw new UpstreamError(code, (data && (data.detail || data.code)) ? String(data.detail || data.code).slice(0, 200) : `OpenVibe.Pics answered ${res.status}`, { status: res.status >= 400 && res.status < 500 ? res.status : 502 });
        }
        const links = data.links && typeof data.links === 'object' ? data.links : {};
        return {
            slug: String(data.slug),
            page: String(links.page || `${base(pics)}/i/${data.slug}`),
            direct: String(links.direct || `${base(pics)}/i/${data.slug}.${data.ext || 'jpg'}`),
            thumb: links.thumb ? String(links.thumb) : null,
            mime_type: data.mime_type || contentType,
            width: Number(data.width) || null,
            height: Number(data.height) || null,
        };
    }

    const tokens = config.oauth.clientSecret
        ? createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.network', scope: 'identity.subject.resolve', fetch: fetchImpl,
        })
        : null;

    /** Resolve @username to a canonical subject with Cam's service token. Disabled without the OAuth client secret. */
    async function resolveUsername(username) {
        const name = String(username || '').trim().replace(/^@/, '');
        if (!USERNAME_RE.test(name)) return { ok: false, code: 'invalid' };
        if (!tokens) return { ok: false, code: 'unavailable' };
        let token;
        try { token = await tokens.getToken(); } catch (err) {
            log.warn(`[OpenVibe.Cam] service token for identity.subject.resolve failed: ${(err && err.message) || err}`);
            return { ok: false, code: 'unavailable' };
        }
        let res;
        try {
            res = await call(`${config.networkInternalUrl}/internal/identity/resolve?username=${encodeURIComponent(name)}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: timeoutMs,
            });
        } catch {
            return { ok: false, code: 'unavailable' };
        }
        if (res.status === 404) return { ok: false, code: 'not_found' };
        if (res.status === 401 || res.status === 403) return { ok: false, code: 'refused' };
        if (!res.ok) return { ok: false, code: 'unavailable' };
        const data = await res.json().catch(() => null);
        const subject = data && data.subject && data.subject.type === 'user' ? String(data.subject.id || '') : '';
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject) || data.banned || data.deleted) return { ok: false, code: 'not_found' };
        return { ok: true, subject, username: data.username || name, display_name: data.display_name || data.username || name };
    }

    return { liveStream, liveFrame, picsUpload, resolveUsername, UpstreamError, base };
}

module.exports = { createUpstreams, UpstreamError, USERNAME_RE };
