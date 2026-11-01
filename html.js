// Tiny HTML helpers (SPEC.md §5.6). `html` escapes every interpolation; the only
// way to emit markup is an explicit raw() / <...> tagged call. Nothing else.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

/** Marker so nested fragments are not escaped again. */
export class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Trusted markup. Comment required at every use: why is this string safe? */
export const raw = (s) => new SafeHtml(String(s));

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

function render(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

/** `html` alias with a name that reads well inside expressions. */
export const tpl = html;

/** Attribute-safe JSON for data-* attributes (always double-quoted). */
export const attr = (v) => esc(v);

export function join(sep, items) {
  return raw(items.map(render).join(sep));
}
