// Page templates (SPEC.md §8). Every interpolated value is escaped by `html`;
// the only raw() calls build chrome from other templates (layouts, fragments).
import { html, raw, esc } from "./html.js";
import { pretty as prettyCode, stickerLines } from "./code.js";
import { STATUSES, QTY_MODES } from "./store.js";
import { qrMatrix, matrixToSvg } from "./qrcode.js";

const SEED_CATEGORIES = [
  "monitor", "laptop", "desktop", "server", "sbc", "phone", "tablet", "hdd", "ssd",
  "ram", "gpu", "psu", "keyboard", "mouse", "router", "switch", "3d-printer", "microcontroller",
];

/** Everything a template needs to render chrome and links. */
export function pageCtx(t, lang, session) {
  return { t, lang, session, member: Boolean(session) };
}

export function layout(c, { title, body, page = "" }) {
  const { t, lang, member } = c;
  return html`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f5f3f" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141516" media="(prefers-color-scheme: dark)">
<title>${title} — ${t("app.title")}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/static/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/static/icon-180.png">
</head>
<body data-page="${page}">
<div class="wrap">
<header class="top">
  <a class="brand" href="/">${t("app.title")}</a>
  <nav>
    ${member ? html`<a class="nav-add" href="/add">${t("nav.add")}</a>` : raw("")}
    <a href="/">${t("nav.home")}</a>
    ${member ? html`<a href="/codes">${t("nav.print")}</a><a href="/export.csv">${t("nav.export")}</a>` : raw("")}
    ${member
      ? html`<form method="post" action="/logout">${csrfField(c)}<button class="link" type="submit">${t("nav.logout")}</button></form>`
      : html`<a href="/login">${t("nav.login")}</a>`}
    <span class="lang" aria-label="${t("nav.ui_lang")}">
      ${["en", "es"].map((l) =>
        html`<form method="get" action="/lang/${l}"><button class="link${l === lang ? " current" : ""}" type="submit">${l.toUpperCase()}</button></form>`,
      )}
    </span>
  </nav>
</header>
<main>
${body}
</main>
<footer>${t("app.title")} · ${t("footer.made_by")}</footer>
</div>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}

/** Hidden _csrf field; empty for anonymous visitors (they only GET). */
export function csrfField(c) {
  return c.session && c.csrf ? html`<input type="hidden" name="_csrf" value="${c.csrf}">` : raw("");
}

export function errorPage(c, status, key, extra) {
  const back = html`<p><a href="/">${c.t("nav.home")}</a></p>`;
  return layout(c, { title: c.t(key), body: html`<h1>${c.t(key)}</h1>${extra || raw("")}${back}` });
}

// ---------------------------------------------------------------- list (§8.4)

export function listPage(c, { rows, total, page, pages, filters, categories, locations }) {
  const { t, member } = c;
  const from = rows.length ? (page - 1) * 50 + 1 : 0;
  const to = (page - 1) * 50 + rows.length;
  const opts = (values, selected) =>
    [html`<option value="">${t("list.filter_all")}</option>`].concat(
      values.map((v) => html`<option value="${v}"${v === selected ? raw(" selected") : raw("")}>${v}</option>`),
    );
  const qs = (p) => {
    const u = new URLSearchParams();
    if (filters.q) u.set("q", filters.q);
    if (filters.category) u.set("category", filters.category);
    if (filters.status) u.set("status", filters.status);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `/?${s}` : "/";
  };
  const body = html`
<h1>${t("nav.home")}</h1>
<p class="subtitle">${t("app.subtitle")}</p>
<form class="filters" method="get" action="/">
  <div><label for="q">${t("list.search_placeholder")}</label>
    <input id="q" name="q" type="search" value="${filters.q || ""}" placeholder="${t("list.scan_hint")}"></div>
  <div><label for="category">${t("list.filter_category")}</label>
    <select id="category" name="category">${opts(c.categories || [], filters.category)}</select></div>
  <div><label for="status">${t("list.filter_status")}</label>
    <select id="status" name="status">${opts(STATUSES, filters.status)}</select></div>
  <button class="primary" type="submit">${t("list.search_placeholder")}</button>
  ${filters.q || filters.category || filters.status ? html`<a class="button" href="/">${t("list.clean")}</a>` : raw("")}
</form>
${rows.length === 0
  ? html`<p>${t("list.empty")} ${member ? html`<a href="/codes">${t("list.empty_member")}</a>` : raw("")}</p>`
  : html`<table class="list">
  <thead><tr><th>${t("item.name")}</th><th>${t("item.category")}</th><th>${t("item.status")}</th><th>${t("item.location")}</th><th>${t("item.qty")}</th></tr></thead>
  <tbody>${rows.map(
    (r) => html`<tr>
      <td data-label="${t("item.name")}"><a href="/r/${r.code.toLowerCase()}">${r.name || r.code}</a></td>
      <td data-label="${t("item.category")}">${r.category}</td>
      <td data-label="${t("item.status")}"><span class="badge ${r.status}">${t(`item.status.${r.status}`)}</span></td>
      <td data-label="${t("item.location")}">${r.location}</td>
      <td data-label="${t("item.qty")}">${r.qty === 1 ? "" : r.qty}</td>
    </tr>`,
  )}</tbody>
</table>`}
<div class="pager">
  ${page > 1 ? html`<a class="button" href="${qs(page - 1)}">${t("list.prev")}</a>` : raw("")}
  <span>${t("list.range", { from, to, total })}</span>
  ${page < pages ? html`<a class="button" href="${qs(page + 1)}">${t("list.next")}</a>` : raw("")}
</div>
${member ? html`<p class="hint"><a href="/codes">${t("nav.print")}</a></p>` : html`<p class="hint"><a href="/login">${t("nav.login")}</a></p>`}
`;
  return layout(c, { title: t("list.title"), body, page: "list" });
}

// ------------------------------------------------------- scan: login prompt

export function loginPrompt(c, code) {
  return layout(c, {
    title: c.t("auth.must_login"),
    page: "login",
    body: html`<h1>${c.t("auth.must_login")}</h1>
<p class="readonly">${prettyCode(code)}</p>
<p>${c.t("auth.must_login_detail")}</p>
<p><a class="button primary" href="/login?next=${encodeURIComponent(`/r/${code.toLowerCase()}`)}">${c.t("auth.login_cta")}</a></p>`,
  });
}

const DASHED = (code) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
/** The code with blanks for the still-unscanned part: "2H__-____-2013-5VJX". */
export const paddedCode = (input) => {
  const clean = String(input).replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 16);
  return DASHED((clean + "_".repeat(16)).slice(0, 16));
};

// ------------------------------------------------- public view / action sheet (§8.3)

export function itemPage(c, { code, item, flash, errors, editing, confirm }) {
  const { t, member } = c;
  const publicPart = html`
<h1>${item.name || item.category || prettyCode(code)}</h1>
<p class="readonly">${prettyCode(code)}</p>
<dl class="item">
  <dt>${t("item.category")}</dt><dd>${item.category}</dd>
  <dt>${t("item.status")}</dt><dd><span class="badge ${item.status}">${t(`item.status.${item.status}`)}</span></dd>
  ${item.location ? html`<dt>${t("item.location")}</dt><dd>${item.location}</dd>` : raw("")}
  ${item.qty !== 1
    ? html`<dt>${t("item.qty")}</dt><dd><span data-qty-value>${item.qty}</span></dd>`
    : raw("")}
</dl>`;
  let memberPart = raw("");
  if (member) {
    memberPart = html`
${photoPanel(c, item, code)}
<section class="panel">
<h2>${t("item.name")}: ${item.name}</h2>
<dl class="item">
  ${item.model ? html`<dt>${t("item.model")}</dt><dd>${item.model}</dd>` : raw("")}
  ${item.serial ? html`<dt>${t("item.serial")}</dt><dd>${item.serial}</dd>` : raw("")}
  ${item.held_by ? html`<dt>${t("item.held_by")}</dt><dd>${item.held_by}</dd>` : raw("")}
  ${item.notes ? html`<dt>${t("item.notes")}</dt><dd>${item.notes}</dd>` : raw("")}
  <dt>${t("item.qty")}</dt><dd><span data-qty-value>${item.qty}</span> <span class="hint">${t(`form.qty_mode.${item.qty_mode}`)}</span></dd>
  <dt>${t("item.created")}</dt><dd>${fmtDate(c.lang, item.created_at)}</dd>
  <dt>${t("item.updated")}</dt><dd>${fmtDate(c.lang, item.updated_at)}</dd>
</dl>
${item.reused ? html`<p class="hint">${t("scan.reused")}</p>` : raw("")}
${flash ? html`<p class="hint">${t(flash)}</p>` : raw("")}
<div class="actions">
  ${statusButtons(c, item)}
</div>
<div class="actions qty-controls">
  <form method="post" action="/r/${code.toLowerCase()}/qty">${csrfField(c)}<input type="hidden" name="delta" value="-1"><button data-qty-delta="-1" type="submit">${t("action.qty_minus")}</button></form>
  <form method="post" action="/r/${code.toLowerCase()}/qty">${csrfField(c)}<input type="number" name="qty" min="0" max="100000" value="${item.qty}" aria-label="${t("item.qty")}"><button type="submit">${t("action.qty_set")}</button></form>
  <form method="post" action="/r/${code.toLowerCase()}/qty">${csrfField(c)}<input type="hidden" name="delta" value="1"><button data-qty-delta="1" type="submit">${t("action.qty_plus")}</button></form>
</div>
<div class="actions">
  <a class="button" href="/r/${code.toLowerCase()}?edit=1">${t("action.edit")}</a>
</div>
${editing ? editForm(c, code, item, errors) : raw("")}
<div class="actions">
  ${confirm === "rebind"
    ? html`<form method="post" action="/r/${code.toLowerCase()}/rebind">${csrfField(c)}<p>${t("action.rebind_confirm")}</p><button class="danger" type="submit">${t("action.rebind_new_code")}</button> <a class="button" href="/r/${code.toLowerCase()}">${t("form.cancel")}</a></form>`
    : html`<form method="post" action="/r/${code.toLowerCase()}/rebind">${csrfField(c)}<input type="hidden" name="confirm" value="1"><button type="submit">${t("action.rebind")}</button></form>`}
  ${confirm === "delete"
    ? html`<form method="post" action="/r/${code.toLowerCase()}/delete">${csrfField(c)}<p>${t("action.delete_confirm")}</p><button class="danger" type="submit">${t("action.delete")}</button> <a class="button" href="/r/${code.toLowerCase()}">${t("form.cancel")}</a></form>`
    : html`<form method="post" action="/r/${code.toLowerCase()}/delete">${csrfField(c)}<input type="hidden" name="confirm" value="1"><button class="danger" type="submit">${t("action.delete")}</button></form>`}
</div>
</section>
${stickerPanel(c, code)}`;
  }
  return layout(c, {
    title: item.name || prettyCode(code),
    page: "item",
    body: html`${publicPart}${memberPart}`,
  });
}

function statusButtons(c, item) {
  const { t } = c;
  return STATUSES.map((s) =>
    html`<form method="post" action="/r/${item.code.toLowerCase()}/status">${csrfField(c)}<input type="hidden" name="status" value="${s}"><button type="submit" class="${s === item.status ? "primary" : ""}">${t(`item.status.${s}`)}</button></form>`,
  );
}

export function fmtDate(lang, iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** The item's photo plus its one upload form (§8.8). Admins only, like the panel. */
export function photoPanel(c, item, code) {
  const { t } = c;
  const src = `/photo/${code.toLowerCase()}`;
  return html`
<section class="panel photo-panel">
<h2>${t("item.photo")}</h2>
${item.photo
  ? html`<a href="${src}"><img class="photo" src="${src}" alt="${t("item.photo")}" loading="lazy"></a>`
  : html`<p class="hint">${t("photo.none")}</p>`}
<form method="post" action="/r/${code.toLowerCase()}/photo" enctype="multipart/form-data">
${csrfField(c)}
<label for="photo-file">${item.photo ? t("photo.replace") : t("photo.add")}</label>
<input id="photo-file" name="photo" type="file" accept="image/jpeg,image/png,image/webp">
<img class="photo-preview" data-photo-preview alt="" hidden>
<p class="hint">${t("photo.hint")}</p>
<div class="actions">
  <button class="primary" type="submit">${t("photo.upload")}</button>
  ${item.photo ? html`<label class="radio"><input type="checkbox" name="remove_photo" value="1"> ${t("photo.remove")}</label>` : raw("")}
</div>
</form>
</section>`;
}

/** The sticker for this item's current code (§8.3): QR + text + SVG download. */
export function stickerPanel(c, code) {
  const { t } = c;
  const url = c.stickerUrl(code);
  return html`
<section class="panel">
<h2>${t("codes.sticker_text", { code: prettyCode(code) })}</h2>
<div class="code-panel">
  ${raw(matrixToSvg(qrMatrix(url, "M"), { px: 120, quiet: 2, title: prettyCode(code), cls: "qr" }))}
  <div>
    <div class="code">${prettyCode(code)}</div>
    <div class="hint">${hostOf(url)}</div>
    <p><a class="button" href="/codes/svg?code=${code.toLowerCase()}">${t("codes.download_sticker")}</a></p>
  </div>
</div>
</section>`;
}

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ------------------------------------------------------ register / edit form (§8.2)

export function formFields(c, values, errors, { code, categories, locations, mode }) {
  const { t } = c;
  const err = (k) => (errors && errors[k] ? html` <span class="error">${t(errors[k])}</span>` : raw(""));
  const v = values || {};
  const cats = unique([...SEED_CATEGORIES, ...(categories || [])]);
  const datalist = html`<datalist id="categories">${cats.map((x) => html`<option value="${x}">`)}</datalist><datalist id="locations">${(locations || []).map((x) => html`<option value="${x}">`)}</datalist>`;
  return html`
${datalist}
${mode === "register"
  ? html`<label for="photo">${t("item.photo")}${err("photo")}</label>
<input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp">
<img class="photo-preview" data-photo-preview alt="" hidden>
<p class="hint">${t("photo.hint")}</p>`
  : raw("")}
<label for="name">${t("item.name")} *${err("name")}</label>
<input id="name" name="name" required maxlength="200" value="${v.name || ""}" placeholder="${t("form.name_placeholder")}">
<label for="category">${t("item.category")} *${err("category")}</label>
<input id="category" name="category" list="categories" required maxlength="100" value="${v.category || ""}" placeholder="${t("form.category_placeholder")}">
<label for="model">${t("item.model")}</label>
<input id="model" name="model" maxlength="200" value="${v.model || ""}" placeholder="${t("form.model_placeholder")}">
<label for="serial">${t("item.serial")}</label>
<input id="serial" name="serial" maxlength="200" value="${v.serial || ""}" placeholder="${t("form.serial_placeholder")}">
<label for="location">${t("item.location")}</label>
<input id="location" name="location" list="locations" maxlength="200" value="${v.location || ""}" placeholder="${t("form.location_placeholder")}">
<fieldset>
  <legend>${t("item.status")}</legend>
  ${STATUSES.map(
    (s) => html`<label class="radio"><input type="radio" name="status" value="${s}"${(v.status || "available") === s ? raw(" checked") : raw("")}> ${t(`item.status.${s}`)}</label>`,
  )}
</fieldset>
<label for="held_by">${t("item.held_by")}</label>
<input id="held_by" name="held_by" maxlength="200" value="${v.held_by || ""}" placeholder="${t("form.held_by_placeholder")}">
<label for="qty">${t("item.qty")}${err("qty")}</label>
<input id="qty" name="qty" type="number" inputmode="numeric" min="0" max="100000" value="${v.qty ?? 1}">
<fieldset>
  <legend>${t("form.qty_mode")}</legend>
  ${QTY_MODES.map(
    (m) => html`<label class="radio"><input type="radio" name="qty_mode" value="${m}"${(v.qty_mode || "count") === m ? raw(" checked") : raw("")}> ${t(`form.qty_mode.${m}`)}</label>`,
  )}
</fieldset>
<label for="notes">${t("item.notes")}</label>
<textarea id="notes" name="notes" rows="4" maxlength="4000" placeholder="${t("form.notes_placeholder")}">${v.notes || ""}</textarea>
${mode === "register"
  ? html`<p class="hint">${t("scan.unclaimed_prompt")}</p><div class="actions"><button class="primary" type="submit">${t("form.register")}</button></div>`
  : html`<div class="actions"><button class="primary" type="submit">${t("form.save")}</button> <a class="button" href="/r/${code.toLowerCase()}">${t("form.cancel")}</a></div>`}`;
}

function editForm(c, code, item, errors) {
  return html`<form method="post" action="/r/${code.toLowerCase()}/edit">
${csrfField(c)}
${formFields(c, item, errors, { code, categories: c.categories, locations: c.locations, mode: "edit" })}
</form>`;
}

export function registerPage(c, { code, values, errors, categories, locations }) {
  const { t } = c;
  return layout(c, {
    title: t("scan.claim_cta"),
    page: "register",
    body: html`<h1>${t("scan.claim_cta")}</h1>
<p class="readonly">${prettyCode(code)}</p>
<form method="post" action="/r/${code.toLowerCase()}/register" enctype="multipart/form-data">
${csrfField(c)}
${formFields(c, values, errors, { code, categories: categories || c.categories, locations: locations || c.locations, mode: "register" })}
</form>`,
  });
}

export function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

// ---------------------------------------------------------- 410 / 409 pages (§8.6)

export function gonePage(c, { code, reason }) {
  const { t, member } = c;
  const key = reason === "deleted" ? "scan.deleted" : "scan.revoked";
  const action = member
    ? reason === "deleted"
      ? html`<form method="post" action="/r/${code.toLowerCase()}/restore">${csrfField(c)}<input type="hidden" name="confirm" value="1"><button class="primary" type="submit">${t("action.restore")}</button></form>`
      : html`<form method="post" action="/items/new">${csrfField(c)}<button type="submit">${t("action.new_with_new_code")}</button></form>`
    : raw("");
  return layout(c, {
    title: t(key),
    page: "gone",
    body: html`<h1>${t(key)}</h1>
<p class="readonly">${prettyCode(code)}</p>
${action}
<p><a href="/">${t("nav.home")}</a></p>`,
  });
}

export function takenPage(c, { code, existing }) {
  const { t } = c;
  return layout(c, {
    title: t("err.code_taken"),
    page: "taken",
    body: html`<h1>${t("err.code_taken")}</h1>
<p class="readonly">${prettyCode(code)}</p>
<p><a href="/r/${existing.code.toLowerCase()}">${existing.name || prettyCode(existing.code)}</a></p>
<p><a class="button" href="/r/${code.toLowerCase()}">${t("scan.public_title")}</a></p>
<form method="post" action="/r/${code.toLowerCase()}/rebind">${csrfField(c)}<input type="hidden" name="confirm" value="1"><button class="danger" type="submit">${t("action.rebind_new_code")}</button></form>`,
  });
}

export function notFoundPage(c) {
  return errorPage(c, 404, "scan.not_found", html`<p>${c.t("scan.not_found_detail")}</p>`);
}

// --------------------------------------------------------- add by phone (§8.9)

/** The scan page: camera QR reader with a typed code as the fallback. */
export function scanPage(c, { error } = {}) {
  const { t } = c;
  return layout(c, {
    title: t("add.title"),
    page: "add",
    body: html`<h1>${t("add.title")}</h1>
<p class="subtitle">${t("add.subtitle")}</p>
${error ? html`<p class="error">${t(error)}</p>` : raw("")}
<div class="scanner" data-scanner-root
  data-msg-denied="${t("add.camera_denied")}"
  data-msg-unsupported="${t("add.unsupported")}"
  data-msg-scanning="${t("add.scanning")}"
  data-msg-notours="${t("add.not_ours")}">
  <video class="scanner-video" data-scanner-video playsinline muted hidden></video>
  <p class="hint" data-scanner-status>${t("add.camera_hint")}</p>
  <div class="actions">
    <button class="primary" type="button" data-scanner-start>${t("add.camera_start")}</button>
    <button type="button" data-scanner-stop hidden>${t("add.camera_stop")}</button>
  </div>
</div>
<form class="scan-manual" method="get" action="/add">
  <label for="code">${t("add.manual")}</label>
  <div class="row">
    <input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX">
    <button type="submit">${t("add.continue")}</button>
  </div>
</form>
<p class="hint">${t("add.https_hint")}</p>
<script src="/vendor/jsQR.js" defer></script>
<script src="/static/scan.js" defer></script>`,
  });
}

// --------------------------------------------------------- /codes print page (§8.7)

export function codesFormPage(c, { n }) {
  const { t } = c;
  return layout(c, {
    title: t("codes.title"),
    page: "codes",
    body: html`<h1>${t("codes.title")}</h1>
<form class="sheet-form" method="get" action="/codes">
  <div><label for="n">${t("codes.count")}</label><input id="n" name="n" type="number" min="1" max="${500}" value="${n}"></div>
  <button class="primary" type="submit">${t("codes.view")}</button>
</form>`,
  });
}

export function codesSheetPage(c, { stickers, n }) {
  const { t } = c;
  return layout(c, {
    title: t("codes.title"),
    page: "codes",
    body: html`<h1 class="no-print">${t("codes.title")}</h1>
<div class="no-print actions">
  <button class="primary" type="button" data-print>${t("codes.print")}</button>
  <a class="button" href="/codes/svg?n=${n}">${t("codes.download_svg")}</a>
  <a class="button" href="/codes?n=${n}">${t("codes.new_sheet")}</a>
</div>
<div class="sheet">
${stickers.map(
  (s) => html`<div class="sticker" data-code="${s.code.toLowerCase()}">
  ${raw(matrixToSvg(qrMatrix(s.url, "M"), { px: 96, quiet: 0 }))}
  <div>
    <div class="text">${stickerLines(s.code)[0]}
${stickerLines(s.code)[1]}</div>
    <div class="host">${hostOf(s.url)}</div>
  </div>
</div>`,
)}
</div>`,
  });
}

/** The same sheet as one standalone SVG (§7.5), server-rendered from the matrices. */
export function sheetSvg(stickers, { host }) {
  // 50 x 25 mm, 4 per row x 11 rows = 44 per A4 page (200 x 275 mm inside 5 mm margins).
  const W = 50;
  const H = 25;
  const perRow = 4;
  const rows = Math.ceil(stickers.length / perRow);
  const width = perRow * W;
  const height = Math.max(1, rows) * H;
  const parts = [];
  stickers.forEach((s, i) => {
    const x = (i % perRow) * W;
    const y = Math.floor(i / perRow) * H;
    const m = qrMatrix(s.url, "M");
    // The sheet viewBox is in mm, so scaling the module grid by 24/size gives a 24 mm QR.
    const qr = matrixToSvg(m, { bodyOnly: true, quiet: 0, dark: "#000", unit: 20 / m.size });
    const lines = stickerLines(s.code);
    parts.push(
      `<g transform="translate(${x + 1.5} ${y + 1.5})">` +
        `<rect x="-0.1" y="-0.1" width="${W - 3}" height="${H - 3}" fill="none" stroke="#bbb" stroke-width="0.2"/>` +
        `<g shape-rendering="crispEdges">${qr}</g>` +
        `<text x="22" y="8.5" font-family="monospace" font-size="2.4">${esc(lines[0])}</text>` +
        `<text x="22" y="12" font-family="monospace" font-size="2.4">${esc(lines[1])}</text>` +
        `<text x="22" y="17" font-family="monospace" font-size="1.7">${esc(host)}</text>` +
        `</g>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
}

