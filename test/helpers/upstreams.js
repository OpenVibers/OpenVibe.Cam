'use strict';

/**
 * In-process stand-ins for OpenVibe.Media, OpenVibe.Live and OpenVibe.Pics on one HTTP server. Boot points
 * OV_MEDIA_URL, OV_LIVE_URL and OV_PICS_URL at it.
 *
 *   GET  /api/streams/:id       a stream with its channel (ownership check)
 *   GET  /live/:sel/frame.jpg   a JPEG frame; state.frames[sel] = { status: 404 } makes it offline
 *   POST /api/v1/images         Pics upload; records the person's token and returns a slug and links
 *
 * A test changes state.frames[slot] or state.pics.status to exercise an offline slot, a busy frame or a Pics
 * refusal, and reads state.uploads / requestsFor() to see what Cam sent.
 */
const http = require('http');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const DEFAULT_STREAMS = {
    1234: { id: 1234, managed_stream_id: 77, managed_stream_slug: 'whip', is_live: true, username: 'alice', title: 'Alice live', channel: { username: 'alice' } },
    2222: { id: 2222, managed_stream_id: 88, managed_stream_slug: 'bob-cam', is_live: false, username: 'bob', title: 'Bob offline', channel: { username: 'bob' } },
};

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const json = (status, obj, headers = {}) => {
                    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                    res.end(JSON.stringify(obj));
                };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({
            server, url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

async function startUpstreams() {
    const state = {
        streams: JSON.parse(JSON.stringify(DEFAULT_STREAMS)),
        frames: {},
        pics: { status: 201 },
        uploads: [],
        requests: [],
        vision: { libraries: new Map(), match: null, calls: [], status: 200, seq: 0 },
    };

    const srv = await listen(async (req, raw, json, res) => {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        state.requests.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, bytes: raw.length });

        const stream = p.match(/^\/api\/streams\/(\d+)$/);
        if (stream) {
            const row = state.streams[stream[1]];
            if (!row) return json(404, { error: 'Stream not found' });
            return json(200, { stream: row });
        }

        const frame = p.match(/^\/live\/([^/]+)\/frame\.jpg$/);
        if (frame) {
            const sel = decodeURIComponent(frame[1]);
            const conf = state.frames[sel] || { status: 200 };
            if (conf.status === 404) {
                res.writeHead(404, { 'Content-Type': 'image/svg+xml' });
                return res.end('<svg xmlns="http://www.w3.org/2000/svg"><text>offline</text></svg>');
            }
            if (conf.status === 429) return json(429, { error: 'Too many requests' });
            if (conf.status === 500) return json(500, { error: 'Failed to grab frame' });
            const bytes = conf.bytes || JPEG;
            const type = conf.type || 'image/jpeg';
            res.writeHead(conf.status || 200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=5' });
            return res.end(bytes);
        }

        // ── Vision's familiar-face library (F1), as Cam's owner-token proxy sees it ──
        if (p.startsWith('/api/v1/faces/libraries')) {
            const auth = String(req.headers.authorization || '');
            state.vision.calls.push({ method: req.method, path: p, auth, body: raw.length ? (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return null; } })() : null });
            if (state.vision.status >= 400) return json(state.vision.status, { code: 'faces.test_refused', detail: 'Vision refused this test call' });
            let body = {};
            try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
            if (p === '/api/v1/faces/libraries' && req.method === 'POST') {
                const id = `flb_${String(++state.vision.seq).padStart(26, '0')}`;
                const library = {
                    id, camera_ids: body.camera_ids || [], region: body.region || 'unknown',
                    region_mode: ['US-IL', 'US-TX', 'US-WA', 'EU', 'GB', 'UK'].includes(String(body.region || '').toUpperCase()) || !body.region ? 'strict' : 'open',
                    threshold: body.threshold == null ? 0.363 : body.threshold,
                    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), people: [],
                };
                state.vision.libraries.set(id, library);
                return json(201, library);
            }
            const libraryPath = p.match(/^\/api\/v1\/faces\/libraries\/([^/]+)$/);
            if (libraryPath) {
                const library = state.vision.libraries.get(libraryPath[1]);
                if (!library) return json(404, { code: 'faces.not_found', detail: 'No such face library.' });
                if (req.method === 'DELETE') { state.vision.libraries.delete(library.id); return json(200, { deleted: true, id: library.id }); }
                if (req.method === 'PATCH') {
                    if (body.region !== undefined) {
                        library.region = body.region;
                        library.region_mode = ['US-IL', 'US-TX', 'US-WA', 'EU', 'GB', 'UK'].includes(String(body.region).toUpperCase()) || !body.region ? 'strict' : 'open';
                    }
                    if (body.threshold !== undefined) library.threshold = body.threshold;
                    return json(200, { ...library, people: library.people });
                }
                return json(200, { ...library, people: library.people });
            }
            const enroll = p.match(/^\/api\/v1\/faces\/libraries\/([^/]+)\/enroll$/);
            if (enroll && req.method === 'POST') {
                const library = state.vision.libraries.get(enroll[1]);
                if (!library) return json(404, { code: 'faces.not_found', detail: 'No such face library.' });
                const person = {
                    id: `flp_${String(++state.vision.seq).padStart(26, '0')}`, library_id: library.id, name: String(body.name || ''),
                    subject: body.subject || null, status: library.region_mode === 'strict' ? 'pending_consent' : 'active',
                    consent_basis: library.region_mode === 'strict' ? null : null, muted: false,
                    has_template: library.region_mode !== 'strict', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_matched_at: null,
                };
                library.people.push(person);
                return json(200, { person, consent_request: person.status === 'pending_consent' ? { token: 'req-token', url: 'https://openvibe.vision/people/privacy?face_request=req-token', expires_at: new Date(Date.now() + 86400000).toISOString(), sent: false, text_version: 'face-library-2026-10-28' } : null, enrolled: person.status === 'active' });
            }
            const match = p.match(/^\/api\/v1\/faces\/libraries\/([^/]+)\/match$/);
            if (match && req.method === 'POST') {
                const library = state.vision.libraries.get(match[1]);
                if (!library) return json(404, { code: 'faces.not_found', detail: 'No such face library.' });
                if (state.vision.match) return json(200, { library_id: library.id, ...state.vision.match });
                return json(200, { library_id: library.id, match: false, label: 'unknown person', name: null, person_id: null, muted: false, score: null, threshold: library.threshold });
            }
            const personMatch = p.match(/^\/api\/v1\/faces\/libraries\/([^/]+)\/people(?:\/([^/]+)(\/request)?)?$/);
            if (personMatch) {
                const library = state.vision.libraries.get(personMatch[1]);
                if (!library) return json(404, { code: 'faces.not_found', detail: 'No such face library.' });
                if (!personMatch[2]) return json(200, { library: { ...library, people: library.people }, people: library.people });
                const person = library.people.find((x) => x.id === personMatch[2]);
                if (!person) return json(404, { code: 'faces.not_found', detail: 'No such named face.' });
                if (personMatch[3]) return json(200, { token: 'req-token', url: 'https://openvibe.vision/people/privacy?face_request=req-token', expires_at: new Date(Date.now() + 86400000).toISOString(), sent: false, text_version: 'face-library-2026-10-28' });
                if (req.method === 'DELETE') { library.people = library.people.filter((x) => x.id !== person.id); return json(200, { deleted: true, id: person.id, name: person.name, templates: 1, crops: 1, requests: 0 }); }
                if (req.method === 'PATCH') { if (body.name !== undefined) person.name = body.name; if (body.muted !== undefined) person.muted = Boolean(body.muted); return json(200, person); }
                return json(200, person);
            }
            if (/^\/api\/v1\/faces\/libraries\/[^/]+\/consent-check$/.test(p) && req.method === 'POST') return json(200, { checked: 0, activated: [] });
            return json(404, { code: 'faces.not_found', detail: 'No such face route.' });
        }

        if (p === '/api/v1/images' && req.method === 'POST') {
            const status = state.pics.status || 201;
            const auth = String(req.headers.authorization || '');
            if (status === 401) return json(401, { code: 'token.required', detail: 'Sign in at openvibe.pics.' });
            if (status === 413) return json(413, { code: 'pics.too_large', detail: 'A picture can be up to 20 MB.' });
            if (status === 415) return json(415, { code: 'pics.not_an_image', detail: 'Send the picture as the body.' });
            if (!auth.startsWith('Bearer ')) return json(401, { code: 'token.required', detail: 'a person\'s token is required' });
            const slug = `pic${state.uploads.length + 1}abcd`.slice(0, 8);
            state.uploads.push({
                auth, contentType: String(req.headers['content-type'] || ''), title: req.headers['x-title'] || null,
                filename: req.headers['x-filename'] || null, bytes: raw.length, slug,
            });
            return json(201, {
                id: `pic_${slug}`, slug, mime_type: 'image/jpeg', ext: 'jpg', width: 640, height: 360, bytes: raw.length,
                links: { page: `https://openvibe.pics/i/${slug}`, direct: `https://openvibe.pics/i/${slug}.jpg`, thumb: `https://openvibe.pics/i/${slug}/thumb.webp` },
            }, { 'Content-Type': 'application/json' });
        }

        return json(404, { error: 'not found' });
    });

    // The page link is relative in this fixture; Cam keeps it as Pics returned it.
    return {
        url: srv.url,
        state,
        close: srv.close,
        requestsFor(path) { return state.requests.filter((r) => r.path === path); },
        lastFor(path) { return state.requests.filter((r) => r.path === path).pop() || null; },
        setFrame(slot, conf) { state.frames[slot] = conf; },
        setPics(status) { state.pics.status = status; },
        uploads() { return state.uploads; },
        setVisionMatch(match) { state.vision.match = match; },
        setVisionStatus(status) { state.vision.status = status; },
        visionCalls() { return state.vision.calls; },
        visionLibrary(id) { return state.vision.libraries.get(id); },
    };
}

module.exports = { startUpstreams, JPEG, DEFAULT_STREAMS };
