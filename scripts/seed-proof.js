#!/usr/bin/env node
'use strict';

/**
 * The first proof, the half that needs no network: pair an owned test camera, grant a viewer for a week, open the
 * private wall as that viewer, revoke the grant, and show that the very next wall request is refused.
 *
 *   CAM_PROOF_OWNER=usr_… CAM_PROOF_VIEWER=usr_… node scripts/seed-proof.js
 *
 * The other two halves need a signed-in person's Network token and are done through the site or the API:
 *   a photo:  POST /api/v1/photos (raw image body) with the cam_at cookie
 *   a still:  POST /api/v1/stills { "slot": "whip", "caption": "…" } with the cam_at cookie
 * Both go to OpenVibe.Pics; Cam stores only the link. Re-running this script reuses the proof camera and makes a
 * fresh grant after the previous one was revoked.
 */
const { ids } = require('openvibe-contracts');
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createStore } = require('../server/store');

const NAME = 'Proof camera';
const SLOT = 'proof';

function subject(v, what) {
    if (!ids.isSubjectId('user', String(v || ''))) {
        throw new Error(`${what} must be a canonical subject (usr_ + 26 Crockford characters); pass it in the environment`);
    }
    return String(v);
}

async function runProof({ config, s, owner, viewer, log = console } = {}) {
    if (!config) config = load();
    if (!s) s = await openStore(config, { log });
    const ownerSubject = subject(owner, 'CAM_PROOF_OWNER');
    const viewerSubject = subject(viewer, 'CAM_PROOF_VIEWER');
    if (ownerSubject === viewerSubject) throw new Error('the owner and the viewer must be different people');
    const cameras = createStore(s, { config });

    let camera = (await cameras.camerasOf(ownerSubject)).find((c) => c.name === NAME && c.slot === SLOT) || null;
    if (!camera) {
        const created = await cameras.createCamera({ owner: ownerSubject, ownerUsername: 'proof-owner', name: NAME, source: 'phone', slot: SLOT, notes: 'The first proof; safe to unpair.' });
        if (!created.ok) throw new Error(`could not pair the proof camera: ${created.message}`);
        camera = created.camera;
        log.log(`[seed-proof] paired ${camera.id} (${NAME}, slot ${SLOT}) for ${ownerSubject}`);
    } else {
        log.log(`[seed-proof] ${camera.id} already paired; using it`);
    }

    const granted = await cameras.grantCamera(camera.id, { owner: ownerSubject, viewerSubject, viewerUsername: 'proof-viewer', days: 7 });
    if (!granted.ok) throw new Error(`could not grant the viewer: ${granted.message}`);
    log.log(`[seed-proof] granted ${viewerSubject} until ${granted.grant.expires_at} (${granted.grant.id})`);

    const wall = await cameras.wall(camera.id, viewerSubject);
    if (!wall || wall.owner) throw new Error('the viewer could not open the wall after the grant; nothing is proven');
    log.log(`[seed-proof] the viewer opened the wall: ${wall.photos.length} photo(s), frame ${camera.slot ? `live/${camera.slot}/frame.jpg` : 'not set'}`);

    const revoked = await cameras.revokeGrant(camera.id, granted.grant.id, { owner: ownerSubject });
    if (!revoked.ok || !revoked.revoked) throw new Error('the grant was not revoked');
    log.log(`[seed-proof] revoked ${granted.grant.id}`);

    const refused = await cameras.wall(camera.id, viewerSubject);
    if (refused) throw new Error('the wall still opened after the revocation; the proof fails');
    log.log('[seed-proof] the next wall request was refused, as it must be');
    log.log('[seed-proof] the photo and the still need a signed-in person: POST /api/v1/photos and POST /api/v1/stills');
    return { camera, grant: granted.grant, wall, revoked: revoked.grant, refused: true };
}

async function main() {
    const owner = process.env.CAM_PROOF_OWNER;
    const viewer = process.env.CAM_PROOF_VIEWER;
    if (!owner || !viewer) {
        console.error('[seed-proof] set CAM_PROOF_OWNER and CAM_PROOF_VIEWER to two canonical usr_ ids');
        process.exitCode = 1;
        return;
    }
    const config = load();
    const s = await openStore(config, { log: console });
    try { await runProof({ config, s, owner, viewer }); } finally { await s.close(); }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[seed-proof] ${err && err.message ? err.message : err}`);
        process.exitCode = 1;
    });
}

module.exports = { runProof, NAME, SLOT };
