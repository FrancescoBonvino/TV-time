/* Service worker: tiene in cache solo i file dell'app, così si apre anche senza rete.
   I dati dei titoli arrivano sempre dalle API. */
const VER = 'tvt2-v1';
const SHELL = ['./', 'index.html', 'style.css', 'core.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // prima la rete (per ricevere gli aggiornamenti), poi la copia salvata
  e.respondWith(
    fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VER).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('index.html')))
  );
});
