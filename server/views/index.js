'use strict';

/**
 * The Cam room's pages (plan 2026-10-28 §5.13). They are plain semantic placeholders with stable `cm-` ids and
 * classes, complete without JavaScript: every action is a real form or link. public/css/cam.css is a one-comment
 * placeholder the main session replaces; public/js/cam.js adds the live preview, the timer, the burst and the
 * on-device filter, and posts the frame to /api/v1/photos.
 *
 *   home({ signedIn })                                   the hero, the three scenes, the privacy rules
 *   app({ signedIn, photos })                            the camera app
 *   my({ viewer, cameras, photos, stills, counts })      pair a camera, your cameras, photos and stills
 *   camera({ camera, grants, photos, frameUrl })         one camera's owner page: edit, grants, unpair
 *   wall({ camera, access, photos, frameUrl })           the private wall an owner or a grantee sees
 *   still({ still, mine })                               one still of a live stream
 *   developers()                                         the API and the Live cam button contract
 *   signIn({ title, text, next })                        a page that needs an account
 *   notFound()
 */
const { esc, time } = require('../render/html');
const kit = require('openvibe-shared/kit');
const sc = require('openvibe-shared/showcase');

const SOURCE_LABEL = { browser: 'Browser', phone: 'Phone', pi: 'Pi', ip: 'IP camera' };
const STATUS_LABEL = { paired: 'Paired', live: 'Live', offline: 'Offline' };
const FILTER_LABEL = { none: 'None', mono: 'Mono', warm: 'Warm', cool: 'Cool', fade: 'Fade', vivid: 'Vivid', blur: 'Soft' };

const sourceLabel = (s) => esc(SOURCE_LABEL[s] || s);
const statusBadge = (s) => `<span class="cm-status cm-status-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const day = (iso) => esc(String(iso || '').slice(0, 10));

function frameUrl(config, camera) {
    if (!camera || !camera.slot) return null;
    return `${String(config.upstreams.media).replace(/\/+$/, '')}/live/${encodeURIComponent(camera.slot)}/frame.jpg?w=640`;
}

/** A shutter iris opening onto a grid of frames, and a photo flying into a gallery. */
function shutterMotif() {
    const frames = [1, 2, 3, 4, 5, 6].map((n) => `<span class="cm-frame cm-frame-${n}"></span>`).join('');
    return `<div class="cm-shutter" aria-hidden="true">
<svg class="cm-iris" viewBox="0 0 200 200"><circle cx="100" cy="100" r="82" fill="none" stroke="currentColor" stroke-width="2" opacity=".45"/>
${[0, 45, 90, 135].map((a) => `<path d="M100 30 A70 70 0 0 1 170 100" transform="rotate(${a} 100 100)" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" opacity=".75"/>`).join('')}
<circle cx="100" cy="100" r="26" fill="currentColor" opacity=".9"/></svg>
<div class="cm-frame-grid">${frames}</div>
</div>`;
}

function photoCard(p, { owner = false } = {}) {
    return `<li class="cm-photo" data-photo="${esc(p.id)}">
<a class="cm-photo-link" href="${esc(p.pics_url)}" rel="noopener"><img src="${esc(p.pics_direct)}" alt="${esc(p.caption || 'A photo on OpenVibe.Cam')}" loading="lazy" width="320" height="240"></a>
<span class="cm-photo-meta">${esc(FILTER_LABEL[p.filter] || p.filter || 'None')}${p.caption ? ` · ${esc(p.caption)}` : ''}${owner ? ` · ${day(p.created_at)}` : ''}</span>
</li>`;
}

function stillCard(s) {
    return `<li class="cm-still" data-still="${esc(s.id)}">
<a class="cm-still-link" href="/s/${esc(s.id)}"><img src="${esc(s.pics_direct)}" alt="${esc(s.caption || 'A still from a live stream')}" loading="lazy" width="320" height="180"></a>
<span class="cm-still-meta">${esc(s.slot)}${s.caption ? ` · ${esc(s.caption)}` : ''} · ${day(s.created_at)}</span>
</li>`;
}

function cameraCard(c) {
    return `<li class="cm-camera-card" data-camera="${esc(c.id)}">
