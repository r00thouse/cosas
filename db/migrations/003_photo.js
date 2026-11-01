// 003_photo — one photo per item (SPEC.md §8.8). The column holds a file name in
// the photo directory, never bytes: SQLite should not carry the images around.
export const version = 3;

export function up(db) {
  db.exec(`ALTER TABLE items ADD COLUMN photo TEXT NOT NULL DEFAULT ''`);
}
