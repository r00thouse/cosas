// Vendored QR Code generator for the print page and /codes/svg. Single file, no
// dependencies, MIT — original implementation for this repo in the style of Project
// Nayuki's QR Code generator library (MIT License, Copyright (c) Project Nayuki,
// https://www.nayuki.io/page/qr-code-generator-library). Do not edit public/qr.js by
// hand: it is copied from this file.
//
// Dual use: `import { qrMatrix } from "./qrcode.js"` in Node, or as the script
// public/qr.js (a copy of this file) where it exposes `window.qrcode.qrMatrix(...)`.
//
// Public API:
//   qrMatrix(text, ecc = "M") -> { size, modules: [[bool]] }      (quiet zone NOT included)
//   matrixToSvg(matrix, {px, quiet, dark, light, title}) -> string
const qrcodeApi = (function () {
  const ECC = {
    L: { ordinal: 0, formatBits: 1 },
    M: { ordinal: 1, formatBits: 0 },
    Q: { ordinal: 2, formatBits: 3 },
    H: { ordinal: 3, formatBits: 2 },
  };
  // Indexed [eccOrdinal][version]; index 0 unused.
  const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  /** Encodes `text` (UTF-8) as a QR matrix; returns {size, modules}. */
  function qrMatrix(text, eccName) {
    const ecc = ECC[(eccName || "M").toUpperCase()];
    if (!ecc) throw new Error(`unknown ECC level ${eccName}`);
    const data = new TextEncoder().encode(String(text));
    if (data.length === 0) throw new Error("empty payload");

    let version = 0;
    let dataCapacityBits = 0;
    for (let v = 1; v <= 40; v++) {
      const cap = getNumDataCodewords(v, ecc) * 8;
      if (4 + (v <= 9 ? 8 : 16) + data.length * 8 <= cap) {
        version = v;
        dataCapacityBits = cap;
        break;
      }
    }
    if (!version) throw new Error("payload too long for a QR code");

    const bits = [];
    const appendBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push(getBit(val, i));
    };
    appendBits(0x4, 4); // byte mode
    appendBits(data.length, version <= 9 ? 8 : 16);
    for (const b of data) appendBits(b, 8);
    appendBits(0, Math.min(4, dataCapacityBits - bits.length)); // terminator
    appendBits(0, (8 - (bits.length % 8)) % 8); // pad to byte
    for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8);
    const dataCodewords = new Uint8Array(bits.length / 8);
    bits.forEach((bit, i) => (dataCodewords[i >>> 3] |= (bit ? 1 : 0) << (7 - (i & 7))));

    const allCodewords = addEccAndInterleave(dataCodewords, version, ecc);
    return { size: version * 4 + 17, modules: drawCodewords(allCodewords, version, ecc) };
  }

  function getNumDataCodewords(version, ecc) {
    return (
      getNumRawDataModules(version) / 8 -
      ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version]
    );
  }

  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function addEccAndInterleave(data, version, ecc) {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
    const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc2 = reedSolomonComputeRemainder(dat, rsDiv);
      const block = Array.from(dat);
      if (i < numShortBlocks) block.push(0); // placeholder keeps the interleave grid square
      blocks.push([...block, ...ecc2]);
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function reedSolomonComputeDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => (result[i] ^= reedSolomonMultiply(coef, factor)));
    }
    return result;
  }

  function reedSolomonMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function drawCodewords(data, version, ecc) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    drawFunctionPatterns(modules, isFunction, version, ecc);

    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < data.length * 8) {
            modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
    applyBestMask(modules, isFunction, version, ecc);
    return modules;
  }

  /** Tries all 8 masks, keeps the one with the lowest ISO penalty (§7.8.3). */
  function applyBestMask(modules, isFunction, version, ecc) {
    const size = modules.length;
    let best = null;
    for (let m = 0; m < 8; m++) {
      const copy = cloneModules(modules);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (isFunction[y][x] || !maskBit(m, x, y)) continue;
          copy[y][x] = !copy[y][x];
        }
      }
      drawFormatBits(copy, ecc, m);
      const p = penalty(copy);
      if (!best || p < best.penalty) best = { penalty: p, modules: copy };
    }
    for (let y = 0; y < size; y++) modules[y] = best.modules[y];
  }

  function cloneModules(m) {
    return m.map((row) => row.slice());
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
    return false;
  }

  function penalty(m) {
    const size = m.length;
    let score = 0;
    // rule 1: runs of 5+ same-colour modules
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x < size; x++) {
        if (m[y][x] === m[y][x - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let x = 0; x < size; x++) {
      let run = 1;
      for (let y = 1; y < size; y++) {
        if (m[y][x] === m[y - 1][x]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // rule 2: 2x2 blocks
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    // rule 3: finder-like 1:1:3:1:1 with 4 light modules on one side
    const pattern = [true, false, true, true, true, false, true];
    const at = (x, y) => (x >= 0 && x < size && y >= 0 && y < size ? m[y][x] : false);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size - 6; x++) {
        if (!pattern.every((v, i) => at(x + i, y) === v)) continue;
        const lightBefore = [1, 2, 3, 4].every((d) => !at(x - d, y));
        const lightAfter = [1, 2, 3, 4].every((d) => !at(x + 6 + d, y));
        if (lightBefore || lightAfter) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size - 6; y++) {
        if (!pattern.every((v, i) => at(x, y + i) === v)) continue;
        const lightBefore = [1, 2, 3, 4].every((d) => !at(x, y - d));
        const lightAfter = [1, 2, 3, 4].every((d) => !at(x, y + 6 + d));
        if (lightBefore || lightAfter) score += 40;
      }
    }
    // rule 4: dark/light balance
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
  }

  function drawFunctionPatterns(modules, isFunction, version, ecc) {
    const size = modules.length;
    const setFn = (x, y, dark) => {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };
    // timing patterns
    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    // finder patterns + separators
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    });
    // alignment patterns
    const align = alignmentPositions(version);
    const numAlign = align.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(align[i] + dx, align[j] + dy, dist !== 1);
          }
        }
      }
    }
    // version information (version >= 7)
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, bit);
        setFn(b, a, bit);
      }
    }
    drawFormatBits(modules, ecc, 0); // placeholder; applyBestMask rewrites it per mask
  }

  function drawFormatBits(modules, ecc, mask) {
    const level = ecc.formatBits;
    const size = modules.length;
    const data = (level << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const set = (x, y, dark) => (modules[y][x] = dark);

    for (let i = 0; i <= 5; i++) set(8, i, getBit(bits, i));
    set(8, 7, getBit(bits, 6));
    set(8, 8, getBit(bits, 7));
    set(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(bits, i));
    set(8, size - 8, true); // dark module
  }

  function alignmentPositions(version) {
    if (version === 1) return [];
    const numAlign = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /** Renders a matrix as an SVG string with a quiet zone. */
  function matrixToSvg(matrix, opts) {
    const o = Object.assign({ px: 120, quiet: 4, dark: "#000000", light: "#ffffff", title: "" }, opts || {});
    const size = matrix.size || matrix.length;
    const total = size + o.quiet * 2;
    const parts = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (matrix.modules[y][x]) parts.push(`M${x + o.quiet} ${y + o.quiet}h1v1h-1z`);
      }
    }
    const title = o.title ? `<title>${String(o.title).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</title>` : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${o.px}" height="${o.px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      title +
      `<rect width="100%" height="100%" fill="${o.light}"/>` +
      `<path d="${parts.join("")}" fill="${o.dark}"/></svg>`
    );
  }

  return { qrMatrix, matrixToSvg };
})();

if (typeof module === "object" && module.exports) module.exports = qrcodeApi;
else if (typeof self !== "undefined") self.qrcode = qrcodeApi;
export const { qrMatrix, matrixToSvg } = qrcodeApi;
