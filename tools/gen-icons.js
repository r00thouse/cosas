// Draws the PWA icons with no dependencies: raw RGBA pixels + a minimal PNG writer.
// The glyph is a white sticker with three QR finder patterns — the same shape the
// printer puts on the devices. Run: node tools/gen-icons.js
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public");

const BG = [31, 95, 63];
const WHITE = [255, 255, 255];
const INK = [17, 17, 17];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One sticker on the app background. `inset` shrinks the sticker for maskable. */
function draw(size, inset) {
  const buf = Buffer.alloc(size * size * 4);
  const rect = (x, y, w, h, c) => {
    for (let j = Math.max(0, y); j < Math.min(size, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(size, x + w); i++) {
        const p = (j * size + i) * 4;
        buf[p] = c[0];
        buf[p + 1] = c[1];
        buf[p + 2] = c[2];
        buf[p + 3] = 255;
      }
    }
  };
  rect(0, 0, size, size, BG);
  const pad = Math.round(size * inset);
  const side = size - pad * 2;
  rect(pad, pad, side, side, WHITE);

  // 16-module grid: finders at (1,1), (9,1), (1,9), each 7 modules wide.
  const q = side / 16;
  const finder = (mx, my) => {
    const x = Math.round(pad + mx * q);
    const y = Math.round(pad + my * q);
    const s = Math.round(q);
    rect(x, y, s * 7, s * 7, INK);
    rect(x + s, y + s, s * 5, s * 5, WHITE);
    rect(x + s * 2, y + s * 2, s * 3, s * 3, INK);
  };
  finder(1, 1);
  finder(9, 1);
  finder(1, 9);
  return png(size, buf);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ["icon-192.png", 192, 0.12],
  ["icon-512.png", 512, 0.12],
  ["icon-180.png", 180, 0.1],
];
for (const [name, size, inset] of files) {
  writeFileSync(join(OUT, name), draw(size, inset));
  console.log(`wrote public/${name} (${size}x${size})`);
}
const maskable = 512;
writeFileSync(join(OUT, "icon-maskable-512.png"), draw(maskable, 0.24));
console.log(`wrote public/icon-maskable-512.png (${maskable}x${maskable}, 76% safe zone)`);
