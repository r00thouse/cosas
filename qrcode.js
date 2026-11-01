// QR encoding: the hard part (bit packing, Reed-Solomon, masking, version
// selection) comes from `qrcode-generator` (MIT, zero transitive dependencies).
// This module only adapts its API to the matrix shape the rest of the app uses
// and renders that matrix as SVG for the print sheets and the item pages.
import qrcodeFactory from "qrcode-generator";

/**
 * Encodes `text` (UTF-8) as a QR matrix. The quiet zone is NOT included.
 * @returns {{ size: number, modules: boolean[][] }}
 */
export function qrMatrix(text, ecc = "M") {
  const payload = String(text);
  if (payload.length === 0) throw new Error("empty payload");
  // Type number 0 = pick the smallest version that fits.
  const qr = qrcodeFactory(0, String(ecc).toUpperCase());
  qr.addData(payload);
  qr.make();
  const size = qr.getModuleCount();
  const modules = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(qr.isDark(y, x));
    modules.push(row);
  }
  return { size, modules };
}

const r4 = (n) => Math.round(n * 10000) / 10000;

/** Renders a matrix as an SVG string with a quiet zone. */
export function matrixToSvg(matrix, opts) {
  const o = Object.assign({ px: 120, quiet: 4, dark: "#000000", light: "#ffffff", title: "", cls: "", bodyOnly: false, unit: 1 }, opts || {});
  const size = matrix.size;
  const total = size + o.quiet * 2;
  const parts = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!matrix.modules[y][x]) continue;
      // `unit` scales every coordinate: 1 = module units, 24/size = millimetres on the sheet.
      const u = o.unit;
      parts.push(`M${r4((x + o.quiet) * u)} ${r4((y + o.quiet) * u)}h${r4(u)}v${r4(u)}h-${r4(u)}z`);
    }
  }
  const escape = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  const shape = `<path d="${parts.join("")}" fill="${o.dark}"/>`;
  if (o.bodyOnly) return shape;
  const title = o.title ? `<title>${String(o.title).replace(/[&<>]/g, (c) => escape[c])}</title>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${o.cls ? ` class="${o.cls}"` : ""} width="${o.px}" height="${o.px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    title +
    `<rect width="100%" height="100%" fill="${o.light}"/>` +
    shape + `</svg>`
  );
}
