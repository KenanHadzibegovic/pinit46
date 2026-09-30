/* PINIT service worker — omogućava da se aplikacija OTVORI i bez interneta.
   Podaci (prijave, vožnje) idu kroz postojeći OUTBOX/syncQueue u app.html;
   ovdje samo keširamo "ljusku" aplikacije. /api se NIKAD ne kešira. */
const CACHE = 'pinit-shell-v5';
const SHELL = [
  '/',
  '/app',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/pinit-share.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // API i ne-GET zahtjevi: uvijek mreža, bez keširanja
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return; // pusti da ide direktno na mrežu (app.html sam hvata offline i redi u OUTBOX)
  }

  // Navigacija (otvaranje app-a): uvijek mreža, bez keša preglednika, pa tek onda keš.
  // Snimak čuvamo pod ADRESOM koja je otvorena — ranije je svaka stranica
  // (npr. /radnik) prepisivala snimak glavne aplikacije, pa je offline verzija
  // znala prikazati pogrešnu stranicu.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(url.pathname === '/app' ? '/' : url.pathname, copy)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match(url.pathname).then(r => r || caches.match('/')))
    );
    return;
  }

  // Naše skripte i podešavanja: mreža pa keš — inače izmjene (prijevodi, karte)
  // nikad ne bi stigle na telefon koji je aplikaciju već jednom otvorio.
  if (url.origin === location.origin && /\.(js|json|css|html)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Slike i fontovi: keš pa mreža
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(r => {
      if (r.ok && (url.origin === location.origin || url.host.includes('fonts.g'))) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return r;
    }).catch(() => cached))
  );
});
