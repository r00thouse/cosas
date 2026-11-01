// Asset versioning (SPEC.md §8.11). Every browser asset is linked as
// `/static/app.css?v=<hash>`, where the hash is computed from the bytes on disk at
// boot. A deploy that changes any of them changes every URL, so a browser (or the
// service worker) can never keep serving yesterday's CSS/JS for an hour — the point
// of this module. There is no build step: the hash is just sha256 of the files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `publicDir` is scanned whole (so a newly added file is picked up), `extra` maps
 * names to paths outside it (the vendored QR decoder).
 *
 * Returns { version, url(path) }; `url` returns the path untouched when it does not
 * name a known asset, so it is safe to call on every link.
 */
export function createAssets(publicDir, extra = {}) {
  const files = { ...extra };
  try {
    for (const name of readdirSync(publicDir).sort()) files[name] = join(publicDir, name);
  } catch {
    // A missing public/ must not stop the server: an unversioned URL still works.
  }
  const digest = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    let bytes = Buffer.alloc(0);
    try {
      bytes = readFileSync(files[name]);
    } catch {
      bytes = Buffer.from(`missing ${name}`);
    }
    digest.update(name).update("\0").update(bytes).update("\0");
  }
  const version = digest.digest("hex").slice(0, 10);
  return {
    version,
    url(path) {
      const name = String(path).split("/").pop();
      return name in files ? `${path}?v=${version}` : path;
    },
  };
}
