# OpenVibe.Cam

> Your camera, your cameras, and the moment Live's cam button takes.

**Status:** v1 written and tested (see [STATUS.json](STATUS.json)).
**Domain:** `openvibe.cam` · **Port:** 5160 · **Service id:** `cam` · **Env prefix:** `CAM`
**License:** AGPL-3.0-only (same as every OpenVibe service).

OpenVibe.Cam is the camera app, the private wall for cameras you own, and the API Live's cam button calls. A photo
or a still is saved to OpenVibe.Pics; Cam keeps the link, the filter and the caption, never the bytes. A camera is
private to its owner, and a viewer sees it only while the grant the owner gave is active and not revoked.

## Purpose

- **The camera app.** A browser preview with a timer, a 3-shot burst, a grid and on-device colour, light and
  softness. The filter runs on the canvas in the person's browser; the server never applies an effect. The picture
  is posted to Cam, which forwards it to OpenVibe.Pics with the person's own Network token. There is no server-side
  image analysis and no face recognition.
- **My cameras.** Pair an old phone, a browser, a Pi or an IP camera you own. If a Live stream id is given, Cam
  reads it from OpenVibe.Live's public API and refuses a stream on somebody else's channel; the slot defaults to the
  stream's managed slot. Its wall is private: `/w/<id>` answers its owner and an active grantee, and 404 to
  everyone else, including staff.
- **Revocable viewer grants.** A grant names one canonical subject and an expiry: seven days by default, ninety at
  most. `@username` is resolved through OpenVibe.Network (`identity.subject.resolve`); a subject id works without
  it. A re-grant extends the active grant instead of making a second one. Revocation writes a timestamp, and the
  wall checks it on every read, so the next request is refused.
- **The Live cam button.** Live calls `POST /api/v1/stills` with the viewer's own Network token. Cam fetches
  OpenVibe.Media's public `GET /live/:slot/frame.jpg` (only `image/jpeg` is accepted), uploads the JPEG to
  OpenVibe.Pics as that person, and returns the still and the exact line Live posts in the stream chat.

## Owns

| Table | Holds | Migration |
|---|---|---|
| `cam_cameras` | `cam_` + ULID, owner `usr_…`, owner username, name, source `browser\|phone\|pi\|ip`, status `paired\|live\|offline`, Live `stream_id` (unique per owner), `slot`, the owner's note, paired/last-seen times | `migrations/0001_initial.sql` |
| `cam_grants` | `cmg_` + ULID, camera, owner, `viewer_subject`, viewer username, `granted_at`, `expires_at`, `revoked_at`, `revoked_by`; one unrevoked grant per camera and viewer | `0001_initial.sql` |
| `cam_photos` | `cmp_` + ULID, subject, optional camera, filter label, caption, visibility `private\|unlisted`, Pics slug, page URL, direct URL | `0001_initial.sql` |
| `cam_stills` | `cms_` + ULID, subject, stream id, slot, caption, visibility `unlisted\|private`, Pics slug, page URL, direct URL | `0001_initial.sql` |
| `account_data_events` | openvibe-sdk/account-data's export/deletion receipts | `0001_initial.sql` |
| `telemetry_samples` | aggregated request telemetry, pruned after 14 days | `0001_initial.sql` |

There is no image, blob or byte column in any Cam table. The `pics_slug` and links are the picture's address in
OpenVibe.Pics; neither Cam nor its database can serve the bytes.

## Does not own

- **The picture bytes, resizing, metadata stripping and takedowns** — OpenVibe.Pics (OpenVibe.MediaHub). Cam reads
  its `201` and stores the slug and links.
- **The live frame** — OpenVibe.Media's `/live/:sel/frame.jpg`. Cam never runs ffmpeg or caches a frame.
- **Streams, chat and the streamer's second camera** — OpenVibe.Live and OpenVibe.Chat. The `OVCamPip` streamer
  camera is Live's; Live also posts the returned still line to the stream's chat with its own chat authority.
- **Identity, usernames and accounts** — OpenVibe.Network. Cam verifies sessions against its JWKS and resolves a
  viewer's `@username` with `identity.subject.resolve`.
- **Search** — OpenVibe.Search. v1 makes nothing public, so Cam queues no Search document.
- **Events, the host and the database** — OpenVibe.Events, OpenVibe.Host.

## Depends on

Environment variable names are in [.env.example](.env.example); no value is committed.

