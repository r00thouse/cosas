// The only browser script (SPEC.md §5.2): language/print helpers, the qty +1/−1
// buttons (fetch), the sticker drawing on the print page and copy-to-clipboard.
// Every page works without it: the same controls are real forms and the code is
// printed as text under every QR.
(function () {
  "use strict";

  // §8.7: draw one QR per sticker from the data-qr attribute into its <canvas>.
  function drawStickers() {
    var nodes = document.querySelectorAll("canvas[data-qr]");
    for (var i = 0; i < nodes.length; i++) {
      var canvas = nodes[i];
      var text = canvas.getAttribute("data-qr");
      if (!text || !window.qrcode) continue;
      var m = window.qrcode.qrMatrix(text, "M");
      drawOnCanvas(canvas, m, 480); // 480 CSS px = 24 mm shrank to print size
    }
  }

  function drawOnCanvas(canvas, m, px) {
    var quiet = 4;
    var total = m.size + quiet * 2;
    var ctx = canvas.getContext("2d");
    canvas.width = px;
    canvas.height = px;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000";
    var cell = px / total;
    for (var y = 0; y < m.size; y++) {
      for (var x = 0; x < m.size; x++) {
        if (m.modules[y][x]) {
          ctx.fillRect(Math.floor((x + quiet) * cell), Math.floor((y + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
  }

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

  // Print button: the sheet is already laid out for A4 (§8.7).
  var printBtn = document.querySelector("button[data-print]");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  drawStickers(); // print sheet (§8.7) and the single sticker on an item page (§8.3)
  wireQty();
  wireCopy();
})();
