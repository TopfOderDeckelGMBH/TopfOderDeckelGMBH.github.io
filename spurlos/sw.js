/* Service Worker: macht Spurlos installierbar und lädt die App auch bei schlechtem Netz schnell. */
const CACHE = 'spurlos-v1';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/util.js', './js/engine.js', './js/net.js', './js/map.js', './js/ui.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Immer zuerst das Netz fragen (damit Updates sofort ankommen), bei Funkloch aus dem Speicher laden.
// Kartenkacheln und die Verbindung zu den Mitspielern laufen am Service Worker vorbei.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  if (!own && url.hostname !== 'unpkg.com') return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, {ignoreSearch: own}).then(r => r || caches.match('./index.html')))
  );
});
