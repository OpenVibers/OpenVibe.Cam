-- phase: expand
-- F1: familiar faces for a camera owner's own cameras (plan L24, 2026-10-31).
--
-- Cam keeps no face template and no face crop: a template and its crop stay in OpenVibe.Vision's library, scoped to
-- the owner. This side keeps the camera's setting, the Vision library id it points at, and the event timeline. An
-- event's clip and still are opaque private references (a Pics/Media URL today) or null; Cam never holds bytes.

ALTER TABLE cam_cameras ADD COLUMN familiar_faces boolean NOT NULL DEFAULT false;
ALTER TABLE cam_cameras ADD COLUMN vision_library_id text;
ALTER TABLE cam_cameras ADD COLUMN region text COLLATE "C" NOT NULL DEFAULT 'unknown';
ALTER TABLE cam_cameras ADD COLUMN region_mode text COLLATE "C" NOT NULL DEFAULT 'strict';
ALTER TABLE cam_cameras ADD COLUMN quiet_hours jsonb NOT NULL DEFAULT '{"enabled":false,"start":"22:00","end":"07:00","tz":"UTC"}'::jsonb;
ALTER TABLE cam_cameras ADD CONSTRAINT cam_cameras_region CHECK (length(region) BETWEEN 1 AND 40);
ALTER TABLE cam_cameras ADD CONSTRAINT cam_cameras_region_mode CHECK (region_mode IN ('strict', 'open'));
ALTER TABLE cam_cameras ADD CONSTRAINT cam_cameras_quiet CHECK (jsonb_typeof(quiet_hours) = 'object');

-- One timeline row per detected event. `kind` is the detection class; a named face is the optional match from the
-- camera's Vision library. away is the owner's presence at the time, high marks the louder alerts.
CREATE TABLE cam_events (
    id                 text COLLATE "C" PRIMARY KEY,          -- cev_ + ULID
    camera_id          text COLLATE "C" NOT NULL REFERENCES cam_cameras (id) ON DELETE CASCADE,
    owner              text COLLATE "C" NOT NULL,
    kind               text COLLATE "C" NOT NULL
                       CHECK (kind IN ('person', 'package', 'vehicle', 'animal', 'loiter', 'door')),
    at                 timestamptz NOT NULL,
    title              text NOT NULL,
    detail             text,
    person_id          text COLLATE "C",
    person_name        text,
    known              boolean NOT NULL DEFAULT false,
    muted              boolean NOT NULL DEFAULT false,
    away               boolean NOT NULL DEFAULT false,
    priority           text COLLATE "C" NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    still_url          text,
    clip_url           text,
    clip_before_seconds integer NOT NULL DEFAULT 10 CHECK (clip_before_seconds BETWEEN 0 AND 60),
    clip_after_seconds  integer NOT NULL DEFAULT 20 CHECK (clip_after_seconds BETWEEN 0 AND 120),
    place              text,
    lat                double precision,
    lng                double precision,
    metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
    notified           boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_events_id CHECK (id ~ '^cev_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_events_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_events_title CHECK (length(title) BETWEEN 1 AND 240),
    CONSTRAINT cam_events_detail CHECK (detail IS NULL OR length(detail) <= 500),
    CONSTRAINT cam_events_still CHECK (still_url IS NULL OR still_url ~ '^https?://'),
    CONSTRAINT cam_events_clip CHECK (clip_url IS NULL OR clip_url ~ '^https?://'),
    CONSTRAINT cam_events_lat CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
    CONSTRAINT cam_events_lng CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180))
);
CREATE INDEX cam_events_timeline ON cam_events (camera_id, at DESC, id DESC);
CREATE INDEX cam_events_by_owner ON cam_events (owner, at DESC);

-- Home or away as the person's phone or browser last said. One row per owner; an event keeps the value it saw.
CREATE TABLE cam_presence (
    owner      text COLLATE "C" PRIMARY KEY,
    state      text COLLATE "C" NOT NULL CHECK (state IN ('home', 'away')),
    source     text COLLATE "C" NOT NULL DEFAULT 'browser' CHECK (source IN ('browser', 'phone', 'node')),
    camera_id  text COLLATE "C" REFERENCES cam_cameras (id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_presence_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);

-- A private link to one event (or the police export). Only the sha256 of the token is stored; the token is returned
-- once. A revoked or expired link answers 404 like a link that never existed.
CREATE TABLE cam_event_shares (
    id         text COLLATE "C" PRIMARY KEY,                  -- ces_ + ULID
    event_id   text COLLATE "C" NOT NULL REFERENCES cam_events (id) ON DELETE CASCADE,
    owner      text COLLATE "C" NOT NULL,
    purpose    text COLLATE "C" NOT NULL DEFAULT 'link' CHECK (purpose IN ('link', 'police')),
    token_hash text COLLATE "C" NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cam_event_shares_id CHECK (id ~ '^ces_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_event_shares_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT cam_event_shares_token CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cam_event_shares_expiry CHECK (expires_at > created_at)
);
CREATE INDEX cam_event_shares_by_event ON cam_event_shares (event_id, created_at DESC);
