// The only always-loaded browser script (SPEC.md §5.2): print button, the qty +1/−1
// buttons (fetch), photo downscaling and the service worker of the PWA. Every page works without it: the same controls are real forms,
// the code is printed as text under every QR, and uploads go as they are.
(function () {
  "use strict";

  // §8.3: the +1/−1 buttons post to /r/:code/qty; with JS they fetch instead of
  // navigating and update the number in place. Server stays the source of truth.
  function wireQty() {
    var buttons = document.querySelectorAll("button[data-qty-delta]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        var form = btn.form;
        if (!form || !window.fetch) return; // no fetch: let the form post normally
        ev.preventDefault();
        var body = new URLSearchParams(new FormData(form));
        btn.disabled = true;
        fetch(form.getAttribute("action") || form.action, {
          method: "POST",
          body: body,
          credentials: "same-origin",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var out = document.querySelector("[data-qty-value]");
            if (out && typeof data.qty === "number") out.textContent = String(data.qty);
          })
          .catch(function () {
            // whole-page fallback: a normal form submit
            form.submit();
          })
          .then(function () {
            btn.disabled = false;
          });
      });
    }
  }

  // Copy the sticker code as text (progressive enhancement, no permission prompts).
  function wireCopy() {
    var nodes = document.querySelectorAll("[data-copy]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        if (!navigator.clipboard) return;
        ev.preventDefault();
        navigator.clipboard.writeText(btn.getAttribute("data-copy")).then(function () {
          btn.dataset.copied = "1";
        });
      });
    }
  }

  // §8.8: a phone photo is 3–5 MB. Redraw it at 1200 px as JPEG when it is picked,
  // swap the file input for a `photo_data` field, and the normal form post carries
  // ~150 KB. Without canvas the file input stays and the server takes the original.
  var MAX_EDGE = 1200;
  function wirePhoto() {
    var inputs = document.querySelectorAll('input[type="file"][name="photo"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener("change", function (ev) {
        var node = ev.currentTarget;
        var file = node.files && node.files[0];
        if (!file || !/^image\//.test(file.type) || file.size < 150 * 1024) return;
        if (!window.URL || !URL.createObjectURL || !window.Image) return;
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          var data;
          try {
            data = canvas.toDataURL("image/jpeg", 0.75);
          } catch (e) {
            return;
          }
          if (!data || data.length < 100) return;
          var hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = "photo_data";
          hidden.value = data;
          if (node.parentNode) node.parentNode.replaceChild(hidden, node);
          var preview = document.querySelector("[data-photo-preview]");
          if (preview) {
            preview.src = data;
            preview.hidden = false;
          }
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
        };
        img.src = url;
      });
    }
  }

  // Print button: the sheet is already laid out for A4 (§8.7).
  var printBtn = document.querySelector("button[data-print]");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  // §8.10: the PWA shell is cached for offline use and for the home-screen icon.
  // Registration only works over https or localhost, so plain-http LAN visits skip it.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  wireQty();
  wireCopy();
  wirePhoto();
})();
