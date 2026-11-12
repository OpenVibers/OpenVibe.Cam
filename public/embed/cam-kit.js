/* OpenVibe.Cam's browser recorder. It runs on the calling page and gives that page a File. */
(function (win) {
    'use strict';
    if (!win || win.OpenVibeCam) return;

    var script = win.document.currentScript;
    var cssUrl = script && script.src ? new URL('cam-kit.css', script.src).href : 'https://openvibe.cam/embed/cam-kit.css';
    var active = null;
    var MODES = ['video', 'photo', 'screen'];
    var CAPTURE_PATH = '/shared/ov-capture.js';
    var capture = null;
    var capturePending = null;
    var remote = null;

    // ── The shared capture core, from this page's own origin (the same arrangement Live's go-live page uses). ─────
    function captureSrc() {
        try { return new URL(CAPTURE_PATH, win.location.href).href; } catch (e) { return ''; }
    }

    /** A chosen camera is that camera, and its side is exact when its id has gone stale. */
    function install(core) {
        if (!core || !core.strategies || typeof core.use !== 'function') return core;
        if (!core.__ovCamExact && !core.__glExact) {
            var before = core.use('constraints', function (o) {
                var constraints = before(o || {});
                o = o || {};
                if (constraints.video && o.lens && o.lens !== 'main' && o.lens !== 'default' && o.lens !== '-') {
                    var rest = { ...constraints.video };
                    delete rest.facingMode;
                    delete rest.deviceId;
                    constraints.video = { ...rest, deviceId: { exact: o.lens } };
                }
                return constraints;
            });
            core.__ovCamExact = true;
        }
        var hasSide = core.strategies.list().some(function (s) { return s.name === 'side'; });
        if (!hasSide) {
            core.strategies.add({
                name: 'side',
                note: 'The chosen camera\'s side exactly (its id changed): the back camera stays the back camera.',
                open: function (o, c) {
                    if (!o.facing || o.video === false || o.mode === 'mic_only') {
                        var e = new Error('No side to ask for');
                        e.name = 'NotFoundError';
                        throw e;
                    }
                    var height = Number(o.resolution) || 720;
                    return c.part('getUserMedia')({
                        video: { facingMode: { exact: o.facing }, width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height } },
                        audio: o.mode !== 'camera_only' && o.audio !== false,
                    });
                },
            }, { before: 'basic' });
        }
        return core;
    }

    function settingsUrl() {
        try { return new URL('/api/v1/me/camera-settings', win.location.href).href; } catch (e) { return ''; }
    }

    /** Cam's camera settings for the person, when this page is on a site that serves them. */
    function camStore() {
        if (remote) return remote;
        var url = settingsUrl();
        if (!url || typeof win.fetch !== 'function') return null;
        var store = {
            latest: null,
            load: function () {
                return win.fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
                    if (!res.ok) throw new Error('No camera settings here');
                    return res.json();
                }).then(function (data) { store.latest = data; return data; });
            },
            save: function (values) {
                return win.fetch(url, {
                    method: 'PUT', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify(values),
                }).then(function (res) {
                    if (!res.ok) throw new Error('The camera settings were not saved');
                    return res.json();
                });
            },
        };
        remote = store;
        return store;
    }

    /** Let facing, resolution and mirror follow the person; the lens is this device's own id, applied here. */
    function syncSettings(core) {
        if (!core || !core.settings || typeof core.settings.sync !== 'function' || typeof core.on !== 'function') return Promise.resolve(core);
        var store = camStore();
        if (!store) return Promise.resolve(core);
        return new Promise(function (resolve) {
            var finished = false, offSynced = null, offFailed = null, timer = null;
            function finish() {
                if (finished) return;
                finished = true;
                if (offSynced) offSynced();
                if (offFailed) offFailed();
                if (timer) win.clearTimeout(timer);
                resolve(core);
            }
            offSynced = core.on('synced', function () {
                if (store.latest && typeof store.latest.lens === 'string' && store.latest.lens) {
                    try { core.settings.save({ lens: store.latest.lens }); } catch (e) { /* this device keeps its own */ }
                }
                finish();
            });
            offFailed = core.on('sync-failed', finish);
            timer = win.setTimeout(finish, 1500);
            try { core.settings.sync(store); } catch (e) { finish(); }
        });
    }

    function loadCapture() {
        if (capturePending) return capturePending;
        if (capture) return Promise.resolve(capture);
        if (win.OVCapture && typeof win.OVCapture.open === 'function') {
            capture = install(win.OVCapture);
            capturePending = syncSettings(capture);
            return capturePending;
        }
        var src = captureSrc();
        if (!src || !win.document || !win.document.createElement) return Promise.reject(new Error('The camera needs this page\'s address.'));
        capturePending = new Promise(function (resolve, reject) {
            var tag = win.document.createElement('script');
            tag.src = src;
            tag.async = true;
            tag.addEventListener('load', function () {
                if (win.OVCapture && typeof win.OVCapture.open === 'function') {
                    capture = install(win.OVCapture);
                    resolve(capture);
                } else {
                    if (tag.remove) tag.remove();
                    reject(new Error('The camera code loaded without OVCapture. Reload the page, then try again.'));
                }
            });
            tag.addEventListener('error', function () {
                if (tag.remove) tag.remove();
                reject(new Error('The camera code did not load. Reload the page, then try again.'));
            });
            (win.document.head || win.document.documentElement).appendChild(tag);
        }).then(syncSettings).catch(function (err) {
            capturePending = null;
            throw err;
        });
        return capturePending;
    }

    function constraintsFor(o) {
        o = o || {};
        var height = Number(o.resolution) || 720;
        return {
            video: o.video === false ? false : {
                facingMode: { ideal: o.facing || 'user' },
                ...(o.lens && o.lens !== 'main' && o.lens !== 'default' ? { deviceId: { ideal: o.lens } } : {}),
                width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height },
            },
            audio: o.audio === false ? false : o.mic && o.mic !== 'default' ? { deviceId: { ideal: o.mic } } : true,
        };
    }

    function networkFor() {
        if (win.navigator.onLine === false) return 'offline';
        var c = win.navigator.connection || win.navigator.mozConnection || win.navigator.webkitConnection;
        return c && (/2g|3g/.test(c.effectiveType || '') || c.downlink && c.downlink < 2.5) ? 'weak' : 'good';
    }

    function meterFor(stream, onLevel) {
        var AC = win.AudioContext || win.webkitAudioContext;
        if (!AC || !stream.getAudioTracks().length) return function () {};
        var ctx = new AC(), analyser = ctx.createAnalyser(), data = new Uint8Array(512), frame = 0, closed = false;
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        if (ctx.state === 'suspended') {
            ctx.resume().catch(function () {});
            win.document.addEventListener('pointerdown', function () { ctx.resume().catch(function () {}); }, { once: true, capture: true });
        }
        function tick() {
            if (closed) return;
            analyser.getByteTimeDomainData(data);
            var sum = 0;
            for (var i = 0; i < data.length; i++) { var d = (data[i] - 128) / 128; sum += d * d; }
            onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
            frame = win.requestAnimationFrame(tick);
        }
        frame = win.requestAnimationFrame(tick);
        return function () { closed = true; win.cancelAnimationFrame(frame); ctx.close().catch(function () {}); };
    }

    // Shared capture primitives for a site's in-place studio. Nothing requests permission until open() is called.
    var core = Object.freeze({
        devices: function () {
            return loadCapture().then(function (c) { return c.devices(); }, function () { return win.navigator.mediaDevices.enumerateDevices(); });
        },
        constraints: function (o) {
            if (capture && typeof capture.part === 'function') return capture.part('constraints')(o || {});
            return constraintsFor(o);
        },
        open: function (o) { return loadCapture().then(function (c) { return c.open(o || {}); }); },
        stop: stopTracks,
        network: function () {
            if (capture && typeof capture.network === 'function') return capture.network();
            return networkFor();
        },
        meter: function (stream, onLevel) {
            if (capture && typeof capture.meter === 'function') return capture.meter(stream, onLevel);
            return meterFor(stream, onLevel);
        },
    });

    function optionsFor(input) {
        var o = input || {};
        if (MODES.indexOf(o.mode || 'video') < 0) throw new TypeError('mode must be video, photo or screen');
        var seconds = Number(o.maxSeconds);
        if (!Number.isFinite(seconds) || seconds <= 0) seconds = 60;
        return { mode: o.mode || 'video', maxSeconds: Math.min(3600, Math.max(1, Math.round(seconds))), onDone: o.onDone, timer: [0, 3, 10].indexOf(Number(o.timer)) >= 0 ? Number(o.timer) : 0 };
    }

    function supported(mode, nav) {
        if (mode === 'screen') return !!(nav.mediaDevices && nav.mediaDevices.getDisplayMedia && win.MediaRecorder);
        return !!(nav.mediaDevices && nav.mediaDevices.getUserMedia && (mode === 'photo' || win.MediaRecorder));
    }

    function mime() {
        if (!win.MediaRecorder) return '';
        return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(function (type) {
            return win.MediaRecorder.isTypeSupported && win.MediaRecorder.isTypeSupported(type);
        }) || '';
    }

    function stopTracks(stream) {
        if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    }

    function secondsText(value) {
        var s = Math.max(0, Math.floor(value));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function open(input) {
        var opts = optionsFor(input);
        if (active) return Promise.reject(new Error('A camera is already open.'));
        return new Promise(function (resolve, reject) {
            var host = win.document.createElement('div');
            host.id = 'openvibe-cam-kit';
            var shadow = host.attachShadow({ mode: 'open' });
            var link = win.document.createElement('link');
            link.rel = 'stylesheet'; link.href = cssUrl;
            shadow.appendChild(link);
            var wrap = win.document.createElement('div');
            wrap.className = 'camkit';
            wrap.setAttribute('role', 'dialog');
            wrap.setAttribute('aria-modal', 'true');
            wrap.setAttribute('aria-label', 'OpenVibe camera');
            wrap.innerHTML = '<div class="stage"><video class="preview" autoplay playsinline muted></video><div class="shade"></div>' +
                '<header><button class="icon close" aria-label="Close camera"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><span class="brand">OpenVibe <strong>Cam</strong></span><span class="clock">0:00</span></header>' +
                '<div class="message" role="status"></div><div class="permission"><div class="permission-mark"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 10.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg></div><h2>Ready when you are</h2><p></p><button class="allow">Continue</button></div>' +
                '<div class="countdown" hidden></div><div class="review" hidden><video playsinline></video><img alt="Photo preview" hidden><button class="play" aria-label="Play clip"><svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg></button><div class="trim" hidden><div class="trim-head"><strong>Trim your clip</strong><span class="trim-label"></span></div><label>Start <input class="trim-start" type="range" min="0" step="0.1"></label><label>End <input class="trim-end" type="range" min="0" step="0.1"></label></div><div class="review-actions"><button class="retake">Retake</button><button class="use">Use this</button></div></div>' +
                '<footer><div class="tools"><button class="icon flip" aria-label="Flip camera" title="Flip camera"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4zM9.5 13.5a2.5 2.5 0 0 1 4.6-1.4M14.5 12.5a2.5 2.5 0 0 1-4.6 1.4M14.4 10.6v1.6h-1.6M9.6 15.4v-1.6h1.6"/></svg></button><button class="icon torch" aria-label="Toggle torch" title="Toggle torch"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3L6 13.5h5L10 21l8-11h-5.2z"/></svg></button><button class="icon timer" aria-label="Set timer" title="Set timer">0s</button></div><div class="shutter-row"><span class="mode-label"></span><button class="shutter" aria-label="Take photo or start recording"><span></span></button><span class="limit"></span></div><div class="hint"></div></footer></div>';
            shadow.appendChild(wrap);
            win.document.body.appendChild(host);
            var $ = function (s) { return shadow.querySelector(s); };
            var preview = $('.preview');
            var review = $('.review');
            var reviewVideo = $('.review video');
            var reviewImage = $('.review img');
            var stream = null, recorder = null, blob = null, url = null, tick = null, autoStop = null;
            var facing = 'user', facingLoaded = false, torch = false, phase = 'permission', done = false, lastFocus = win.document.activeElement;
            var captureCore = null;
            var duration = 0, trimStart = 0, trimEnd = 0, timer = opts.timer;
            active = host;
            $('.mode-label').textContent = opts.mode === 'photo' ? 'Photo' : opts.mode === 'screen' ? 'Screen' : 'Video';
            $('.limit').textContent = opts.mode === 'photo' ? '' : secondsText(opts.maxSeconds) + ' max';
            $('.permission p').textContent = opts.mode === 'screen' ? 'Choose the screen or window to record. Your browser will ask what to share.' : opts.mode === 'photo' ? 'Allow camera access to take a photo. Your photo stays here until you choose Use this.' : 'Allow camera and microphone access to record. Your clip stays here until you choose Use this.';
            $('.hint').textContent = opts.mode === 'photo' ? 'Tap the shutter for a photo' : 'Tap to start and stop · Space to record';
            $('.timer').textContent = timer + 's';
            $('.flip').hidden = opts.mode === 'screen';
            $('.torch').hidden = opts.mode === 'screen';
            $('.timer').hidden = opts.mode === 'screen';
            $('.allow').focus();

            function say(message) { $('.message').textContent = message || ''; }
            function cleanRecording() { win.clearInterval(tick); win.clearTimeout(autoStop); tick = null; autoStop = null; }
            function clearBlob() { if (url) win.URL.revokeObjectURL(url); url = null; blob = null; reviewVideo.removeAttribute('src'); reviewImage.removeAttribute('src'); }
            function close(result, error) {
                if (done) return;
                done = true; cleanRecording();
                if (recorder) { try { recorder.cancel(); } catch (e) { /* already stopped */ } recorder = null; }
                stopTracks(stream); stream = null; clearBlob();
                win.document.removeEventListener('keydown', keydown, true);
                host.remove(); active = null;
                if (lastFocus && lastFocus.focus) lastFocus.focus();
                if (error) reject(error); else resolve(result || null);
            }
            /** What happened and what to tap, in OVCapture's plain words. */
            function explained(err, mode) {
                if (captureCore && typeof captureCore.explain === 'function') {
                    try {
                        var said = captureCore.explain(err, mode);
                        if (said && said.title) return [said.title].concat(said.steps || []).join(' ');
                    } catch (e) { /* fall back to the error's own words */ }
                }
                return (err && err.message) || 'This camera is unavailable.';
            }
            function permissionError(err) {
                say(explained(err, opts.mode === 'screen' ? 'screen' : opts.mode === 'photo' ? 'camera_only' : 'camera'));
                phase = 'permission'; $('.permission').hidden = false;
            }
            function updateTorch() {
                var track = stream && stream.getVideoTracks()[0];
                var caps = track && track.getCapabilities ? track.getCapabilities() : {};
                $('.torch').hidden = !caps.torch;
                if (caps.torch) $('.torch').setAttribute('aria-pressed', String(torch));
            }
            async function start() {
                try {
                    captureCore = await loadCapture();
                } catch (err) { permissionError(err); return; }
                var can = typeof captureCore.can === 'function' ? captureCore.can() : null;
                var allowed = can ? (opts.mode === 'screen' ? can.screen : can.camera && (opts.mode === 'photo' || can.record))
                    : supported(opts.mode, win.navigator);
                if (!allowed) {
                    var noApi = new Error(opts.mode === 'screen' ? 'This browser has no screen sharing here' : 'This browser has no camera here');
                    noApi.name = 'NoApi';
                    permissionError(noApi);
                    return;
                }
                try {
                    if (!facingLoaded) {
                        var saved = captureCore.settings && typeof captureCore.settings.load === 'function' ? captureCore.settings.load() : {};
                        if (saved.facing === 'user' || saved.facing === 'environment') facing = saved.facing;
                        facingLoaded = true;
                    }
                    var next = opts.mode === 'screen' ? await captureCore.screen({ video: true, audio: true })
                        : await captureCore.open({ facing: facing, audio: opts.mode === 'video' });
                    if (done) { stopTracks(next); return; }
                    stopTracks(stream); stream = next;
                    preview.srcObject = stream; await preview.play();
                    if (done) return;
                    var videoTrack = stream.getVideoTracks()[0];
                    if (videoTrack) videoTrack.addEventListener('ended', function () { if (phase === 'recording') stopRecord(); else if (!done) say('Sharing ended.'); });
                    $('.permission').hidden = true; phase = 'ready'; say(''); updateTorch();
                } catch (err) { permissionError(err); }
            }
            function countdown() {
                if (!timer) return Promise.resolve();
                phase = 'countdown';
                return new Promise(function (resolveCountdown) {
                    var left = timer, el = $('.countdown'); el.hidden = false; el.textContent = left;
                    var id = win.setInterval(function () {
                        if (done || phase !== 'countdown') { win.clearInterval(id); el.hidden = true; resolveCountdown(false); return; }
                        left -= 1;
                        if (!left) { win.clearInterval(id); el.hidden = true; phase = 'ready'; resolveCountdown(true); }
                        else el.textContent = left;
                    }, 1000);
                });
            }
            function showReview(media, length) {
                blob = media; duration = length || 0; trimStart = 0; trimEnd = duration;
                stopTracks(stream); stream = null; preview.srcObject = null;
                url = win.URL.createObjectURL(blob);
                var photo = opts.mode === 'photo';
                reviewImage.hidden = !photo; reviewVideo.hidden = photo; $('.play').hidden = photo;
                if (photo) reviewImage.src = url; else reviewVideo.src = url;
                $('.trim').hidden = photo || duration < 0.2;
                $('.trim-start').max = String(duration); $('.trim-end').max = String(duration);
                $('.trim-start').value = '0'; $('.trim-end').value = String(duration);
                updateTrim(); review.hidden = false; phase = 'review';
                $('.use').focus();
            }
            async function capturePhoto() {
                var settings = captureCore.settings && typeof captureCore.settings.load === 'function' ? captureCore.settings.load() : {};
                var image = await captureCore.photo(stream, { mirror: !!settings.mirror && facing === 'user' });
                if (!image) throw new Error('The photo could not be encoded.');
                showReview(image, 0);
            }
            function stopRecord() {
                if (phase !== 'recording' || !recorder) return;
                var stopped = recorder;
                phase = 'stopping'; cleanRecording();
                stopped.stop().then(function (recorded) {
                    if (recorder === stopped) recorder = null;
                    if (done || phase !== 'stopping') return;
                    if (!recorded || !recorded.size) { phase = 'ready'; say('No video was recorded. Try again.'); return; }
                    showReview(recorded, stopped.seconds());
                }).catch(function (err) {
                    if (recorder === stopped) recorder = null;
                    if (done || phase !== 'stopping') return;
                    phase = 'ready';
                    say(explained(err, 'camera'));
                });
            }
            function record() {
                recorder = captureCore.record(stream, { maxSeconds: opts.maxSeconds });
                phase = 'recording';
                $('.shutter').classList.add('recording');
                $('.shutter').style.setProperty('--progress', '0%');
                tick = win.setInterval(function () {
                    var elapsed = recorder ? recorder.seconds() : 0;
                    $('.clock').textContent = secondsText(elapsed);
                    $('.shutter').style.setProperty('--progress', (100 * elapsed / opts.maxSeconds) + '%');
                }, 100);
                autoStop = win.setTimeout(stopRecord, opts.maxSeconds * 1000);
            }
            async function shutter() {
                if (phase === 'recording') { stopRecord(); return; }
                if (phase !== 'ready') return;
                if (!(await countdown())) { if (timer) return; }
                if (done || phase !== 'ready') return;
                try { if (opts.mode === 'photo') await capturePhoto(); else record(); }
                catch (err) { phase = 'ready'; say(explained(err, opts.mode === 'photo' ? 'camera_only' : 'camera')); }
            }
            function updateTrim() {
                var startInput = $('.trim-start'), endInput = $('.trim-end');
                trimStart = Math.min(Number(startInput.value), Math.max(0, Number(endInput.value) - 0.1));
                trimEnd = Math.max(Number(endInput.value), trimStart + 0.1);
                startInput.value = String(trimStart); endInput.value = String(trimEnd);
                $('.trim-label').textContent = secondsText(trimStart) + ' – ' + secondsText(trimEnd);
            }
            async function trimmedBlob() {
                if (trimStart <= 0 && trimEnd >= duration - 0.1) return blob;
                if (!reviewVideo.captureStream || !win.MediaRecorder) throw new Error('This browser cannot export a trimmed clip.');
                say('Preparing your trimmed clip…');
                reviewVideo.pause(); reviewVideo.currentTime = trimStart;
                await new Promise(function (resolveSeek, rejectSeek) {
                    if (Math.abs(reviewVideo.currentTime - trimStart) < 0.05 && reviewVideo.readyState >= 2) return resolveSeek();
                    reviewVideo.addEventListener('seeked', resolveSeek, { once: true });
                    reviewVideo.addEventListener('error', rejectSeek, { once: true });
                });
                var captured = reviewVideo.captureStream();
                if (!captured.getVideoTracks().length) throw new Error('This browser cannot export a trimmed clip.');
                var pieces = [], type = mime(), cutter = new win.MediaRecorder(captured, type ? { mimeType: type } : undefined);
                var output = new Promise(function (resolveCut, rejectCut) {
                    cutter.ondataavailable = function (event) { if (event.data && event.data.size) pieces.push(event.data); };
                    cutter.onerror = function () { rejectCut(new Error('The trim could not be exported.')); };
                    cutter.onstop = function () { var cut = new Blob(pieces, { type: cutter.mimeType || type || blob.type }); cut.size ? resolveCut(cut) : rejectCut(new Error('The trim was empty.')); };
                });
                cutter.start(200); await reviewVideo.play();
                await new Promise(function (resolvePlay) {
                    var until = win.setInterval(function () { if (reviewVideo.currentTime >= trimEnd || reviewVideo.ended || done) { win.clearInterval(until); resolvePlay(); } }, 40);
                });
                cutter.stop(); reviewVideo.pause();
                return output;
            }
            function keydown(event) {
                if (event.key === 'Escape') { event.preventDefault(); close(); }
                if (event.code === 'Space' && event.target.tagName !== 'BUTTON' && event.target.tagName !== 'INPUT' && phase !== 'review') { event.preventDefault(); shutter(); }
            }
            $('.close').onclick = function () { close(); };
            $('.allow').onclick = start;
            $('.shutter').onclick = shutter;
            $('.flip').onclick = async function () {
                if (phase !== 'ready') return;
                facing = facing === 'user' ? 'environment' : 'user'; torch = false;
                if (captureCore && captureCore.settings) captureCore.settings.save({ facing: facing });
                await start();
            };
            $('.torch').onclick = async function () {
                var track = stream && stream.getVideoTracks()[0]; if (!track) return;
                try { torch = !torch; await track.applyConstraints({ advanced: [{ torch: torch }] }); updateTorch(); }
                catch { torch = false; say('Torch is unavailable on this camera.'); }
            };
            $('.timer').onclick = function () { timer = timer === 0 ? 3 : timer === 3 ? 10 : 0; $('.timer').textContent = timer + 's'; };
            $('.trim-start').oninput = updateTrim; $('.trim-end').oninput = updateTrim;
            $('.play').onclick = function () { if (reviewVideo.paused) reviewVideo.play(); else reviewVideo.pause(); };
            // The play button's own icon: a filled triangle, two bars while it plays (an SVG path, never a text glyph).
            var playPath = function (d, label) { var p = $('.play path'); if (p) p.setAttribute('d', d); $('.play').setAttribute('aria-label', label); };
            reviewVideo.onplay = function () { playPath('M7 5h3.5v14H7zM13.5 5H17v14h-3.5z', 'Pause clip'); };
            reviewVideo.onpause = function () { playPath('M8 5.5v13l11-6.5z', 'Play clip'); };
            $('.retake').onclick = function () { clearBlob(); review.hidden = true; $('.shutter').classList.remove('recording'); $('.clock').textContent = '0:00'; phase = 'permission'; $('.permission').hidden = false; start(); };
            $('.use').onclick = async function () {
                if (phase !== 'review') return;
                phase = 'exporting'; $('.use').disabled = true;
                try {
                    var output = opts.mode === 'photo' ? blob : await trimmedBlob();
                    var ext = opts.mode === 'photo' ? 'jpg' : output.type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
                    var file = new File([output], 'openvibe-' + opts.mode + '-' + Date.now() + '.' + ext, { type: output.type });
                    var result = { file: file, mode: opts.mode, mimeType: output.type, duration: opts.mode === 'photo' ? 0 : trimEnd - trimStart, width: opts.mode === 'photo' ? reviewImage.naturalWidth : reviewVideo.videoWidth, height: opts.mode === 'photo' ? reviewImage.naturalHeight : reviewVideo.videoHeight, maxSeconds: opts.maxSeconds };
                    if (typeof opts.onDone === 'function') await opts.onDone(result);
                    close(result);
                } catch (err) { phase = 'review'; $('.use').disabled = false; say(err.message || 'The file could not be prepared.'); }
            };
            win.document.addEventListener('keydown', keydown, true);
        });
    }

    win.OpenVibeCam = Object.freeze({ open: open, core: core });
    if (typeof module === 'object' && module.exports) module.exports = { optionsFor: optionsFor, supported: supported, secondsText: secondsText };
})(typeof window !== 'undefined' ? window : null);
