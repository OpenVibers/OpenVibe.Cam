'use strict';
// What openvibe.cam tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the JSON API, the /developers page that documents it,
// and the llms.txt/sitemap machine map. The API authenticates a person's cam_at session or Network user
// token and needs no app or service token; no OpenAPI document is published, so none is named.
module.exports = {
    id: 'cam',
    name: 'OpenVibe.Cam',
    purpose: 'The OpenVibe camera app: on-device filters plus a timer, burst and grid, private cameras with revocable viewer grants, stills from live streams, and the API behind Live\'s cam button.',
    home: 'https://openvibe.cam',
    site: 'openvibe.cam',
    api: '/api/v1',
    docs: '/developers',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
