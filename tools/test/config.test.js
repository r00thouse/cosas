import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";

import { loadConfig } from "../../config.js";

test("storage paths are absolute, relative values resolve against the cwd", () => {
  const cfg = loadConfig({ DB_PATH: "./data/cosas.db", PHOTO_DIR: "./photos" });
  assert.equal(cfg.dbPath, resolve("data/cosas.db"));
  assert.equal(cfg.photoDir, resolve("photos"));
  assert.ok(isAbsolute(cfg.dbPath) && isAbsolute(cfg.photoDir));
});

test("photo dir defaults next to the database", () => {
  const cfg = loadConfig({ DB_PATH: "/data/cosas.db" });
  assert.equal(cfg.dbPath, "/data/cosas.db");
  assert.equal(cfg.photoDir, "/data/photos");
});

test("a relative PHOTO_DIR is never left ambiguous", () => {
  // The incident this guards: PHOTO_DIR=./photos inside the container meant
  // /app/photos, outside the /photos mount, so the files vanished on recreate
  // while the rows survived. Boot logs the resolved path, so it must be absolute.
  const cfg = loadConfig({ PHOTO_DIR: "./photos" });
  assert.notEqual(cfg.photoDir, "./photos");
  assert.equal(cfg.photoDir, resolve("photos"));
});
