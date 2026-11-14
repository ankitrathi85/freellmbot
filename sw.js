// FreeLLM service worker: keeps a copy of the app itself (this page, its icons and its JavaScript
// libraries) so FreeLLM can open without an internet connection.
//
// It NEVER touches model files. WebLLM and the voice model already keep those in their own caches,
// and saving several GB twice would fill people's storage. Requests to Hugging Face, GitHub and the
// web-search sources are not intercepted at all.
//
// Bump the version when this file changes; old copies made by this worker are then cleaned up.
const CACHE = "freellm-shell-v1";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];
// CDNs the app loads its libraries from (WebLLM, Kokoro, pdf.js, mammoth).
const LIB_HOSTS = ["cdn.jsdelivr.net", "esm.run"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // Only delete our own old caches: WebLLM's and the voice model's caches must survive.
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("freellm-shell-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isLib = url => LIB_HOSTS.includes(url.hostname);
function worthSaving(req, res) {
  if (req.mode === "navigate" && res.redirected) return false; // browsers refuse redirected pages served from a cache
  return res.ok || (res.type === "opaque" && isLib(new URL(req.url))); // opaque = a plain <script> from a CDN (mammoth)
}

// Online: always use the newest copy (so updates and the latest WebLLM show up straight away) and save it.
// Offline, or no answer within 4 seconds: use the saved copy.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then(res => { if (worthSaving(req, res)) cache.put(req, res.clone()).catch(() => { }); return res; });
  const saved = await cache.match(req, { ignoreSearch: req.mode === "navigate" })
    || (req.mode === "navigate" ? await cache.match("./") : undefined);
  if (!saved) return net;
  net.catch(() => { }); // if the saved copy wins, a later network error is fine
  return Promise.race([net, new Promise(r => setTimeout(() => r(saved), 4000))]).catch(() => saved);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin || isLib(url)) e.respondWith(networkFirst(req));
  // Everything else (model downloads, web search) goes straight to the network, untouched.
});

// The page loads its libraries before this worker starts on the very first visit, so it sends us
// their addresses afterwards and we save a copy. That makes the app work offline from the first visit.
self.addEventListener("message", e => {
  if (e.data?.type !== "cache-libs") return;
  const urls = (e.data.urls || []).filter(u => { try { return isLib(new URL(u)); } catch { return false; } });
  const saveOne = async (cache, u) => {
    try {
      if (await cache.match(u)) return;
      const res = await fetch(u);            // usually answered from the browser's own cache, so cheap
      if (res.ok) await cache.put(u, res);
    } catch { /* offline or blocked: try again next visit */ }
  };
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(urls.map(u => saveOne(cache, u)))));
});
