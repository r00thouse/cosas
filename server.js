// HTTP server (SPEC.md §5, §8). node:http only, one file, explicit routes.
//
// Pipeline, in order: security headers → route match → rate limit (/r/*) → CSRF on
// every POST → auth (member/admin) → handler. GET renders, POST mutates and ends in
// a 302 (or 409/410/422 with the same shell as every other page, §9.5).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { loadConfig } from "./config.js";
import { openDb, log } from "./db/index.js";
import { createStore, Conflict, STATUSES, QTY_MODES } from "./store.js";
import { normalize as normalizeCode, parse as parseCode, normalizeScan } from "./code.js";
import { parseSheetQuery, sheetCodes, freshCode, stickerUrl } from "./codes.js";
import { boundaryOf, parseMultipart, MultipartError } from "./multipart.js";
import { MAX_PHOTO, parseDataUrl, savePhoto, removePhoto, photoFile, sniff, collectGarbage } from "./photos.js";
import { makeT, pickLang, LANGS } from "./i18n.js";
import { sign, unsign, csrfFor, csrfValid, newSecret, clientIp, createLimiter } from "./security.js";
import { OidcClient, pkcePair, safeNext, OidcError } from "./oidc.js";
import * as V from "./views.js";
import { html } from "./html.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const COOKIE = { session: "session", tx: "oidc_tx", lang: "lang" };
const SESSION_TTL_S = 8 * 60 * 60;
const TX_TTL_S = 10 * 60;
const PAGE_SIZE = 50;
const MAX_QTY = 100000;
// A photo upload is the only large body: 8 MB of bytes plus multipart overhead,
// with room for the phone's base64 fallback (~4/3 of the image).
const MAX_BODY = 12 * 1024 * 1024;

