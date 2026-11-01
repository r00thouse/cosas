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

  // §8.8: a phone photo is 3–5 MB. Redraw each picked file at 1200 px as JPEG and
  // add it as a hidden `photo_data` field, so the normal form post carries ~150 KB
  // per photo. The file input is swapped for an empty clone after every pick, which
  // lets the operator take one photo, then another, without ever posting the originals.
  // Without canvas the input stays and the server takes what the browser sends.
  var MAX_EDGE = 1200;
  // Cropped output is allowed to be a little larger than a downscaled upload: a
  // crop keeps pixels the operator chose, and phones are the only way to see them.
  var CROP_EDGE = 1600;
  var MAX_PHOTOS = 8;
  var scaled = 0;

  function downscale(file, done) {
    if (!window.URL || !URL.createObjectURL || !window.Image || !window.HTMLCanvasElement) return done(null);
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      var data = null;
      try {
        data = canvas.toDataURL("image/jpeg", 0.75);
      } catch (e) {
        data = null;
      }
      done(data && data.length > 100 ? data : null);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      done(null);
    };
    img.src = url;
  }

  function addHidden(form, data) {
    var hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "photo_data";
    hidden.value = data;
    form.appendChild(hidden);
  }

  function showPreview(container, data) {
    var img = document.createElement("img");
    img.src = data;
    img.alt = "";
    container.appendChild(img);
  }

  /** Read a file as a data URL, for a small image or when canvas is unavailable. */
  function readRaw(file, done) {
    if (!window.FileReader) return done(null);
    var reader = new FileReader();
    reader.onload = function () {
      done(typeof reader.result === "string" && reader.result.indexOf("data:image/") === 0 ? reader.result : null);
    };
    reader.onerror = function () {
      done(null);
    };
    reader.readAsDataURL(file);
  }

  // §8.8, optional crop step. The <dialog> markup is a server-rendered <template>
  // (so its labels are translated like everything else); Cropper.js gives the
  // touch-friendly box. No Cropper, no <dialog> or no blob URLs -> the photo is used
  // whole, exactly as before, so this is a pure enhancement.
  var crop = { dialog: null, api: null, settle: null, url: null };

  function cropReady() {
    return Boolean(window.Cropper && window.HTMLDialogElement && window.URL && URL.createObjectURL);
  }

  function buildCropDialog() {
    if (crop.dialog) return crop.dialog;
    var tpl = document.querySelector("template[data-crop-template]");
    if (!tpl || !tpl.content || !tpl.content.firstElementChild) return null;
    crop.dialog = tpl.content.firstElementChild.cloneNode(true);
    document.body.appendChild(crop.dialog);
    var img = crop.dialog.querySelector("[data-crop-image]");
    crop.dialog.querySelector("[data-crop-rotate]").addEventListener("click", function () {
      if (crop.api) crop.api.rotate(90);
    });
    crop.dialog.querySelector("[data-crop-whole]").addEventListener("click", function () {
      finishCrop(null);
    });
    crop.dialog.querySelector("[data-crop-cancel]").addEventListener("click", function () {
      finishCrop(false);
    });
    crop.dialog.querySelector("[data-crop-apply]").addEventListener("click", function () {
      if (!crop.api) return finishCrop(null);
      var canvas;
      try {
        canvas = crop.api.getCroppedCanvas({
          maxWidth: CROP_EDGE,
          maxHeight: CROP_EDGE,
          imageSmoothingQuality: "high",
        });
      } catch (e) {
        canvas = null;
      }
      var data = null;
      if (canvas) {
        try {
          data = canvas.toDataURL("image/jpeg", 0.82);
        } catch (e) {
          data = null;
        }
      }
      finishCrop(data && data.length > 100 ? data : null);
    });
    // Escape / a swipe back closes the dialog: treat it as "cancel", like the button.
    crop.dialog.addEventListener("cancel", function (ev) {
      ev.preventDefault();
      finishCrop(false);
    });
    crop.dialog.addEventListener("close", function () {
      if (crop.api) {
        try {
          crop.api.destroy();
        } catch (e) {
          /* ignore */
        }
        crop.api = null;
      }
      img.removeAttribute("src");
    });
    return crop.dialog;
  }

  function finishCrop(data) {
    var settle = crop.settle;
    crop.settle = null;
    if (crop.url) {
      URL.revokeObjectURL(crop.url);
      crop.url = null;
    }
    if (crop.dialog && crop.dialog.open) crop.dialog.close();
    if (settle) settle(data);
  }

  /** Ask the operator whether to crop; resolves a data URL, null (use whole) or false (skip). */
  function askCrop(file) {
    return new Promise(function (resolve) {
      if (!cropReady() || !buildCropDialog()) return resolve(null);
      var img = crop.dialog.querySelector("[data-crop-image]");
      crop.settle = resolve;
      crop.url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          crop.api = new window.Cropper(img, {
            viewMode: 1,
            dragMode: "move",
            autoCropArea: 0.9,
            checkOrientation: true,
            responsive: true,
            background: false,
            guides: false,
            toggleDragModeOnDblclick: false,
            movable: true,
            zoomable: true,
          });
        } catch (e) {
          finishCrop(null);
        }
      };
      img.onerror = function () {
        finishCrop(null);
      };
      img.src = crop.url;
      crop.dialog.showModal();
    });
  }

  function wirePhoto() {
    var inputs = document.querySelectorAll('input[type="file"][name="photo"]');
    for (var i = 0; i < inputs.length; i++) attach(inputs[i]);

    function attach(node) {
      node.addEventListener("change", function () {
        var form = node.form;
        var picked = node.files ? [].slice.call(node.files) : [];
        if (!form || !picked.length) return;
        var images = picked.filter(function (f) {
          return /^image\//.test(f.type);
        });
        // A non-image is the server's call to refuse, with a message: post it as-is.
        if (images.length !== picked.length) return;
        var previews = form.querySelector("[data-photo-previews]");
        var batch = images.slice(0, Math.max(0, MAX_PHOTOS - scaled));
        // Clearing the input matters: the picked originals must never travel with
        // the form next to their downscaled copies. The input stays, so more photos
        // can be added by picking again.
        try {
          node.value = "";
        } catch (e) {
          return;
        }
        if (!batch.length) return;
        var chain = Promise.resolve();
        batch.forEach(function (file) {
          chain = chain.then(function () {
            return one(file);
          });
        });
        // One photo at a time: the dialog is a single surface, so a multi-select
        // queues the crops instead of stacking them.
        function one(file) {
          return askCrop(file).then(function (data) {
            if (data === false) return;
            if (data) return add(data);
            return new Promise(function (res) {
              downscale(file, function (small) {
                if (small) {
                  add(small);
                  return res();
                }
                readRaw(file, function (raw) {
                  if (raw) add(raw);
                  res();
                });
              });
            });
          });
        }
        function add(data) {
          addHidden(form, data);
          scaled++;
          if (previews) showPreview(previews, data);
        }
      });
    }
  }

  // §8.2: the category and location fields suggest the values already in use. The
  // <datalist> stays in the markup for browsers without JS; this list is the same
  // data, but tappable on a phone, where the native datalist is hard to hit.
  function wireCombo() {
    var inputs = document.querySelectorAll("input[data-suggest]");
    for (var i = 0; i < inputs.length; i++) combo(inputs[i]);

    function combo(input) {
      var list = document.getElementById(input.getAttribute("data-suggest"));
      if (!list || !list.options.length) return;
      var values = [];
      for (var o = 0; o < list.options.length; o++) {
        var value = list.options[o].value;
        if (value && values.indexOf(value) === -1) values.push(value);
      }
      var box = document.createElement("ul");
      box.className = "suggest";
      box.setAttribute("role", "listbox");
      box.hidden = true;
      input.parentNode.appendChild(box);
      var shown = [];
      var active = -1;

      function close() {
        box.hidden = true;
        box.textContent = "";
        shown = [];
        active = -1;
        input.setAttribute("aria-expanded", "false");
      }

      function render() {
        var needle = input.value.trim().toLowerCase();
        shown = values
          .filter(function (v) {
            return !needle || v.toLowerCase().indexOf(needle) !== -1;
          })
          .sort(function (a, b) {
            var ap = a.toLowerCase().indexOf(needle) === 0 ? 0 : 1;
            var bp = b.toLowerCase().indexOf(needle) === 0 ? 0 : 1;
            return ap - bp || a.localeCompare(b);
          })
          .slice(0, 8);
        if (!shown.length) return close();
        box.textContent = "";
        shown.forEach(function (v, index) {
          var li = document.createElement("li");
          li.textContent = v;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", String(index === active));
          li.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            input.value = v;
            close();
          });
          box.appendChild(li);
        });
        box.hidden = false;
        input.setAttribute("aria-expanded", "true");
      }

      input.setAttribute("aria-expanded", "false");
      input.addEventListener("input", function () {
        active = -1;
        render();
      });
      input.addEventListener("focus", render);
      input.addEventListener("blur", function () {
        window.setTimeout(close, 120);
      });
      input.addEventListener("keydown", function (ev) {
        if (box.hidden) {
          if (ev.key === "ArrowDown") render();
          return;
        }
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          active = active + (ev.key === "ArrowDown" ? 1 : -1);
          if (active < 0) active = shown.length - 1;
          if (active >= shown.length) active = 0;
          var items = box.querySelectorAll("li");
          for (var j = 0; j < items.length; j++) items[j].setAttribute("aria-selected", String(j === active));
          if (items[active] && items[active].scrollIntoView) items[active].scrollIntoView({ block: "nearest" });
        } else if (ev.key === "Enter" && active >= 0 && shown[active]) {
          ev.preventDefault();
          input.value = shown[active];
          close();
        } else if (ev.key === "Escape") {
          close();
        }
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
  wireCombo();
})();
