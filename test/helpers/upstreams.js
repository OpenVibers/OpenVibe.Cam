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
    };
}

module.exports = { startUpstreams, JPEG, DEFAULT_STREAMS };
