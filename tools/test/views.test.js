// Template checks that need no server (and so no GET /r/* from the e2e suite's
// shared rate-limit window).
import test from "node:test";
import assert from "node:assert/strict";
import { makeT } from "../../i18n.js";
import { registerPage, photoPanel } from "../../views.js";

const ctx = (lang = "es") => ({
  t: makeT(lang), lang, session: { name: "a", role: "admin" }, member: true, admin: true, csrf: "x",
  asset: (p) => p, stickerUrl: (c) => `https://x/r/${c}`,
});

test("photo fields offer the rear camera and the file picker, both as name=photo (§8.8)", () => {
  for (const html of [
    String(registerPage(ctx(), { code: "AAAA000000000001" })),
    String(photoPanel(ctx(), {}, "AAAA000000000001", [])),
  ]) {
    const inputs = html.match(/<input[^>]*type="file"[^>]*>/g) || [];
    assert.equal(inputs.length, 2, "camera + files");
    assert.ok(inputs.every((i) => /name="photo"/.test(i)), "app.js and the server treat both the same");
    assert.equal(inputs.filter((i) => /capture="environment"/.test(i)).length, 1, "one opens the camera");
    assert.match(html, /Tomar foto/);
    assert.match(html, /Elegir archivos/);
    assert.match(html, /data-photo-previews data-msg-remove="Quitar"/, "picked photos can be taken back out");
    assert.match(html, /data-camera-shots data-msg-remove="Quitar"/, "so can camera shots");
    assert.match(html, /<template data-camera-template[\s\S]*data-camera-shutter[\s\S]*Sacar foto[\s\S]*Listo/, "in-page camera dialog");
  }
  assert.match(String(registerPage(ctx("en"), { code: "AAAA000000000001" })), /Take photo/);

  // A fresh item has all eight slots open; the panel tells the picker how many are left
  // so a gallery pick of nine is trimmed before it posts, not refused after (§8.8).
  const fresh = String(photoPanel(ctx(), {}, "AAAA000000000001", []));
  assert.equal((fresh.match(/data-room="8"/g) || []).length, 2);
  const full = String(photoPanel(ctx(), {}, "AAAA000000000001", Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }))));
  assert.equal((full.match(/data-room="0"/g) || []).length, 2);
});
