// SPEC.md §3 makes Chromium 83 the browser baseline (older Android WebViews and
// kiosk browsers are still out there). There is no build step to down-level the
// sources, so this test fails when newer syntax sneaks into public/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");

const JS_FILES = ["app.js", "scan.js", "sw.js"];
const CSS_FILES = ["app.css"];

const BANNED_JS = [
  [/\?\.\s*[A-Za-z_$[(]/, "optional chaining (?. — Chrome 80)"],
  [/\?\?/, "nullish coalescing (?? — Chrome 80)"],
  [/\.replaceAll\s*\(/, "String#replaceAll (Chrome 85)"],
  [/\.findLast(Index)?\s*\(/, "Array#findLast (Chrome 97)"],
  [/\bObject\.hasOwn\s*\(/, "Object.hasOwn (Chrome 93)"],
  [/\bstructuredClone\s*\(/, "structuredClone (Chrome 98)"],
  [/\bPromise\.any\s*\(/, "Promise.any (Chrome 85)"],
  [/\.at\s*\(/, "Array#at (Chrome 92)"],
];

const BANNED_CSS = [
  [/color-mix\s*\(/, "color-mix() (Chrome 111)"],
  [/:has\s*\(/, ":has() (Chrome 105)"],
  [/\baspect-ratio\s*:/, "aspect-ratio (Chrome 88)"],
  [/(?:^|[;{\s])inset\s*:/, "inset shorthand (Chrome 87)"],
  [/\d(?:dvh|dvw|dvi|dvb|dvmin|dvmax)\b/, "dynamic viewport units (Chrome 108)"],
  [/overflow-wrap\s*:\s*anywhere/, "overflow-wrap: anywhere (Chrome 84)"],
];

function hits(text, banned) {
  return banned
    .map(([pattern, label]) => (pattern.test(text) ? label : null))
    .filter(Boolean);
}

// The innermost `selector { declarations }` pairs of a stylesheet. At-rule
// wrappers are skipped because their bodies contain nested braces.
function cssRules(text) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    rules.push({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] });
  }
  return rules;
}

test("browser JS stays within Chromium 83 syntax", () => {
  for (const name of JS_FILES) {
    const found = hits(read(name), BANNED_JS);
    assert.deepEqual(found, [], `public/${name} uses ${found.join(", ")}`);
  }
});

test("browser CSS avoids features Chromium 83 lacks", () => {
  for (const name of CSS_FILES) {
    const css = read(name).replace(/\/\*[\s\S]*?\*\//g, "");
    const found = hits(css, BANNED_CSS);
    assert.deepEqual(found, [], `public/${name} uses ${found.join(", ")}`);
  }
});

test("flex containers do not rely on gap (Chromium 84)", () => {
  for (const name of CSS_FILES) {
    const css = read(name).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of cssRules(css)) {
      const flex = /display\s*:\s*(?:inline-)?flex\b/.test(rule.body);
      const gap = /(?:^|[;\s])(?:row-|column-)?gap\s*:/.test(rule.body);
      assert.ok(!(flex && gap), `public/${name}: "${rule.selector}" is flex + gap`);
    }
  }
});
