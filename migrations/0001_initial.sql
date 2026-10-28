-- phase: expand
-- OpenVibe.Cam: paired cameras, revocable viewer grants, and the photos and stills whose bytes live in
-- OpenVibe.Pics. A camera row is private to its owner; a grant names one viewer and an expiry, and a revocation is
-- a timestamp checked on every read. Nothing here is a credential and no picture bytes are stored.

CREATE TABLE cam_cameras (
    id             text COLLATE "C" PRIMARY KEY,             -- cam_ + 26 Crockford base32 characters (ULID)
    owner          text COLLATE "C" NOT NULL,                -- usr_…
    owner_username text,                                     -- the owner's Network username when it was paired
    name           text NOT NULL,
    source         text COLLATE "C" NOT NULL DEFAULT 'phone',-- browser | phone | pi | ip
    status         text COLLATE "C" NOT NULL DEFAULT 'paired',-- paired | live | offline
    stream_id      bigint,                                   -- OpenVibe.Live stream id, when the camera is a Live slot
    slot           text COLLATE "C",                         -- a Live slot id, slug or @username for Media's frame
    notes          text,                                     -- the owner's own note; never rendered for a viewer
    paired_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz,                              -- when the wall last asked for its frame
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_cameras_id CHECK (id ~ '^cam_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_cameras_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_cameras_name CHECK (length(name) BETWEEN 1 AND 80),
    CONSTRAINT cam_cameras_source CHECK (source IN ('browser', 'phone', 'pi', 'ip')),
    CONSTRAINT cam_cameras_status CHECK (status IN ('paired', 'live', 'offline')),
    CONSTRAINT cam_cameras_stream CHECK (stream_id IS NULL OR stream_id > 0),
    CONSTRAINT cam_cameras_slot CHECK (slot IS NULL OR slot ~ '^@?[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
);
CREATE UNIQUE INDEX cam_cameras_stream_unique ON cam_cameras (owner, stream_id) WHERE stream_id IS NOT NULL;
CREATE INDEX cam_cameras_by_owner ON cam_cameras (owner, created_at DESC);

-- One viewer, one expiry, one revocation. An active grant is revoked_at IS NULL and expires_at in the future; the
-- store compares both against its clock on every read, so a revocation takes effect at once. A revoked row stays as
-- the record that the grant existed. A re-grant reuses the row that was never revoked.
CREATE TABLE cam_grants (
    id              text COLLATE "C" PRIMARY KEY,            -- cmg_ + ULID
    camera_id       text COLLATE "C" NOT NULL REFERENCES cam_cameras (id) ON DELETE CASCADE,
    owner           text COLLATE "C" NOT NULL,               -- the person who granted it (usr_…)
    viewer_subject  text COLLATE "C" NOT NULL,               -- usr_…
    viewer_username text,                                    -- as resolved when the grant was made
    granted_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    revoked_by      text COLLATE "C",                        -- usr_… of the owner, or service:cam
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_grants_id CHECK (id ~ '^cmg_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_grants_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_grants_viewer CHECK (viewer_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_grants_revoked_by CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 64),
    CONSTRAINT cam_grants_expiry CHECK (expires_at > granted_at),
    CONSTRAINT cam_grants_revoked CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX cam_grants_one_active ON cam_grants (camera_id, viewer_subject) WHERE revoked_at IS NULL;
CREATE INDEX cam_grants_by_camera ON cam_grants (camera_id, granted_at DESC);
CREATE INDEX cam_grants_by_viewer ON cam_grants (viewer_subject, expires_at DESC);

-- A photo the camera app saved. The bytes went to OpenVibe.Pics; this row keeps its slug and public links. A photo
-- attached to a camera is unlisted so the owner and an active viewer see it on the wall; otherwise it is private.
CREATE TABLE cam_photos (
    id          text COLLATE "C" PRIMARY KEY,                -- cmp_ + ULID
    subject     text COLLATE "C" NOT NULL,                   -- usr_…
    camera_id   text COLLATE "C" REFERENCES cam_cameras (id) ON DELETE SET NULL,
    filter      text COLLATE "C" NOT NULL DEFAULT 'none',    -- an on-device look; the server applies nothing
    caption     text,
    visibility  text COLLATE "C" NOT NULL DEFAULT 'private', -- private | unlisted
    pics_slug   text COLLATE "C" NOT NULL,
    pics_url    text NOT NULL,                               -- https://openvibe.pics/i/<slug>
    pics_direct text NOT NULL,                               -- https://openvibe.pics/i/<slug>.<ext>
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_photos_id CHECK (id ~ '^cmp_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_photos_subject CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_photos_filter CHECK (filter IN ('none', 'mono', 'warm', 'cool', 'fade', 'vivid', 'blur')),
    CONSTRAINT cam_photos_caption CHECK (caption IS NULL OR length(caption) BETWEEN 1 AND 280),
    CONSTRAINT cam_photos_visibility CHECK (visibility IN ('private', 'unlisted')),
    CONSTRAINT cam_photos_slug CHECK (length(pics_slug) BETWEEN 1 AND 64),
    CONSTRAINT cam_photos_url CHECK (pics_url ~ '^https?://'),
    CONSTRAINT cam_photos_direct CHECK (pics_direct ~ '^https?://')
);
CREATE INDEX cam_photos_by_subject ON cam_photos (subject, created_at DESC);
CREATE INDEX cam_photos_by_camera ON cam_photos (camera_id, created_at DESC);

-- A still of a Live stream, from the cam button. Also a Pics picture by reference; unlisted by default so the link
-- posted in chat opens it, private when the person chooses. Never a recording.
CREATE TABLE cam_stills (
    id          text COLLATE "C" PRIMARY KEY,                -- cms_ + ULID
    subject     text COLLATE "C" NOT NULL,                   -- usr_… of the viewer who snapped it
    stream_id   bigint,
    slot        text COLLATE "C" NOT NULL,
    caption     text,
    visibility  text COLLATE "C" NOT NULL DEFAULT 'unlisted',-- unlisted | private
    pics_slug   text COLLATE "C" NOT NULL,
    pics_url    text NOT NULL,
    pics_direct text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_stills_id CHECK (id ~ '^cms_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_stills_subject CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_stills_stream CHECK (stream_id IS NULL OR stream_id > 0),
    CONSTRAINT cam_stills_slot CHECK (slot ~ '^@?[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'),
    CONSTRAINT cam_stills_caption CHECK (caption IS NULL OR length(caption) BETWEEN 1 AND 280),
    CONSTRAINT cam_stills_visibility CHECK (visibility IN ('unlisted', 'private')),
    CONSTRAINT cam_stills_slug CHECK (length(pics_slug) BETWEEN 1 AND 64),
    CONSTRAINT cam_stills_url CHECK (pics_url ~ '^https?://'),
    CONSTRAINT cam_stills_direct CHECK (pics_direct ~ '^https?://')
);
CREATE INDEX cam_stills_by_subject ON cam_stills (subject, created_at DESC);

-- openvibe-sdk/account-data keeps its own idempotency here (ADR-033): a redelivered export or deletion changes
-- nothing. It holds an export_id or deletion_id, the subject and the counts sent to Network; it is not a secret.
CREATE TABLE account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);

-- Request telemetry (openvibe-sdk/telemetry): one row per aggregated sample, pruned after 14 days.
CREATE TABLE telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX telemetry_samples_service_idx ON telemetry_samples (service, operation, at);
