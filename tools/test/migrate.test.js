// Migration safety (SPEC.md §6.2): an existing database must upgrade in place. The
// one that matters is 004, which moves `items.photo` into `item_photos` and drops the
// column — getting it wrong silently loses every image the lab has taken.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../../db/index.js";
import * as m1 from "../../db/migrations/001_init.js";
import * as m2 from "../../db/migrations/002_code_history.js";
import * as m3 from "../../db/migrations/003_photo.js";

test("004 moves items.photo into item_photos without losing a row", () => {
  const dir = mkdtempSync(join(tmpdir(), "cosas-migrate-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    for (const m of [m1, m2, m3]) m.up(old);
    old.exec("PRAGMA user_version = 3");
    old.exec(`INSERT INTO items (code, code_seq, name, category, status, qty_mode, qty, notes, photo, created_at, updated_at)
              VALUES ('2h00000000000001', 1, 'Viejo', 'monitor', 'available', 'count', 1, '', '7-0123456789ab.jpg', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO items (code, code_seq, name, category, status, qty_mode, qty, notes, photo, created_at, updated_at)
              VALUES ('2h00000000000002', 2, 'Sin foto', 'monitor', 'available', 'count', 1, '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    old.close();

    const db = openDb(path);
    const cols = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
    assert.ok(!cols.includes("photo"), "the old column is gone");
    const photos = db.prepare("SELECT item_id, name FROM item_photos").all();
    assert.deepEqual(
      photos.map((p) => ({ ...p })),
      [{ item_id: 1, name: "7-0123456789ab.jpg" }],
      "the photo row moved and the empty one stayed empty",
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
