# AGENTS.md — OpenVibe.Cam

## Project overview

The camera app, the private wall for cameras you own, and the API Live's cam button calls. A photo or
a still is saved to **OpenVibe.Pics** (the MediaHub); Cam keeps the link, the filter label and the
caption, **never the bytes**. A camera is private to its owner, and a viewer sees it only while the
grant the owner gave is active and not revoked. Node.js/Express, PostgreSQL, CommonJS, no build step.

- Origin `https://openvibe.cam`, port `5160`, service id `cam`, env prefix `CAM`, unit
  `openvibe-cam.service`, release root `/opt/openvibe.cam`.
- v1 is written and tested ([STATUS.json](STATUS.json)); the README records that it is not deployed by
  the change that added it.

## What it owns

- `cam_cameras` (`cam_` + ULID, owner `usr_…`, source `browser|phone|pi|ip`, status, Live stream id
  unique per owner, slot, note) and `cam_grants` (`cmg_`, one canonical viewer subject, expiry,
  revocation); `cam_photos`, `cam_stills`; account-data receipts and telemetry. All in
  [migrations/0001_initial.sql](migrations/0001_initial.sql).
- **There is no image/blob/byte column anywhere.** The `pics_slug` and links are the picture's address
  in Pics; Cam and its database cannot serve the bytes.
- The capture app (browser preview, timer, 3-shot burst, grid, on-device colour/light/softness), the
  private wall `/w/:id`, `/my`, `/my/cameras/:id`, the still `/s/:id` and the `<ov-camera>` element.
- Revocable viewer grants: `@username` resolved through Network (`identity.subject.resolve`), a
  subject id accepted without it, default 7 days and at most 90, a re-grant extends instead of making a
  second grant, revocation writes a timestamp checked on every read.
- The Live cam button: `POST /api/v1/stills` fetches Media's public `GET /live/:slot/frame.jpg`
  (only `image/jpeg` accepted), uploads it to Pics as the person and returns the still plus the exact
  line Live posts.

Not owned: identity (Network), the live frame (Media), the picture bytes and their visibility
(Pics/MediaHub), the stream (Live), Studio (the edit link points at `openvibe.studio`).

## Who calls it, and whom it calls

- Callers: people in the browser; **OpenVibe.Live**'s cam button (`POST /api/v1/stills` with the
  viewer's own token); any site embedding `<ov-camera>`.
- Depends on:
  - **Network** — sign-in (OAuth client `cam`, PKCE S256, cookies `cam_at`/`cam_rt`/`cam_oauth`),
    JWKS, token exchange/refresh/revoke, account export/deletion, `identity.subject.resolve`.
  - **Media** — the public live frame (`OV_MEDIA_URL`, `GET /live/:sel/frame.jpg?w=640`).
  - **Live** — `GET /api/streams/:id` to check a paired stream is on the owner's channel
    (`live.stream.read`).
  - **Pics / MediaHub** — `POST /api/v1/images`, called with the **person's own** Network token
    (`pics.image.upload`); Cam never holds a service token for Pics, and MediaHub refuses one there.
  - **Events** — account deliveries; PostgreSQL (`DATABASE_URL`, owner `DATABASE_DIRECT_URL` for
    migrations); Valkey optional.

## Repository map

- **Entry:** [server/index.js](server/index.js) — `createApp()`, listen, key warm-up, graceful stop.
- **App:** [server/app.js](server/app.js) — helmet/CSP, `/auth`, `/internal/events`, `/shared`,
  `/api/v1`, pages (`/`, `/app`, `/my`, `/w/:id`, `/s/:id`, `/developers`), machine endpoints.
- **Config/db:** [server/config.js](server/config.js), [server/db.js](server/db.js).
- **Domain:** [server/cameras.js](server/cameras.js) (cameras, grants, photos, stills),
  [server/store.js](server/store.js), [server/upstreams.js](server/upstreams.js) (Media/Live/Pics),
  [server/events/pipeline.js](server/events/pipeline.js).
- **HTTP:** [server/http/api.js](server/http/api.js), `pages.js`, `principal.js`, `discovery.js`,
  `openapi-routes.js`, `router.js`; views in [server/views/index.js](server/views/index.js).
- **Auth:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js).
- **Browser:** [public/js/developers.js](public/js/developers.js) and the camera pages/view strings;
  the filter runs on a canvas in the person's browser.
- **Proof seed:** [scripts/seed-proof.js](scripts/seed-proof.js).
- **Deploy:** [deploy/systemd/openvibe-cam.service](deploy/systemd/openvibe-cam.service),
  [deploy/nginx/openvibe.cam.conf](deploy/nginx/openvibe.cam.conf) (TLS, www→apex, `/auth/me` and
  `/my/` rate-limited, `/internal` and `/metrics` 404, 16 MB body cap).

## Commands

