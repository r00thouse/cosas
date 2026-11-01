import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssets } from "../../assets.js";

function dir(files) {
  const base = mkdtempSync(join(tmpdir(), "cosas-assets-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(base, name), text);
  return base;
}

test("asset URLs carry a content hash; unknown paths are untouched", () => {
  const base = dir({ "app.css": "a{}", "app.js": "1;", "icon-192.png": "png" });
  const assets = createAssets(base);
  assert.match(assets.version, /^[0-9a-f]{10}$/);
  assert.equal(assets.url("/static/app.css"), `/static/app.css?v=${assets.version}`);
  assert.equal(assets.url("/static/icon-192.png"), `/static/icon-192.png?v=${assets.version}`);
  assert.equal(assets.url("/manifest.webmanifest"), "/manifest.webmanifest");
});

test("changing any file changes the version (§8.11)", () => {
  const before = createAssets(dir({ "app.css": "a{}", "app.js": "1;" }));
  const after = createAssets(dir({ "app.css": "a{color:red}", "app.js": "1;" }));
  assert.notEqual(before.version, after.version);
});

test("an added or removed file changes the version", () => {
  const two = createAssets(dir({ "app.css": "a{}", "app.js": "1;" }));
  const three = createAssets(dir({ "app.css": "a{}", "app.js": "1;", "scan.js": "2;" }));
  assert.notEqual(two.version, three.version);
});

test("files outside public/ are versioned through the extra map", () => {
  const base = dir({ "app.css": "a{}" });
  const assets = createAssets(base, { "jsQR.js": join(base, "app.css") });
  assert.equal(assets.url("/vendor/jsQR.js"), `/vendor/jsQR.js?v=${assets.version}`);
});

test("a missing public/ must not throw", () => {
  const assets = createAssets(join(tmpdir(), "cosas-does-not-exist-" + Date.now()));
  assert.match(assets.version, /^[0-9a-f]{10}$/);
  assert.equal(assets.url("/static/app.css"), "/static/app.css");
});
