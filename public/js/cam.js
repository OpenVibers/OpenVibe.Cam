/* OpenVibe.Cam: the camera app's enhancement. The page is complete without it; with it, the preview runs, the
 * timer, burst and grid work, and the on-device filter is applied to the canvas before the picture is posted to
 * /api/v1/photos. The picture goes to OpenVibe.Pics; Cam never receives it as anything but a request body. */
(function () {
    'use strict';

    var root = document.getElementById('cm-camera');
    if (!root) return;
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
    var stream = null;
    var busy = false;

    var FILTERS = {
        none: 'none',
        mono: 'grayscale(1) contrast(1.08)',
        warm: 'sepia(.35) saturate(1.15)',
        cool: 'hue-rotate(-10deg) saturate(1.1)',
        fade: 'saturate(.8) contrast(.92) brightness(1.06)',
        vivid: 'saturate(1.45) contrast(1.06)',
        blur: 'blur(1.5px)'
    };

    function say(text) { if (statusEl) statusEl.textContent = text; }

    function start() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            say('This browser has no camera input. Pick a picture below instead.');
            return;
        }
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then(function (s) {
            stream = s;
            video.srcObject = s;
            return video.play();
        }).then(function () {
            shootBtn.disabled = false;
            startBtn.textContent = 'Camera on';
            say('The camera is on. Nothing is recorded.');
        }).catch(function () {
            say('The camera was not allowed. Allow it in the browser, or pick a picture below.');
        });
    }

    function drawFiltered() {
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
        drawFiltered();
        canvas.toBlob(function (blob) { if (blob) upload(blob, 'image/jpeg', filterSel.value); }, 'image/jpeg', 0.92);
    }

    function countdown(n) {
        if (n <= 0) { snap(); return; }
        say(n + '…');
        setTimeout(function () { countdown(n - 1); }, 1000);
    }

    function shoot() {
        var n = parseInt(timerSel.value, 10) || 0;
        if (n > 0) countdown(n); else snap();
    }

    function burst() {
        if (!stream) { say('Turn the camera on first.'); return; }
        say('Burst of three…');
        for (var i = 0; i < 3; i++) setTimeout(snap, i * 450);
    }

    startBtn.addEventListener('click', start);
    shootBtn.addEventListener('click', shoot);
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
    window.addEventListener('pagehide', function () {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    });
})();
