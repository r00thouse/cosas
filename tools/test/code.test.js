// Unit tests for code.js (§7.5 vector) and qrcode.js (matrix -> SVG). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, oneOff, randomCode, parse, normalize, pretty, stickerLines } from "../../code.js";
import { sheetCodes } from "../../codes.js";
import { qrMatrix, matrixToSvg } from "../../qrcode.js";

const DEV_SECRET = "dev-code-secret-that-is-long-enough-0000000";
const MONTH = (2026 - 2020) * 12 + (10 - 1); // 2026-10, the spec's test month

test("§7.3 unit vector (explicit nonce 0xABCD1)", () => {
  assert.equal(build(DEV_SECRET, MONTH, 0, 0xabcd1), "2H000000NF6H9SSF");
});

test("§7.5 sheet codes are random and distinct, never sequential", () => {
  const sheet = sheetCodes(DEV_SECRET, "http://localhost:8080", 200, MONTH);
  assert.equal(sheet.length, 200);
  assert.equal(new Set(sheet.map((s) => s.code)).size, 200, "no duplicates on a sheet");
  for (const s of sheet) {
    assert.ok(parse(DEV_SECRET, s.code), `invalid code ${s.code}`);
    assert.equal(s.url, `http://localhost:8080/r/${s.code.toLowerCase()}`);
  }
  // The decoded "seq" field must not be an ascending counter.
  const seqs = sheet.map((s) => parse(DEV_SECRET, s.code).seq);
  const ascending = seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1);
  assert.equal(ascending, false, "codes must not be sequential");
  // Two sheets share no code and no visible prefix.
  const again = sheetCodes(DEV_SECRET, "http://localhost:8080", 200, MONTH);
  assert.equal(again.filter((s) => sheet.some((o) => o.code === s.code)).length, 0);
});

test("round trip of 10,000 codes", () => {
  for (let i = 0; i < 10_000; i++) {
    const seq = i * 7;
    const c = i % 2 ? build(DEV_SECRET, MONTH, seq % 2 ** 30, 0x12345) : oneOff(DEV_SECRET, MONTH);
    const p = parse(DEV_SECRET, c);
    assert.ok(p, `valid code rejected: ${c}`);
    assert.equal(p.code, c);
    if (i % 2) assert.equal(p.seq, (i * 7) % 2 ** 30);
  }
});

test("parse tolerates case, dashes, spaces and confusables", () => {
  const c = build(DEV_SECRET, MONTH, 0, 0xabcd1);
  assert.equal(parse(DEV_SECRET, c.toLowerCase()).code, c);
  assert.equal(parse(DEV_SECRET, pretty(c).toLowerCase()).code, c);
  assert.equal(parse(DEV_SECRET, ` ${pretty(c)} `).code, c);
  // decode-side confusables are normalized before the HMAC check
  const withO = c.replace(/0/g, "O");
  assert.equal(parse(DEV_SECRET, withO).code, c.replace(/O/g, "0"));
});

test("rejects tampering, wrong secret and junk", () => {
  const c = build(DEV_SECRET, MONTH, 3, 0x1234);
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

test("randomCode keeps the month field and a valid tag", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = randomCode(DEV_SECRET, MONTH);
    assert.equal(c.slice(0, 2), "2H", "month prefix is stable");
    assert.ok(parse(DEV_SECRET, c), `invalid ${c}`);
    seen.add(c);
  }
  assert.equal(seen.size, 500);
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
