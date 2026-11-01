// Item photos (SPEC.md §8.8). Bytes live on disk next to the database, one file per
// photo, and the `item_photos` table stores only the file name. No image library: the phone
// downscales before upload and the server only checks the magic bytes.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_PHOTO = 8 * 1024 * 1024;

/** How many photos one item may carry (§8.8). The panel is a grid, not a gallery. */
export const MAX_PHOTOS = 8;

const KINDS = [
  {
    mime: "image/jpeg",
    ext: "jpg",
    ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    ext: "png",
    ok: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
  },
  {
    mime: "image/webp",
    ext: "webp",
    ok: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  },
];

const KIND_BY_EXT = Object.fromEntries(KINDS.map((k) => [k.ext, k]));

/** { mime, ext } from the first bytes, or null when it is not an image we accept. */
export function sniff(bytes) {
  if (!bytes || bytes.length < 12) return null;
  for (const k of KINDS) if (k.ok(bytes)) return { mime: k.mime, ext: k.ext };
  return null;
}

/** `data:image/jpeg;base64,...` (the phone's downscaled upload) -> Buffer, or null. */
export function parseDataUrl(text) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(text || "").trim());
  if (!m) return null;
  const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  return bytes.length ? bytes : null;
}

/** Store `bytes` for `itemId`; returns the file name to keep in `item_photos.name`. */
export async function savePhoto(dir, itemId, bytes, ext) {
  await mkdir(dir, { recursive: true });
  const name = `${Number(itemId)}-${randomBytes(6).toString("hex")}.${ext}`;
  await writeFile(join(dir, name), bytes, { mode: 0o600 });
  return name;
}

/** Best effort: a missing file is not an error (the row is the source of truth). */
export async function removePhoto(dir, name) {
  if (!name) return;
  try {
    await rm(join(dir, name), { force: true });
  } catch {
    /* ignore */
  }
}

const NAME_RE = /^(\d+)-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** Absolute path for a stored name, or null when the name is not one we wrote. */
export function photoFile(dir, name) {
  const m = NAME_RE.exec(String(name || ""));
  return m ? { path: join(dir, m[0]), mime: KIND_BY_EXT[m[2]].mime } : null;
}

/** Files on disk that no live row points at (`item_photos`), so a crash cannot leak. */
export async function collectGarbage(dir, keep) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const live = new Set(keep);
  let removed = 0;
  for (const name of names) {
    if (live.has(name) || !NAME_RE.test(name)) continue;
    await rm(join(dir, name), { force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