- **OpenVibe.Network** — sign-in (OAuth client `cam`, PKCE S256, cookies `cam_at`/`cam_rt`/`cam_oauth`), JWKS,
  token exchange/refresh/revoke, account export/deletion, and `identity.subject.resolve` for `@username`:
  `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_NETWORK_ISSUER`, `OV_OAUTH_CLIENT_ID`,
  `OV_OAUTH_CLIENT_SECRET`, `OV_OAUTH_REDIRECT_URI`, `OV_SESSION_AUDIENCE`, `CAM_AUDIENCE`.
- **OpenVibe.Media** — the public live frame, `GET /live/:sel/frame.jpg?w=640` (`media.derivative.read` is the
  planned capability; the route needs no token today): `OV_MEDIA_URL`.
- **OpenVibe.Live** — `GET /api/streams/:id`, the public read used to check that a paired stream is on the owner's
  channel (`live.stream.read`: `OV_LIVE_URL`).
- **OpenVibe.Pics (OpenVibe.MediaHub)** — `POST /api/v1/images`, called with the signed-in person's own Network
  token; Cam never holds a service token for Pics (`OV_PICS_URL`). The route is `pics.image.upload` in the person's
  own right; MediaHub refuses an app or service token there.
- **OpenVibe.Events** — account deliveries: `CAM_EVENTS_SECRET`, `CAM_EVENTS_URL`, `CAM_EVENTS_ENDPOINT`.
- **PostgreSQL** — `DATABASE_URL` (through PgBouncer) and `DATABASE_DIRECT_URL` (migrations); embedded PGlite in
  `CAM_PGLITE_DIR` for development.
- **Valkey** — optional `VALKEY_URL`, `VALKEY_PREFIX` (readiness lists it; the limits in v1 count in-process).
- **Packages** — `openvibe-contracts` v0.234.0, `openvibe-sdk` v0.74.0, `openvibe-shared` v4.80.0, the same tags
  OpenVibe.Meme pins.

## API

Everything is JSON under `/api/v1`; errors are `application/problem+json` with a `code`. A person is the `cam_at`
session cookie or `Authorization: Bearer <Network user token>`, verified offline with the Network JWKS. A write made
with the session cookie must come from `https://openvibe.cam` (403 `cam.cross_site`). A signed-in account also gets
per-actor minute/hour limits (`CAM_LIMITS_MINUTE`, `CAM_LIMITS_HOUR`).

| Route | What it does |
|---|---|
| `POST /photos` | a person; raw picture body (`image/jpeg`, `image/png`, `image/webp`), optional `X-Filter`, `X-Caption`, `X-Camera`, `X-Filename` (URI-encoded); forwarded to Pics |
| `GET /photos` · `GET /photos/:id` | your photos |
| `GET /cameras` | your cameras with active grant counts |
| `POST /cameras` | `{ name, source, stream_id?, slot?, notes? }`; a `stream_id` is read from Live and must be yours |
| `GET /cameras/:id` · `PATCH /cameras/:id` · `DELETE /cameras/:id` | the owner: read, change name/source/status/slot/notes, unpair |
| `GET /cameras/:id/wall` | the owner or an active grantee; a stranger gets 404 |
| `GET /cameras/:id/grants` | the owner: every grant, including expired and revoked |
| `POST /cameras/:id/grants` | the owner: `{ viewer_username }` or `{ viewer_subject }`, `{ days }` 1–90 |
| `DELETE /cameras/:id/grants/:grantId` | the owner: revoke at once |
| `POST /stills` | a person; `{ slot, caption?, stream_id?, w?, visibility? }`; Media's frame → Pics → a still and the chat line |
| `GET /stills` | your stills |
| `GET /stills/:id` | an unlisted still by its link; a private one only for its owner |

Validation refusals are `400 { code: "cam.invalid", message }`; a blocked caption is `400 { code:
"cam.blocked_words" }`. Other codes: `cam.sign_in_required`, `cam.person_required`, `cam.cross_site`,
`cam.not_found`, `cam.camera_exists`, `cam.camera_limit`, `cam.grant_limit`, `cam.grant_not_found`,
`cam.stream_not_found`, `cam.not_your_stream`, `cam.stream_offline`, `cam.frame_unavailable`, `cam.frame_busy`,
`cam.pics.refused`, `cam.pics.unavailable`, `cam.too_large`, `cam.not_an_image`, `cam.viewer_not_found`,
`cam.identity_unavailable`, `cam.rate_limited`.

