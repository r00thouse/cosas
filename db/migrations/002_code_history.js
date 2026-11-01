// 002_code_history — retire-code bookkeeping, as used by store.js (§6.3, §8.6).
//
// items.code is NOT NULL and UNIQUE: item rows are never deleted (§6.3 r4), so a
// code that a retired sticker carries or carried cannot simply live on that row.
// "Retired sticker X once meant item N" is therefore its own history row, which
// nothing in the UI edits and which survives the item it mentions.
export const version = 2;

export function up(db) {
  db.exec(`
CREATE TABLE code_history (         -- a retired (forgotten) sticker, and what it meant
  code      TEXT    PRIMARY KEY,    -- the retired code; it is never claimable again
  item_id   INTEGER,                -- item that carried the sticker that retired it
  reason    TEXT    NOT NULL,       -- 'rebind' (reprinted) | 'reused' (printed again, kept)
  at        TEXT    NOT NULL
);
INSERT INTO code_history (code, item_id, reason, at)
  SELECT code, NULL, reason, at FROM forgotten_codes;
`);
}
