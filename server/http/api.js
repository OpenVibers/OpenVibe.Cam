'use strict';

/**
 * /api/v1 — OpenVibe.Cam's JSON API.
 *
 *   POST   /photos                          a person: raw image bytes → OpenVibe.Pics, recorded here
 *   GET    /photos                          your photos
 *   GET    /photos/:id                      one of your photos
 *   GET    /cameras                         your paired cameras
 *   POST   /cameras                         pair one (a Live stream id is checked against Live)
 *   GET    /cameras/:id                     one of your cameras
 *   PATCH  /cameras/:id                     name, source, status, slot, notes
 *   DELETE /cameras/:id                     unpair it
 *   GET    /cameras/:id/wall                owner or an active viewer
 *   GET    /cameras/:id/grants              owner
 *   POST   /cameras/:id/grants              owner: @username or subject, and days
 *   DELETE /cameras/:id/grants/:grantId     owner: revoke at once
 *   POST   /stills                          the Live cam button: fetch Media's frame, save to Pics
 *   GET    /stills                          your stills
 *   GET    /stills/:id                      one still (unlisted: the link; private: its owner)
 *
 * Errors are application/problem+json with a `code`. A person is the cam_at session cookie or a Network user
 * token as a Bearer; a session write must come from openvibe.cam itself (403 cam.cross_site). No route needs an app
 * or service token: the still is saved to the viewer's own Pics with the viewer's own token.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { pairCamera, resolveViewer } = require('../cameras');
const { frameUrl } = require('../views');

function createApi(ctx) {
    const { config, s, principal, cameras, upstreams } = ctx;
    const r = asyncRouter();

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // Per-actor limits, on top of the per-address limit in server/app.js: a signed-in person gets the minute and
    // hour budget from config, and an app or anonymous caller is left to the address limiter. A second process
    // has its own counters; VALKEY_URL would make them shared (the readiness check says so).
    const buckets = new Map();
    function windowCount(key, windowMs, limit) {
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now - b.start >= windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
        b.n += 1;
        return b.n <= limit;
    }
    r.use((req, res, next) => {
        if (req.principal && req.principal.kind === 'user' && req.principal.subject) {
            const who = `user:${req.principal.subject}`;
            const okMinute = windowCount(`${who}:m`, 60_000, config.limits.minute);
            const okHour = windowCount(`${who}:h`, 60 * 60_000, config.limits.hour);
            if (!okMinute || !okHour) return problem(res, 429, 'cam.rate_limited', 'too many requests from this account; retry shortly');
            if (buckets.size > 20_000) {
                for (const [k, b] of buckets) if (Date.now() - b.start > 2 * 60 * 60_000) buckets.delete(k);
            }
        }
        return next();
    });

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const invalid = (res, detail) => problem(res, 400, 'cam.invalid', detail);

    function person(req, res) {
        const p = req.principal;
        if (p.kind === 'anonymous') { problem(res, 401, 'cam.sign_in_required', 'Sign in at openvibe.cam, or send a person\'s Network token as a Bearer.'); return null; }
        if (p.kind !== 'user') { problem(res, 403, 'cam.person_required', 'A camera and a picture are a person\'s; an app or service token cannot act here.'); return null; }
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) {
            problem(res, 403, 'cam.cross_site', 'A signed-in request that changes something must come from openvibe.cam itself.');
            return null;
        }
        return p;
    }
    const requirePerson = (req, res, next) => (person(req, res) ? next() : undefined);

    function upstreamProblem(res, err) {
        const status = err && Number.isFinite(Number(err.status)) ? Number(err.status) : 502;
        const safe = status >= 400 && status < 600 ? status : 502;
        return problem(res, safe, (err && err.code) || 'cam.upstream', (err && err.message) || 'an upstream service did not answer');
    }

    const asInt = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
    const decoded = (req, name, max) => { try { return decodeURIComponent(String(req.get(name) || '')).slice(0, max); } catch { return null; } };

    r.get('/ping', (_req, res) => res.json({ ok: true, service: config.service }));

    // A JSON body everywhere except the photo upload, whose body is the picture itself.
    const jsonBody = express.json({ limit: '64kb' });
    r.use((req, res, next) => ((req.method === 'POST' && req.path === '/photos') ? next() : jsonBody(req, res, next)));

    // ── Cameras ─────────────────────────────────────────────
    r.get('/cameras', requirePerson, async (req, res) => {
        const list = await cameras.camerasOf(req.principal.subject);
        return res.json({ count: list.length, cameras: list });
    });

    r.post('/cameras', requirePerson, async (req, res) => {
        const out = await pairCamera({ cameras, upstreams, principal: req.principal, body: req.body || {} });
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        res.set('Location', `/api/v1/cameras/${out.camera.id}`);
        return res.status(201).json({ ...out.camera, frame_url: frameUrl(config, out.camera) });
    });

    async function ownCamera(req, res) {
        const row = await cameras.cameraById(String(req.params.id || ''));
        if (!row || row.owner !== req.principal.subject) {
            problem(res, 404, 'cam.not_found', 'No such camera.');
            return null;
        }
        return row;
    }

    r.get('/cameras/:id', requirePerson, async (req, res) => {
        const row = await ownCamera(req, res);
        if (!row) return undefined;
        const camera = cameras.wireCamera(row);
        return res.json({ ...camera, frame_url: frameUrl(config, camera) });
    });

    r.patch('/cameras/:id', requirePerson, async (req, res) => {
        const row = await ownCamera(req, res);
        if (!row) return undefined;
        const out = await cameras.patchCamera(row.id, req.principal.subject, req.body || {});
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        return res.json({ ...out.camera, frame_url: frameUrl(config, out.camera) });
    });

    r.delete('/cameras/:id', requirePerson, async (req, res) => {
        const row = await ownCamera(req, res);
        if (!row) return undefined;
        const out = await cameras.removeCamera(row.id, req.principal.subject);
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        return res.status(204).end();
    });

    r.get('/cameras/:id/wall', requirePerson, async (req, res) => {
        const wall = await cameras.wall(String(req.params.id || ''), req.principal.subject);
        if (!wall) return problem(res, 404, 'cam.not_found', 'No such camera, or you have no grant for it.');
        const camera = { ...cameras.wireCamera(wall.camera), ...(wall.owner ? {} : { notes: undefined }) };
        if (!wall.owner) delete camera.notes;
        return res.json({
            camera,
            owner: wall.owner,
            grant: wall.grant,
            frame_url: frameUrl(config, camera),
            photos: wall.photos,
        });
    });

    // ── Viewer grants ───────────────────────────────────────
    r.get('/cameras/:id/grants', requirePerson, async (req, res) => {
        const out = await cameras.grantsOf(String(req.params.id || ''), req.principal.subject);
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        return res.json({ count: out.grants.length, grants: out.grants });
    });

    r.post('/cameras/:id/grants', requirePerson, async (req, res) => {
        const camera = await ownCamera(req, res);
        if (!camera) return undefined;
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const viewer = await resolveViewer({ upstreams, body: b });
        if (!viewer.ok) return problem(res, viewer.status, viewer.code, viewer.message);
        const out = await cameras.grantCamera(camera.id, {
            owner: req.principal.subject, viewerSubject: viewer.subject, viewerUsername: viewer.username,
            days: b.days == null || b.days === '' ? null : Number(b.days),
        });
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        res.set('Location', `/api/v1/cameras/${camera.id}/grants`);
        return res.status(out.changed ? 201 : 200).json(out.grant);
    });

    r.delete('/cameras/:id/grants/:grantId', requirePerson, async (req, res) => {
        const camera = await ownCamera(req, res);
        if (!camera) return undefined;
        const out = await cameras.revokeGrant(camera.id, String(req.params.grantId || ''), { owner: req.principal.subject });
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        return res.json({ revoked: out.revoked, already: out.already, grant: out.grant });
    });

    // ── Photos: the raw picture is the body ─────────────────
    const rawBody = express.raw({ type: () => true, limit: config.photos.maxBytes + 1024 });
    r.post('/photos', requirePerson, (req, res, next) => {
        rawBody(req, res, (err) => {
            if (err && err.type === 'entity.too.large') return problem(res, 413, 'cam.too_large', `A photo can be up to ${Math.round(config.photos.maxBytes / 1024 / 1024)} MB.`);
            if (err) return next(err);
            return next();
        });
    }, async (req, res) => {
        const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
            return problem(res, 415, 'cam.not_an_image', 'Send the picture as the body, with an image/jpeg, image/png or image/webp Content-Type.');
        }
        const bytes = Buffer.isBuffer(req.body) ? req.body : null;
        if (!bytes || !bytes.length) return invalid(res, 'The picture is empty.');
        if (bytes.length > config.photos.maxBytes) return problem(res, 413, 'cam.too_large', `A photo can be up to ${Math.round(config.photos.maxBytes / 1024 / 1024)} MB.`);
        const filter = String(req.get('x-filter') || 'none').toLowerCase();
        if (!cameras.FILTERS.includes(filter)) return invalid(res, `X-Filter must be one of ${cameras.FILTERS.join(', ')}`);
        const caption = decoded(req, 'x-caption', 280);
        if (caption === null) return invalid(res, 'X-Caption must be URI-encoded text');
        const cameraId = String(req.get('x-camera') || '').trim() || null;
        const filename = decoded(req, 'x-filename', 200) || `cam-${Date.now()}.jpg`;
        let stored;
        try {
            stored = await upstreams.picsUpload({
                token: req.principal.token, bytes, contentType: type,
                title: caption || 'A photo on OpenVibe.Cam', filename,
            });
        } catch (err) { return upstreamProblem(res, err); }
        const out = await cameras.createPhoto({
            subject: req.principal.subject, cameraId, filter, caption: caption || null, pics: stored,
        });
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        res.set('Location', `/api/v1/photos/${out.photo.id}`);
        return res.status(201).json(out.photo);
    });

    r.get('/photos', requirePerson, async (req, res) => {
        const photos = await cameras.photosOf(req.principal.subject, { limit: asInt(req.query.limit, 60) });
        return res.json({ count: photos.length, photos });
    });

    r.get('/photos/:id', requirePerson, async (req, res) => {
        const photo = await cameras.photoById(String(req.params.id || ''));
        if (!photo || photo.subject !== req.principal.subject) return problem(res, 404, 'cam.not_found', 'No such photo.');
        return res.json(photo);
    });

    // ── Stills: the Live cam button ─────────────────────────
    r.post('/stills', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const slot = String(b.slot == null ? '' : b.slot).trim();
        if (!cameras.SLOT_RE.test(slot)) return invalid(res, 'slot must be a Live slot id, slug or @username');
        const w = b.w == null || b.w === '' ? config.stills.defaultWidth : Number(b.w);
        if (!Number.isFinite(w) || w < 160 || w > 1920) return invalid(res, 'w must be from 160 to 1920');
        const streamId = b.stream_id == null || b.stream_id === '' ? null : Number(b.stream_id);
        if (streamId != null && (!Number.isInteger(streamId) || streamId <= 0)) return invalid(res, 'stream_id must be a positive whole number');
        const visibility = b.visibility == null || b.visibility === '' ? 'unlisted' : String(b.visibility);
        if (!cameras.STILL_VISIBILITIES.includes(visibility)) return invalid(res, `visibility must be one of ${cameras.STILL_VISIBILITIES.join(', ')}`);
        const caption = b.caption == null ? '' : String(b.caption);

        let frame;
        try { frame = await upstreams.liveFrame({ slot, w: Math.round(w), maxBytes: config.stills.maxBytes }); } catch (err) { return upstreamProblem(res, err); }
        if (!frame.ok) {
            if (frame.code === 'offline') return problem(res, 404, 'cam.stream_offline', 'That slot is offline right now.');
            if (frame.code === 'busy') return problem(res, 429, 'cam.frame_busy', 'OpenVibe.Media is busy grabbing that frame; try again in a second.');
            if (frame.code === 'too_large') return problem(res, 413, 'cam.too_large', 'That frame is too large to save.');
            return problem(res, 502, 'cam.frame_unavailable', 'OpenVibe.Media did not return a JPEG frame.');
        }
        let stored;
        try {
            stored = await upstreams.picsUpload({
                token: req.principal.token, bytes: frame.bytes, contentType: 'image/jpeg',
                title: caption || `A still from ${slot}`, filename: `still-${slot.replace(/[^A-Za-z0-9_.-]/g, '')}-${Date.now()}.jpg`,
            });
        } catch (err) { return upstreamProblem(res, err); }
        const out = await cameras.createStill({
            subject: req.principal.subject, streamId, slot, caption, visibility, pics: stored,
        });
        if (!out.ok) return problem(res, out.status, out.code, out.message);
        const shareUrl = `${String(config.baseUrl).replace(/\/+$/, '')}/s/${out.still.id}`;
        const text = (out.still.caption ? `${out.still.caption} — ${shareUrl}` : `A still from ${out.still.slot}: ${shareUrl}`).slice(0, 500);
        res.set('Location', `/api/v1/stills/${out.still.id}`);
        return res.status(201).json({
            still: out.still,
            frame_url: `${String(config.upstreams.media).replace(/\/+$/, '')}/live/${encodeURIComponent(slot)}/frame.jpg?w=${Math.round(w)}`,
            share: { url: shareUrl, caption: out.still.caption, text },
        });
    });

    r.get('/stills', requirePerson, async (req, res) => {
        const stills = await cameras.stillsOf(req.principal.subject, { limit: asInt(req.query.limit, 60) });
        return res.json({ count: stills.length, stills });
    });

    r.get('/stills/:id', async (req, res) => {
        const still = await cameras.stillById(String(req.params.id || ''));
        if (!still) return problem(res, 404, 'cam.not_found', 'No such still.');
        const mine = req.principal.kind === 'user' && req.principal.subject === still.subject;
        if (still.visibility !== 'unlisted' && !mine) return problem(res, 404, 'cam.not_found', 'No such still.');
        const out = { ...still, mine };
        if (!mine) delete out.subject;
        return res.json(out);
    });

    return r;
}

module.exports = { createApi };
