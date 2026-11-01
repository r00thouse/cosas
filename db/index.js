// Opens the SQLite file, applies pending migrations (SPEC.md §6.2), returns the handle.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import migrations from "./migrations/index.js";

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const current = row ? Object.values(row)[0] : 0;
  for (const { version, up } of migrations) {
    if (version <= current) continue;
    db.exec("BEGIN");
    try {
      up(db);
      db.exec(`PRAGMA user_version = ${Number(version)}`);
      db.exec("COMMIT");
      log("info", "db.migrated", { version });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

// tiny logger shared by db/store/server (no dependency, JSON lines in prod)
export function log(level, msg, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