<a class="cm-camera-link" href="/my/cameras/${esc(c.id)}">
<span class="cm-camera-name">${esc(c.name)}</span>
<span class="cm-camera-meta">${sourceLabel(c.source)} · ${statusBadge(c.status)}${c.slot ? ` · <code>${esc(c.slot)}</code>` : ' · no live slot yet'}</span>
<span class="cm-camera-grants">${Number(c.active_grants) || 0} ${Number(c.active_grants) === 1 ? 'viewer' : 'viewers'}</span>
</a></li>`;
}

function empty(text, href = '/app', label = 'Open the camera') {
    return `<div class="cm-empty"><p>${esc(text)}</p><a class="cm-btn cm-btn-quiet" href="${esc(href)}">${esc(label)}</a></div>`;
}

function home({ signedIn = false } = {}) {
    const room = sc.room({
        room: 'cam',
        hero: {
            title: 'Every camera has a moment',
            lede: 'Take a photo with the filters you choose, keep a camera of your own behind a private wall, and share it with one person for a week — or snap a still from a Live stream and send it to the chat.',
            start: { href: '/app', label: 'Open the camera' },
            chips: [{ label: 'My cameras', href: '/my' }, { label: 'The API', href: '/developers' }],
            proof: [{ value: '0', label: 'public cameras' }],
            motif: shutterMotif(),
        },
        scenes: [
            {
                title: 'A still from a stream',
                text: 'The cam button takes the frame OpenVibe.Media already serves, saves it to your OpenVibe.Pics as a still with your caption, and hands the chat line back to Live. Nothing is recorded and nothing is analysed.',
                html: `<figure class="cm-demo-still"><img src="/img/cam-shutter.svg" alt="" width="320" height="180"><figcaption>“the exact second the robot fell over”</figcaption></figure>`,
                action: { href: '/developers', label: 'How the cam button calls Cam' },
            },
            {
                title: 'A camera behind a grant',
                text: 'Pair a phone, a Pi or an IP camera you own. Its wall is private; you name one viewer, choose a week, and revoke it at any time. The next request is refused — there is no cached copy of a grant.',
                html: `<div class="cm-demo-grant"><span class="cm-demo-cam">Front door</span><span class="cm-demo-arrow">→</span><span class="cm-demo-viewer">@ada</span><span class="cm-demo-days">7 days</span></div>`,
                action: { href: '/my', label: 'Pair a camera' },
            },
            {
                title: 'A photo to Pics',
                text: 'The camera app runs the colour, light and blur on your device. The picture goes to OpenVibe.Pics; Cam keeps the link and the filter name, never the bytes.',
                html: `<figure class="cm-demo-photo"><img src="/img/cam-shutter.svg" alt="" width="320" height="240"><figcaption>Warm · saved to Pics</figcaption></figure>`,
                action: { href: '/app', label: 'Take a photo' },
            },
        ],
        faq: {
            items: [
                ['Is my camera public?', 'No. A camera is private to its owner. A viewer sees its wall only while a grant you gave is active, and a revocation is checked on every read. v1 has no public directory.'],
                ['Where are my photos and stills?', 'In OpenVibe.Pics, as your own pictures. Cam stores the Pics slug and links, the filter name and your caption — never the image bytes.'],
                ['Does Cam recognise faces?', 'No. There is no face recognition, no identity classification and no AI analysis of a picture. Filters are colour and light, applied in your browser.'],
                ['What does the cam button on Live do?', 'It calls Cam with your own Network token. Cam fetches the live frame from OpenVibe.Media, saves it to your Pics as a still and returns the line Live posts in the stream chat.'],
            ],
        },
    });
    const live = `<section class="cm-section" id="cm-rules" aria-labelledby="cm-rules-h">
