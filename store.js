// Data access for items (SPEC.md §6.3). Raw SQL, prepared statements, one nowIso().
// Multi-row invariants run inside one explicit BEGIN/COMMIT.
//
// Code ownership: `items.code` is the canonical CURRENT code of the item (UNIQUE);
// `item_codes` is the claim of live items; a retired code survives only in
// `code_history` and `forgotten_codes`.
const EDITABLE = ["name", "category", "model", "serial", "location", "status", "held_by", "qty_mode", "qty", "notes"];
const STATUSES = ["available", "in_use", "broken", "missing"];
const QTY_MODES = ["count", "bin"];

export const nowIso = () => new Date().toISOString();

export class Conflict extends Error {}

export function createStore(db, { log } = {}) {
  const stmt = {
    byCode: db.prepare("SELECT * FROM items WHERE code = ?"),
    byId: db.prepare("SELECT * FROM items WHERE id = ?"),
    forgotten: db.prepare("SELECT reason FROM forgotten_codes WHERE code = ?"),
    claim: db.prepare("SELECT item_id FROM item_codes WHERE code = ?"),
    liveClaim: db.prepare(
      "SELECT i.* FROM item_codes c JOIN items i ON i.id = c.item_id WHERE c.code = ? AND i.deleted_at IS NULL",
    ),
    insertItem: db.prepare(`INSERT INTO items
      (code, code_seq, name, category, model, serial, location, status, held_by, qty_mode, qty, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    photosOf: db.prepare("SELECT id, name, created_at FROM item_photos WHERE item_id = ? ORDER BY id"),
    photoById: db.prepare("SELECT id, name FROM item_photos WHERE id = ? AND item_id = ?"),
    insertPhoto: db.prepare("INSERT INTO item_photos (item_id, name, created_at) VALUES (?, ?, ?)"),
    deletePhoto: db.prepare("DELETE FROM item_photos WHERE id = ?"),
    insertCode: db.prepare("INSERT INTO item_codes (code, item_id, created_at) VALUES (?, ?, ?)"),
    forgetCode: db.prepare("INSERT INTO forgotten_codes (code, reason, at) VALUES (?, ?, ?)"),
    deleteCode: db.prepare("DELETE FROM item_codes WHERE code = ?"),
    insertHistory: db.prepare("INSERT INTO code_history (code, item_id, reason, at) VALUES (?, ?, ?, ?)"),
    history: db.prepare("SELECT item_id FROM code_history WHERE code = ?"),
    audit: db.prepare("INSERT INTO items_audit (code, action, actor, before, after, at) VALUES (?, ?, ?, ?, ?, ?)"),
  };

  function audit(code, action, actor, before, after, at) {
    stmt.audit.run(code, action, actor, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, at);
  }

  function tx(fn) {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const isForgotten = (code) => Boolean(stmt.forgotten.get(code));
  const liveFor = (code) => stmt.liveClaim.get(code) || null;
  /** The item of the live claim on `code`, or null. */
  const ownerOf = (code) => {
    const claim = stmt.claim.get(code);
    return claim ? stmt.byId.get(claim.item_id) || null : null;
  };

  /** Free = no live item holds it and no retired sticker carries it. */
  const isFree = (code) => !liveFor(code) && !isForgotten(code);

  /**
   * Which item a scanned code shows (§8.1). A live claim wins; otherwise a retired
   * sticker that a *new* item was registered with shows that item (scan.reused);
   * else the item that owned it last (deleted → 410), or null (free → 404).
   */
  function itemForScan(code) {
    const live = liveFor(code);
    if (live) return { ...live, reused: isForgotten(code) ? "rebound" : null };
    const h = stmt.history.get(code);
    if (h) {
      const item = stmt.byId.get(h.item_id);
      if (item && !item.deleted_at && item.code === code) return { ...item, reused: "reused_code" };
      if (!item) return null;
    }
    return ownerOf(code) || stmt.byCode.get(code) || null;
  }

  /** The item for an exact known code (alias kept for callers of the old API). */
  const itemByCode = (code) => itemForScan(code) || undefined;

  function claimFree(code, seq, fields, actor, now) {
    const r = stmt.insertItem.run(
      code,
      seq,
      fields.name,
      fields.category,
      fields.model,
      fields.serial,
      fields.location,
      fields.status,
      fields.held_by,
      fields.qty_mode,
      fields.qty,
      fields.notes,
      now,
      now,
    );
    const id = Number(r.lastInsertRowid);
    stmt.insertCode.run(code, id, now);
    audit(code, "register", actor, null, { ...fields }, now);
    return stmt.byId.get(id);
  }

  /**
   * Register a new item with the sticker's code (§6.3 r3).
   * - held by a live item                              -> Conflict('code_taken')
   * - retired by rebind, or held by a deleted item     -> the new item takes the
   *   sticker over (a repurposed sticker must show its current device).
   */
  function register(code, seq, fields, actor) {
    const now = nowIso();
    return tx(() => {
      if (liveFor(code)) throw new Conflict("code_taken");
      stmt.deleteCode.run(code); // predecessor (deleted or retired) loses the sticker
      return claimFree(code, seq, fields, actor, now);
    });
  }

  function update(id, code, fields, actor) {
    const before = stmt.byId.get(id);
    if (!before) return undefined;
    const now = nowIso();
    const set = EDITABLE.map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE items SET ${set}, updated_at = ? WHERE id = ?`).run(...EDITABLE.map((k) => fields[k]), now, id);
    audit(before.code, "update", actor, before, fields, now);
    return stmt.byId.get(id);
  }

  function setStatus(id, code, status, actor) {
    assertStatus(status);
    const now = nowIso();
    db.prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    audit(code, "status", actor, null, { status }, now);
    return stmt.byId.get(id);
  }

  /** delta is ±n; clamped to 0..100000. Returns the new row. */
  function bumpQty(id, code, delta, actor) {
    const now = nowIso();
    db.prepare("UPDATE items SET qty = min(100000, max(0, qty + ?)), updated_at = ? WHERE id = ?").run(delta, now, id);
    audit(code, "qty", actor, null, { delta }, now);
    return stmt.byId.get(id);
  }

  function setQty(id, code, qty, actor) {
    const now = nowIso();
    db.prepare("UPDATE items SET qty = ?, updated_at = ? WHERE id = ?").run(qty, now, id);
    audit(code, "qty", actor, null, { qty }, now);
    return stmt.byId.get(id);
  }

  /** Photos of an item, oldest first (§8.8). The panel shows them in this order. */
  const photosOf = (itemId) => stmt.photosOf.all(itemId);

  /** Attach an already-written file name to an item; returns the new photo list. */
  function addPhoto(itemId, code, name, actor) {
    const now = nowIso();
    stmt.insertPhoto.run(itemId, String(name), now);
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(now, itemId);
    audit(code, "photo_add", actor, null, { name }, now);
    return stmt.photosOf.all(itemId);
  }

  /** Detach one photo; returns the removed row (so the caller can delete the file). */
  function removePhoto(itemId, photoId, code, actor) {
    const row = stmt.photoById.get(Number(photoId), itemId);
    if (!row) return null;
    const now = nowIso();
    stmt.deletePhoto.run(row.id);
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(now, itemId);
    audit(code, "photo_remove", actor, { name: row.name }, null, now);
    return row;
  }

  /** Every photo file name still referenced by a row — the keep-list for GC. */
  function photoNames() {
    return db.prepare("SELECT name FROM item_photos").all().map((r) => r.name);
  }

  /** item_id -> photo count, for the CSV export. One query, not one per row. */
  function photoCounts() {
    const map = new Map();
    for (const r of db.prepare("SELECT item_id, count(*) AS n FROM item_photos GROUP BY item_id").all()) {
      map.set(r.item_id, r.n);
    }
    return map;
  }

  /**
   * Soft delete (§6.3 r4): the row stays, the claim goes away, so the code reads
   * as 410 until `restore` takes it back — unless a new item registers with the
   * same sticker first (register deletes the claim and shows the new item).
   */
  function softDelete(id, code, actor) {
    const before = stmt.byId.get(id);
    if (!before) return undefined;
    const now = nowIso();
    return tx(() => {
      db.prepare("UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      stmt.deleteCode.run(before.code);
      audit(before.code, "delete", actor, before, null, now);
      return stmt.byId.get(id);
    });
  }

  /** Undo a soft delete; Conflict('code_taken') when a live item now owns the sticker. */
  function restore(id, code, actor) {
    const before = stmt.byId.get(id);
    if (!before) return undefined;
    const now = nowIso();
    return tx(() => {
      const owner = ownerOf(before.code);
      if ((owner && owner.id !== id) || isForgotten(before.code)) throw new Conflict("code_taken");
      db.prepare("UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
      stmt.insertCode.run(before.code, id, now);
      audit(before.code, "restore", actor, before, null, now);
      return stmt.byId.get(id);
    });
  }

  /**
   * Give the item a fresh code (§6.3 r2) in one transaction: the old sticker is
   * retired (410 from now on, forever), the item is bound to the new one.
   */
  function rebind(item, newCode, actor) {
    const before = stmt.byId.get(item.id);
    if (!before) return undefined;
    if (before.deleted_at) throw new Conflict("deleted");
    if (newCode === before.code) throw new Conflict("same_code");
    const now = nowIso();
    return tx(() => {
      if (!isFree(newCode)) throw new Conflict("code_taken");
      audit(before.code, "rebind", actor, before, { code: newCode }, now);
      stmt.forgetCode.run(before.code, "rebind", now);
      stmt.insertHistory.run(before.code, before.id, "rebind", now);
      stmt.deleteCode.run(before.code);
      stmt.insertCode.run(newCode, before.id, now);
      db.prepare("UPDATE items SET code = ?, updated_at = ? WHERE id = ?").run(newCode, now, before.id);
      return stmt.byId.get(before.id);
    });
  }

  /** Total number of non-deleted items. */
  const countLive = () => db.prepare("SELECT count(*) AS n FROM items WHERE deleted_at IS NULL").get().n;
  /** Number of non-deleted items matching the same filters as listLive(). */
  const countFiltered = (opts = {}) => listLive({ ...opts, count: true });

  /** Distinct non-empty values for the autocomplete datalists (§8.5), live items
   *  only. `limit` keeps a form from embedding a huge <datalist> (0 = no limit). */
  const distinct = (column, limit = 0) =>
    db
      .prepare(`SELECT DISTINCT ${column} AS v FROM items WHERE ${column} <> '' AND deleted_at IS NULL ORDER BY v${limit ? " LIMIT ?" : ""}`)
      .all(...(limit ? [limit] : []))
      .map((r) => r.v);
  /** Last sequence number ever used, deleted items included (never reuse a seq). */

  function listLive(opts = {}) {
    // Anonymous visitors search the public subset only (§8.4).
    const cols = opts.anon
      ? ["name", "category", "location"]
      : ["name", "model", "serial", "category", "location", "held_by", "notes"];
    const where = ["deleted_at IS NULL"];
    const args = [];
    if (opts.q) {
      where.push(`(${cols.map((c) => `coalesce(${c}, '') LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      const pat = `%${escapeLike(opts.q)}%`;
      for (const _ of cols) args.push(pat);
    }
    if (opts.category) {
      where.push("category = ?");
      args.push(opts.category);
    }
    if (opts.status) {
      assertStatus(opts.status);
      where.push("status = ?");
      args.push(opts.status);
    }
    const filter = `FROM items WHERE ${where.join(" AND ")}`;
    if (opts.count) return db.prepare(`SELECT count(*) AS n ${filter}`).get(...args).n;
    return db
      .prepare(`SELECT * ${filter} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, opts.limit || 50, opts.offset || 0);
  }

  return {
    itemForScan,
    itemByCode,
    isFree,
    isForgotten,
    register,
    update,
    setStatus,
    bumpQty,
    setQty,
    photosOf,
    addPhoto,
    removePhoto,
    photoNames,
    photoCounts,
    softDelete,
    restore,
    rebind,
    listLive,
    countLive,
    countFiltered,
    distinct,
  };
}

export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}
function assertStatus(v) {
  if (!STATUSES.includes(v)) throw new RangeError(`bad status ${v}`);
}
export { STATUSES, QTY_MODES, EDITABLE };