```bash
npm install
npm run dev                # NODE_ENV=development node server/index.js
npm start                  # node server/index.js, http://127.0.0.1:5160
npm test                   # test/run.js, PGlite, mock Network + Media/Live/Pics fixtures
OV_ALLOW_SUITE=1 npm test  # the README's guarded form
npm run test:pg            # same on PostgreSQL (CAM_TEST_STORE=pg)
npm test -- cameras        # filter by file name; --strict makes a skip fail
npm run seed:proof         # CAM_PROOF_OWNER=usr_… CAM_PROOF_VIEWER=usr_… node scripts/seed-proof.js
ov test                    # the harness's sharded run of what the change reaches
```

## Database and migrations

Cam's own PostgreSQL database on the host's data role (`DATABASE_URL` through PgBouncer; owner
`DATABASE_DIRECT_URL` for migrations; PGlite under `CAM_PGLITE_DIR` in development). Migrations are
`migrations/NNNN_*.sql`, applied at boot; never edit an applied one, add a new number. Constraints are
part of the privacy model (one unrevoked grant per camera+viewer, owner/stream uniqueness) — do not
drop or relax them for a feature.

## Auth and privacy

- People sign in with Network SSO. The API takes the signed-in person's token; `POST /api/v1/stills`
  forwards **the viewer's own token** to Pics; there is no Cam service-to-Pics credential.
- A wall is for its owner and an active, unrevoked, unexpired grantee — **staff have no bypass**
  (404 for everyone else, including admins).
- A grant is one canonical subject with an expiry; revocation is immediate on the next read. `@username`
  resolution is Network's; a subject id works when Network is not reachable.
- The `<ov-camera>` element holds no session and uploads nothing unless the site asks; the camera is
  a browser API, not a server capture.
- Account export/deletion go through `/internal/events` with this service's own client token.

## Frontend loading model

Server-rendered pages and plain browser JavaScript; the **filter, timer, burst and grid run in the
person's browser on a canvas** — the server never applies an effect and does no image analysis. The
embeddable `<ov-camera>` is one script from `https://openvibe.cam/embed/ov-camera.js`; there is no SPA,
bundler or transpiler. `openvibe-shared` supplies the Frame/legal/SEO and `/shared/*` from the pinned
node_modules. CSP is in [server/app.js](server/app.js).

## Deploy

Unit [deploy/systemd/openvibe-cam.service](deploy/systemd/openvibe-cam.service) runs
`/opt/openvibe.cam/server/index.js` on `127.0.0.1:5160`, env `/etc/openvibe/cam.env`; vhost
[deploy/nginx/openvibe.cam.conf](deploy/nginx/openvibe.cam.conf). The README does not record an
`ovhost deploy cam` command and says this release is not deployed — use the host's own service
installer, and do not claim the domain is live until the owner's launch step runs.

## Tests

`npm test` runs each `test/*.test.js` in its own process (90 s) with a temp PGlite, a mock Network and
a Media/Live/Pics fixture server. It covers the migration and its constraints; pairing and stream
ownership; grants (username resolution, extension, revocation, expiry, **no staff bypass**); the still's
Media→Pics path and refusals; photo upload and limits; pages/cache headers; sign-in; account
export/deletion; and the home page must not put any camera or grant on the public page. `ov test` runs
the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; factories with injectable config/store/clock/
  fetch/log; rendering in `server/render/` and `server/views/`.
- IDs are prefixed ULIDs (`cam_`, `cmg_`, `cmp_`, `cms_`); timestamps are the store's clock.
- Errors are small JSON problems or 404s; never reveal that a camera exists to someone without a grant.
- No secret in a log, a response or the database; Pics' slugs are not secrets but are not enumerable.

## Pitfalls

- **No bytes in Cam.** Do not add an image/blob column or proxy the picture: Pics owns the bytes and
  its own visibility; Cam stores only the slug and links.
- **No face recognition, no server-side filter, no image analysis.** The README's promise is part of
  the product; a "smart" server feature breaks it.
- **The wall is private even from staff.** A grant is the only door (besides the owner); a 404, not a
  403, is the answer.
- **Only `image/jpeg` from Media's frame is accepted** for a still; do not accept arbitrary content
  types or arbitrary URLs.
- **Check stream ownership through Live's public API** before pairing a stream; the slot defaults to
  the stream's managed slot.
- **Grants have a maximum of 90 days**; a re-grant extends the active row, never duplicates it.
- **The Live cam button must use the viewer's token** to upload to Pics; a service token is refused
  by MediaHub and would attribute the still to Cam.
- **A photo of someone else's Pics object is 404 in Studio**, not a redirect or a preview.

## Documentation

- [README.md](README.md) — purpose, the tables, API, Live cam button, `<ov-camera>`, pages, proof,
  run/test and deploy files.
- [STATUS.json](STATUS.json) — what works and what does not.
- OpenVibe.Contracts holds the `cam.*` capability shapes; Pics/Media own the image contract.
