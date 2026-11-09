-- Phase: expand. Per-person browser camera choices shared by Cam, Live, Video and Codes.
-- Device ids are browser-scoped hints; callers fall back when a device is absent.
CREATE TABLE cam_camera_settings (
    owner text COLLATE "C" PRIMARY KEY CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    facing text NOT NULL DEFAULT 'user' CHECK (facing IN ('user', 'environment')),
    lens text NOT NULL DEFAULT 'main' CHECK (length(lens) BETWEEN 1 AND 120),
    mic text NOT NULL DEFAULT 'default' CHECK (length(mic) BETWEEN 1 AND 120),
    resolution text NOT NULL DEFAULT '720' CHECK (resolution IN ('480', '720', '1080')),
    mirror boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