## The Live cam button

Live is the caller. It holds the viewer's Network token in its own session; it sends that token to Cam as a Bearer
(server-side), never a Cam service token:

1. The watch page sends `{ slot, stream_id, caption }` to Live's server.
2. Live calls `POST https://openvibe.cam/api/v1/stills` with `Authorization: Bearer <viewer's Network token>`.
3. Cam reads `GET https://openvibe.media/live/:slot/frame.jpg?w=640`; a 404 is `cam.stream_offline`, and an SVG
   offline card served with 200 is refused as `cam.frame_unavailable`.
4. Cam calls `POST https://openvibe.pics/api/v1/images` with the same token, the JPEG as the body, `X-Title` and
   `X-Filename`. Pics re-encodes and strips metadata.
5. Cam answers `201 { still, frame_url, share: { url, caption, text } }`. Live posts `share.text` to the stream's
   chat and shows `share.url` (or `still.pics_direct`).

Cam needs no app/service token for this, and Live needs no new Cam grant. A still is `unlisted` by default; pass
`"visibility": "private"` to keep it to its owner. Media caches one frame per slot for five seconds and rate-limits
by address, so a burst of button presses can answer `429 cam.frame_busy`.

## Pages

All server-rendered through the OpenVibe Frame (`openvibe-shared/shell`), readable without JavaScript, with
semantic HTML and stable `cm-` ids/classes. Public pages are `public, max-age=60` with `Vary: Cookie`; a page drawn
for a signed-in person, a wall or a still is `private, no-store`.

| Page | What it is |
|---|---|
| `/` | the shutter hero, the three scenes, the privacy rules |
| `/app` | the camera app: preview, timer, burst, grid, filter, caption, and your recent photos |
| `/my` | pair a camera, your cameras, your photos and stills (signed in) |
| `/my/cameras/:id` | one camera: its frame, edit form, viewers, revoke buttons, unpair |
| `/w/:id` | the private wall an owner or an active grantee sees |
| `/s/:id` | one still of a live stream, with its Pics link |
| `/developers` | the API and the Live cam button contract |
| 404 | the not-found page |

`public/css/cam.css` is a one-comment placeholder: the pages are complete without it, and the main session designs
it. `public/js/cam.js` adds the live preview, the timer, the burst, the grid and the on-device filter. The two
pictures in `public/img/` are data-free SVG placeholders. `robots.txt`, `sitemap.xml`, `llms.txt` and
`llms-full.txt` list the three public pages and never a wall, a grant or a still.

## The first proof

`scripts/seed-proof.js` performs the part that needs no network:

- pair an owned test camera (`Proof camera`, slot `proof`) for `CAM_PROOF_OWNER`;
- grant `CAM_PROOF_VIEWER` for seven days;
- open the wall as that viewer;
- revoke the grant;
- ask for the wall again and assert it is refused.

Re-running reuses the camera and makes a fresh grant. The photo and the still need a signed-in person's Network
token and are done through `/app` or the API; both go to OpenVibe.Pics.

## Run and test

```sh
npm install
npm test                 # PGlite; every test file in its own process, no network needed
npm run test:pg          # the same through PostgreSQL + PgBouncer (openvibe-sdk scripts/test-services.sh up)
OV_ALLOW_SUITE=1 npm test
npm start                # PORT 5160, loopback; DATABASE_URL or an embedded PGlite in development
CAM_PROOF_OWNER=usr_… CAM_PROOF_VIEWER=usr_… node scripts/seed-proof.js
```

The tests boot the app with a mock Network, a Media/Live/Pics fixture server, and a temporary database: the
migration and its constraints, pairing and stream ownership, grants (username resolution, extension, revocation,
expiry, staff have no bypass), the still's Media → Pics path and its refusals, the photo upload and its limits, the
pages and cache headers, sign-in, and account export/deletion.

## Deploy

`deploy/systemd/openvibe-cam.service` (127.0.0.1:5160, `/etc/openvibe/cam.env`) and
`deploy/nginx/openvibe.cam.conf` (TLS, www → apex, `/auth/me` on the API zone, `/my/` on the API zone, `/internal`
and `/metrics` 404, a 16 MB body cap for a photo). Not deployed by this change.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

<!-- versions:start -->
- openvibe-contracts: v0.237.0
- openvibe-sdk: v0.74.0
- openvibe-shared: v4.80.0
<!-- versions:end -->
