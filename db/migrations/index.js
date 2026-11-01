// The migration list, in order. To add one: create NNN_name.js exporting
// { version, up(db) } and append it here (SPEC.md §6.2). Versions are 1..N.
import * as m1 from "./001_init.js";
import * as m2 from "./002_code_history.js";
import * as m3 from "./003_photo.js";
import * as m4 from "./004_item_photos.js";

export default [m1, m2, m3, m4].sort((a, b) => a.version - b.version);
