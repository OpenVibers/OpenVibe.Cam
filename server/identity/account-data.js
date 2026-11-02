'use strict';

/**
 * Account export and deletion → Cam (ADR-033; openvibe-sdk/account-data). A person's cameras, the grants they gave
 * and the grants they received, their photos and their stills are theirs to export and erase.
 *
 * A deletion of a camera's owner removes the camera and (by the foreign key) every grant on it. A deletion of a
 * viewer removes the grants naming them and leaves the owner's camera alone. Cam never holds the picture bytes: a
 * photo or still row is a Pics slug and its public links, and OpenVibe.Pics erases the picture itself on the same
 * event. The database stores bare usr_ ids and no tokens.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    // F1's timeline and presence are the owner's. Shares and events go before the camera they hang under.
    { table: 'cam_event_shares', subject: 'owner', file: 'event-shares.json', erase: 'delete' },
    { table: 'cam_events', subject: 'owner', file: 'events.json', erase: 'delete' },
    { table: 'cam_presence', subject: 'owner', file: 'presence.json', erase: 'delete' },
    { table: 'cam_cameras', subject: 'owner', file: 'cameras.json', erase: 'delete' },
    { table: 'cam_grants', subject: 'owner', file: 'grants-given.json', erase: 'delete' },
    { table: 'cam_grants', subject: 'viewer_subject', file: 'grants-received.json', erase: 'delete' },
    { table: 'cam_photos', subject: 'subject', file: 'photos.json', erase: 'delete' },
    { table: 'cam_stills', subject: 'subject', file: 'stills.json', erase: 'delete' },
];

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'cam',
        tables: TABLES,
        note: 'A camera is private to its owner; a grant is the only way in. Pictures live in OpenVibe.Pics; Cam keeps only the link.',
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
