// §8.9: the camera QR reader on /add. Two decoders:
//   1. the browser's BarcodeDetector (Chrome/Edge/Android) when it has qr_code;
//   2. otherwise jsQR (/vendor/jsQR.js), a proven decoder that runs on canvas
//      pixels (Safari/iOS reaches this path).
// A read sticker navigates straight to /r/<code>, where the normal register form is.
(function () {
  "use strict";

  var root = document.querySelector("[data-scanner-root]");
  if (!root) return;

  var video = root.querySelector("[data-scanner-video]");
  var status = root.querySelector("[data-scanner-status]");
  var startBtn = root.querySelector("[data-scanner-start]");
  var stopBtn = root.querySelector("[data-scanner-stop]");

  var msg = {
    denied: root.getAttribute("data-msg-denied") || "",
    unsupported: root.getAttribute("data-msg-unsupported") || "",
    scanning: root.getAttribute("data-msg-scanning") || "",
    notours: root.getAttribute("data-msg-notours") || "",
  };

  var stream = null;
  var raf = 0;
  var last = 0;
  var busy = false;
  var canvas = null;
  var ctx = null;
  var detector = null;

  function say(text) {
    if (status) status.textContent = text;
  }

  // BarcodeDetector's format support check is async; until it resolves we use the
  // bundled decoder, so the first frames are never dropped.
  if ("BarcodeDetector" in window && typeof BarcodeDetector.getSupportedFormats === "function") {
    BarcodeDetector.getSupportedFormats()
      .then(function (formats) {
        if (formats && formats.indexOf("qr_code") !== -1) detector = new BarcodeDetector({ formats: ["qr_code"] });
      })
      .catch(function () {});
  }

  // Our stickers hold "<origin>/r/<code>"; accept that, a pasted link, or a bare code.
  function go(text) {
    var s = String(text || "").trim();
    var m = /\/r\/([0-9A-Za-z]{4,40})/.exec(s) || /^([0-9A-Za-z]{4,40})$/.exec(s);
    if (!m) {
      say(msg.notours);
      return false;
    }
    stop();
    location.href = "/r/" + m[1];
    return true;
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (ts - last < 200) return; // ~5 reads a second: enough for a hand-held phone, light on the battery
    last = ts;
    if (busy || !video.videoWidth || !video.videoHeight) return;
    busy = true;

    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var scale = Math.min(1, 480 / Math.max(vw, vh)); // 480 px wide keeps a frame well under 200 ms
    var w = Math.max(1, Math.round(vw * scale));
    var h = Math.max(1, Math.round(vh * scale));
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);

    var done = false;
    function finish(text) {
      if (done) return;
      done = true;
      busy = false;
      if (text) go(text);
    }

    function useJsQR() {
      var dec = window.jsQR;
      if (typeof dec !== "function") {
        busy = false;
        say(msg.unsupported);
        stop();
        return;
      }
      var image;
      try {
        image = ctx.getImageData(0, 0, w, h);
      } catch (e) {
        finish(null);
        return;
      }
      var text = null;
      try {
        var hit = dec(image.data, w, h, { inversionAttempts: "dontInvert" });
        text = hit && hit.data;
      } catch (e) {
        text = null;
      }
      finish(text || null);
    }

    if (detector) {
      detector
        .detect(canvas)
        .then(function (codes) {
          if (codes && codes.length && codes[0] && codes[0].rawValue) finish(codes[0].rawValue);
          else useJsQR();
        })
        .catch(useJsQR);
    } else {
      useJsQR();
    }
  }

  function start() {
    if (stream) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      say(msg.unsupported);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.hidden = false;
        var playing = video.play && video.play();
        if (playing && playing.catch) playing.catch(function () {});
        startBtn.hidden = true;
        stopBtn.hidden = false;
        say(msg.scanning);
        raf = requestAnimationFrame(frame);
      })
      .catch(function (err) {
        var name = err && err.name;
        say(name === "NotAllowedError" || name === "SecurityError" ? msg.denied : msg.unsupported);
      });
  }

  function stop() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (stream) {
      var tracks = stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      stream = null;
    }
    if (video) {
      if (video.pause) video.pause();
      video.srcObject = null;
      video.hidden = true;
    }
    if (startBtn) startBtn.hidden = false;
    if (stopBtn) stopBtn.hidden = true;
  }

  if (startBtn) startBtn.addEventListener("click", start);
  if (stopBtn) stopBtn.addEventListener("click", stop);
  window.addEventListener("pagehide", stop);
})();
