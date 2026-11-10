/* OpenVibe.Cam <ov-camera>: the camera app as one framework-free custom element.
 *
 *   <script src="https://openvibe.cam/embed/ov-camera.js" async></script>
 *   <ov-camera facing="user" filters="none,mono,warm" timer="3" mode="photo" upload="off"></ov-camera>
 *
 * The preview, the filters, the timer and the burst run in the browser; nothing is recorded. With upload="off" the
 * picture never leaves the page and is delivered as an ov-camera:capture event. With upload="openvibe" and the
 * page served from openvibe.cam, the picture is also posted to POST /api/v1/photos as the signed-in person.
 *
 * The same file is the camera app's filter and capture code: public/js/cam.js reads window.OVCameraCore, so the
 * app and the element cannot drift apart. Node can require it for the parsing helpers (no DOM is touched then).
 */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OVCameraCore = api;
    if (root && root.customElements && root.HTMLElement) api.define(root);
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // The FILTER_CSS names the camera app uses; the attribute and the API's X-Filter accept these.
    var FILTERS = {
        none: 'none',
        mono: 'grayscale(1) contrast(1.08)',
        warm: 'sepia(.35) saturate(1.15)',
        cool: 'hue-rotate(-10deg) saturate(1.1)',
        fade: 'saturate(.8) contrast(.92) brightness(1.06)',
        vivid: 'saturate(1.45) contrast(1.06)',
        blur: 'blur(1.5px)'
    };
    var LABELS = { none: 'None', mono: 'Mono', warm: 'Warm', cool: 'Cool', fade: 'Fade', vivid: 'Vivid', blur: 'Soft' };
    var FILTER_NAMES = Object.keys(FILTERS);
    var FACINGS = ['user', 'environment'];
    var TIMERS = [0, 3, 10];
    var MODES = ['photo', 'burst'];
    var UPLOADS = ['off', 'openvibe'];
    var DEFAULT_SRC = 'https://openvibe.cam/embed/ov-camera.js';
    var SCRIPT_ORIGIN = null;

    /** "none, mono, WARM" → ['none','mono','warm']; unknown names and duplicates are dropped, empty → ['none']. */
    function parseFilters(value) {
        if (value === null || value === undefined || String(value).trim() === '') return ['none'];
        var seen = {};
        var out = [];
        String(value).split(',').forEach(function (raw) {
            var name = raw.trim().toLowerCase();
            if (name === 'soft') name = 'blur';
            if (FILTERS[name] && !seen[name]) { seen[name] = true; out.push(name); }
        });
        return out.length ? out : ['none'];
    }

    /** 0, 3 or 10 seconds; anything else is 0 (no timer). */
    function parseTimer(value) {
        var n = parseInt(value, 10);
        return TIMERS.indexOf(n) >= 0 ? n : 0;
    }

    /** user (the front camera) or environment (the back camera); user by default. */
    function parseFacing(value) {
        var v = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
        if (v === 'rear' || v === 'back') v = 'environment';
        if (v === 'front') v = 'user';
        return FACINGS.indexOf(v) >= 0 ? v : 'user';
    }

    /** photo or burst; photo by default. */
    function parseMode(value) {
        var v = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
        return MODES.indexOf(v) >= 0 ? v : 'photo';
    }

    /** off or openvibe; off by default, so an embed never uploads unless it says so. */
    function parseUpload(value) {
        var v = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
        return UPLOADS.indexOf(v) >= 0 ? v : 'off';
    }

    /** All five attributes at once, from a getter (element.getAttribute) or a plain object. */
    function parseAttrs(get) {
        var read = typeof get === 'function' ? get : function (name) { return get ? get[name] : null; };
        return {
            facing: parseFacing(read('facing')),
            filters: parseFilters(read('filters')),
            timer: parseTimer(read('timer')),
            mode: parseMode(read('mode')),
            upload: parseUpload(read('upload'))
        };
    }

    function filterCss(name) { return FILTERS[name] || 'none'; }
    function filterLabel(name) { return LABELS[name] || 'None'; }

    /** Draw a video or an image to a canvas with the named filter, at its own size. Returns { width, height }. */
    function drawTo(canvas, source, filter, width, height) {
        var w = Math.round(width || source.videoWidth || source.naturalWidth || source.width || 1280);
        var h = Math.round(height || source.videoHeight || source.naturalHeight || source.height || 720);
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('The canvas is not available in this browser.');
        ctx.filter = filterCss(filter);
        ctx.drawImage(source, 0, 0, w, h);
        return { width: w, height: h };
    }

    /** canvas.toBlob as a promise; jpeg 0.92 is what the camera app posts. */
    function toBlob(canvas, type, quality) {
        return new Promise(function (resolve, reject) {
            if (!canvas.toBlob) { reject(new Error('This browser cannot encode a picture.')); return; }
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob); else reject(new Error('The picture could not be encoded.'));
            }, type || 'image/jpeg', quality === undefined ? 0.92 : quality);
        });
    }

    /** The origin of the page the element runs on and the origin the embed script came from. */
    function originOf(url) {
        try { return new URL(url, root && root.location ? root.location.href : DEFAULT_SRC).origin; } catch { return ''; }
    }
    function isSameOrigin(a, b) {
        return Boolean(a && b && originOf(a) === originOf(b));
    }

    /**
     * A picture picked from disk, drawn through the same filter and encoded the same way a capture is. Resolves to
     * { blob, width, height, filter } and revokes the object URL it used to decode the file.
     */
    function fileToCapture(file, filter, makeCanvas) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                var canvas = makeCanvas();
                var size;
                try { size = drawTo(canvas, img, filter); } catch (err) { URL.revokeObjectURL(url); reject(err); return; }
                toBlob(canvas, 'image/jpeg', 0.92).then(function (blob) {
                    URL.revokeObjectURL(url);
                    resolve({ blob: blob, width: size.width, height: size.height, filter: filter });
                }, function (err) { URL.revokeObjectURL(url); reject(err); });
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not a picture this browser can read.')); };
            img.src = url;
        });
    }

    var ICONS = {
        timer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13.5" r="7"/><path d="M12 13.5V10M9.5 3.5h5"/></svg>',
        flip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9a8 8 0 0 1 14.3-3.3L20 7.5M20 3.5v4h-4M20 15a8 8 0 0 1-14.3 3.3L4 16.5M4 20.5v-4h4"/></svg>',
        photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="m3.5 16 5-5 4 4 2.5-2.5 5.5 5.5"/></svg>',
        upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5M5 15.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-3.5"/></svg>'
    };

    // The camera app's look, in the shadow tree: the dark framed viewfinder, the off card, the filter strip, the
    // pill controls and the shutter. The two public knobs are --ov-camera-accent and --ov-camera-radius.
    var CSS = [
        ':host{display:block;--_accent:var(--ov-camera-accent,#00c7d2);--_radius:var(--ov-camera-radius,26px);',
        '--_ink:var(--ov-camera-ink,#e6edf7);--_muted:var(--ov-camera-muted,#96a7c2);--_line:var(--ov-camera-border,#1f2d47);',
        '--_card:var(--ov-camera-card,#0f1729);--_on:var(--ov-camera-on-accent,#041416);',
        'color:var(--_ink);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.4;',
        'contain:layout style;--_camera-gap:12px}',
        '*,*::before,*::after{box-sizing:border-box}',
        '.wrap{display:grid;gap:14px;padding:14px;border-radius:calc(var(--_radius) + 6px);background:var(--_card);border:1px solid var(--_line)}',
        '.stage{position:relative;overflow:hidden;border-radius:var(--_radius);background:#04060b;aspect-ratio:4/3;',
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.06),0 30px 70px -40px rgba(0,0,0,.9);isolation:isolate}',
        '.stage video,.stage canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:filter .25s ease}',
        ':host([facing="user"]) .stage video{transform:scaleX(-1)}',
        '.count{position:absolute;inset:0;z-index:3;display:grid;place-items:center;font-size:clamp(64px,20vw,140px);font-weight:900;color:#fff;text-shadow:0 6px 30px rgba(0,0,0,.5);pointer-events:none}',
        '.count:empty{display:none}.count.is-tick{animation:ov-tick .9s cubic-bezier(.2,1.3,.4,1)}',
        '@keyframes ov-tick{0%{transform:scale(1.6);opacity:0}30%{transform:scale(1);opacity:1}100%{opacity:.2}}',
        '.off{position:absolute;inset:0;z-index:5;display:grid;place-content:center;justify-items:center;gap:10px;padding:24px;text-align:center;color:#e8ecf3;',
        'background:radial-gradient(120% 90% at 50% 20%,color-mix(in srgb,var(--_accent) 22%,#04060b) 0%,#04060b 70%)}',
        '.camera:not([data-state="off"]) .off{display:none}',
        '.off-title{margin:0;font-size:clamp(22px,4vw,30px);font-weight:800;letter-spacing:-.03em}',
        '.off-text{margin:0;max-width:34ch;color:rgba(232,236,243,.75);font-size:14px}',
        '.btn-big{min-height:52px;padding:0 26px;border:0;border-radius:999px;font:inherit;font-size:16px;font-weight:800;cursor:pointer;',
        'background:var(--_accent);color:var(--_on);box-shadow:0 10px 30px -12px var(--_accent)}',
        '.btn-big:focus-visible,.round:focus-visible,.pill:focus-visible,.shutter:focus-visible,.swatch:focus-visible,.pick:focus-within{outline:2px solid var(--_accent);outline-offset:2px}',
        '.pick{position:relative;display:inline-flex;align-items:center;gap:8px;min-height:42px;padding:0 14px;border-radius:999px;color:rgba(232,236,243,.85);font-size:14px;font-weight:650;cursor:pointer}',
        '.pick svg{width:18px;height:18px}.pick:hover{background:rgba(255,255,255,.08)}',
        '.pick input{position:absolute;inset:0;opacity:0;cursor:pointer}',
        '.top{position:absolute;z-index:2;top:12px;left:12px;right:12px;display:flex;justify-content:flex-end;gap:8px}',
        '.round,.pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:44px;min-width:44px;padding:0 12px;border:0;border-radius:999px;',
        'color:#fff;background:rgba(4,6,11,.45);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);font:inherit;font-size:13px;font-weight:750;cursor:pointer}',
        '.round{padding:0;width:44px}.round svg,.pill svg{width:20px;height:20px}',
        '.pill.is-set{background:color-mix(in srgb,var(--_accent) 75%,rgba(4,6,11,.4))}',
        '.filters{position:absolute;z-index:2;left:0;right:0;bottom:12px;display:flex;gap:8px;padding:4px 14px;overflow-x:auto;scrollbar-width:none}',
        '.filters::-webkit-scrollbar{display:none}.filters[hidden]{display:none}',
        '.swatch{flex:none;display:grid;justify-items:center;gap:4px;padding:4px;border:0;background:none;color:#fff;font:inherit;font-size:11.5px;font-weight:700;cursor:pointer;text-shadow:0 1px 6px rgba(0,0,0,.6)}',
        '.swatch-chip{width:42px;height:42px;border-radius:13px;box-shadow:0 0 0 2px rgba(255,255,255,.35);transition:box-shadow .15s,transform .15s;filter:var(--_filter,none);',
        'background:radial-gradient(circle at 30% 30%,#ffd27a 0 18%,transparent 19%),linear-gradient(160deg,#6fb6ff,#8f6bff 45%,#ff7aa8 75%,#ffcf6b)}',
        '.swatch[aria-checked="true"] .swatch-chip{box-shadow:0 0 0 3px #fff;transform:scale(1.06)}',
        '.camera[data-state="off"] .top,.camera[data-state="off"] .filters{display:none}',
        '.bar{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;padding:0 4px}',
        '.thumb{justify-self:start;display:grid;place-items:center;width:52px;height:52px;padding:0;border:1px solid var(--_line);border-radius:14px;overflow:hidden;cursor:pointer;',
        'color:var(--_muted);background:var(--_card)}.thumb img{width:100%;height:100%;object-fit:cover}.thumb svg{width:24px;height:24px}',
        '.thumb[aria-label="Your last photo"]{cursor:pointer}',
        '.flip{justify-self:end;color:var(--_ink);background:var(--_card);border:1px solid var(--_line);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.shoot-wrap{display:grid;justify-items:center;gap:8px}',
        '.modes{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:color-mix(in srgb,var(--_ink) 6%,transparent)}',
        '.mode{height:30px;padding:0 12px;border:0;border-radius:999px;background:none;color:var(--_muted);font:inherit;font-size:12.5px;font-weight:750;letter-spacing:.02em;text-transform:uppercase;cursor:pointer}',
        '.mode[aria-checked="true"]{color:var(--_accent);background:color-mix(in srgb,var(--_accent) 16%,transparent)}',
        '.shutter{position:relative;display:grid;place-items:center;width:76px;height:76px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer}',
        '.shutter::before{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 4px var(--_ink)}',
        '.shutter span{width:60px;height:60px;border-radius:50%;background:var(--_ink);transition:transform .12s ease,background-color .15s}',
        '.shutter:active span,.shutter.is-firing span{transform:scale(.86)}',
        '.camera[data-mode="burst"] .shutter span{background:var(--_accent)}',
        '.shutter[disabled]{opacity:.45;cursor:not-allowed}',
        '.status{margin:0;min-height:1.4em;text-align:center;font-size:13px;font-variant-numeric:tabular-nums;color:var(--_muted)}',
        '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
    ].join('');

    var TEMPLATE = '<div class="wrap camera" part="wrap"><div class="stage" part="stage">'
        + '<video part="preview" playsinline muted aria-label="Camera preview"></video>'
        + '<canvas part="canvas" hidden></canvas>'
        + '<div class="count" part="countdown" aria-hidden="true"></div>'
        + '<div class="off"><p class="off-title">Camera</p><p class="off-text">Live filters on your device. Nothing is recorded.</p>'
        + '<button class="btn-big" type="button" data-start>Turn on the camera</button>'
        + '<label class="pick">' + ICONS.upload + '<span>Or pick a picture</span><input data-file type="file" accept="image/jpeg,image/png,image/webp"></label></div>'
        + '<div class="top"><button class="pill" type="button" data-timer aria-label="Timer: off">' + ICONS.timer + '<b data-timer-label>Off</b></button></div>'
        + '<div class="filters" role="radiogroup" aria-label="Filter" data-filters></div>'
        + '</div><div class="bar"><button class="thumb" type="button" data-thumb disabled aria-label="No photo yet">' + ICONS.photos + '</button>'
        + '<div class="shoot-wrap"><div class="modes" role="radiogroup" aria-label="Mode">'
        + '<button class="mode" type="button" role="radio" aria-checked="true" data-mode="photo">Photo</button>'
        + '<button class="mode" type="button" role="radio" aria-checked="false" data-mode="burst">Burst</button></div>'
        + '<button class="shutter" type="button" data-shoot aria-label="Take the photo"><span></span></button></div>'
        + '<button class="round flip" type="button" data-flip aria-label="Switch camera">' + ICONS.flip + '</button></div>'
        + '<p class="status" part="status" role="status" aria-live="polite">The camera is off.</p></div>';

    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    var OvCamera = root && root.HTMLElement ? class OvCamera extends root.HTMLElement {
        constructor() {
            super();
            this._stream = null;
            this._starting = null;
            this._capturing = false;
            this._selectedFilter = 'none';
            this._lastUrl = null;
            var shadow = this.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<style>' + CSS + '</style>' + TEMPLATE;
            this._camera = shadow.querySelector('.camera') || shadow.querySelector('.wrap');
            this._video = shadow.querySelector('video');
            this._canvas = shadow.querySelector('canvas');
            this._countEl = shadow.querySelector('.count');
            this._statusEl = shadow.querySelector('.status');
            this._startBtn = shadow.querySelector('[data-start]');
            this._shootBtn = shadow.querySelector('[data-shoot]');
            this._flipBtn = shadow.querySelector('[data-flip]');
            this._timerBtn = shadow.querySelector('[data-timer]');
            this._timerLabel = shadow.querySelector('[data-timer-label]');
            this._filterGroup = shadow.querySelector('[data-filters]');
            this._fileInput = shadow.querySelector('[data-file]');
            this._thumb = shadow.querySelector('[data-thumb]');
            this._modeBtns = Array.prototype.slice.call(shadow.querySelectorAll('[data-mode]'));
            this._facing = 'user';
            this._config = parseAttrs(null);

            var self = this;
            this._startBtn.addEventListener('click', function () {
                if (self._stream) self.stop(); else self.start().catch(function () { /* start() already dispatched the error */ });
            });
            this._shootBtn.addEventListener('click', function () {
                if (!self._stream) { self.start().catch(function () { /* start() already dispatched the error */ }); return; }
                self.capture().catch(function () { /* capture() already dispatched the error */ });
            });
            this._flipBtn.addEventListener('click', function () { self.flip().catch(function () { /* no camera is not an error here */ }); });
            this._timerBtn.addEventListener('click', function () {
                var next = TIMERS[(TIMERS.indexOf(self._config.timer) + 1) % TIMERS.length];
                self.setAttribute('timer', String(next));
            });
            this._filterGroup.addEventListener('click', function (e) {
                var btn = e.target.closest ? e.target.closest('[data-filter]') : null;
                if (!btn) return;
                self._selectFilter(btn.getAttribute('data-filter'));
            });
            this._modeBtns.forEach(function (btn) {
                btn.addEventListener('click', function () { self.setAttribute('mode', btn.getAttribute('data-mode')); });
            });
            this._fileInput.addEventListener('change', function () {
                var file = self._fileInput.files && self._fileInput.files[0];
                if (!file) return;
                if (!/^image\//.test(file.type)) { self._say('That is not a picture.'); self._fileInput.value = ''; return; }
                self._fromFile(file);
                self._fileInput.value = '';
            });
            this._thumb.addEventListener('click', function () { self._downloadLast(); });
        }

        static get observedAttributes() { return ['facing', 'filters', 'timer', 'mode', 'upload']; }

        connectedCallback() {
            if (!this._camera) return;
            this._applyAttributes();
            this._camera.setAttribute('data-state', 'off');
            this._camera.setAttribute('data-mode', this._config.mode);
            this._camera.setAttribute('data-facing', this._config.facing);
            this.setAttribute('facing', this._config.facing);
        }

        disconnectedCallback() { this.stop(); }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue === newValue || !this._camera) return;
            var wasFacing = this._config.facing;
            this._applyAttributes();
            if (name === 'facing' && this._stream && wasFacing !== this._config.facing) {
                var self = this;
                this.stop();
                this.start().catch(function () { /* start() already dispatched the error */ });
            }
        }

        // ── The public methods ───────────────────────────────
        /** Turn the camera on. Never called on connect: a camera starts only from a click or an explicit call. */
        start() {
            var self = this;
            if (this._stream) return Promise.resolve();
            if (this._starting) return this._starting;
            if (!root.navigator || !root.navigator.mediaDevices || !root.navigator.mediaDevices.getUserMedia) {
                this._say('This browser has no camera input. Pick a picture instead.');
                this._error('camera_unavailable', 'This browser has no camera input. Pick a picture instead.');
                return Promise.resolve();
            }
            this._say('Turning the camera on…');
            this._camera.setAttribute('data-state', 'starting');
            var seq = (this._startSeq || 0) + 1;
            this._startSeq = seq;
            this._starting = root.navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: this._config.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
                audio: false
            }).then(function (stream) {
                if (seq !== self._startSeq) { stream.getTracks().forEach(function (t) { t.stop(); }); return false; }
                self._stream = stream;
                self._video.srcObject = stream;
                var track = stream.getVideoTracks()[0];
                var settings = track && track.getSettings ? track.getSettings() : {};
                self._camera.setAttribute('data-facing', settings.facingMode || (self._config.facing === 'user' ? 'user' : 'environment'));
                return self._video.play().catch(function () { /* muted autoplay is allowed; a blocked play is not fatal */ }).then(function () { return true; });
            }).then(function (ok) {
                if (ok === false || seq !== self._startSeq) return;
                self._camera.setAttribute('data-state', 'on');
                self._startBtn.textContent = 'Turn the camera off';
                self._say('The camera is on. Nothing is recorded.');
            }).catch(function (err) {
                if (seq !== self._startSeq) return;
                self._camera.setAttribute('data-state', 'off');
                var code = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'permission_denied' : 'camera_unavailable';
                var message = code === 'permission_denied'
                    ? 'The camera was not allowed. Allow it in the browser, or pick a picture.'
                    : 'The camera could not be started. Pick a picture instead.';
                self._say(message);
                self._error(code, message);
            }).then(function () { self._starting = null; });
            return this._starting;
        }

        stop() {
            this._startSeq = (this._startSeq || 0) + 1;
            if (this._stream) {
                this._stream.getTracks().forEach(function (t) { t.stop(); });
                this._stream = null;
            }
            if (this._video) this._video.srcObject = null;
            if (this._camera) this._camera.setAttribute('data-state', 'off');
            if (this._startBtn) this._startBtn.textContent = 'Turn on the camera';
            if (this._statusEl && this.isConnected) this._say('The camera is off.');
        }

        /** Take one photo (or three, in burst mode), honouring the timer. Resolves to the capture detail(s). */
        capture() {
            var self = this;
            if (this._capturing) return Promise.resolve(null);
            if (!this._stream || !this._video || !this._video.videoWidth) {
                this._say('Turn the camera on first.');
                this._error('not_started', 'Turn the camera on first.');
                return Promise.resolve(null);
            }
            this._capturing = true;
            var timer = this._config.timer;
            var done = function () {
                self._capturing = false;
                self._say('The camera is on. Nothing is recorded.');
            };
            var run = timer > 0 ? this._countdown(timer) : Promise.resolve();
            return run.then(function () {
                if (self._config.mode === 'burst') {
                    var shots = [];
                    var chain = Promise.resolve();
                    for (var i = 0; i < 3; i++) {
                        chain = chain.then(function (i) {
                            return i ? sleep(450) : Promise.resolve();
                        }.bind(null, i)).then(function () { return self._snap(); }).then(function (detail) {
                            if (detail) shots.push(detail);
                        });
                    }
                    return chain.then(function () { done(); return shots; });
                }
                return self._snap().then(function (detail) { done(); return detail; });
            }).catch(function (err) {
                self._capturing = false;
                self._error('capture_failed', err && err.message ? err.message : 'The picture could not be taken.');
                return null;
            });
        }

        /** Switch front/back; if the camera is on it restarts on the other one. Resolves to the new facing. */
        flip() {
            var next = this._config.facing === 'user' ? 'environment' : 'user';
            this.setAttribute('facing', next);
            return Promise.resolve(next);
        }

        // ── Internals ────────────────────────────────────────
        _applyAttributes() {
            var config = parseAttrs(this.getAttribute.bind(this));
            var filtersChanged = String(config.filters) !== String(this._config.filters);
            this._config = config;
            this._facing = config.facing;
            if (this._camera) this._camera.setAttribute('data-mode', config.mode);
            if (this._startBtn) this._startBtn.textContent = this._stream ? 'Turn the camera off' : 'Turn on the camera';
            if (this._timerLabel) this._timerLabel.textContent = config.timer ? config.timer + 's' : 'Off';
            if (this._timerBtn) {
                this._timerBtn.setAttribute('aria-label', config.timer ? 'Timer: ' + config.timer + ' seconds' : 'Timer: off');
                this._timerBtn.classList.toggle('is-set', config.timer !== 0);
            }
            this._modeBtns.forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-mode') === config.mode ? 'true' : 'false'); });
            if (this._shootBtn) this._shootBtn.setAttribute('aria-label', config.mode === 'burst' ? 'Take three photos' : 'Take the photo');
            if (filtersChanged || !this._filterGroup.children.length) this._renderFilters();
        }

        _renderFilters() {
            var allowed = this._config.filters;
            if (!allowed.includes(this._selectedFilter)) this._selectedFilter = allowed[0];
            var self = this;
            this._filterGroup.textContent = '';
            this._filterGroup.hidden = allowed.length <= 1;
            allowed.forEach(function (name) {
                var btn = root.document.createElement('button');
                btn.type = 'button';
                btn.className = 'swatch';
                btn.setAttribute('role', 'radio');
                btn.setAttribute('data-filter', name);
                btn.setAttribute('aria-label', filterLabel(name));
                btn.setAttribute('aria-checked', name === self._selectedFilter ? 'true' : 'false');
                var chip = root.document.createElement('span');
                chip.className = 'swatch-chip';
                chip.setAttribute('aria-hidden', 'true');
                if (name !== 'none') chip.style.filter = filterCss(name);
                var label = root.document.createElement('span');
                label.textContent = filterLabel(name);
                btn.appendChild(chip);
                btn.appendChild(label);
                self._filterGroup.appendChild(btn);
            });
            if (this._video) this._video.style.filter = filterCss(this._selectedFilter);
        }

        _selectFilter(name) {
            if (!this._config.filters.includes(name)) return;
            this._selectedFilter = name;
            Array.prototype.forEach.call(this._filterGroup.querySelectorAll('[data-filter]'), function (b) {
                b.setAttribute('aria-checked', b.getAttribute('data-filter') === name ? 'true' : 'false');
            });
            if (this._video) this._video.style.filter = filterCss(name);
        }

        _say(text) { if (this._statusEl) this._statusEl.textContent = text; }

        _error(code, message) {
            this.dispatchEvent(new root.CustomEvent('ov-camera:error', {
                detail: { code: code, message: message }, bubbles: true, composed: true
            }));
        }

        _countdown(n) {
            var self = this;
            return new Promise(function (resolve) {
                var left = n;
                var tick = function () {
                    if (left <= 0) { if (self._countEl) { self._countEl.textContent = ''; } resolve(); return; }
                    self._say(left + '…');
                    if (self._countEl) {
                        self._countEl.textContent = String(left);
                        self._countEl.classList.remove('is-tick');
                        void self._countEl.offsetWidth;
                        self._countEl.classList.add('is-tick');
                    }
                    left -= 1;
                    setTimeout(tick, 1000);
                };
                tick();
            });
        }

        _snap() {
            var self = this;
            var size;
            try { size = drawTo(this._canvas, this._video, this._selectedFilter); }
            catch (err) { this._error('capture_failed', err.message); return Promise.resolve(null); }
            if (this._shootBtn) {
                this._shootBtn.classList.add('is-firing');
                setTimeout(function () { if (self._shootBtn) self._shootBtn.classList.remove('is-firing'); }, 160);
            }
            if (root.navigator && root.navigator.vibrate) { try { root.navigator.vibrate(12); } catch (e) { /* not every browser */ } }
            return toBlob(this._canvas, 'image/jpeg', 0.92).then(function (blob) {
                var detail = { blob: blob, width: size.width, height: size.height, filter: self._selectedFilter };
                self._showThumb(blob);
                self.dispatchEvent(new root.CustomEvent('ov-camera:capture', { detail: detail, bubbles: true, composed: true }));
                if (self._config.upload === 'openvibe') { self._upload(detail); }
                return detail;
            }).catch(function (err) {
                self._error('capture_failed', err.message);
                return null;
            });
        }

        _showThumb(blob) {
            if (!this._thumb || !root.URL || !root.URL.createObjectURL) return;
            if (this._lastUrl) root.URL.revokeObjectURL(this._lastUrl);
            this._lastUrl = root.URL.createObjectURL(blob);
            this._thumb.textContent = '';
            var img = root.document.createElement('img');
            img.alt = '';
            img.src = this._lastUrl;
            this._thumb.appendChild(img);
            this._thumb.disabled = false;
            this._thumb.setAttribute('aria-label', 'Your last photo');
        }

        _downloadLast() {
            if (!this._lastUrl || !root.document) return;
            var a = root.document.createElement('a');
            a.href = this._lastUrl;
            a.download = 'ov-camera-' + Date.now() + '.jpg';
            a.rel = 'noopener';
            root.document.body.appendChild(a);
            a.click();
            a.remove();
        }

        _fromFile(file) {
            var self = this;
            this._say('Reading the picture…');
            fileToCapture(file, this._selectedFilter, function () {
                var canvas = root.document.createElement('canvas');
                canvas.width = 1;
                canvas.height = 1;
                return canvas;
            }).then(function (detail) {
                self._say('The picture is ready.');
                self._showThumb(detail.blob);
                self.dispatchEvent(new root.CustomEvent('ov-camera:capture', { detail: detail, bubbles: true, composed: true }));
                if (self._config.upload === 'openvibe') self._upload(detail);
            }).catch(function (err) {
                self._say(err && err.message ? err.message : 'That picture could not be read.');
                self._error('file_unreadable', err && err.message ? err.message : 'That picture could not be read.');
            });
        }

        /** POST the picture to Cam as the signed-in person; only same-origin (openvibe.cam) pages can. */
        _upload(detail) {
            var self = this;
            var apiOrigin = SCRIPT_ORIGIN || originOf(DEFAULT_SRC);
            var pageOrigin = root.location ? root.location.origin : '';
            if (!isSameOrigin(pageOrigin, apiOrigin)) {
                self._error('upload_unavailable', 'upload="openvibe" posts only from openvibe.cam; keep upload="off" and send the blob to your own server.');
                return Promise.resolve(null);
            }
            this._say('Saving to OpenVibe.Pics…');
            return root.fetch('/api/v1/photos', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'image/jpeg',
                    'X-Filter': detail.filter || 'none',
                    'X-Filename': encodeURIComponent('cam-' + Date.now() + '.jpg')
                },
                body: detail.blob
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (body) {
                    if (res.status === 401 || res.status === 403) {
                        self._say('Sign in to save this photo to OpenVibe.Pics.');
                        self._error('upload_denied', 'Sign in to save this photo to OpenVibe.Pics.');
                        return null;
                    }
                    if (!res.ok) {
                        var message = (body && body.detail) || 'The photo was not saved.';
                        self._say(message);
                        self._error('upload_failed', message);
                        return null;
                    }
                    self._say('Saved to OpenVibe.Pics.');
                    return body;
                });
            }).catch(function () {
                self._say('The photo was not saved: the network did not answer.');
                self._error('upload_failed', 'The photo was not saved: the network did not answer.');
                return null;
            });
        }
    } : null;

    function define(win) {
        if (!SCRIPT_ORIGIN) SCRIPT_ORIGIN = originOf((win.document && win.document.currentScript && win.document.currentScript.src) || DEFAULT_SRC);
        if (!OvCamera || !win.customElements || win.customElements.get('ov-camera')) return;
        win.customElements.define('ov-camera', OvCamera);
    }

    return {
        FILTERS: FILTERS,
        FILTER_NAMES: FILTER_NAMES,
        LABELS: LABELS,
        DEFAULT_SRC: DEFAULT_SRC,
        parseFilters: parseFilters,
        parseTimer: parseTimer,
        parseFacing: parseFacing,
        parseMode: parseMode,
        parseUpload: parseUpload,
        parseAttrs: parseAttrs,
        filterCss: filterCss,
        filterLabel: filterLabel,
        drawTo: drawTo,
        toBlob: toBlob,
        isSameOrigin: isSameOrigin,
        version: '1.0.0',
        define: function () { if (root) define(root); }
    };
});
