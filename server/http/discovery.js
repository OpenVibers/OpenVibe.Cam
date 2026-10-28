'use strict';

/**
 * Crawl artifacts for openvibe.cam: robots.txt, sitemap.xml, llms.txt and llms-full.txt. Only the three public
 * pages are listed. A camera wall, a grant and a still are not for crawlers — the sitemap never names one, and
 * robots.txt disallows the three paths that could carry one.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Cam';
const DESCRIPTION = 'OpenVibe.Cam is the camera app: take a photo with on-device filters, pair a camera you own, share its private wall with one viewer for a week, and take a still from a Live stream for its chat.';
const DISALLOW = ['/auth/', '/api/', '/my/', '/w/', '/s/', '/internal', '/metrics'];

function siteUpdated() {
    try {
        const m = String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated || '').match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'MultimediaApplication', keywords: 'openvibe cam, camera app, private camera, viewer grant, live still, on-device filters' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

function publicPages() {
    return [
        { path: '/', changefreq: 'weekly', priority: 1.0, title: 'OpenVibe.Cam home', text: 'The camera app, your private cameras and viewer grants, and a still from a Live stream.' },
        { path: '/app', changefreq: 'weekly', priority: 0.9, title: 'The camera app', text: 'A photo with on-device colour, light and softness, a timer, a burst and a grid; the picture is saved to OpenVibe.Pics.' },
        { path: '/developers', changefreq: 'weekly', priority: 0.6, title: 'The OpenVibe.Cam API', text: 'The JSON API, the viewer-grant rules and the Live cam button contract.' },
    ];
}

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });
    const pages = publicPages();

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.cam: the three public pages are for crawlers; a camera wall, a grant, a still and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Cam is the camera app: photos with on-device filters saved to OpenVibe.Pics, private cameras with revocable viewer grants, and a still from a Live stream for its chat. A camera is private; there is no public directory in v1.',
            details: 'GET /api/v1/cameras lists a signed-in person\'s cameras; POST /api/v1/cameras pairs one; POST /api/v1/cameras/:id/grants names a viewer and a number of days; DELETE /api/v1/cameras/:id/grants/:grantId revokes it at once. POST /api/v1/stills takes a frame from OpenVibe.Media\'s public GET /live/:sel/frame.jpg and saves it to OpenVibe.Pics as the person. No route is public except GET /api/v1/stills/:id for an unlisted still.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Cam', url: abs('/'), note: 'the camera app and the privacy rules' },
                    { title: 'The camera app', url: abs('/app') },
                    { title: 'The API', url: abs('/developers') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Live', url: 'https://openvibe.live', note: 'the stream the cam button takes a still from' },
                    { title: 'OpenVibe.Media', url: 'https://openvibe.media', note: 'the live frame endpoint' },
                    { title: 'OpenVibe.Pics', url: 'https://openvibe.pics', note: 'where a photo and a still are stored' },
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts and usernames' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Cam. No camera, grant or still is listed: those are private or link-only.',
            base: site,
            maxBytes: 256 * 1024,
            sections: [{ title: 'Pages', pages: pages.map((p) => ({ url: p.path, title: p.title, text: p.text })) }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = pages.map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
