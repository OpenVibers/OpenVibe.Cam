# Security policy

OpenVibe is run in the open, and we want to hear about security problems before anyone else does.

## Reporting a vulnerability

Email **contact@openvibe.network** with "security" in the subject. Please include what you found, where (URL,
repository, file), how to reproduce it, and what an attacker could do with it. Do not open a public GitHub issue for
a vulnerability, and do not test against other people's cameras, grants, pictures or streams.

We reply within 7 days, keep you updated while we fix it, and credit you when the fix ships if you would like.

## Scope

Every OpenVibe service and site (openvibe.live, openvibe.network, openvibe.cam, openvibe.media, openvibe.pics and
the other openvibe.* domains) and every repository under github.com/OpenVibers. Machine-readable contact details
are at `/.well-known/security.txt` on each site.

## What OpenVibe.Cam holds

- A paired camera: its name, source, status, Live stream id and slot, the owner's username and note, and times. It
  is private to its owner; there is no public camera page in v1.
- A viewer grant: the camera, the owner's subject, the viewer's subject and username, its grant and expiry times,
  and a revocation time and author. It is not a secret, but it is the only thing that opens a wall.
- A photo or a still: the person's subject, a camera or stream/slot, the filter name and caption, and OpenVibe.Pics'
  slug, page link and direct link. **No picture bytes, no face template and no identity classification** are stored
  here. The picture itself is OpenVibe.Pics' and follows Pics' own access rules, re-encoding and takedowns.
- Network session tokens only in httpOnly cookies (`cam_at`, `cam_rt`). The token is forwarded to OpenVibe.Pics when
  the person saves a picture; it is never stored in the database, rendered into a page or logged.

A wall answers 404 whether the camera does not exist or the caller has no active grant, so a stranger cannot probe
for one. Staff have no bypass: a Network `global_mod` without a grant is refused like anyone else. A session write
must come from `openvibe.cam` (Sec-Fetch-Site same-origin, or an Origin equal to ours); a cross-site form cannot
pair a camera, grant a viewer, revoke a grant or upload a photo. The `/internal/events` account route is loopback
only and refuses a proxied request; nginx answers 404 for `/internal` and `/metrics`.

There is no face recognition, no nudity or violence classifier, no AI call and no recording in v1. The camera is
same-origin only (`Permissions-Policy: camera=(self), microphone=()`), and the filter runs in the browser.

## Supported versions

Only the current `main` branch, which is what runs in production, receives fixes.
