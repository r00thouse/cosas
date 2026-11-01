// 001_init — the whole schema (SPEC.md §6.2). One migration, one transaction.
export const version = 1;

export function up(db) {
  db.exec(`
CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE,          -- canonical 16-char code, §7
  code_seq      INTEGER NOT NULL,                 -- the SSSSSS field, informational (§7.1)
  name          TEXT    NOT NULL DEFAULT '',      -- short human name, e.g. "Monitor LG 24"
  category      TEXT    NOT NULL DEFAULT '',      -- free text w/ autocomplete, §8.5
  model         TEXT    NOT NULL DEFAULT '',
  serial        TEXT    NOT NULL DEFAULT '',
  location      TEXT    NOT NULL DEFAULT '',      -- free text w/ autocomplete
  status        TEXT    NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','in_use','broken','missing')),
  held_by       TEXT    NOT NULL DEFAULT '',      -- free text (who has it), '' = nobody
  qty_mode      TEXT    NOT NULL DEFAULT 'count'
                        CHECK (qty_mode IN ('count','bin')),  -- see §8.3 qty rules
  qty           INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0 AND qty <= 100000),
  notes         TEXT    NOT NULL DEFAULT '',      -- may contain newlines
  deleted_at    TEXT,                             -- ISO-8601 UTC or NULL
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX idx_items_live      ON items (deleted_at);
CREATE INDEX idx_items_category  ON items (category);
CREATE INDEX idx_items_status    ON items (status);
CREATE INDEX idx_items_location  ON items (location);

CREATE TABLE item_codes (             -- claimed codes = the audit trail of bindings
  code       TEXT    PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_item_codes_item ON item_codes (item_id);

CREATE TABLE items_audit (            -- safety net; no UI in v1
  id         INTEGER PRIMARY KEY,
  code       TEXT    NOT NULL,        -- code at the time of the event (may be gone)
  action     TEXT    NOT NULL,        -- 'register' | 'update' | 'delete' | 'restore' | 'rebind' | 'qty'
  actor      TEXT    NOT NULL,        -- session.sub
  before     TEXT,                    -- JSON snapshot, NULL for register
  after      TEXT,                    -- JSON snapshot, NULL for delete (soft)
  at         TEXT    NOT NULL
);

CREATE TABLE forgotten_codes (        -- freed sticker codes must not be reusable
  code       TEXT    PRIMARY KEY,
  reason     TEXT    NOT NULL,        -- always 'rebind'; deleting never forgets a code
  at         TEXT    NOT NULL
);
`);
}