<div class="cm-head-row"><h2 id="cm-rules-h">The privacy rules, up front</h2>${signedIn ? '<a class="cm-more" href="/my">Your cameras' + kit.icon('chevron') + '</a>' : '<a class="cm-more" href="/auth/login?next=%2Fmy">Sign in' + kit.icon('chevron') + '</a>'}</div>
<ul class="cm-rules">
<li><strong>Private by default.</strong> A paired camera has no public page. A grant is the only way in.</li>
<li><strong>A grant is a person and an expiry.</strong> Seven days by default, ninety at most. Revoking it refuses the next request.</li>
<li><strong>No face recognition.</strong> Nothing identifies anyone; effects never leave your device.</li>
<li><strong>Nothing public without its owner's grant.</strong> v1 has no camera directory, no timelapse and no public wall.</li>
</ul>
</section>`;
    return `<div class="cm-wrap cm-home" id="cm-home">${room}${live}</div>`;
}

function app({ signedIn = false, photos = [] } = {}) {
    const options = Object.entries(FILTER_LABEL).map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
    return `<div class="cm-wrap" id="cm-app">
<header class="cm-page-h"><p class="cm-kicker">The camera app</p><h1>Take a photo</h1>
<p class="cm-lede">The preview, the timer, the burst and every filter run in your browser. The picture you keep goes to OpenVibe.Pics; Cam stores the link, the filter and your caption.</p></header>
${signedIn ? '' : `<p class="cm-note">You can try the camera now. <a href="/auth/login?next=%2Fapp">Sign in</a> to save a photo to your Pics.</p>`}
<section class="cm-camera" id="cm-camera" data-cm-camera>
<div class="cm-stage">
<video data-cm-preview playsinline muted aria-label="Camera preview"></video>
<canvas data-cm-canvas hidden></canvas>
<div class="cm-grid-overlay" data-cm-grid hidden aria-hidden="true"></div>
</div>
<div class="cm-controls">
<button class="cm-btn" type="button" data-cm-start>Turn the camera on</button>
<button class="cm-btn cm-btn-quiet" type="button" data-cm-shoot disabled>Take the photo</button>
<label class="cm-field"><span>Timer</span><select data-cm-timer><option value="0">Off</option><option value="3">3 seconds</option><option value="5">5 seconds</option><option value="10">10 seconds</option></select></label>
<button class="cm-btn cm-btn-quiet" type="button" data-cm-burst>Burst of 3</button>
<label class="cm-field"><span>Filter</span><select data-cm-filter>${options}</select></label>
<label class="cm-field"><span>Caption</span><input data-cm-caption type="text" maxlength="280" placeholder="A line for the photo"></label>
<button class="cm-btn cm-btn-quiet" type="button" data-cm-grid-toggle aria-pressed="false">Grid</button>
</div>
<p class="cm-status" data-cm-status role="status">The camera is off.</p>
<label class="cm-field"><span>Or pick a picture</span><input data-cm-file type="file" accept="image/jpeg,image/png,image/webp"></label>
<noscript><p class="cm-fine">The live preview needs JavaScript. You can still use the API at <code>POST /api/v1/photos</code>.</p></noscript>
</section>
<section class="cm-section" id="cm-gallery" aria-labelledby="cm-gallery-h">
<div class="cm-head-row"><h2 id="cm-gallery-h">Your photos</h2>${signedIn ? `<span class="cm-count">${photos.length} recent</span>` : ''}</div>
${signedIn ? (photos.length ? `<ul class="cm-photos">${photos.map((p) => photoCard(p, { owner: true })).join('')}</ul>` : empty('No photo yet. Take one above; it will appear here once Pics has it.', '/app', 'Take a photo')) : empty('Sign in to see the photos you saved to Pics.', '/auth/login?next=%2Fapp', 'Sign in with OpenVibe')}
</section>
</div>`;
}

function my({ viewer, cameras = [], photos = [], stills = [], counts = {}, problem = null } = {}) {
    return `<div class="cm-wrap" id="cm-my">
