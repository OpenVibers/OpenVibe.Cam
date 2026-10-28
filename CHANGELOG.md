# Changelog

What changed in OpenVibe.Cam, newest first.

## 0.1.0 — 2026-10-28

The first version: the camera app, my cameras and revocable viewer grants, and the API Live's cam button calls.

- **The camera app.** `/app` runs a live preview in the browser; the timer, the 3-shot burst, the grid and the
  colour/light/softness filter are all on the device. The picture is posted as raw bytes to `POST /api/v1/photos`,
  forwarded to OpenVibe.Pics with the person's own Network token, and recorded as a Pics slug, page link, direct
  link, filter name and caption. No image bytes, no face template and no classification are stored here.
- **My cameras.** `cam_cameras` pairs a phone, a browser, a Pi or an IP camera. A Live stream id is read from
  OpenVibe.Live's public API and must be on the owner's channel; the slot defaults to the stream's managed slot.
  The owner can rename it, set the slot and status, and unpair it. `/my/cameras/:id` is the owner's page.
- **Viewer grants.** `cam_grants` names one canonical viewer and an expiry (7 days by default, 90 at most), with a
  partial unique index for one unrevoked grant per camera and viewer. `@username` is resolved through
  OpenVibe.Network with `identity.subject.resolve`; a subject id works without Network. A re-grant extends the row;
  a revocation writes `revoked_at` and the wall checks it on every read, so the next request is refused.
- **The private wall.** `/w/:id` and `GET /api/v1/cameras/:id/wall` answer the owner and an active grantee, and 404
  to everyone else. Staff have no bypass. A grantee never sees the owner's note. An attached photo is unlisted and
  appears on the wall; a photo without a camera is private.
- **The Live cam button.** `POST /api/v1/stills` reads OpenVibe.Media's public `GET /live/:slot/frame.jpg`, accepts
  only a JPEG (never an offline SVG card or HTML), uploads it to OpenVibe.Pics as the viewer, records the still and
  returns `share.text`, the exact line Live posts in the stream's chat. A still is unlisted by default and private
  on request.
- **The service.** Network sign-in as OAuth client `cam` (PKCE S256, `cam_at`/`cam_rt`/`cam_oauth`), truthful
  readiness, Prometheus metrics on loopback, discovery, deploy files, and server-rendered pages with stable `cm-`
  ids. `public/css/cam.css` is a one-comment placeholder for the main session.
- **Account data.** Export and deletion cover cameras, grants given and received, photos and stills; a deleted
  owner's camera and its grants go, a deleted viewer's grants go and the owner's camera stays. Pictures themselves
  are OpenVibe.Pics' and are erased on the same Network event.
- **The first proof.** `scripts/seed-proof.js` pairs a test camera, grants a viewer, opens the wall, revokes the
  grant and proves the next wall request is refused.
- **Tests.** Migration and constraints, pairing and stream ownership, grants and their refusals, the still path,
  the photo upload, pages and cache headers, SSO, and account export/deletion, each in its own process on a
  temporary PGlite database with a mock Network and a Media/Live/Pics fixture server.
