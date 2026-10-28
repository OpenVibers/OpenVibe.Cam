'use strict';
/**
 * An in-process stand-in for OpenVibe.Network with a real RS256 key pair.
 *
 *   Network   JWKS; /oauth/token (authorization_code + PKCE S256 for client `cam`, refresh_token,
 *             client_credentials); /oauth/revoke; /internal/identity/resolve?username=; a user card.
 *
 * Every request is recorded in `.requests`, token exchanges in `.tokenRequests`.
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => { json(500, { error: String(err && err.message) }); });
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({
            server, url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(claims, privateKey) {
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const st = { users: new Map(), byUsername: new Map(), codes: new Map(), refresh: new Map(), requests: [], tokenRequests: [], down: false, resolveDown: false };
    let issuer = null;
    let nextUserId = 1;

    const problem = (json, status, code, detail) => json(status, { type: `https://openvibe.network/problems/${code}`, title: 'Error', status, code, detail, error: detail, request_id: `req_${crypto.randomBytes(6).toString('hex')}` }, { 'Content-Type': 'application/problem+json' });

    function addUser(username, { role = 'user' } = {}) {
        const u = { id: nextUserId++, subject: ids.newId('user'), username, display_name: username, role };
        st.users.set(u.id, u);
        st.byUsername.set(username.toLowerCase(), u);
        return u;
    }
    function userToken(u, { ttl = 3600, iat = null } = {}) {
        const now = iat != null ? iat : Math.floor(Date.now() / 1000);
        return signJwt({ iss: issuer, sub: u.id, subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role, aud: ['openvibe.network'], iat: now, exp: now + ttl }, privatePem);
    }

    const srv = await listen(async (req, raw, json) => {
        const url = new URL(req.url, 'http://x');
        st.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: raw.toString('utf8') });
        if (st.down) return problem(json, 503, 'network.down', 'Network is restarting');

        if (url.pathname === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (url.pathname === '/.well-known/openvibe') return json(200, { name: 'OpenVibe', issuer, contracts: { version: require('openvibe-contracts/package.json').version }, services: [] });
        if (url.pathname === '/oauth/revoke') return json(200, {});
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
            const ct = String(req.headers['content-type'] || '');
            const body = ct.includes('json') ? JSON.parse(raw.toString('utf8') || '{}') : Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
            st.tokenRequests.push({ grant_type: body.grant_type, client_id: body.client_id, audience: body.audience, scope: body.scope });
            if (body.client_id !== 'cam' || body.client_secret !== 'cam-secret') return json(401, { error: 'invalid_client', error_description: 'bad client secret' });
            if (body.grant_type === 'authorization_code') {
                const c = st.codes.get(body.code);
                if (!c) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
                st.codes.delete(body.code);
                const challenge = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
                if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
                const rt = `rt_${crypto.randomBytes(12).toString('hex')}`;
                st.refresh.set(rt, c.user);
                return json(200, { access_token: userToken(c.user), refresh_token: rt, token_type: 'Bearer' });
            }
            if (body.grant_type === 'refresh_token') {
                const user = st.refresh.get(body.refresh_token);
                if (!user) return json(400, { error: 'invalid_grant', error_description: 'refresh token rejected' });
                st.refresh.delete(body.refresh_token);
                const rt = `rt_${crypto.randomBytes(12).toString('hex')}`;
                st.refresh.set(rt, user);
                return json(200, { access_token: userToken(user), refresh_token: rt, token_type: 'Bearer' });
            }
            if (body.grant_type === 'client_credentials') {
                const now = Math.floor(Date.now() / 1000);
                const caps = String(body.scope || '').split(/\s+/).filter(Boolean);
                return json(200, {
                    access_token: serviceAuth.signServiceToken({ iss: issuer, sub: 'svc:cam', actor_type: 'service', aud: [body.audience || 'openvibe.network'], cap: caps, iat: now, exp: now + 300, jti: crypto.randomUUID() }, privatePem),
                    token_type: 'Bearer', expires_in: 300, scope: caps.join(' '),
                });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }

        if (url.pathname === '/internal/identity/resolve' && req.method === 'GET') {
            if (st.resolveDown) return problem(json, 503, 'identity.down', 'identity is restarting');
            const auth = String(req.headers.authorization || '');
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
            const v = token ? serviceAuth.verifyServiceToken(token, { publicKey: publicPem, issuer, audience: 'openvibe.network' }) : { ok: false };
            if (!v.ok) return problem(json, 401, 'token.invalid', 'a service token with identity.subject.resolve is required');
            if (!Array.isArray(v.claims.cap) || !v.claims.cap.includes('identity.subject.resolve')) return problem(json, 403, 'token.forbidden', 'identity.subject.resolve is not granted');
            const name = String(url.searchParams.get('username') || '').replace(/^@/, '').toLowerCase();
            const u = st.byUsername.get(name);
            if (!u) return problem(json, 404, 'identity.subject_not_found', 'no subject for that name');
            return json(200, { subject: { type: 'user', id: u.subject }, network_user_id: u.id, username: u.username, display_name: u.display_name, avatar_url: null, banned: false });
        }

        if (url.pathname === '/api/v1/me/follows' && req.method === 'GET') return json(200, { items: [], next_cursor: null });
        if (url.pathname === '/internal/identity/resolve-batch' && req.method === 'POST') return json(200, { results: {} });
        if (url.pathname === '/internal/notifications/push' && req.method === 'POST') return json(200, { ok: true });

        return json(404, { error: 'not found' });
    });
    issuer = srv.url;

    return {
        url: srv.url, publicPem, privatePem, state: st, requests: st.requests, tokenRequests: st.tokenRequests,
        addUser, userToken, signJwt: (claims) => signJwt(claims, privatePem), issuer: () => issuer,
        issueCode(user, challenge) { const code = `code_${crypto.randomBytes(8).toString('hex')}`; st.codes.set(code, { user, challenge }); return code; },
        setDown(v) { st.down = v; }, setResolveDown(v) { st.resolveDown = v; },
        close: srv.close,
    };
}

module.exports = { startNetwork, signJwt };
