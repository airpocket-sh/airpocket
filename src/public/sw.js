"use strict";
// Keeps the app shell on the phone, so the page still opens when the Mac that
// served it is asleep, and can reach whichever of your Macs is awake.
// Network first: a reachable Mac always serves the current version.
// The API is never cached: session data must be live or absent, never stale.
const CACHE = "panel-shell-v6";
const SHELL = ["/", "/app.js", "/app.css", "/md.js", "/manifest.webmanifest", "/icon-180.png", "/icon-512.png",
               "/agent-claude.png", "/agent-codex.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
        return res;
      })
      .catch(() => caches.match(url.pathname).then((hit) => hit || caches.match("/")))
  );
});
