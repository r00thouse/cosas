// multipart/form-data parser (SPEC.md §5.4). Flat parts, no nesting. A name that
// repeats (several `<input type="file" name="photo">`, or several downscaled
// `photo_data` fields) becomes an array; a name seen once stays a plain value, so
// ordinary form fields keep working unchanged. No dependencies, no streaming — the
// caller caps the body size before calling.
export class MultipartError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

/** Store `value` under `key`, turning a repeat into an array. */
function push(bag, key, value) {
  const seen = bag[key];
  if (seen === undefined) bag[key] = value;
  else if (Array.isArray(seen)) seen.push(value);
  else bag[key] = [seen, value];
}

/** `multipart/form-data; boundary=...` -> boundary string, or null. */
export function boundaryOf(contentType) {
  const type = String(contentType || "");
  if (!/^multipart\/form-data\b/i.test(type)) return null;
  const m = /;\s*boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(type);
  const raw = m && (m[1] || m[2]);
  return raw || null;
}

/**
 * body: Buffer of the whole request body.
 * Returns { fields, files } where `files[name] = { filename, type, bytes }`.
 * Throws MultipartError("file_too_large") when one file exceeds `maxFile`.
 */
export function parseMultipart(body, boundary, { maxFile = 8 * 1024 * 1024, maxParts = 64 } = {}) {
  if (!Buffer.isBuffer(body) || !boundary) throw new MultipartError("bad_request");
  const delim = Buffer.from(`--${boundary}`, "latin1");
  const sep = Buffer.concat([CRLF, delim]);
  const fields = {};
  const files = {};
  let parts = 0;

  let pos = body.indexOf(delim);
  if (pos < 0) throw new MultipartError("no_boundary");

  for (;;) {
    pos += delim.length;
    // A `--` right after the delimiter closes the multipart body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1; // tolerate a bare LF

    const headEnd = body.indexOf(HEAD_END, pos);
    if (headEnd < 0) throw new MultipartError("bad_part");
    if (++parts > maxParts) throw new MultipartError("too_many_parts");

    const headerText = body.toString("utf8", pos, headEnd);
    const next = body.indexOf(sep, headEnd + HEAD_END.length);
    const dataEnd = next < 0 ? body.length : next;
    const data = body.subarray(headEnd + HEAD_END.length, dataEnd);

    const cd = /^content-disposition:\s*(.+)$/im.exec(headerText);
    if (!cd) throw new MultipartError("bad_disposition");
    const name = /\bname="([^"]*)"/i.exec(cd[1]) || /\bname=([^;\s]+)/i.exec(cd[1]);
    if (name) {
      const key = name[1].slice(0, 100);
      const filename = /\bfilename="([^"]*)"/i.exec(cd[1]) || /\bfilename=([^;\s]+)/i.exec(cd[1]);
      if (filename) {
        if (data.length > maxFile) throw new MultipartError("file_too_large");
        const ct = /^content-type:\s*([^\r\n]+)$/im.exec(headerText);
        push(files, key, {
          filename: filename[1].slice(0, 200),
          type: ct ? ct[1].trim().slice(0, 100) : "",
          bytes: Buffer.from(data),
        });
      } else {
        push(fields, key, data.toString("utf8"));
      }
    }

    if (next < 0) break;
    pos = next + CRLF.length; // now pointing at the next delimiter
  }
  return { fields, files };
}
