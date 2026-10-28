'use strict';

/**
 * Cam's server-rendered pages. They are complete without JavaScript: forms are plain POSTs and every link is a real
 * link. The camera preview, timer, burst, grid and filters are an enhancement in public/js/cam.js.
 *
 *   /                         the hero, the three scenes, the privacy rules
 *   /app                      the camera app, with your recent photos when signed in
 *   /my                       pair a camera, your cameras, photos, stills (signed in)
 *   /my/cameras/:id           one camera's owner page: edit, grants, unpair
 *   /w/:id                    the private wall an owner or an active grantee sees
 *   /s/:id                    one still of a live stream
 *   /developers               the API and the Live cam button contract
 *   404                       the not-found page
 *
 * Public pages are served `public, max-age=60` with Vary: Cookie; every page drawn for a signed-in person, a wall
 * and a still are `private, no-store`.
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { pairCamera, resolveViewer } = require('../cameras');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const views = require('../views');

const PUBLIC_CACHE = 'public, max-age=60';

function createPageRoutes(ctx) {
    const { config, s, cameras, upstreams } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const notFromHere = (req, res) => page(req, res, {
        title: 'Not from this site',
        body: raw(html`<div class="cm-wrap cm-page-pad cm-narrow"><div class="cm-empty"><h1>That came from somewhere else</h1><p class="cm-muted">Use the form on <a href="/">OpenVibe.Cam</a>.</p></div></div>`),
    }, 403);
    const signedOut = (req, res, title, text, next) => page(req, res, {
        title, body: raw(views.signIn({ title, text, next })),
    }, 401);

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: null,
        description: 'OpenVibe.Cam is the camera app: on-device filters, private cameras with revocable viewer grants, and a still from a Live stream for its chat.',
        jsonLd: homeJsonLd(config),
        body: raw(views.home({ signedIn: Boolean(signedIn(req)) })),
    }));

    // ── The camera app ───────────────────────────────────────
    r.get('/app', async (req, res) => {
        const photos = signedIn(req) ? await cameras.photosOf(req.viewer.subject, { limit: 12 }) : [];
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE, title: 'The camera app',
            description: 'Take a photo with on-device colour, light and blur, a timer, a burst and a grid; save it to OpenVibe.Pics.',
            body: raw(views.app({ signedIn: Boolean(signedIn(req)), photos })),
        });
    });

    // ── My cameras ───────────────────────────────────────────
    async function renderMy(req, res, { problem = null, status = 200 } = {}) {
        const [list, photos, stills, counts] = await Promise.all([
            cameras.camerasOf(req.viewer.subject), cameras.photosOf(req.viewer.subject), cameras.stillsOf(req.viewer.subject), cameras.countsFor(req.viewer.subject),
        ]);
        return page(req, res, {
            title: 'My cameras',
            description: 'Pair a camera you own, grant one viewer for a week, and revoke it at once.',
            body: raw(views.my({ viewer: req.viewer, cameras: list, photos, stills, counts, problem })),
        }, status);
    }

    r.get('/my', async (req, res) => {
        if (!signedIn(req)) return signedOut(req, res, 'My cameras', 'A camera belongs to your OpenVibe account, so you can pair it, grant a viewer and revoke it later.', '/my');
        return renderMy(req, res);
    });

    r.post('/my/cameras', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fmy');
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const out = await pairCamera({ cameras, upstreams, principal: { subject: req.viewer.subject, username: req.viewer.username }, body: req.body || {} });
        if (!out.ok) return renderMy(req, res, { problem: out.message, status: out.status || 400 });
        return res.redirect(303, `/my/cameras/${encodeURIComponent(out.camera.id)}`);
    });

    async function ownerCamera(req, res) {
        const row = await cameras.cameraById(String(req.params.id || ''));
        if (!row || row.owner !== req.viewer.subject) return null;
        return row;
    }

    async function renderCamera(req, res, row, { problem = null, status = 200 } = {}) {
        const grants = await cameras.grantsOf(row.id, req.viewer.subject);
        const wall = await cameras.wall(row.id, req.viewer.subject);
        const camera = cameras.wireCamera(row);
        return page(req, res, {
            title: camera.name,
            description: `Manage ${camera.name}: its slot, its viewers and its wall.`,
            body: raw(views.camera({
                camera, grants: grants.ok ? grants.grants : [], photos: wall ? wall.photos : [],
                frameUrl: views.frameUrl(config, camera), problem,
            })),
        }, status);
    }

    r.get('/my/cameras/:id', async (req, res) => {
        if (!signedIn(req)) return signedOut(req, res, 'My cameras', 'Sign in to manage this camera.', `/my/cameras/${req.params.id}`);
        const row = await ownerCamera(req, res);
        if (!row) {
            const access = await cameras.accessTo(String(req.params.id || ''), req.viewer.subject);
            if (access && !access.owner) return res.redirect(303, `/w/${encodeURIComponent(access.camera.id)}`);
            return notFound(req, res);
        }
        return renderCamera(req, res, row);
    });

    r.post('/my/cameras/:id', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/my/cameras/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const row = await ownerCamera(req, res);
        if (!row) return notFound(req, res);
        const out = await cameras.patchCamera(row.id, req.viewer.subject, req.body || {});
        if (!out.ok) return renderCamera(req, res, row, { problem: out.message, status: out.status || 400 });
        return res.redirect(303, `/my/cameras/${encodeURIComponent(row.id)}`);
    });

    r.post('/my/cameras/:id/delete', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fmy');
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const row = await ownerCamera(req, res);
        if (!row) return notFound(req, res);
        await cameras.removeCamera(row.id, req.viewer.subject);
        return res.redirect(303, '/my');
    });

    r.post('/my/cameras/:id/grants', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/my/cameras/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const row = await ownerCamera(req, res);
        if (!row) return notFound(req, res);
        const viewer = await resolveViewer({ upstreams, body: req.body || {} });
        if (!viewer.ok) return renderCamera(req, res, row, { problem: viewer.message, status: viewer.status || 400 });
        const out = await cameras.grantCamera(row.id, {
            owner: req.viewer.subject, viewerSubject: viewer.subject, viewerUsername: viewer.username, days: req.body && req.body.days,
        });
        if (!out.ok) return renderCamera(req, res, row, { problem: out.message, status: out.status || 400 });
        return res.redirect(303, `/my/cameras/${encodeURIComponent(row.id)}?granted=1`);
    });

    r.post('/my/cameras/:id/grants/:grantId/revoke', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/my/cameras/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const row = await ownerCamera(req, res);
        if (!row) return notFound(req, res);
        const out = await cameras.revokeGrant(row.id, String(req.params.grantId || ''), { owner: req.viewer.subject });
        if (!out.ok) return renderCamera(req, res, row, { problem: out.message, status: out.status || 400 });
        return res.redirect(303, `/my/cameras/${encodeURIComponent(row.id)}?revoked=1`);
    });

    // ── The private wall ─────────────────────────────────────
    r.get('/w/:id', async (req, res) => {
        if (!signedIn(req)) return signedOut(req, res, 'A private camera', 'This wall opens only for its owner and the viewers they granted. Sign in to see whether one of them is you.', `/w/${req.params.id}`);
        const wall = await cameras.wall(String(req.params.id || ''), req.viewer.subject);
        if (!wall) return notFound(req, res);
        const camera = cameras.wireCamera(wall.camera);
        if (!wall.owner) delete camera.notes;
        return page(req, res, {
            title: camera.name,
            description: 'A private camera wall on OpenVibe.Cam.',
            body: raw(views.wall({ camera, access: { owner: wall.owner, grant: wall.grant }, photos: wall.photos, frameUrl: views.frameUrl(config, camera) })),
        });
    });

    // ── One still ────────────────────────────────────────────
    r.get('/s/:id', async (req, res) => {
        const still = await cameras.stillById(String(req.params.id || ''));
        if (!still) return notFound(req, res);
        const mine = Boolean(signedIn(req) && req.viewer.subject === still.subject);
        if (still.visibility !== 'unlisted' && !mine) return notFound(req, res);
        return page(req, res, {
            title: still.caption || `A still from ${still.slot}`,
            description: still.caption ? `${still.caption} — a still from a live stream on OpenVibe.Cam.` : 'A still from a live stream on OpenVibe.Cam.',
            jsonLd: [seo.jsonLd.webPage({
                name: still.caption || `A still from ${still.slot}`,
                url: `${base()}/s/${still.id}`,
                description: still.caption || `A still from ${still.slot} on OpenVibe.Cam.`,
                siteUrl: base(),
            })],
            body: raw(views.still({ still, mine })),
        });
    });

    // ── Developers ───────────────────────────────────────────
    r.get('/developers', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'The OpenVibe.Cam API',
        description: 'The JSON API, the viewer-grant rules and the Live cam button contract.',
        jsonLd: [seo.jsonLd.webPage({ name: 'The OpenVibe.Cam API', url: `${base()}/developers`, description: 'The JSON API, the viewer-grant rules and the Live cam button contract.', siteUrl: base() })],
        body: raw(views.developers()),
    }));

    // ── Discovery and 404 ────────────────────────────────────
    r.use(createDiscoveryRoutes(ctx));

    function notFound(req, res) {
        return page(req, res, { title: 'Not found', body: raw(views.notFound()) }, 404);
    }

    return r;
}

module.exports = { createPageRoutes };
