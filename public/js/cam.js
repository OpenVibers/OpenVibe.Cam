/* OpenVibe.Cam: the camera app's enhancement. The page is complete without it; with it, the preview runs, the
 * timer, burst and grid work, and the on-device filter is applied to the canvas before the picture is posted to
 * /api/v1/photos. The picture goes to OpenVibe.Pics; Cam never receives it as anything but a request body. */
(function () {
    'use strict';

    // One source for the filters and the canvas capture: the <ov-camera> element in public/embed/ov-camera.js.
    // The layout loads that file before this one, so the app and an embed cannot drift apart.
    var CORE = window.OVCameraCore || null;
    var FILTERS = (CORE && CORE.FILTERS) || {
        none: 'none',
        mono: 'grayscale(1) contrast(1.08)',
        warm: 'sepia(.35) saturate(1.15)',
        cool: 'hue-rotate(-10deg) saturate(1.1)',
        fade: 'saturate(.8) contrast(.92) brightness(1.06)',
        vivid: 'saturate(1.45) contrast(1.06)',
        blur: 'blur(1.5px)'
    };

    // The camera on the page now. Leaving the page, for good or for another one swapped in place (boost), turns it off.
    var stopCamera = null;
    function off() { if (stopCamera) { stopCamera(); stopCamera = null; } }
    window.addEventListener('pagehide', off);
    document.addEventListener('ov:boost:before', off);

    // The camera app is wired when its page is shown: on load, and when boost swaps it in (a link from the home or the
    // navbar). It used to be wired only on load, so a visit from another page left a camera that did nothing.
    function wire() {
        var root = document.getElementById('cm-camera');
        if (!root || root.dataset.cmReady) return;
        root.dataset.cmReady = '1';
        var video = root.querySelector('[data-cm-preview]');
        var canvas = root.querySelector('[data-cm-canvas]');
        var statusEl = root.querySelector('[data-cm-status]');
        var startBtn = root.querySelector('[data-cm-start]');
        var shootBtn = root.querySelector('[data-cm-shoot]');
        var timerSel = root.querySelector('[data-cm-timer]');
        var burstBtn = root.querySelector('[data-cm-burst]');
        var filterSel = root.querySelector('[data-cm-filter]');
        var captionEl = root.querySelector('[data-cm-caption]');
        var gridBtn = root.querySelector('[data-cm-grid-toggle]');
        var gridEl = root.querySelector('[data-cm-grid]');
        var fileInput = root.querySelector('[data-cm-file]');
        var gallery = document.getElementById('cm-gallery');
        // The app's own controls (11-07): flip, the timer pill, the filter strip, the modes, the flash and the thumb.
        var flipBtn = root.querySelector('[data-cm-flip]');
        var timerBtn = root.querySelector('[data-cm-timer-btn]');
        var timerLabel = root.querySelector('[data-cm-timer-label]');
        var flashEl = root.querySelector('[data-cm-flash]');
        var countEl = root.querySelector('[data-cm-count]');
        var thumb = root.querySelector('[data-cm-thumb]');
        var picks = Array.prototype.slice.call(root.querySelectorAll('[data-cm-filter-pick]'));
        var modeBtns = Array.prototype.slice.call(root.querySelectorAll('[data-cm-mode]'));
        var facing = 'environment';
        var mode = 'photo';
        var stream = null;
        var busy = false;


        function say(text) { if (statusEl) statusEl.textContent = text; }

        function start() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                say('This browser has no camera input. Pick a picture instead.');
                return Promise.resolve(false);
            }
            if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
            // A phone opens on its back camera; a computer on whatever it has. Flip swaps them.
            return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false }).then(function (s) {
                stream = s;
                video.srcObject = s;
                var track = s.getVideoTracks()[0];
                var settings = track && track.getSettings ? track.getSettings() : {};
                root.dataset.facing = settings.facingMode || (facing === 'user' ? 'user' : 'environment');
                return video.play();
            }).then(function () {
                shootBtn.disabled = false;
                root.dataset.state = 'on';
                say('The camera is on. Nothing is recorded.');
                return true;
            }).catch(function () {
                root.dataset.state = 'off';
                say('The camera was not allowed. Allow it in the browser, or pick a picture.');
                return false;
            });
        }
        // The filter shows live on the preview, the way a phone camera does.
        function setFilter(name) {
            filterSel.value = name;
            video.style.filter = FILTERS[name] || 'none';
            picks.forEach(function (b) { b.setAttribute('aria-checked', b.dataset.cmFilterPick === name ? 'true' : 'false'); });
        }
        function flash() {
            if (!flashEl) return;
            flashEl.classList.remove('is-on'); void flashEl.offsetWidth; flashEl.classList.add('is-on');
            shootBtn.classList.add('is-firing');
            setTimeout(function () { shootBtn.classList.remove('is-firing'); }, 160);
            if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* not every browser */ } }
        }

        function drawFiltered() {
            if (CORE && CORE.drawTo) { CORE.drawTo(canvas, video, filterSel.value); return; }
            var w = video.videoWidth || 1280;
            var h = video.videoHeight || 720;
            canvas.width = w;
            canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.filter = FILTERS[filterSel.value] || 'none';
            ctx.drawImage(video, 0, 0, w, h);
        }

        function addToGallery(p) {
            if (!gallery || !p || !p.pics_direct) return;
            var list = gallery.querySelector('.cm-photos');
            if (!list) {
                list = document.createElement('ul');
                list.className = 'cm-photos';
                gallery.appendChild(list);
            }
            var li = document.createElement('li');
            li.className = 'cm-photo';
            var a = document.createElement('a');
            a.className = 'cm-photo-link';
            a.href = p.pics_url;
            a.rel = 'noopener';
            var img = document.createElement('img');
            img.src = p.pics_direct;
            img.alt = p.caption || 'A photo on OpenVibe.Cam';
            img.loading = 'lazy';
            a.appendChild(img);
            li.appendChild(a);
            list.insertBefore(li, list.firstChild);
            // The thumb shows the newest photo, with a small pop.
            if (thumb) {
                thumb.textContent = '';
                var t = document.createElement('img'); t.src = p.pics_direct; t.alt = ''; thumb.appendChild(t);
                thumb.classList.remove('is-new'); void thumb.offsetWidth; thumb.classList.add('is-new');
            }
        }

        function upload(blob, type, filterName) {
            if (busy) return Promise.resolve(null);
            busy = true;
            var headers = { 'Content-Type': type, 'X-Filter': filterName || 'none', 'X-Filename': encodeURIComponent('cam-' + Date.now() + '.jpg') };
            var caption = captionEl && captionEl.value ? captionEl.value : '';
            if (caption) headers['X-Caption'] = encodeURIComponent(caption);
            return fetch('/api/v1/photos', { method: 'POST', credentials: 'same-origin', headers: headers, body: blob })
                .then(function (res) {
                    return res.json().catch(function () { return {}; }).then(function (body) {
                        if (res.status === 401 || res.status === 403) { say('Sign in to save this photo to OpenVibe.Pics.'); return null; }
                        if (!res.ok) { say((body && body.detail) || 'The photo was not saved.'); return null; }
                        say('Saved to OpenVibe.Pics.');
                        addToGallery(body);
                        return body;
                    });
                })
                .catch(function () { say('The photo was not saved: the network did not answer.'); return null; })
                .then(function (out) { busy = false; return out; });
        }

        function snap() {
            if (!stream) { say('Turn the camera on first.'); return; }
            flash();
            drawFiltered();
            canvas.toBlob(function (blob) { if (blob) upload(blob, 'image/jpeg', filterSel.value); }, 'image/jpeg', 0.92);
        }

        function countdown(n) {
            if (n <= 0) { if (countEl) countEl.textContent = ''; if (mode === 'burst') burst(); else snap(); return; }
            say(n + '…');
            if (countEl) { countEl.textContent = String(n); countEl.classList.remove('is-tick'); void countEl.offsetWidth; countEl.classList.add('is-tick'); }
            setTimeout(function () { countdown(n - 1); }, 1000);
        }

        function shoot() {
            // The shutter turns the camera on when it is off, like opening a phone camera.
            if (!stream) { start(); return; }
            var n = parseInt(timerSel.value, 10) || 0;
            if (n > 0) countdown(n); else if (mode === 'burst') burst(); else snap();
        }

        function burst() {
            if (!stream) { say('Turn the camera on first.'); return; }
            say('Burst of three…');
            for (var i = 0; i < 3; i++) setTimeout(snap, i * 450);
        }

        startBtn.addEventListener('click', start);
        shootBtn.disabled = false;
        shootBtn.addEventListener('click', shoot);
        if (flipBtn) flipBtn.addEventListener('click', function () { facing = facing === 'user' ? 'environment' : 'user'; if (stream) start(); });
        if (timerBtn) timerBtn.addEventListener('click', function () {
            var steps = ['0', '3', '5', '10'];
            var next = steps[(steps.indexOf(timerSel.value) + 1) % steps.length];
            timerSel.value = next;
            if (timerLabel) timerLabel.textContent = next === '0' ? 'Off' : next + 's';
            timerBtn.classList.toggle('is-set', next !== '0');
            timerBtn.setAttribute('aria-label', next === '0' ? 'Timer: off' : 'Timer: ' + next + ' seconds');
        });
        picks.forEach(function (b) { b.addEventListener('click', function () { setFilter(b.dataset.cmFilterPick); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }); });
        modeBtns.forEach(function (b) { b.addEventListener('click', function () {
            mode = b.dataset.cmMode;
            root.dataset.mode = mode;
            modeBtns.forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
            shootBtn.setAttribute('aria-label', mode === 'burst' ? 'Take three photos' : 'Take the photo');
        }); });
        burstBtn.addEventListener('click', burst);
        if (gridBtn) gridBtn.addEventListener('click', function () {
            if (!gridEl) return;
            var show = gridEl.hidden;
            gridEl.hidden = !show;
            gridBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
        });
        if (fileInput) fileInput.addEventListener('change', function () {
            var f = fileInput.files && fileInput.files[0];
            if (!f) return;
            if (!/^image\//.test(f.type)) { say('That is not a picture.'); return; }
            upload(f, f.type, 'none');
            fileInput.value = '';
        });
        stopCamera = function () { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; };
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
    document.addEventListener('ov:boost:load', wire);
})();
