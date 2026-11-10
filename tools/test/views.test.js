// Template checks that need no server (and so no GET /r/* from the e2e suite's
// shared rate-limit window).
import test from "node:test";
import assert from "node:assert/strict";
import { makeT } from "../../i18n.js";
import { registerPage, photoPanel, listPage } from "../../views.js";

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

test("a photo whose file is missing offers an in-place replace form (§8.8)", () => {
  const photos = [{ id: 4 }, { id: 5 }];
  const html = String(photoPanel(ctx(), {}, "AAAA000000000001", photos, new Set([5])));
  assert.match(html, /Faltan fotos \(1 de 2\)/, "the panel repeats the missing count");
  assert.match(html, /Falta el archivo de la foto/);
  assert.match(html, /Reemplazar foto/);
  assert.match(html, /action="\/r\/aaaa000000000001\/photo\/5\/replace"/);
  assert.equal((html.match(/data-room="1"/g) || []).length, 1, "one slot for one replacement");
  assert.ok(/<img class="photo-thumb" src="\/photo\/[^"]+\/4"/.test(html), "the healthy photo still renders");
  assert.ok(!/src="\/photo\/[^"]+\/5"/.test(html), "the missing photo is a placeholder, not a broken image");
  const inputs = html.match(/<input[^>]*type="file"[^>]*>/g) || [];
  assert.equal(inputs.length, 3, "camera + files on the add form, one on replace");
});
test("the list warns about items without photos or whose files are gone (§8.4)", () => {
  const rows = [
    { id: 1, code: "AAAA000000000001", name: "Sin fotos", category: "cable", status: "available", location: "", qty: 1 },
    { id: 2, code: "AAAA000000000002", name: "Perdidas", category: "cable", status: "available", location: "", qty: 1 },
    { id: 3, code: "AAAA000000000003", name: "Bien", category: "cable", status: "available", location: "", qty: 1 },
  ];
  const warnings = new Map([[1, { total: 0, missing: 0 }], [2, { total: 3, missing: 2 }]]);
  const html = String(listPage(ctx(), { rows, total: 3, page: 1, pages: 1, filters: {}, photoWarnings: warnings }));
  const rowFor = (name) => html.split("<tr>").find((r) => r.includes(name)) || "";
  assert.match(rowFor("Sin fotos"), /class="warn-icon warn-none"[^>]*aria-label="Sin fotos"/);
  assert.match(rowFor("Perdidas"), /class="warn-icon warn-lost"[^>]*aria-label="Faltan fotos \(2 de 3\)"/);
  assert.equal((html.match(/warn-icon/g) || []).length, 2, "healthy rows carry no icon");
  assert.ok(!/warn-icon/.test(rowFor("Bien")));

  // Signed-out visitors get the plain list: the hint is for people who can fix it.
  const anon = String(listPage(ctx(), { rows, total: 3, page: 1, pages: 1, filters: {} }));
  assert.ok(!/warn-icon/.test(anon));
  assert.match(String(listPage(ctx("en"), { rows, total: 3, page: 1, pages: 1, filters: {}, photoWarnings: warnings })), /Photo files missing \(2 of 3\)/);
});
