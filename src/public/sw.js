"use strict";
// Keeps the app shell on the phone, so the page still opens when the Mac that
// served it is asleep, and can reach whichever of your Macs is awake.
// The shell is network first: a reachable Mac always serves the current version.
// Fonts, the map and the icons never change within a version: cache first, fetched once.
// The API is never cached: session data must be live or absent, never stale.
const CACHE = "airpocket-shell-v2";
const SHELL = ["/", "/app.js", "/app.css", "/md.js", "/qr.js", "/where.js", "/manifest.webmanifest", "/icon-180.png"];
const ASSETS = ["/map.svg", "/fonts/b612-400.woff2", "/fonts/b612-700.woff2", "/fonts/b612-mono-400.woff2", "/fonts/b612-mono-700.woff2",
                "/fonts/plex-400.woff2", "/fonts/plex-500.woff2", "/fonts/plex-600.woff2"];
const ONCE = /^\/(map\.svg|fonts\/[a-z0-9-]+\.woff2|icon-[a-z0-9-]+\.png|launch\/[0-9x@]+\.jpg)$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...ASSETS])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const fromNetwork = () => fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
    return res;
  });
  if (ONCE.test(url.pathname)) {
    e.respondWith(caches.match(url.pathname).then((hit) => hit || fromNetwork()));
    return;
  }
  e.respondWith(fromNetwork().catch(() => caches.match(url.pathname).then((hit) => hit || caches.match("/"))));
});
