/* OpenVibe.Cam's browser recorder. It runs on the calling page and gives that page a File. */
(function (win) {
    'use strict';
    if (!win || win.OpenVibeCam) return;

    var script = win.document.currentScript;
    var cssUrl = script && script.src ? new URL('cam-kit.css', script.src).href : 'https://openvibe.cam/embed/cam-kit.css';
    var active = null;
    var MODES = ['video', 'photo', 'screen'];

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
                '<header><button class="icon close" aria-label="Close camera">×</button><span class="brand">OpenVibe <strong>Cam</strong></span><span class="clock">0:00</span></header>' +
                '<div class="message" role="status"></div><div class="permission"><div class="permission-mark">◎</div><h2>Ready when you are</h2><p></p><button class="allow">Continue</button></div>' +
                '<div class="countdown" hidden></div><div class="review" hidden><video playsinline></video><img alt="Photo preview" hidden><button class="play" aria-label="Play clip">▶</button><div class="trim" hidden><div class="trim-head"><strong>Trim your clip</strong><span class="trim-label"></span></div><label>Start <input class="trim-start" type="range" min="0" step="0.1"></label><label>End <input class="trim-end" type="range" min="0" step="0.1"></label></div><div class="review-actions"><button class="retake">Retake</button><button class="use">Use this</button></div></div>' +
                '<footer><div class="tools"><button class="icon flip" aria-label="Flip camera" title="Flip camera">↻</button><button class="icon torch" aria-label="Toggle torch" title="Toggle torch">☼</button><button class="icon timer" aria-label="Set timer" title="Set timer">0s</button></div><div class="shutter-row"><span class="mode-label"></span><button class="shutter" aria-label="Take photo or start recording"><span></span></button><span class="limit"></span></div><div class="hint"></div></footer></div>';
            shadow.appendChild(wrap);
            win.document.body.appendChild(host);
            var $ = function (s) { return shadow.querySelector(s); };
            var preview = $('.preview');
            var review = $('.review');
            var reviewVideo = $('.review video');
            var reviewImage = $('.review img');
            var stream = null, recorder = null, chunks = [], blob = null, url = null, started = 0, tick = null, autoStop = null;
            var facing = 'user', torch = false, phase = 'permission', done = false, lastFocus = win.document.activeElement;
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
                if (recorder && recorder.state !== 'inactive') recorder.stop();
                stopTracks(stream); stream = null; clearBlob();
                win.document.removeEventListener('keydown', keydown, true);
                host.remove(); active = null;
                if (lastFocus && lastFocus.focus) lastFocus.focus();
                if (error) reject(error); else resolve(result || null);
            }
            function permissionError(err) {
                var denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
                say(denied ? 'Permission was not granted. You can try again.' : (err && err.message) || 'This camera is unavailable.');
                phase = 'permission'; $('.permission').hidden = false;
            }
            function updateTorch() {
                var track = stream && stream.getVideoTracks()[0];
                var caps = track && track.getCapabilities ? track.getCapabilities() : {};
                $('.torch').hidden = !caps.torch;
                if (caps.torch) $('.torch').setAttribute('aria-pressed', String(torch));
            }
            async function start() {
                if (!supported(opts.mode, win.navigator)) { say('This browser cannot use the selected camera mode.'); return; }
                try {
                    var next = opts.mode === 'screen' ? await win.navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }) : await win.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: opts.mode === 'video' });
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
                var canvas = win.document.createElement('canvas');
                canvas.width = preview.videoWidth || 1280; canvas.height = preview.videoHeight || 720;
                canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height);
                var image = await new Promise(function (resolveImage) { canvas.toBlob(resolveImage, 'image/jpeg', 0.92); });
                if (!image) throw new Error('The photo could not be encoded.');
                showReview(image, 0);
            }
            function stopRecord() {
                if (phase !== 'recording' || !recorder) return;
                phase = 'stopping'; cleanRecording(); recorder.stop();
            }
            function record() {
                chunks = [];
                var type = mime(); recorder = new win.MediaRecorder(stream, type ? { mimeType: type } : undefined);
                recorder.ondataavailable = function (event) { if (event.data && event.data.size) chunks.push(event.data); };
                recorder.onerror = function () { say('Recording failed. Please retake.'); };
                recorder.onstop = function () {
                    if (done || phase !== 'stopping') return;
                    var length = Math.min(opts.maxSeconds, (Date.now() - started) / 1000);
                    var recorded = new Blob(chunks, { type: recorder.mimeType || type || 'video/webm' });
                    if (!recorded.size) { phase = 'ready'; say('No video was recorded. Try again.'); return; }
                    showReview(recorded, length);
                };
                recorder.start(200); started = Date.now(); phase = 'recording';
                $('.shutter').classList.add('recording');
                $('.shutter').style.setProperty('--progress', '0%');
                tick = win.setInterval(function () {
                    var elapsed = Math.min(opts.maxSeconds, (Date.now() - started) / 1000);
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
                catch (err) { phase = 'ready'; say(err.message || 'Capture failed.'); }
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
                facing = facing === 'user' ? 'environment' : 'user'; torch = false; await start();
            };
            $('.torch').onclick = async function () {
                var track = stream && stream.getVideoTracks()[0]; if (!track) return;
                try { torch = !torch; await track.applyConstraints({ advanced: [{ torch: torch }] }); updateTorch(); }
                catch { torch = false; say('Torch is unavailable on this camera.'); }
            };
            $('.timer').onclick = function () { timer = timer === 0 ? 3 : timer === 3 ? 10 : 0; $('.timer').textContent = timer + 's'; };
            $('.trim-start').oninput = updateTrim; $('.trim-end').oninput = updateTrim;
            $('.play').onclick = function () { if (reviewVideo.paused) reviewVideo.play(); else reviewVideo.pause(); };
            reviewVideo.onplay = function () { $('.play').textContent = 'Ⅱ'; $('.play').setAttribute('aria-label', 'Pause clip'); };
            reviewVideo.onpause = function () { $('.play').textContent = '▶'; $('.play').setAttribute('aria-label', 'Play clip'); };
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

    win.OpenVibeCam = Object.freeze({ open: open });
    if (typeof module === 'object' && module.exports) module.exports = { optionsFor: optionsFor, supported: supported, secondsText: secondsText };
})(typeof window !== 'undefined' ? window : null);
