'use strict';
/**
 * The first proof, without the network: pair the proof camera for one owner, grant a second person for seven days,
 * open the wall as that viewer, revoke the grant, and see the next wall request refused. Re-running reuses the
 * camera and makes a fresh grant after the previous one was revoked.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { runProof, NAME, SLOT } = require('../scripts/seed-proof');

(async () => {
    const t = await boot();
    const owner = ids.newId('user');
    const viewer = ids.newId('user');
    try {
        await check('the proof pairs a camera, grants a viewer, opens the wall, revokes and is refused', async () => {
            const out = await runProof({ config: t.config, s: t.ctx.s, owner, viewer, log: { log() {} } });
            assert.strictEqual(out.camera.name, NAME);
            assert.strictEqual(out.camera.slot, SLOT);
            assert.strictEqual(out.camera.owner_username, 'proof-owner');
            assert.strictEqual(out.grant.viewer_subject, viewer);
            assert.strictEqual(out.wall.owner, false);
            assert.strictEqual(out.revoked.revoked_at != null, true);
            assert.strictEqual(out.refused, true);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM cam_grants WHERE camera_id = $1', [out.camera.id])), 1);
        });

        await check('a second run reuses the camera and grants again after the revocation', async () => {
            const again = await runProof({ config: t.config, s: t.ctx.s, owner, viewer, log: { log() {} } });
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM cam_cameras WHERE owner = $1 AND name = $2', [owner, NAME])), 1);
            assert.notStrictEqual(again.grant.id, null);
            assert.strictEqual(again.refused, true);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM cam_grants WHERE camera_id = $1', [again.camera.id])), 2);
        });

        await check('the proof refuses the same person twice and a non-subject', async () => {
            await assert.rejects(runProof({ config: t.config, s: t.ctx.s, owner, viewer: owner, log: { log() {} } }), /different people/);
            await assert.rejects(runProof({ config: t.config, s: t.ctx.s, owner: 'nobody', viewer, log: { log() {} } }), /CAM_PROOF_OWNER/);
        });
    } finally {
        await t.close();
    }
    done();
})();
