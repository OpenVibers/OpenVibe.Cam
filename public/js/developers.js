/* OpenVibe.Cam /developers: the live <ov-camera> demo. A capture is shown on this page only; the element itself has
 * upload="off", so nothing is sent. The docs' copy-paste snippet is the same listener, without this page's chrome. */
(function () {
    'use strict';
    var demo = document.getElementById('cm-ov-demo');
    var shots = document.getElementById('cm-ov-demo-shots');
    var status = document.getElementById('cm-ov-demo-status');
    if (!demo || !shots) return;

    function say(text) { if (status) status.textContent = text; }

    document.addEventListener('ov-camera:capture', function (e) {
        if (e.target !== demo || !e.detail || !e.detail.blob) return;
        var d = e.detail;
        var li = document.createElement('li');
        li.className = 'cm-photo';
        var link = document.createElement('a');
        link.className = 'cm-photo-link';
        link.rel = 'noopener';
        link.download = 'ov-camera-demo.jpg';
        var img = document.createElement('img');
        img.alt = 'A photo from the ov-camera demo';
        img.width = 320;
        img.height = 240;
        var url = URL.createObjectURL(d.blob);
        img.src = url;
        link.href = url;
        link.appendChild(img);
        li.appendChild(link);
        shots.insertBefore(li, shots.firstChild);
        say('Captured ' + d.width + '×' + d.height + ' · ' + d.filter + ' · it stayed in this page.');
        // The link keeps the blob alive while the photo is shown; the page revokes it when it goes away.
        window.addEventListener('pagehide', function () { URL.revokeObjectURL(url); }, { once: true });
    });

    document.addEventListener('ov-camera:error', function (e) {
        if (e.target !== demo || !e.detail) return;
        say(e.detail.message || 'The camera stopped.');
    });
})();
