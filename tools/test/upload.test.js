// Unit tests for the multipart parser and the photo helpers (SPEC.md §5.4, §8.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryOf, parseMultipart, MultipartError } from "../../multipart.js";
import { sniff, parseDataUrl, savePhoto, removePhoto, photoFile, collectGarbage, missingPhotos, MAX_PHOTO } from "../../photos.js";

const BOUNDARY = "----testboundary1234";

/** Build a multipart body the way a browser does for one file and some fields. */
function body(parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${p.type || "application/octet-stream"}\r\n\r\n`));
      chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(p.value));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0x22)]);

test("boundaryOf reads quoted and bare boundaries, rejects other types", () => {
  assert.equal(boundaryOf("multipart/form-data; boundary=abc"), "abc");
  assert.equal(boundaryOf('multipart/form-data; boundary="a b c"'), "a b c");
  assert.equal(boundaryOf("multipart/form-data;charset=utf-8; boundary=xyz9"), "xyz9");
  assert.equal(boundaryOf("application/x-www-form-urlencoded"), null);
  assert.equal(boundaryOf("multipart/mixed; boundary=abc"), null);
  assert.equal(boundaryOf(""), null);
  assert.equal(boundaryOf(null), null);
});

test("parseMultipart splits fields and one file", () => {
  const buffer = body([
    { name: "_csrf", value: "abc.def" },
    { name: "name", value: "Dell U2412M" },
    { name: "photo", filename: "shot.jpg", type: "image/jpeg", value: JPEG },
    { name: "notes", value: "línea uno\nlínea dos" },
  ]);
  const { fields, files } = parseMultipart(buffer, BOUNDARY);
  assert.equal(fields._csrf, "abc.def");
  assert.equal(fields.name, "Dell U2412M");
  assert.equal(fields.notes, "línea uno\nlínea dos");
  assert.equal(files.photo.filename, "shot.jpg");
  assert.equal(files.photo.type, "image/jpeg");
  assert.deepEqual(files.photo.bytes, JPEG);
});

test("parseMultipart keeps an empty file input as an empty file", () => {
  const buffer = body([
    { name: "name", value: "x" },
    { name: "photo", filename: "", type: "application/octet-stream", value: Buffer.alloc(0) },
  ]);
  const { fields, files } = parseMultipart(buffer, BOUNDARY);
  assert.equal(fields.name, "x");
  assert.equal(files.photo.bytes.length, 0);
});

test("parseMultipart refuses a file over the cap and malformed bodies", () => {
  const big = body([{ name: "photo", filename: "huge.jpg", type: "image/jpeg", value: Buffer.alloc(64) }]);
  assert.throws(() => parseMultipart(big, BOUNDARY, { maxFile: 16 }), (e) => e instanceof MultipartError && e.code === "file_too_large");
  assert.throws(() => parseMultipart(Buffer.from("nothing here"), BOUNDARY), (e) => e.code === "no_boundary");
  assert.throws(() => parseMultipart(Buffer.from("--x\r\nContent-Disposition: form-data"), "x"), (e) => e.code === "bad_part");
  assert.throws(() => parseMultipart(Buffer.from("--x\r\nContent-Type: text/plain\r\n\r\nv\r\n--x--\r\n", "latin1"), "x"), (e) => e.code === "bad_disposition");
});

test("sniff accepts jpeg, png and webp, and nothing else", () => {
  assert.deepEqual(sniff(JPEG), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(sniff(PNG), { mime: "image/png", ext: "png" });
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.alloc(8)]);
  assert.deepEqual(sniff(webp), { mime: "image/webp", ext: "webp" });
  assert.equal(sniff(Buffer.from("GIF89a......")), null);
  assert.equal(sniff(Buffer.from("<svg xmlns=...")), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.equal(sniff(null), null);
});

test("parseDataUrl decodes the phone's canvas output", () => {
  const data = "data:image/jpeg;base64," + JPEG.toString("base64");
  assert.deepEqual(parseDataUrl(data), JPEG);
  assert.equal(parseDataUrl("data:image/gif;base64,R0lGOD"), null);
  assert.equal(parseDataUrl("data:image/jpeg;base64,"), null);
  assert.equal(parseDataUrl(JPEG.toString("base64")), null);
  assert.equal(parseDataUrl(null), null);
});

test("savePhoto, photoFile and removePhoto round-trip inside the directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cosas-photo-"));
  const name = await savePhoto(dir, 7, JPEG, "jpg");
  assert.match(name, /^7-[0-9a-f]{12}\.jpg$/);
  const mode = (await stat(join(dir, name))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(await readFile(join(dir, name)), JPEG);

  const found = photoFile(dir, name);
  assert.equal(found.mime, "image/jpeg");
  assert.equal(found.path, join(dir, name));

  // Names we did not write never become paths (no traversal, no odd extensions).
  assert.equal(photoFile(dir, "../../etc/passwd"), null);
  assert.equal(photoFile(dir, "7-abcdef123456.svg"), null);
  assert.equal(photoFile(dir, "7-abcdef12345.jpg"), null);
  assert.equal(photoFile(dir, ""), null);

  await removePhoto(dir, name);
  await assert.rejects(readFile(join(dir, name)));
  await removePhoto(dir, name); // missing file is not an error
  await removePhoto(dir, "");
});

test("missingPhotos names the rows whose file is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cosas-missing-"));
  const here = await savePhoto(dir, 1, PNG, "png");
  const gone = "2-0123456789ab.jpg";
  assert.deepEqual(await missingPhotos(dir, [here, gone]), [gone]);
  assert.deepEqual(await missingPhotos(join(dir, "no-such-dir"), [gone]), [gone]);
});

test("collectGarbage removes only files no row points at", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cosas-gc-"));
  const keep = await savePhoto(dir, 1, PNG, "png");
  const orphan = await savePhoto(dir, 2, PNG, "png");
  await writeFile(join(dir, "not-ours.txt"), "x");
  const removed = await collectGarbage(dir, [keep]);
  assert.equal(removed, 1);
  await readFile(join(dir, keep));
  await assert.rejects(readFile(join(dir, orphan)));
  await readFile(join(dir, "not-ours.txt"));
  assert.equal(await collectGarbage(join(dir, "missing"), []), 0);
});

test("MAX_PHOTO is 8 MB", () => {
  assert.equal(MAX_PHOTO, 8 * 1024 * 1024);
});

test("repeated part names become arrays (several photos in one post)", () => {
  const B = "----photos";
  const body = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\ntok\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo_data"\r\n\r\ndata:image/png;base64,AAAA\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo_data"\r\n\r\ndata:image/png;base64,BBBB\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    Buffer.from("\r\n"),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    Buffer.from("\r\n"),
    Buffer.from(`--${B}--\r\n`),
  ]);
  const { fields, files } = parseMultipart(body, B);
  assert.equal(fields._csrf, "tok", "a lone field stays a string");
  assert.equal(fields.photo_data.length, 2);
  assert.equal(files.photo.length, 2);
  assert.equal(files.photo[1].filename, "b.png");
});
