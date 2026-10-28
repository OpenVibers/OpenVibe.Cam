'use strict';

/**
 * OpenVibe.Cam configuration. Every value comes from the environment (production: /etc/openvibe/cam.env,
 * see .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const size = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5160);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.cam' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'cam',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: env.CAM_DRILL === '1' || env.CAM_DRILL === 'true',
        limits: {
            minute: Math.max(1, int(env.CAM_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.CAM_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (CAM_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.CAM_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:cam:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE), its JWKS, and the service token Cam uses
        // only to resolve a viewer's @username when a camera is shared (identity.subject.resolve).
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        audience: env.CAM_AUDIENCE || 'openvibe.cam',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'cam',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service's account export/deletion route. The secret signs a delivery
        // (comma-separated for rotation, 32+ characters each); unset turns POST /internal/events off (503).
        events: {
            secrets: String(env.CAM_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.CAM_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.CAM_EVENTS_ENDPOINT || '',
            intervalMs: Math.max(500, int(env.CAM_EVENTS_INTERVAL_MS, 5000)),
            scope: env.CAM_EVENTS_SCOPE || 'events.subscription.manage',
        },

        // The existing public APIs Cam uses. No service grant is needed for any of them:
        //   OpenVibe.Media  GET /live/:sel/frame.jpg   a near-realtime JPEG of a live slot (public, CORS-open)
        //   OpenVibe.Live   GET /api/streams/:id       a stream and its channel (public; presence is not ownership)
        //   OpenVibe.Pics   POST /api/v1/images        called with the signed-in person's own Network token
        upstreams: {
            media: trim(env.OV_MEDIA_URL || 'https://openvibe.media'),
            live: trim(env.OV_LIVE_URL || 'https://openvibe.live'),
            pics: trim(env.OV_PICS_URL || 'https://openvibe.pics'),
            timeoutMs: Math.max(500, int(env.CAM_UPSTREAM_TIMEOUT_MS, 8000)),
        },

        // A photo the camera app uploads, and the still Live's cam button takes. Neither is ever stored here:
        // the bytes go to OpenVibe.Pics, and Cam keeps the Pics slug and links.
        photos: { maxBytes: size(env.CAM_PHOTO_MAX_BYTES, 12 * 1024 * 1024) },
        stills: {
            maxBytes: size(env.CAM_STILL_MAX_BYTES, 8 * 1024 * 1024),
            defaultWidth: Math.min(1920, Math.max(160, int(env.CAM_STILL_WIDTH, 640))),
        },

        // A camera is private until its owner grants a viewer. Grants expire (7 days by default, 90 at most) and a
        // revocation is checked on every read, so it takes effect at once.
        cameras: {
            maxPerOwner: Math.min(200, Math.max(1, int(env.CAM_MAX_CAMERAS, 20))),
            grantDays: Math.min(90, Math.max(1, int(env.CAM_GRANT_DAYS, 7))),
            grantMaxDays: Math.min(90, Math.max(1, int(env.CAM_GRANT_MAX_DAYS, 90))),
            grantsPerCamera: Math.min(500, Math.max(1, int(env.CAM_GRANTS_PER_CAMERA, 50))),
        },
    };
}

module.exports = { load };
