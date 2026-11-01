// Unit tests for code.js (§7.5 vector) and qrcode.js (matrix -> SVG). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, sheetCode, oneOff, parse, normalize, pretty, stickerLines, batchNonce } from "../../code.js";
import { qrMatrix, matrixToSvg } from "../../qrcode.js";

const DEV_SECRET = "dev-code-secret-that-is-long-enough-0000000";
const MONTH = (2026 - 2020) * 12 + (10 - 1); // 2026-10, the spec's test month

test("§7.3 unit vector (explicit nonce 0xABCD1)", () => {
  assert.equal(build(DEV_SECRET, MONTH, 0, 0xabcd1), "2H000000NF6H9SSF");
});

test("§7.5 batch vector (start=0, n=5)", () => {
  const sheet = [0, 1, 2, 3, 4].map((i) => sheetCode(DEV_SECRET, MONTH, 0, i));
  assert.deepEqual(sheet, ["2H00000039NYDG6D", "2H000001M7NS24TA", "2H000002Q5X4ZF1S", "2H000003JS4DZA8E", "2H0000042754KQMW"]);
  assert.equal(batchNonce(DEV_SECRET, 0, 0), 0x1a6be); // 20 bits from the batch HMAC
  assert.notEqual(batchNonce(DEV_SECRET, 0, 0), batchNonce(DEV_SECRET, 1, 0));
});

test("round trip of 10,000 codes", () => {
  for (let i = 0; i < 10_000; i++) {
    const seq = i * 7;
    const c = i % 2 ? sheetCode(DEV_SECRET, MONTH, seq, 0) : oneOff(DEV_SECRET, i, MONTH);
    const p = parse(DEV_SECRET, c);
    assert.ok(p, `valid code rejected: ${c}`);
    assert.equal(p.code, c);
    assert.equal(p.seq, (i % 2 ? i * 7 : i) % 2 ** 30);
  }
});

test("parse tolerates case, dashes, spaces and confusables", () => {
  const c = sheetCode(DEV_SECRET, 0, 0, MONTH);
  assert.equal(parse(DEV_SECRET, c.toLowerCase()).code, c);
  assert.equal(parse(DEV_SECRET, pretty(c).toLowerCase()).code, c);
  assert.equal(parse(DEV_SECRET, ` ${pretty(c)} `).code, c);
  // decode-side confusables are normalized before the HMAC check
  const withO = c.replace(/0/g, "O");
  assert.equal(parse(DEV_SECRET, withO).code, c.replace(/O/g, "0"));
});

test("rejects tampering, wrong secret and junk", () => {
  const c = sheetCode(DEV_SECRET, 0, 3, MONTH);
  for (let i = 0; i < c.length; i++) {
    const ch = c[i] === "0" ? "1" : "0";
    assert.equal(parse(DEV_SECRET, c.slice(0, i) + ch + c.slice(i + 1)), null, `flip at ${i}`);
  }
  assert.equal(parse("another-secret-that-is-long-enough-000000001", c), null);
  assert.equal(parse(DEV_SECRET, "short"), null);
  // I is not in the alphabet; it normalizes to 1, so the variant ends in "61" and has a bad tag
  assert.equal(normalize("2h00-0000-39ny-dg6i"), "2H00000039NYDG61");
  assert.equal(parse(DEV_SECRET, "2H00000039NYDG6I"), null);
  assert.equal(parse(DEV_SECRET, "39NYDG6D2H000000"), null, "field order matters");
  assert.equal(parse(DEV_SECRET, "¿".repeat(16)), null);
  assert.equal(parse(DEV_SECRET, "2H00000039NYDG6D-").code, "2H00000039NYDG6D"); // dashes/spaces are cosmetic
  assert.equal(parse(DEV_SECRET, "2H00-0000-39NY-DG6D--").code, "2H00000039NYDG6D");
  assert.equal(parse(DEV_SECRET, null), null);
  assert.equal(normalize("x".repeat(100)), null);
});

test("a sheet continues the sequence: start=10, i=3 has seq 13", () => {
  const p = parse(DEV_SECRET, sheetCode(DEV_SECRET, MONTH, 10, 3));
  assert.equal(p.seq, 13);
  assert.equal(p.seq, parse(DEV_SECRET, sheetCode(DEV_SECRET, MONTH, 0, 13)).seq);
  assert.throws(() => sheetCode(DEV_SECRET, MONTH, 2 ** 30 - 1, 1), RangeError);
});

test("pretty/stickerLines geometry", () => {
  assert.equal(pretty("2H00000039NYDG6D"), "2H00-0000-39NY-DG6D");
  assert.deepEqual(stickerLines("2H00000039NYDG6D"), ["2H00-0000", "39NY-DG6D"]);
  for (const l of stickerLines("2H00000039NYDG6D")) assert.equal(l.length, 9);
});

test("QR: matrix is square, has finder patterns and round-trips to SVG", () => {
  const m = qrMatrix("http://localhost:8080/r/2h00000039nydg6d", "M");
  assert.ok(m.size >= 21 && (m.size - 21) % 4 === 0, "size must be 21 + 4k");
  assert.equal(m.modules.length, m.size);
  // finder pattern: 7x7 dark border in the top-left corner
  for (let i = 0; i < 7; i++) assert.ok(m.modules[0][i] && m.modules[i][0] && m.modules[6][i] && m.modules[i][6]);
  const svg = matrixToSvg(m, { px: 120 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<rect/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
});

test("QR: matrices differ between codes (they encode different URLs)", () => {
  const a = qrMatrix("http://x/r/aaaa", "M");
  const b = qrMatrix("http://x/r/bbbb", "M");
  assert.notDeepEqual(a.modules, b.modules);
  assert.throws(() => qrMatrix("", "M"));
});