/** Static files served from the repo root, outside the /static/ prefix (§5.2). */
// Served from the repo root rather than public/: the PWA files must answer on "/" to
// own the whole scope, and the QR decoder is a plain browser build of an npm package.
const ROOT_FILES = {
  "/manifest.webmanifest": { file: join(PUBLIC_DIR, "manifest.webmanifest"), type: "application/manifest+json", cache: "no-cache" },
  "/sw.js": { file: join(PUBLIC_DIR, "sw.js"), type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/vendor/jsQR.js": { file: join(HERE, "node_modules/jsqr/dist/jsQR.js"), type: "text/javascript; charset=utf-8", cache: "public, max-age=86400" },
};

/** `meta` rides along for the error page (e.g. the item holding a taken code). */
export class HttpError extends Error {
  constructor(status, key, meta = null) {
    super(key);
    this.status = status;
    this.key = key;
    this.meta = meta;
  }
}

export function createApp(cfg, { db, oidc, now = () => Date.now() }) {
  const store = createStore(db);
  const secure = cfg.publicOrigin.startsWith("https://");
  const rateLimit = createLimiter({ limit: 30, windowMs: 60_000, now });

  // ---------------------------------------------------------------- sessions

  const sessions = {
    issue(user) {
      const t = Math.floor(now() / 1000);
      return sign(cfg.sessionSecret, {
        sub: user.sub,
        name: user.name,
        role: user.role,
        iat: t,
        exp: t + SESSION_TTL_S,
      });
    },
    read(req) {
      const raw = cookie(req, COOKIE.session);
      if (!raw) return null;
      const p = unsign(cfg.sessionSecret, raw, now());
      if (!p || typeof p.sub !== "string" || !["admin", "member"].includes(p.role)) return null;
      return p;
    },
  };

  function ctxFor(req, session, extra = {}) {
    const lang = pickLang(cookie(req, COOKIE.lang), req.headers["accept-language"]);
    // Decode exactly like cookie() does, or the token is not reproducible on POST.
    const rawSession = cookie(req, COOKIE.session) || "";
    return {
      t: makeT(lang),
      lang,
      session,
      member: Boolean(session),
      csrf: session ? csrfFor(cfg.sessionSecret, rawSession) : "",
      stickerUrl: (code) => stickerUrl(cfg.publicOrigin, code),
      categories: store.distinct("category"),
      locations: store.distinct("location"),
      ...extra,
    };
  }

  // ---------------------------------------------------------------- responses

  function send(req, res, status, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "", "utf8");
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": buf.length,
      ...headers,
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  }
  const sendHtml = (req, res, status, doc) => send(req, res, status, String(doc), { "cache-control": "no-store" });
  const sendJson = (req, res, status, obj) =>
    send(req, res, status, JSON.stringify(obj), { "content-type": "application/json", "cache-control": "no-store" });

  function redirect(res, location, setCookies = []) {
    const headers = { location, "cache-control": "no-store" };
    if (setCookies.length) headers["set-cookie"] = setCookies;
    res.writeHead(302, headers);
    res.end();
  }

  function setCookie(name, value, { maxAge, secure: sec = secure, httpOnly = true } = {}) {
    const parts = [`${name}=${value}`, "Path=/", "SameSite=Lax"];
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    if (httpOnly) parts.push("HttpOnly");
    if (sec) parts.push("Secure");
    return parts.join("; ");
  }

  // ---------------------------------------------------------------- helpers

  /** The whole request body, capped. Photos are the only big ones (§8.8). */
  async function readBody(req) {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY) throw new HttpError(413, "err.photo_too_big");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, "err.photo_too_big");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** A POST body -> { fields, files }. Accepts urlencoded and multipart (§5.4). */
  async function readForm(req) {
    const type = String(req.headers["content-type"] || "");
    const body = await readBody(req);
    if (type.toLowerCase().startsWith("multipart/form-data")) {
      const boundary = boundaryOf(type);
      if (!boundary) throw new HttpError(400, "err.internal");
      try {
        const { fields, files } = parseMultipart(body, boundary, { maxFile: MAX_PHOTO });
        return { fields, files };
      } catch (e) {
        if (e instanceof MultipartError && e.code === "file_too_large") throw new HttpError(413, "err.photo_too_big");
        throw new HttpError(400, "err.internal");
      }
    }
    const fields = {};
    for (const [k, v] of new URLSearchParams(body.toString("utf8"))) fields[k] = v;
    return { fields, files: {} };
  }

  /**
   * The photo of a form: an uploaded file, the phone's downscaled `photo_data`
   * data-URL, or nothing. Throws 422 when the bytes are not JPEG/PNG/WebP.
   */
  function readPhoto(form, files) {
    const upload = files && files.photo;
    const bytes =
      upload && upload.bytes && upload.bytes.length
        ? upload.bytes
        : form.photo_data
          ? parseDataUrl(form.photo_data)
          : null;
    if (!bytes) return null;
    if (bytes.length > MAX_PHOTO) throw new HttpError(413, "err.photo_too_big");
    const kind = sniff(bytes);
    if (!kind) throw new HttpError(422, "err.bad_photo");
    return { bytes, ext: kind.ext };
  }

  /** Item fields from a form (§8.2). Returns {values, errors}. */
  function readItemFields(form) {
    const text = (k, max) => String(form[k] ?? "").trim().slice(0, max);
    const errors = {};
    const name = text("name", 200);
    const category = text("category", 100);
    if (!name) errors.name = "err.field_required";
    if (!category) errors.category = "err.field_required";
    const qtyRaw = String(form.qty ?? "1").trim();
    const qty = qtyRaw === "" ? 1 : Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) errors.qty = "err.qty_range";
    return {
      errors,
      values: {
        name,
        category,
        model: text("model", 200),
        serial: text("serial", 200),
        location: text("location", 200),
        status: STATUSES.includes(form.status) ? form.status : "available",
        held_by: text("held_by", 200),
        qty_mode: QTY_MODES.includes(form.qty_mode) ? form.qty_mode : "count",
        qty: Number.isInteger(qty) && qty >= 0 && qty <= MAX_QTY ? qty : 1,
        notes: text("notes", 4000),
      },
    };
  }

  /** The §8.1 decision table for `/r/<code>`; `state` is 'bound' | 'deleted' | 'free'. */
  function resolveCode(codeParam) {
    const parsed = parseCode(cfg.codeSecret, codeParam);
    if (!parsed) return null;
    const item = store.itemForScan(parsed.code);
    return { parsed, item, state: item ? (item.deleted_at ? "deleted" : "bound") : "free" };
  }

  function resolveOr404(codeParam) {
    const r = resolveCode(codeParam);
    if (!r) throw new HttpError(404, "scan.not_found");
    return r;
  }

  /** A bound (live) item, or 404/410 per the table. */
  function boundOr410(codeParam) {
    const r = resolveOr404(codeParam);
    if (r.state === "deleted") throw new HttpError(410, "scan.deleted");
    if (r.state === "free") throw new HttpError(410, "scan.revoked");
    return r;
  }

  function flashFor(req, url) {
    const f = url.searchParams.get("flash");
    if (f === "+1") return "action.qty_plus";
    if (f === "-1") return "action.qty_minus";
    if (f === "photo") return "action.photo_saved";
    return null;
  }

  function renderItem(req, res, status, session, { item, code, editing = false, confirm = null, errors = null, url = null }) {
    const c = ctxFor(req, session);
    const flash = url ? flashFor(req, url) : null;
    sendHtml(req, res, status, V.itemPage(c, { code, item, flash, errors, editing, confirm }));
  }

  // ---------------------------------------------------------------- handlers

  function handleHealthz(req, res) {
    db.prepare("SELECT 1").get();
    send(req, res, 200, "ok", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  }

  function handleList(req, res, session, url) {
    const c = ctxFor(req, session);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
    const category = (url.searchParams.get("category") || "").slice(0, 100);
    const rawStatus = url.searchParams.get("status") || "";
    const status = STATUSES.includes(rawStatus) ? rawStatus : "";
    const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
    const opts = { q, category, status, anon: !session };
    const total = store.countFiltered(opts);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = store.listLive({ ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    sendHtml(req, res, 200, V.listPage(c, { rows, total, page, pages, filters: { q, category, status } }));
  }

  function handleScan(req, res, session, url, codeParam) {
    const r = resolveOr404(codeParam);
    const confirm = url.searchParams.get("confirm");
    if (r.state === "deleted") {
      return sendHtml(req, res, 410, V.gonePage(ctxFor(req, session), { code: r.item.code, reason: "deleted" }));
    }
    // §8.1: a sticker retired by rebind must never fall through to the 200 "register me" page.
    if (r.state === "free" && store.isForgotten(r.parsed.code)) {
      return sendHtml(req, res, 410, V.gonePage(ctxFor(req, session), { code: r.parsed.code, reason: "revoked" }));
    }
    if (r.state === "free") {
      const code = r.parsed.code;
      if (!session) return sendHtml(req, res, 200, V.loginPrompt(ctxFor(req, session), codeParam));
      return sendHtml(req, res, 200, V.registerPage(ctxFor(req, session), { code }));
    }
    const editing = Boolean(session) && url.searchParams.get("edit") === "1";
    const okConfirm = confirm === "rebind" || confirm === "delete" ? confirm : null;
    renderItem(req, res, 200, session, { item: r.item, code: r.item.code, editing, confirm: okConfirm, url });
  }

  /** `GET /add` (§8.9): the phone's scan page, or the no-JS `?code=` fallback. */
  function handleAdd(req, res, session, url) {
    const c = ctxFor(req, session);
    if (url.searchParams.has("code")) {
      const code = normalizeScan(url.searchParams.get("code"));
      if (code && parseCode(cfg.codeSecret, code)) return redirect(res, `/r/${code.toLowerCase()}`);
      return sendHtml(req, res, 422, V.scanPage(c, { error: "scan.not_found" }));
    }
    return sendHtml(req, res, 200, V.scanPage(c, {}));
  }

  async function postRegister(req, res, session, { code: codeParam, form, files }) {
    const r = resolveOr404(codeParam);
    if (r.state === "deleted") throw new HttpError(410, "scan.deleted");
    if (r.state !== "free") throw new HttpError(409, "err.code_taken", { existing: r.item });
    const c = ctxFor(req, session);
    const { values, errors } = readItemFields(form);
    let photo = null;
    try {
      photo = readPhoto(form, files);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      errors.photo = e.key;
    }
    if (Object.keys(errors).length) {
      return sendHtml(req, res, 422, V.registerPage(c, { code: r.parsed.code, values, errors }));
    }
    let item;
    try {
      item = store.register(r.parsed.code, r.parsed.seq, values, session.sub);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      // Lost a race or a retired sticker: never a silent overwrite (§6.3 r3).
      const existing = store.itemByCode(r.parsed.code);
      if (existing && !existing.deleted_at) {
        return sendHtml(req, res, 409, V.takenPage(c, { code: r.parsed.code, existing }));
      }
      throw new HttpError(409, "err.code_taken", { existing });
    }
    if (photo) {
      const name = await savePhoto(cfg.photoDir, item.id, photo.bytes, photo.ext);
      item = store.setPhoto(item.id, item.code, name, session.sub);
    }
    log("info", "item.register", { code: item.code, actor: session.sub, photo: Boolean(photo) });
    redirect(res, `/r/${item.code.toLowerCase()}`);
  }

  /** `POST /r/:code/photo` (§8.8): add, replace, or clear the item's photo. */
  async function postPhoto(req, res, session, { code: codeParam, form, files }) {
    const { item } = boundOr410(codeParam);
    const home = `/r/${item.code.toLowerCase()}`;
    if (form.remove_photo === "1") {
      store.setPhoto(item.id, item.code, "", session.sub);
      await removePhoto(cfg.photoDir, item.photo);
      log("info", "item.photo_remove", { code: item.code, actor: session.sub });
      return redirect(res, `${home}?flash=photo`);
    }
    const photo = readPhoto(form, files);
    if (!photo) throw new HttpError(422, "err.bad_photo");
    const name = await savePhoto(cfg.photoDir, item.id, photo.bytes, photo.ext);
    store.setPhoto(item.id, item.code, name, session.sub);
    await removePhoto(cfg.photoDir, item.photo);
    log("info", "item.photo", { code: item.code, bytes: photo.bytes.length, actor: session.sub });
    redirect(res, `${home}?flash=photo`);
  }

  /** `GET /photo/:code` (§8.8): the bytes of the item's photo, admins only. */
  async function handlePhoto(req, res, session, url, codeParam) {
    const { item } = boundOr410(codeParam);
    const f = item.photo ? photoFile(cfg.photoDir, item.photo) : null;
    if (!f) throw new HttpError(404, "err.not_found");
    let data;
    try {
      data = await readFile(f.path);
    } catch {
      throw new HttpError(404, "err.not_found");
    }
    send(req, res, 200, data, { "content-type": f.mime, "cache-control": "private, max-age=300" });
  }

  function postEdit(req, res, session, { code: codeParam, form }) {
    const { item } = boundOr410(codeParam);
    const { values, errors } = readItemFields(form);
    if (Object.keys(errors).length) {
      return renderItem(req, res, 422, session, {
        item: { ...item, ...values },
        code: item.code,
        editing: true,
        errors,
      });
    }
    const updated = store.update(item.id, item.code, values, session.sub);
    log("info", "item.update", { code: updated.code, actor: session.sub });
    redirect(res, `/r/${updated.code.toLowerCase()}`);
  }

  function postStatus(req, res, session, { code: codeParam, form }) {
    const { item } = boundOr410(codeParam);
    if (!STATUSES.includes(form.status)) throw new HttpError(422, "err.field_required");
    store.setStatus(item.id, item.code, form.status, session.sub);
    log("info", "item.status", { code: item.code, status: form.status, actor: session.sub });
    redirect(res, `/r/${item.code.toLowerCase()}`);
  }

  /** §8.3: `qty` (absolute) xor `delta`; ±1 redirects with `?flash=`, fetch gets JSON. */
  function postQty(req, res, session, { code: codeParam, form, wantsJson }) {
    const { item } = boundOr410(codeParam);
    const hasQty = form.qty !== undefined && String(form.qty).trim() !== "";
    const hasDelta = form.delta !== undefined && String(form.delta).trim() !== "";
    const bad = () =>
      wantsJson
        ? sendJson(req, res, 422, { error: "err.qty_range" })
        : renderItem(req, res, 422, session, { item, code: item.code, errors: { qty: "err.qty_range" } });
    if (hasQty === hasDelta) return bad();
    let updated;
    if (hasDelta) {
      const delta = Number(form.delta);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_QTY) return bad();
      updated = store.bumpQty(item.id, item.code, delta, session.sub);
    } else {
      const qty = Number(form.qty);
      if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) return bad();
      updated = store.setQty(item.id, item.code, qty, session.sub);
    }
    log("info", "item.qty", { code: item.code, qty: updated.qty, actor: session.sub });
    if (wantsJson) return sendJson(req, res, 200, { qty: updated.qty });
    const flash = hasDelta ? `?flash=${encodeURIComponent(form.delta)}` : "";
    redirect(res, `/r/${item.code.toLowerCase()}${flash}`);
  }

  function postRebind(req, res, session, { code: codeParam, form }) {
    if (form.confirm !== "1") {
      // The first press only asks the confirmation question (§8.3, no confirm()).
      const r = resolveOr404(codeParam);
      if (r.state !== "bound") throw new HttpError(r.state === "deleted" ? 410 : 409, r.state === "deleted" ? "scan.deleted" : "err.code_taken");
      return renderItem(req, res, 200, session, { item: r.item, code: r.item.code, confirm: "rebind" });
    }
    const r = resolveOr404(codeParam);
    if (r.state === "deleted") throw new HttpError(410, "scan.deleted");
    const item = r.item || store.itemByCode(r.parsed.code);
    if (!item || item.deleted_at) throw new HttpError(409, "err.code_taken");
    let updated;
    try {
      updated = store.rebind(item, freshCode(cfg.codeSecret), session.sub);
    } catch (e) {
      if (e instanceof Conflict) throw new HttpError(409, "err.code_taken");
      throw e;
    }
    log("info", "item.rebind", { from: item.code, to: updated.code, actor: session.sub });
    redirect(res, `/r/${updated.code.toLowerCase()}`);
  }

  function postDelete(req, res, session, { code: codeParam, form }) {
    if (form.confirm !== "1") {
      const r = resolveOr404(codeParam);
      if (r.state !== "bound") throw new HttpError(r.state === "deleted" ? 410 : 409, r.state === "deleted" ? "scan.deleted" : "err.code_taken");
      return renderItem(req, res, 200, session, { item: r.item, code: r.item.code, confirm: "delete" });
    }
    const { item } = boundOr410(codeParam);
    store.softDelete(item.id, item.code, session.sub);
    log("info", "item.delete", { code: item.code, actor: session.sub });
    redirect(res, "/");
  }

  function postRestore(req, res, session, { code: codeParam }) {
    const r = resolveOr404(codeParam);
    if (r.state !== "deleted") throw new HttpError(r.state === "free" ? 410 : 409, r.state === "free" ? "scan.revoked" : "err.code_taken");
    try {
      store.restore(r.item.id, r.item.code, session.sub);
    } catch (e) {
      if (e instanceof Conflict) throw new HttpError(409, "err.code_taken");
      throw e;
    }
    log("info", "item.restore", { code: r.item.code, actor: session.sub });
    redirect(res, `/r/${r.item.code.toLowerCase()}`);
  }

  function postItemsNew(req, res, session) {
    const code = freshCode(cfg.codeSecret);
    log("info", "item.new_code", { actor: session.sub });
    redirect(res, `/r/${code.toLowerCase()}`);
  }

  function stickerHost() {
    try {
      return new URL(cfg.publicOrigin).host;
    } catch {
      return cfg.publicOrigin;
    }
  }

  function svgFor(stickers) {
    return V.sheetSvg(stickers, { host: stickerHost() });
  }

  function handleCodes(req, res, session, url) {
    const c = ctxFor(req, session);
    const sheet = parseSheetQuery(url.searchParams);
    if (sheet.mode === "range") return sendHtml(req, res, 422, V.errorPage(c, 422, "err.range"));
    if (sheet.mode === "form") return sendHtml(req, res, 200, V.codesFormPage(c, { n: sheet.n }));
    const stickers = sheetCodes(cfg.codeSecret, cfg.publicOrigin, sheet.n);
    sendHtml(req, res, 200, V.codesSheetPage(c, { stickers, n: sheet.n }));
  }

  function handleCodesSvg(req, res, session, url) {
    // `/codes/svg?code=X` is the single sticker of X's page (§8.3); with `n` it is a sheet.
    if (url.searchParams.has("code") && !url.searchParams.has("n")) return handleStickerSvg(req, res, session, url);
    const sheet = parseSheetQuery(url.searchParams);
    if (sheet.mode !== "sheet") {
      const key = sheet.mode === "range" ? "err.range" : "err.not_found";
      return sendHtml(req, res, 422, V.errorPage(ctxFor(req, session), 422, key));
    }
    const stickers = sheetCodes(cfg.codeSecret, cfg.publicOrigin, sheet.n);
    send(req, res, 200, svgFor(stickers), {
      "content-type": "image/svg+xml; charset=utf-8",
      "content-disposition": `attachment; filename="cosas-stickers-${sheet.n}.svg"`,
      "cache-control": "no-store",
    });
  }

  /** The sticker of one item's page (§8.3): `/codes/svg?code=<code>`. */
  function handleStickerSvg(req, res, session, url) {
    const parsed = parseCode(cfg.codeSecret, url.searchParams.get("code") || "");
    if (!parsed) throw new HttpError(404, "scan.not_found");
    const sticker = { code: parsed.code, url: stickerUrl(cfg.publicOrigin, parsed.code) };
    send(req, res, 200, svgFor([sticker]), { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
  }

  function csvCell(v) {
    return `"${String(v ?? "").replace(/"/g, '""')}"`;
  }

  function handleExport(req, res) {
    const cols = ["code", "name", "category", "model", "serial", "location", "status", "held_by", "qty", "notes", "photo", "created_at", "updated_at"];
    const rows = db.prepare("SELECT * FROM items WHERE deleted_at IS NULL ORDER BY id").all();
    const lines = [cols.join(",")];
    for (const r of rows) lines.push(cols.map((k) => csvCell(r[k])).join(","));
    const day = new Date().toISOString().slice(0, 10);
    send(req, res, 200, lines.join("\r\n") + "\r\n", {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="cosas-${day}.csv"`,
      "cache-control": "no-store",
    });
  }

  function handleLogin(req, res, url) {
    const next = safeNext(url.searchParams.get("next") || "/");
    const { verifier, challenge } = pkcePair();
    const state = newSecret(24);
    const tx = sign(cfg.sessionSecret, {
      state,
      verifier,
      next,
      nonce: newSecret(8),
      exp: Math.floor(now() / 1000) + TX_TTL_S,
    });
    redirect(res, oidc.authorizeUrl(state, challenge), [setCookie(COOKIE.tx, tx, { maxAge: TX_TTL_S })]);
  }

  async function handleCallback(req, res, url) {
    const txRaw = cookie(req, COOKIE.tx);
    const tx = txRaw ? unsign(cfg.sessionSecret, txRaw, now()) : null;
    const clearTx = setCookie(COOKIE.tx, "", { maxAge: 0 });
    const idpError = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (idpError) {
      const err = new HttpError(403, "auth.denied");
      err.setCookies = [clearTx];
      err.reason = idpError;
      throw err;
    }
    if (!code || !state || !tx || tx.state !== state || typeof tx.verifier !== "string") {
      const err = new HttpError(403, "auth.denied");
      err.setCookies = [clearTx];
      err.reason = "state_mismatch_or_expired";
      throw err;
    }
    let claims;
    try {
      claims = await oidc.exchange(code, tx.verifier);
    } catch (e) {
      const err = new HttpError(403, "auth.denied");
      err.setCookies = [clearTx];
      err.reason = e instanceof OidcError ? e.kind : "exchange_failed";
      throw err;
    }
    log("info", "auth.login", { sub: claims.sub, role: claims.role });
    redirect(res, safeNext(typeof tx.next === "string" ? tx.next : "/"), [
      clearTx,
      setCookie(COOKIE.session, sessions.issue(claims), { maxAge: SESSION_TTL_S }),
    ]);
  }

  function handleLang(req, res, lang) {
    if (!LANGS.includes(lang)) throw new HttpError(404, "err.not_found");
    redirect(res, safeBack(req), [setCookie(COOKIE.lang, lang, { maxAge: 31536000, httpOnly: false })]);
  }

  function handleLogout(req, res) {
    redirect(res, "/", [setCookie(COOKIE.session, "", { maxAge: 0 })]);
  }

  async function handleStatic(req, res, pathname) {
    const rel = decodeURIComponent(pathname.slice("/static/".length));
    // public/ is flat: one segment, no dots in the name, known extension only.
    if (!rel || rel.includes("/") || rel.includes("\\") || rel.startsWith(".") || rel.includes("\0")) {
      throw new HttpError(404, "err.not_found");
    }
    const ext = extname(rel);
    if (!MIME[ext]) throw new HttpError(404, "err.not_found");
    const file = join(PUBLIC_DIR, rel);
    if (normalize(file) !== file || !file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, "err.not_found");
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, "err.not_found");
    }
    send(req, res, 200, data, { "content-type": MIME[ext], "cache-control": "public, max-age=3600" });
  }

  /** `/manifest.webmanifest`, `/sw.js` and the vendored QR decoder. */
  async function handleRootFile(req, res, pathname) {
    const spec = ROOT_FILES[pathname];
    let data;
    try {
      data = await readFile(spec.file);
    } catch {
      throw new HttpError(404, "err.not_found");
    }
    send(req, res, 200, data, { "content-type": spec.type, "cache-control": spec.cache });
  }

  // ---------------------------------------------------------------- routing

  // handler(req, res, session, url, params) — `auth`: anon | member (admin role)
  const ROUTES = [
    ["GET", "/healthz", (req, res) => handleHealthz(req, res), "anon"],
    ["GET", "/", (req, res, s, url) => handleList(req, res, s, url), "anon"],
    ["GET", "/login", (req, res, s, url) => handleLogin(req, res, url), "anon"],
    ["GET", "/oidc/callback", (req, res, s, url) => handleCallback(req, res, url), "anon"],
    ["POST", "/logout", (req, res) => handleLogout(req, res), "anon"],
    ["GET", "/lang/:lang", (req, res, s, url, p) => handleLang(req, res, p.lang), "anon"],
    ["GET", "/r/:code", (req, res, s, url, p) => handleScan(req, res, s, url, p.code), "anon"],
    ["POST", "/r/:code/register", postRegister, "member"],
    ["POST", "/r/:code/edit", postEdit, "member"],
    ["POST", "/r/:code/status", postStatus, "member"],
    ["POST", "/r/:code/qty", postQty, "member"],
    ["POST", "/r/:code/photo", postPhoto, "member"],
    ["POST", "/r/:code/rebind", postRebind, "member"],
    ["POST", "/r/:code/delete", postDelete, "member"],
    ["POST", "/r/:code/restore", postRestore, "member"],
    ["GET", "/photo/:code", (req, res, s, url, p) => handlePhoto(req, res, s, url, p.code), "member"],
    ["POST", "/items/new", postItemsNew, "member"],
    ["GET", "/add", (req, res, s, url) => handleAdd(req, res, s, url), "member"],
    ["GET", "/manifest.webmanifest", (req, res, s, url) => handleRootFile(req, res, url.pathname), "anon"],
    ["GET", "/sw.js", (req, res, s, url) => handleRootFile(req, res, url.pathname), "anon"],
    ["GET", "/vendor/jsQR.js", (req, res, s, url) => handleRootFile(req, res, url.pathname), "anon"],
    ["GET", "/export.csv", (req, res) => handleExport(req, res), "member"],
    ["GET", "/codes", (req, res, s, url) => handleCodes(req, res, s, url), "member"],
    ["GET", "/codes/svg", (req, res, s, url) => handleCodesSvg(req, res, s, url), "member"],
    ["GET", "/static/:file", (req, res, s, url) => handleStatic(req, res, url.pathname), "anon"],
  ];

  function matchRoute(method, pathname) {
    for (const [m, pattern, handler, auth] of ROUTES) {
      if (m !== method) continue;
      if (!pattern.includes(":")) {
        if (pattern === pathname) return { method: m, handler, auth, params: {} };
        continue;
      }
      const want = pattern.split("/");
      const got = pathname.split("/");
      if (want.length !== got.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < want.length; i++) {
        if (want[i].startsWith(":")) {
          if (!got[i]) {
            ok = false;
            break;
          }
          params[want[i].slice(1)] = got[i];
        } else if (want[i] !== got[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { method: m, handler, auth, params };
    }
    return null;
  }

  // SPEC.md §5.2: the CSP denies everything that is not listed, so a page can only
  // load its own stylesheet, scripts and images. connect-src is for the qty fetch,
  // manifest-src/worker-src for the PWA (§8.10), media-src for the camera stream.
  const SECURITY_HEADERS = {
    "content-security-policy":
      "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };

  async function dispatch(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const route = matchRoute(req.method, url.pathname);
    if (!route) throw new HttpError(404, "err.not_found");

    // Sticker scans only (§10.3): POST actions stay bearer-token (CSRF) guarded, but
    // are not rate limited, so a bulk owner never locks their own session out.
    if (req.method === "GET" && url.pathname.startsWith("/r/")) {
      const ip = clientIp(req.socket?.remoteAddress, req.headers["x-forwarded-for"], cfg.trustProxy);
      const hit = rateLimit(ip);
      if (!hit.ok) {
        res.setHeader("retry-after", String(hit.retryAfter));
        throw new HttpError(429, "err.rate_limited");
      }
    }

    const session = sessions.read(req);
    let form = {};
    let files = {};
    if (req.method === "POST") {
      const parsed = await readForm(req);
      form = parsed.fields;
      files = parsed.files;
      if (!csrfValid(cfg.sessionSecret, cookie(req, COOKIE.session), form._csrf)) {
        log("warn", "csrf.rejected", { path: url.pathname, session: Boolean(session) });
        throw new HttpError(403, "err.csrf");
      }
    }
    if (route.auth === "member" && session?.role !== "admin") throw new HttpError(403, "err.forbidden");

    const wantsJson = String(req.headers.accept || "").includes("application/json");
    // The sticker is whichever code the URL carries, so every handler that needs it
    // passes it explicitly instead of relying on a shared argument position.
    if (route.method === "POST") return route.handler(req, res, session, { ...route.params, form, files, wantsJson });
    return route.handler(req, res, session, url, route.params);
  }

  const server = createServer((req, res) => {
    const rid = randomUUID().slice(0, 8);
    const started = now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("cache-control", "no-store");
    res.on("finish", () => {
      log(cfg.logLevel === "debug" ? "info" : "debug", "http", {
        rid,
        method: req.method,
        path: (req.url || "").split("?")[0],
        status: res.statusCode,
        ms: now() - started,
      });
    });
    dispatch(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) {
        if (e.reason) log("warn", "auth.denied", { reason: e.reason });
        if (Array.isArray(e.setCookies)) res.setHeader("set-cookie", e.setCookies);
        try {
          const c = ctxFor(req, sessions.read(req));
          let extra = null;
          if (e.key === "err.csrf") {
            extra = html`<p><a class="button primary" href="/login">${c.t("auth.login_cta")}</a></p>`;
          } else if (e.key === "auth.denied") {
            extra = html`<p><a class="button primary" href="/login">${c.t("auth.login_cta")}</a></p>`;
          } else if (e.key === "err.code_taken" && e.meta?.existing) {
            const ex = e.meta.existing;
            extra = html`<p><a href="/r/${ex.code.toLowerCase()}">${ex.name || V.paddedCode(ex.code)}</a></p>`;
          } else if (e.key === "err.code_taken") {
            extra = html`<p>${c.t("err.code_taken")}</p>`;
          }
          return sendHtml(req, res, e.status, V.errorPage(c, e.status, e.key, extra));
        } catch (inner) {
          log("error", "http.error_render", { rid, error: String(inner) });
          return send(req, res, 500, "error", { "content-type": "text/plain; charset=utf-8" });
        }
      }
      log("error", "http.unhandled", { rid, path: req.url, error: e?.stack || String(e) });
      try {
        sendHtml(req, res, 500, V.errorPage(ctxFor(req, sessions.read(req)), 500, "err.internal"));
      } catch {
        res.destroy();
      }
    });
  });

  return { server, store };
}

function cookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Same-origin path from Referer, for `GET /lang/:lang` (§8 route 5). */
function safeBack(req) {
  const ref = req.headers.referer;
  if (!ref) return "/";
  try {
    const u = new URL(ref);
    if (req.headers.host && u.host !== req.headers.host) return "/";
    const p = u.pathname + (u.search || "");
    return p.startsWith("/") && !p.startsWith("//") ? p.slice(0, 500) : "/";
  } catch {
    return "/";
  }
}


// ---------------------------------------------------------------------------
// Boot (`node server.js`, SPEC.md §10.1). Compose runs exactly this.

if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const oidc = new OidcClient(cfg, log);
  await oidc.init();
  const { server, store } = createApp(cfg, { db, oidc });
  // Drop photo files no row points at (e.g. a crash between write and COMMIT, §8.8).
  try {
    const removed = await collectGarbage(cfg.photoDir, store.photoNames());
    if (removed) log("info", "photos.collected", { removed });
  } catch (err) {
    log("warn", "photos.collect_failed", { error: String(err && err.message) });
  }
  server.listen(cfg.port, () => log("info", "listening", { port: cfg.port, origin: cfg.publicOrigin }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
