// §8.10: the PWA service worker. It only ever caches our own static assets, so a
// signed-in page is NEVER served from the cache — the inventory stays a network-only
// app. Pages that fail offline get a small built-in page.
// §8.11: the two placeholders are filled in by the server from the current asset
// hashes. A deploy changes them, so this file changes, so the browser installs a new
// worker, which opens a new cache and deletes the old one.
const VERSION = "__VERSION__";
const CACHE = "cosas-" + VERSION;
const STATIC = __ASSETS__;

const OFFLINE = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
  "<title>Offline</title><link rel=\"stylesheet\" href=\"" + STATIC[0] + "\"></head>",
  "<body><div class=\"wrap\"><h1>Offline</h1>",
  "<p>The network is not reachable right now. The stickers and the printed sheet still work as paper.</p>",
  "<p>La red no está disponible ahora. Las etiquetas y la hoja impresa siguen sirviendo como papel.</p>",
  "</div></body></html>",
].join("");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(STATIC))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    );
    return;
  }

  if (url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest") {
    // Stale-while-revalidate: the cached copy answers instantly, a fresh copy is
    // fetched in the background and stored for the next visit — so a deploy that
    // changes app.css/app.js reaches an installed app on its second load.
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => null);
        return hit || net.then((res) => res || Response.error());
      }),
    );
  }

  // /photo/*, /export.csv, /r/* and everything else: network only.
});