<header class="cm-page-h"><p class="cm-kicker">My cameras</p><h1>Your cameras, your viewers</h1>
<p class="cm-lede">Pair a camera you own. Its wall is private; a viewer sees it only while the grant you gave is active. ${Number(counts.cameras) || cameras.length} ${Number(counts.cameras) === 1 ? 'camera' : 'cameras'}, ${Number(counts.photos) || photos.length} ${Number(counts.photos) === 1 ? 'photo' : 'photos'}, ${Number(counts.stills) || stills.length} ${Number(counts.stills) === 1 ? 'still' : 'stills'}.</p></header>
${problem ? `<p class="cm-note is-bad" role="alert">${esc(problem)}</p>` : ''}

<section class="cm-section" id="cm-pair" aria-labelledby="cm-pair-h">
<h2 id="cm-pair-h">Pair a camera</h2>
<form class="cm-form cm-card" method="post" action="/my/cameras">
<label class="cm-field"><span>Name</span><input name="name" type="text" maxlength="80" required placeholder="Front door"></label>
<label class="cm-field"><span>What is it?</span><select name="source"><option value="phone">An old phone</option><option value="browser">A browser</option><option value="pi">A Pi</option><option value="ip">An IP camera</option></select></label>
<label class="cm-field"><span>Live stream id (optional)</span><input name="stream_id" type="number" min="1" step="1" inputmode="numeric" placeholder="1234"></label>
<label class="cm-field"><span>Live slot, slug or @username (optional)</span><input name="slot" type="text" maxlength="80" placeholder="whip or @ada"></label>
<label class="cm-field"><span>Note (only you see it)</span><textarea name="notes" rows="2" maxlength="500"></textarea></label>
<button class="cm-btn" type="submit">Pair the camera</button>
<p class="cm-fine">A stream id is checked against OpenVibe.Live and must be a stream on your own channel. The slot is what OpenVibe.Media's frame endpoint reads.</p>
</form>
</section>

<section class="cm-section" id="cm-cameras" aria-labelledby="cm-cameras-h">
<div class="cm-head-row"><h2 id="cm-cameras-h">Paired</h2><span class="cm-count">${cameras.length}</span></div>
${cameras.length ? `<ul class="cm-cameras">${cameras.map(cameraCard).join('')}</ul>` : empty('No camera is paired yet. An old phone is the fastest one: pair it, then grant one viewer.', '#cm-pair', 'Pair one above')}
</section>

<section class="cm-section" id="cm-photos" aria-labelledby="cm-photos-h">
<div class="cm-head-row"><h2 id="cm-photos-h">Your photos</h2><a class="cm-more" href="/app">Take one${kit.icon('chevron')}</a></div>
${photos.length ? `<ul class="cm-photos">${photos.map((p) => photoCard(p, { owner: true })).join('')}</ul>` : '<p class="cm-muted">No photo yet.</p>'}
</section>

<section class="cm-section" id="cm-stills" aria-labelledby="cm-stills-h">
<div class="cm-head-row"><h2 id="cm-stills-h">Your stills</h2><span class="cm-count">${stills.length}</span></div>
${stills.length ? `<ul class="cm-stills">${stills.map(stillCard).join('')}</ul>` : '<p class="cm-muted">A still comes from a Live stream, through the cam button or <code>POST /api/v1/stills</code>.</p>'}
</section>
</div>`;
}

function camera({ camera: c, grants = [], photos = [], frameUrl: frame = null, problem = null } = {}) {
    const active = grants.filter((g) => g.active);
    return `<div class="cm-wrap" id="cm-camera-owner" data-camera="${esc(c.id)}">
<header class="cm-page-h"><p class="cm-kicker">${sourceLabel(c.source)} · ${statusBadge(c.status)}</p><h1>${esc(c.name)}</h1>
<p class="cm-lede">${c.slot ? `The wall shows <code>${esc(c.slot)}</code>'s current frame from OpenVibe.Media.` : 'No live slot yet: set one below and the wall will show its frame.'} ${active.length} active ${active.length === 1 ? 'grant' : 'grants'}.</p></header>
${problem ? `<p class="cm-note is-bad" role="alert">${esc(problem)}</p>` : ''}

