// 004_item_photos — several photos per item (SPEC.md §8.8). The old single column
// becomes rows here, so nothing is lost and the display order is insertion order.
export const version = 4;

export function up(db) {
  db.exec(`CREATE TABLE item_photos (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX item_photos_item ON item_photos (item_id, id)`);
  db.exec(`INSERT INTO item_photos (item_id, name, created_at)
           SELECT id, photo, updated_at FROM items WHERE photo <> ''`);
  db.exec(`ALTER TABLE items DROP COLUMN photo`);
}
