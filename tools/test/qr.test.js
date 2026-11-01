// QR round-trip tests: our encoder wrapper (qrcode-generator) and the decoder the
// browser uses (jsQR). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { qrMatrix, matrixToSvg } from "../../qrcode.js";

/** Paints a matrix into an RGBA frame the way a camera would see it. */
function render(matrix, scale = 4, quiet = 4) {
  const side = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

function rotate(frame, turns) {
  const { data, width } = frame;
  let out = data;
  let side = width;
  for (let t = 0; t < turns; t++) {
    const next = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const from = (y * side + x) * 4;
        const to = (x * side + (side - 1 - y)) * 4;
        next[to] = out[from];
        next[to + 1] = out[from + 1];
        next[to + 2] = out[from + 2];
        next[to + 3] = out[from + 3];
      }
    }
    out = next;
  }
  return { data: out, width: side, height: side };
}

function blur3(frame) {
  const { data, width, height } = frame;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
          sum += data[(yy * width + xx) * 4];
          n++;
        }
      }
      const v = sum / n;
      const i = (y * width + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return { data: out, width, height };
}

const URL = "http://localhost:8080/r/2j003wpg972pb0j0";

test("qrMatrix returns a square matrix of valid modules", () => {
  const m = qrMatrix(URL, "M");
  assert.ok(m.size >= 21 && m.size <= 177);
  assert.equal(m.modules.length, m.size);
  for (const row of m.modules) {
    assert.equal(row.length, m.size);
    for (const cell of row) assert.equal(typeof cell, "boolean");
  }
  // Three finder patterns: the top-left 7x7 corner is dark at (0,0) and (3,3).
  assert.equal(m.modules[0][0], true);
  assert.equal(m.modules[3][3], true);
});

test("qrMatrix picks a bigger symbol for a bigger payload and is deterministic", () => {
  const small = qrMatrix("hi", "M");
  const big = qrMatrix("x".repeat(300), "M");
  assert.ok(big.size > small.size);
  assert.deepEqual(qrMatrix(URL, "M"), qrMatrix(URL, "M"));
  // A higher error-correction level needs at least as much room.
  assert.ok(qrMatrix(URL, "H").size >= qrMatrix(URL, "L").size);
});

test("qrMatrix rejects an empty payload", () => {
  assert.throws(() => qrMatrix(""), /empty payload/);
});

test("matrixToSvg draws one path, honours the quiet zone and escapes the title", () => {
  const m = qrMatrix("hi", "M");
  const svg = matrixToSvg(m, { px: 100, quiet: 4, title: "<a&b>" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 29 29"/); // size 21 + a quiet zone of 4 on both sides
  assert.match(svg, /<title>&lt;a&amp;b&gt;<\/title>/);
  const d = svg.match(/<path d="([^"]*)"/)[1];
  const dark = m.modules.flat().filter(Boolean).length;
  assert.equal((d.match(/M/g) || []).length, dark);
});

test("jsQR reads our frames back at 1..6 px per module", () => {
  const m = qrMatrix(URL, "M");
  for (let scale = 1; scale <= 6; scale++) {
    const frame = render(m, scale);
    const hit = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
    assert.ok(hit, `no decode at scale ${scale}`);
    assert.equal(hit.data, URL);
  }
});

test("jsQR still reads rotated, blurred and inverted frames", () => {
  const m = qrMatrix(URL, "M");
  const base = render(m, 5);
  for (const turns of [1, 2, 3]) {
    const hit = jsQR(...Object.values(rotate(base, turns)), { inversionAttempts: "dontInvert" });
    assert.equal(hit && hit.data, URL, `rotation ${turns * 90}°`);
  }
  const blurred = blur3(blur3(base));
  assert.equal(jsQR(blurred.data, blurred.width, blurred.height, { inversionAttempts: "dontInvert" }).data, URL);
  const inverted = base.data.map((v, i) => (i % 4 === 3 ? 255 : 255 - v));
  const hit = jsQR(inverted, base.width, base.height, { inversionAttempts: "attemptBoth" });
  assert.equal(hit && hit.data, URL);
});

test("jsQR returns null instead of throwing on blank and noise frames", () => {
  const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  assert.equal(jsQR(blank, 64, 64), null);
  const noise = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
  assert.doesNotThrow(() => jsQR(noise, 64, 64));
  assert.equal(jsQR(noise, 64, 64), null);
});

test("the /codes sheet SVG decodes to the sticker URL", async () => {
  const { sheetSvg } = await import("../../views.js");
  const sticker = { code: "2j00000039nyq33r", url: "http://localhost:8080/r/2j00000039nyq33r" };
  const svg = sheetSvg([sticker], { host: "localhost:8080" });

  // One sticker <g> per sticker: take the translate origin and the module path.
  const group = svg.split('<g transform="translate(')[1];
  const [ox, oy] = group.split(")")[0].split(" ").map(Number);
  const d = group.match(/<path d="([^"]*)"/)[1];
  const cells = [...d.matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)/g)].map((m) => ({
    x: Number(m[1]) / Number(m[3]),
    y: Number(m[2]) / Number(m[3]),
    size: Number(m[3]),
  }));
  assert.ok(cells.length > 100, "the QR has modules");

  // Rasterise the 20 mm QR at 8 px/mm with a generous white margin, then decode.
  const pxPerMm = 8;
  const qrPx = 20 * pxPerMm;
  const margin = 24;
  const side = qrPx + margin * 2;
  const frame = new Uint8ClampedArray(side * side * 4).fill(255);
  const modulePx = (20 / Math.max(...cells.map((c) => c.x + 1))) * pxPerMm;
  for (const c of cells) {
    const x0 = margin + Math.round(c.x * modulePx);
    const y0 = margin + Math.round(c.y * modulePx);
    const w = Math.max(1, Math.round(c.size * pxPerMm));
    for (let y = y0; y < y0 + w; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * side + x) * 4;
        frame[i] = frame[i + 1] = frame[i + 2] = 0;
      }
    }
  }
  assert.ok(ox >= 0 && oy >= 0, "the sticker is placed inside the sheet");
  const hit = jsQR(frame, side, side, { inversionAttempts: "dontInvert" });
  assert.ok(hit, "the sheet SVG decodes");
  assert.equal(hit.data, sticker.url);
});