<section class="cm-wall-preview" id="cm-frame">
${frame ? `<img src="${esc(frame)}" alt="The camera's current frame" width="640" height="360" loading="lazy">` : '<div class="cm-empty"><p>No frame yet.</p><span class="cm-fine">A slot is needed.</span></div>'}
</section>

<section class="cm-section" id="cm-edit" aria-labelledby="cm-edit-h">
<h2 id="cm-edit-h">The camera</h2>
<form class="cm-form cm-card" method="post" action="/my/cameras/${esc(c.id)}">
<label class="cm-field"><span>Name</span><input name="name" type="text" maxlength="80" value="${esc(c.name)}" required></label>
<label class="cm-field"><span>What is it?</span><select name="source">${Object.entries(SOURCE_LABEL).map(([v, l]) => `<option value="${esc(v)}"${c.source === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
<label class="cm-field"><span>Status</span><select name="status">${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${esc(v)}"${c.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
<label class="cm-field"><span>Slot, slug or @username</span><input name="slot" type="text" maxlength="80" value="${esc(c.slot || '')}"></label>
<label class="cm-field"><span>Note (only you see it)</span><textarea name="notes" rows="2" maxlength="500">${esc(c.notes || '')}</textarea></label>
<div class="cm-actions"><button class="cm-btn" type="submit">Save the camera</button></div>
</form>
<form class="cm-form cm-inline" method="post" action="/my/cameras/${esc(c.id)}/delete"><button class="cm-btn cm-btn-quiet" type="submit">Unpair this camera</button></form>
</section>

<section class="cm-section" id="cm-grants" aria-labelledby="cm-grants-h">
<h2 id="cm-grants-h">Viewers</h2>
<form class="cm-form cm-card" method="post" action="/my/cameras/${esc(c.id)}/grants">
<label class="cm-field"><span>Viewer's OpenVibe username</span><input name="viewer_username" type="text" maxlength="40" required placeholder="ada"></label>
<label class="cm-field"><span>For how long?</span><select name="days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
<button class="cm-btn" type="submit">Grant a viewer</button>
<p class="cm-fine">The name is resolved to its canonical subject through OpenVibe.Network. A grant never becomes public; it lets that one person open the wall until it expires or you revoke it.</p>
</form>
${grants.length ? `<div class="cm-table-wrap"><table class="cm-grants"><thead><tr><th scope="col">Viewer</th><th scope="col">Expires</th><th scope="col">State</th><th scope="col"><span class="cm-sr">Action</span></th></tr></thead><tbody>${grants.map((g) => `<tr data-grant="${esc(g.id)}"><td>${g.viewer_username ? `@${esc(g.viewer_username)}` : `<code>${esc(g.viewer_subject)}</code>`}</td><td>${day(g.expires_at)}</td><td>${g.active ? '<span class="cm-status cm-status-live">Active</span>' : g.revoked_at ? '<span class="cm-status cm-status-offline">Revoked</span>' : '<span class="cm-status cm-status-offline">Expired</span>'}</td><td>${g.active ? `<form method="post" action="/my/cameras/${esc(c.id)}/grants/${esc(g.id)}/revoke"><button class="cm-btn cm-btn-small cm-btn-quiet" type="submit">Revoke</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="cm-muted">Nobody has a grant. Share with one person when you are ready.</p>'}
</section>

<section class="cm-section" id="cm-camera-photos" aria-labelledby="cm-camera-photos-h">
<h2 id="cm-camera-photos-h">On the wall</h2>
${photos.length ? `<ul class="cm-photos">${photos.map((p) => photoCard(p, { owner: true })).join('')}</ul>` : '<p class="cm-muted">A photo taken with this camera chosen appears here and on the wall for an active viewer.</p>'}
</section>
</div>`;
}

function wall({ camera: c, access, photos = [], frameUrl: frame = null } = {}) {
    const owner = access && access.owner;
    return `<div class="cm-wrap" id="cm-wall" data-camera="${esc(c.id)}">
<header class="cm-page-h"><p class="cm-kicker">${owner ? 'Your private wall' : `Shared by @${esc(c.owner_username || 'its owner')}`}</p><h1>${esc(c.name)}</h1>
<p class="cm-lede">${owner ? 'Only you and the viewers you granted can open this page.' : `Your grant is active until ${day(access && access.grant && access.grant.expires_at)}. The owner can revoke it at any time.`}</p></header>
<section class="cm-wall-preview" id="cm-wall-frame">
${frame ? `<img src="${esc(frame)}" alt="The camera's current frame" width="640" height="360">` : '<div class="cm-empty"><p>This camera has no live slot yet.</p></div>'}
</section>
<section class="cm-section" id="cm-wall-photos" aria-labelledby="cm-wall-photos-h">
<h2 id="cm-wall-photos-h">Photos on this wall</h2>
${photos.length ? `<ul class="cm-photos">${photos.map((p) => photoCard(p, { owner })).join('')}</ul>` : '<p class="cm-muted">The owner has not put a photo on this wall.</p>'}
</section>
</div>`;
}

function still({ still: s, mine = false } = {}) {
    return `<div class="cm-wrap" id="cm-still" data-still="${esc(s.id)}">
<header class="cm-page-h"><p class="cm-kicker">A still from ${esc(s.slot)}</p><h1>${esc(s.caption || 'A moment from the stream')}</h1>
<p class="cm-lede">${mine ? 'Yours. ' : ''}Saved to OpenVibe.Pics on ${day(s.created_at)}. This is one frame, not a recording.</p></header>
<figure class="cm-still-large"><img src="${esc(s.pics_direct)}" alt="${esc(s.caption || 'A still from a live stream')}" width="960" height="540"><figcaption>${esc(s.caption || '')}</figcaption></figure>
<dl class="cm-facts"><div><dt>Slot</dt><dd><code>${esc(s.slot)}</code></dd></div><div><dt>Saved</dt><dd>${day(s.created_at)}</dd></div><div><dt>Picture</dt><dd><a href="${esc(s.pics_url)}" rel="noopener">OpenVibe.Pics${kit.icon('chevron')}</a></dd></div></dl>
<div class="cm-actions"><a class="cm-btn" href="/app">Take a photo</a><a class="cm-btn cm-btn-quiet" href="/">Back to Cam</a></div>
</div>`;
}

function signIn({ title, text, next }) {
    return `<div class="cm-wrap cm-page-pad cm-narrow"><div class="cm-empty"><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="cm-btn" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a></div></div>`;
}

function developers() {
    const ep = (m, p, d) => `<div><dt><code>${esc(m)} ${esc(p)}</code></dt><dd>${d}</dd></div>`;
    return `<div class="cm-wrap" id="cm-developers">
<header class="cm-page-h"><p class="cm-kicker">Developers</p><h1>The Cam API</h1>
<p class="cm-lede">JSON under <code>/api/v1</code>, with <code>application/problem+json</code> errors. A person is the <code>cam_at</code> session cookie or a Network user token as a Bearer. No route needs an app or service token.</p></header>

<section><h2>The camera app</h2><dl class="cm-eps">
${ep('POST', '/api/v1/photos', 'A person; the picture is the raw body (<code>image/jpeg</code>, <code>image/png</code> or <code>image/webp</code>), with optional <code>X-Filter</code>, <code>X-Caption</code> and <code>X-Camera</code> headers (URI-encoded). Cam uploads it to OpenVibe.Pics and stores the link.')}
${ep('GET', '/api/v1/photos', 'Your photos, newest first.')}
${ep('GET', '/api/v1/photos/:id', 'One of your photos.')}
</dl></section>

<section><h2>My cameras and viewer grants</h2><dl class="cm-eps">
${ep('GET', '/api/v1/cameras', 'Your paired cameras with their active grant count.')}
${ep('POST', '/api/v1/cameras', '<code>{ name, source, stream_id?, slot?, notes? }</code>. A stream id is read from Live and must be on your channel.')}
${ep('PATCH', '/api/v1/cameras/:id', '<code>{ name?, source?, status?, slot?, notes? }</code>; the owner only.')}
${ep('DELETE', '/api/v1/cameras/:id', 'Unpair it; every grant on it goes. The owner only.')}
${ep('GET', '/api/v1/cameras/:id/wall', 'The private wall: owner, or a viewer whose grant is active. A stranger gets 404, never a hint that it exists.')}
${ep('GET', '/api/v1/cameras/:id/grants', 'The grants you gave, including expired and revoked ones. The owner only.')}
${ep('POST', '/api/v1/cameras/:id/grants', '<code>{ viewer_username }</code> or <code>{ viewer_subject }</code>, and <code>{ days }</code> (1–90, default 7). An existing active grant is extended, never duplicated.')}
${ep('DELETE', '/api/v1/cameras/:id/grants/:grantId', 'Revoke at once: the next wall request is refused.')}
</dl></section>

<section id="cm-live-button"><h2>The Live cam button</h2>
<p class="cm-fine">Live calls Cam with the viewer's own Network token — the token in the viewer's Live session — because the picture is saved to that person's OpenVibe.Pics. Cam needs no service token from Live.</p>
<ol class="cm-steps">
<li>Live receives <code>{ slot, stream_id, caption }</code> from its watch page and calls <code>POST https://openvibe.cam/api/v1/stills</code> with <code>Authorization: Bearer &lt;viewer's Network token&gt;</code>.</li>
<li>Cam reads <code>GET https://openvibe.media/live/:slot/frame.jpg?w=640</code>. A 404 means the slot is offline; SVG offline cards and HTML errors are never uploaded.</li>
<li>Cam calls <code>POST https://openvibe.pics/api/v1/images</code> with the viewer's token, the JPEG as the body, <code>X-Title</code> and <code>X-Filename</code>.</li>
<li>Cam answers <code>201 { still, share: { url, caption, text } }</code>. Live posts <code>share.text</code> to the stream's chat with its existing chat authority and shows the still.</li>
</ol>
<pre class="cm-code"><code>POST /api/v1/stills
{ "slot": "whip", "stream_id": 1234, "caption": "the exact second the robot fell over" }</code></pre>
<p class="cm-fine">A still is <code>unlisted</code> by default: anyone with the link opens <code>/s/&lt;id&gt;</code>; it is not listed anywhere. Pass <code>"visibility": "private"</code> to keep it to yourself. Media's frame endpoint returns at most one frame every five seconds per slot and is rate-limited; a busy frame is <code>429 cam.frame_busy</code>.</p>
</section>

<section><h2>Stills</h2><dl class="cm-eps">
${ep('POST', '/api/v1/stills', '<code>{ slot, caption?, stream_id?, w?, visibility? }</code>. A person; fetches Media\'s frame and uploads it to Pics as them.')}
${ep('GET', '/api/v1/stills', 'Your stills, newest first.')}
${ep('GET', '/api/v1/stills/:id', 'One still; an unlisted one is readable by anyone with the link, a private one only by its owner.')}
</dl></section>

<section id="cm-privacy"><h2>Privacy</h2>
<p class="cm-fine">A camera is private. Staff have no bypass; a global moderator without a grant is refused like anyone else. Cam stores no image bytes, no face template and no identity classification. It stores a camera's name and slot, a grant's two subjects and expiry, and a picture's Pics slug, links, filter name and caption. Account export and deletion cover cameras, grants, photos and stills; the picture itself is erased by OpenVibe.Pics on the same Network event.</p></section>
</div>`;
}

function notFound() {
    return `<div class="cm-wrap cm-page-pad cm-narrow"><div class="cm-empty" id="cm-not-found"><p class="cm-kicker">404</p><h1>This camera is not here</h1><p>It may have been unpaired, your grant may have expired or been revoked, or the address was never a camera. A private wall answers the same whether it exists or not.</p><a class="cm-btn" href="/">Back to Cam</a></div></div>`;
}

module.exports = {
    home, app, my, camera, wall, still, signIn, developers, notFound,
    frameUrl, sourceLabel, statusBadge, photoCard, stillCard, cameraCard,
    SOURCE_LABEL, STATUS_LABEL, FILTER_LABEL,
};
