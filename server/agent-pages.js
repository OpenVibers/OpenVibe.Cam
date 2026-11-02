'use strict';
// The Markdown twins of openvibe.cam's public pages (openvibe-shared/agent-layer), rendered by the same
// view builders and page shell the routes use (views/index.js through render/layout.js's renderPage),
// signed out so a twin can never carry a signed-in person's photos or a private wall. Only the pages the
// site itself marks indexable are twinned: the home, the camera app's signed-out shell and /developers.
// /my, /w/:id, /s/:id and every per-person page are never rendered here.
const seo = require('openvibe-shared/seo');
const { renderPage } = require('./render/layout');
const { homeJsonLd } = require('./http/discovery');
const { raw } = require('./render/html');
const views = require('./views');

function createAgentPages({ config }) {
    const twin = (path, o) => ({ html: renderPage({ ...o, path, config, viewer: { kind: 'anonymous' } }) });
    const base = () => String(config.baseUrl).replace(/\/+$/, '');

    function home() {
        return twin('/', {
            index: true, title: null,
            description: 'OpenVibe.Cam is the camera app: on-device filters, private cameras with revocable viewer grants, and a still from a Live stream for its chat.',
            jsonLd: homeJsonLd(config),
            body: raw(views.home({ signedIn: false })),
        });
    }

    function app() {
        return twin('/app', {
            index: true, title: 'The camera app',
            description: 'Take a photo with on-device colour, light and blur, a timer, a burst and a grid; save it to OpenVibe.Pics.',
            body: raw(views.app({ signedIn: false, photos: [] })),
        });
    }

    function developers() {
        return twin('/developers', {
            index: true, title: 'The OpenVibe.Cam API',
            description: 'The JSON API, the viewer-grant rules and the Live cam button contract.',
            jsonLd: [seo.jsonLd.webPage({
                name: 'The OpenVibe.Cam API', url: `${base()}/developers`,
                description: 'The JSON API, the viewer-grant rules and the Live cam button contract.', siteUrl: base(),
            })],
            body: raw(views.developers()),
        });
    }

    async function renderPublicPage(path) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (p === '/') return home();
        if (p === '/app') return app();
        if (p === '/developers') return developers();
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
