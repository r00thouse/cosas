# Agent rules

Notes for anyone (human or agent) changing this repository. Read this before you
edit anything; `SPEC.md` is the design document, this file is the workflow.

## Commit every change

**Every change must be committed to git before you finish.** Do not leave modified
or untracked files behind in the working tree: a turn that changes code but ends
with `git status` dirty is an unfinished turn.

- One logical change per commit, with a message that says *what* and *why*
  (subject in the imperative, body for the reasoning when it is not obvious).
- Commit in the same turn as the edit, right after the change is verified — not
  "later", not as one giant catch-up commit at the end of a session.
- Keep the tree releasable: a commit must boot, and `npm test`, `npm run test:e2e`
  and `./dev.sh test` must pass for the code they touch (`TESTING.md` says how).
- Never commit generated or private data: `.env*` (except `.env.example`),
  `dev-data/`, `.dev/`, `*.db*`, `codes.txt`, `*.svg` sheets, `node_modules/`.
  `.gitignore` already covers them; do not add an exception for your convenience.
- Do not rewrite published history (no `push --force`, no `commit --amend` on a
  commit you did not just create) and do not commit secrets from the environment.

## Browser baseline: Chromium 83

The browser app must run on Chromium 83 (Chrome/Edge 83, Android WebView 83);
`SPEC.md` §3 records the contract and `tools/test/browser.test.js` enforces it.
There is no build step, so nothing down-levels the sources — write 83-compatible
code directly.

- **JS** (`public/*.js`): no optional chaining (`?.`), nullish coalescing (`??`),
  `String#replaceAll`, `Array#at`/`#findLast`, `Object.hasOwn`, `structuredClone`
  or `Promise.any`. `BarcodeDetector` is missing in 83: keep the jsQR fallback.
- **CSS** (`public/app.css`): no flexbox `gap` (use child margins; grid `gap` is
  fine), no `color-mix()` (precompute a variable), no `:has()` (mirror state onto
  a class in `app.js`, like the radio chips), no `aspect-ratio` (fixed size), no
  `inset` shorthand (four side properties), no `dvh` (use `vh` +
  `-webkit-fill-available`), and no `overflow-wrap: anywhere` (use `break-word`).
  `::file-selector-button` needs a `::-webkit-file-upload-button` twin, and
  `:focus-visible` needs the `@supports not selector(:focus-visible)` fallback.
- Add new browser features only after checking caniuse/MDN against 83, and keep
  the test list in `tools/test/browser.test.js` current when you do.
