/* ════════════════════════════════════════════════════════════
   PINIT SERVER — pokretanje:  node server.js
   Bez ikakvih instalacija (nula zavisnosti, samo Node.js).

   Servira:
     http://ADRESA:3000/           → mobilna aplikacija (app.html)
     http://ADRESA:3000/komandni   → komandni centar (komandni.html)
   API — građani i prijave:
     POST  /api/register            {name, city}        → {userId, token}
     GET   /api/reports?city=X      → lista prijava
     POST  /api/reports             {token, cat, note, photo, lat, lng, ts, city, name}
     POST  /api/reports/:id/vote    {delta}
     PATCH /api/reports/:id         {status, worker, cost, invoices, work, foto…}
     GET   /api/drives?city=X       → lista vožnji
     POST  /api/drives              (šalje aplikacija sama)
     GET   /api/stats?city=X

   API — radnici (nalozi i prijava):
     GET    /api/workers            → lista (bez PIN-a i tokena)
     POST   /api/workers            dispečer dodaje → vraća {code, pin} JEDNOM
     POST   /api/workers/:id/pin    dispečer resetuje PIN → novi {code, pin}
     POST   /api/worker/login       {code, pin}         → {token, worker}
     POST   /api/worker/logout      {token}
     GET    /api/worker/me?token=   provjera sesije
     POST   /api/worker/pin         {token, oldPin, newPin}
     PATCH  /api/workers/:id        {token, …}  radnik uređuje SVOJ profil
     POST   /api/workers/:id/loc    {token, lat, lng}  lokacija za dispečera
     DELETE /api/workers/:id
   Podaci se čuvaju u data.json pored servera.
   ════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'),
      crypto = require('crypto'), os = require('os');

/* ── VERZIJA ──
   Kad objaviš izmjene, otvori /api/verzija na svojoj adresi: ako tu ne piše
   broj ispod, Render još vrti stari kod (fajlovi nisu stigli ili deploy nije
   prošao). Isti broj ispiše se i u logu pri pokretanju. */
const PINIT_VERZIJA = 'v45';

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const PUB  = path.join(__dirname, 'public');

let DB = { users: [], reports: [], drives: [], workers: [], adminSessions: {}, postavke: null, oprema: [] };

/* ── SISTEMSKI ZAPIS ──
   Postavke institucije i sesije dispečera nisu ni prijava ni radnik, a u
   Supabaseu postoje samo četiri tabele. Da ne tražimo novu tabelu i ručni SQL,
   čuvamo ih kao JEDAN poseban red u tabeli korisnika, pod ovim ID-om.
   Pri učitavanju se taj red izdvoji iz liste korisnika, pa ga ostatak koda
   nikad ne vidi kao korisnika (ne ulazi ni u brojanje građana). */
const SISTEM_ID = '__pinit_sistem__';

/* ══════════════════════════════════════════════════════════════════
   POHRANA PODATAKA

   Do sada je sve živjelo u data.json na disku. Na Render free planu taj
   disk se briše pri svakom deployu i pri svakom gašenju instance, pa su
   nestajale sve prijave, radnici i njihovi nalozi.

   Sada, ako su postavljene varijable SUPABASE_URL i SUPABASE_KEY, podaci
   idu u Supabase (PostgreSQL) i preživljavaju sve. Ako nisu postavljene,
   sve radi kao prije preko data.json — tako lokalni rad ne traži nikakvo
   podešavanje.

   Kako radi:
     • pri pokretanju se sve učita u memoriju (kao i dosad),
     • server radi nad memorijom — brzo, bez ijedne izmjene u rutama,
     • save() u pozadini upiše u Supabase SAMO zapise koji su se stvarno
       promijenili, upoređujući ih s kopijom od zadnjeg upisa.

   Komunikacija ide preko Supabase REST sučelja običnim fetch pozivom, pa
   server i dalje nema nijednu vanjsku biblioteku i ne treba npm install.
   ══════════════════════════════════════════════════════════════════ */
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const SB_ON  = !!(SB_URL && SB_KEY);
const TABLES = { users: 'pinit_users', reports: 'pinit_reports',
                 drives: 'pinit_drives', workers: 'pinit_workers' };

function sbFetch(pathQ, opts = {}) {
  return fetch(SB_URL + '/rest/v1/' + pathQ, {
    method: opts.method || 'GET',
    headers: Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, opts.headers || {}),
    body: opts.body
  }).then(async r => {
    const txt = await r.text();
    if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + txt.slice(0, 300));
    return txt ? JSON.parse(txt) : null;
  });
}

/* Kopija zadnjeg upisanog stanja — po njoj znamo šta se promijenilo. */
const LAST = { users: new Map(), reports: new Map(), drives: new Map(), workers: new Map() };
const rowId = o => String(o.id);

async function loadDB() {
  if (!SB_ON) {
    try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}
    if (!Array.isArray(DB.oprema)) DB.oprema = [];
    return 'data.json (lokalni fajl)';
  }
  for (const key of Object.keys(TABLES)) {
    /* Supabase vraća najviše 1000 redova odjednom, pa idemo u koracima. */
    const all = [];
    for (let from = 0; ; from += 1000) {
      const page = await sbFetch(TABLES[key] + '?select=data&order=id.asc', {
        headers: { 'Range-Unit': 'items', 'Range': from + '-' + (from + 999) }
      });
      if (!page || !page.length) break;
      page.forEach(r => all.push(r.data));
      if (page.length < 1000) break;
    }
    DB[key] = all;
    all.forEach(o => LAST[key].set(rowId(o), JSON.stringify(o)));
  }
  const si = DB.users.findIndex(x => x && x.id === SISTEM_ID);
  if (si >= 0) {
    const sis = DB.users.splice(si, 1)[0];
    DB.postavke = sis.postavke || null;
    DB.adminSessions = sis.adminSessions || {};
    DB.oprema = Array.isArray(sis.oprema) ? sis.oprema : [];
  }
  return 'Supabase (' + SB_URL.replace(/^https?:\/\//, '') + ')';
}

let saveT = null, saving = false, again = false;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(flush, SB_ON ? 800 : 300);
}
function flush() {
  if (!SB_ON) return fs.writeFile(DATA, JSON.stringify(DB), () => {});
  if (saving) { again = true; return; }          // upis već traje — ponovi poslije
  saving = true;
  flushSB().catch(e => log('⚠ Upis u Supabase nije uspio: ' + e.message))
    .then(() => {
      saving = false;
      if (again) { again = false; save(); }
    });
}
async function flushSB() {
  for (const key of Object.keys(TABLES)) {
    let live = DB[key] || [];
    const seen = new Set();
    /* Sistemski red (postavke + sesije) ide uz korisnike — vidi SISTEM_ID. */
    if (key === 'users') live = live.concat([{ id: SISTEM_ID,
      postavke: DB.postavke || null, adminSessions: DB.adminSessions || {}, oprema: DB.oprema || [] }]);
    const changed = [];
    for (const o of live) {
      const id = rowId(o); seen.add(id);
      const now = JSON.stringify(o);
      if (LAST[key].get(id) !== now) changed.push({ id, data: o, _s: now });
    }
    /* Šaljemo u paketima da jedan ogroman zahtjev ne padne na vremenu. */
    for (let i = 0; i < changed.length; i += 50) {
      const part = changed.slice(i, i + 50);
      await sbFetch(TABLES[key], {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(part.map(x => ({ id: x.id, data: x.data })))
      });
      part.forEach(x => LAST[key].set(x.id, x._s));
    }
    /* Obrisani zapisi (npr. uklonjen radnik) moraju nestati i iz baze. */
    const gone = [...LAST[key].keys()].filter(id => !seen.has(id));
    for (let i = 0; i < gone.length; i += 50) {
      const part = gone.slice(i, i + 50);
      await sbFetch(TABLES[key] + '?id=in.(' +
        part.map(x => '"' + x.replace(/"/g, '') + '"').join(',') + ')', { method: 'DELETE' });
      part.forEach(id => LAST[key].delete(id));
    }
  }
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  /* Bez 'Access-Control-Allow-Origin': aplikacije dolaze s istog servera,
     pa im dozvola ne treba. Tuđe stranice time gube pristup ovom API-ju. */
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(b);
}
function readBody(req, cb) {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 25e6) { req.destroy(); } });
  req.on('end', () => { try { cb(JSON.parse(d || '{}')); } catch (e) { cb(null); } });
}
function log(msg) { console.log(new Date().toLocaleTimeString('bs'), '·', msg); }

/* ══════════════════════════════════════════════════════════════════
   PRIJAVA ZA DISPEČERA (platforma i komandni centar)

   Dosad je svako ko zna adresu mogao otvoriti platformu, vidjeti imena i
   tačne lokacije građana, mijenjati statuse, brisati radnike i resetovati
   im PIN-ove. Sada oboje traži lozinku.

   Lozinka NE stoji u data.json nego u varijabli okruženja PINIT_ADMIN_PASS.
   Razlog je praktičan: data.json se na Render free planu briše pri svakom
   deployu, pa bi nalog spremljen u njemu nestao i zaključao te van vlastitog
   sistema. Varijabla okruženja preživi deploy.

   Na Renderu:  Dashboard → tvoj servis → Environment → Add Environment
   Variable → Key: PINIT_ADMIN_PASS, Value: tvoja lozinka → Save.
   Lokalno:     PINIT_ADMIN_PASS=nekalozinka node server.js

   Ako varijabla nije postavljena, server pri pokretanju sam smisli lozinku
   i ispiše je u konzolu — tako lokalni rad radi bez podešavanja, ali sistem
   nikad ne ostaje otključan.
   ══════════════════════════════════════════════════════════════════ */
const ADMIN_SESSION_MS = 12 * 3600e3;        // sesija dispečera traje 12 h
/* ══ PREKIDAČ ZA PODEŠAVANJE ══
   PINIT_NO_AUTH=1 isključuje SVE prijave: platforma i komandni centar se
   otvaraju bez lozinke, a radnička aplikacija bez koda i PIN-a.

   Ovo postoji samo da ti ne smeta dok podešavaš stanicu. NE OSTAVLJAJ GA
   UKLJUČENOG na javnoj adresi — bez njega svako ko pogodi /platforma može
   brisati radnike, resetovati PIN-ove i vidjeti puna imena i fotografije
   građana. Render adrese botovi skeniraju same od sebe.

   Kad završiš: obriši varijablu PINIT_NO_AUTH i sve se vrati kako je bilo.
   Ništa se ne gubi — nalozi, PIN-ovi i lozinka ostaju gdje jesu. */
const NO_AUTH = process.env.PINIT_NO_AUTH === '1' ||
                String(process.env.PINIT_NO_AUTH || '').toLowerCase() === 'true';

/* ══════════════════════════════════════════════════════════════════
   LOZINKA ZA PLATFORMU I KOMANDNI CENTAR

   Ovdje je upisana stalna lozinka. Ne mijenja se, ne treba je nigdje
   podešavati, radi odmah nakon deploya.

   DA JE PROMIJENIŠ: izmijeni red ispod i pošalji na GitHub.

   Ako ti kasnije zatreba da lozinka NE stoji u kodu (npr. ako repo
   postane javan), postavi PINIT_ADMIN_PASS u Render → Environment —
   ta vrijednost ima prednost nad ovom ovdje.
   ══════════════════════════════════════════════════════════════════ */
const UGRADJENA_LOZINKA = 'pinit2026';

let ADMIN_PASS = process.env.PINIT_ADMIN_PASS || UGRADJENA_LOZINKA;
let ADMIN_GENERATED = false;

/* ── LOZINKA KOJU SERVER SAM SMISLI ──
   Ako PINIT_ADMIN_PASS nije postavljen, server smisli privremenu. Ranije ju
   je smišljao pri SVAKOM pokretanju, pa se mijenjala kad god se servis
   restartuje — a Render restartuje sam od sebe (uspavljivanje, deploy).
   Dok čovjek pročita lozinku iz loga i upiše je, ona više ne važi.
   Zato se sada pamti u bazi i ostaje ista dok je ne promijeniš.
   Poziva se tek nakon što se baza učita. */
const LOZ_FAJL = path.join(__dirname, '.pinit-lozinka');
function pripremiLozinku() {
  if (ADMIN_PASS) return;                      // postavljena kroz okruženje

  /* Pamti se u malom fajlu pored servera. Namjerno NE u Supabaseu — to bi
     tražilo novu tabelu i da ti ručno pokreneš SQL, a lozinka bi stajala u
     bazi u čitljivom obliku. Fajl preživi restart i uspavljivanje servisa,
     što je slučaj koji je i pravio problem.
     Napomena: na besplatnom Renderu PUNI DEPLOY briše disk, pa se tada
     smisli nova. Zato je pravo rješenje postaviti PINIT_ADMIN_PASS. */
  try {
    const spremljena = fs.readFileSync(LOZ_FAJL, 'utf8').trim();
    if (spremljena) { ADMIN_PASS = spremljena; ADMIN_GENERATED = true; return; }
  } catch (e) {}

  ADMIN_PASS = crypto.randomBytes(4).toString('hex');
  try { fs.writeFileSync(LOZ_FAJL, ADMIN_PASS, { mode: 0o600 }); } catch (e) {}
  ADMIN_GENERATED = true;
}
/* ── SESIJE DISPEČERA ──
   Prije su stajale samo u memoriji. Render besplatni plan uspava servis nakon
   par minuta bez posjeta, a pri buđenju memorija je prazna — dispečer je tada
   tiho ostajao bez sesije: dugmad su klikala, a server je sve odbijao (zato
   se „ne može napraviti radnik" ni dodijeliti zadatak). Zato sesije sada
   čuvamo uz ostale podatke, pa prežive gašenje i buđenje servisa. */
const ADMIN_SESSIONS = new Map();            // token → vrijeme isteka
function ucitajSesije() {
  const spremljene = (DB && DB.adminSessions) || {};
  const sad = Date.now();
  Object.keys(spremljene).forEach(t => { if (spremljene[t] > sad) ADMIN_SESSIONS.set(t, spremljene[t]); });
}
function zapamtiSesije() {
  const sad = Date.now(), out = {};
  ADMIN_SESSIONS.forEach((exp, t) => { if (exp > sad) out[t] = exp; });
  DB.adminSessions = out;
  save();
}

/* Poređenje lozinki u konstantnom vremenu. Obično poređenje (===) staje
   na prvom različitom znaku, pa se iz razlike u trajanju odgovora može
   pogađati lozinka znak po znak. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function adminCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)pinit_adm=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdmin(req) {
  if (NO_AUTH) return true;              // prekidač za podešavanje
  const t = adminCookie(req);
  if (!t) return false;
  const exp = ADMIN_SESSIONS.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { ADMIN_SESSIONS.delete(t); zapamtiSesije(); return false; }
  return true;
}
/* Kolačić je HttpOnly — JavaScript na stranici mu ne može pristupiti, pa ga
   ni ubačena skripta ne može ukrasti. Secure se šalje samo preko https. */
function setAdminCookie(res, token, req, maxAgeSec) {
  const https = (req.headers['x-forwarded-proto'] || '').indexOf('https') === 0 || !!req.socket.encrypted;
  res.setHeader('Set-Cookie',
    'pinit_adm=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec + (https ? '; Secure' : ''));
}
/* Usporavanje pogađanja lozinke: 10 promašaja s iste adrese → pauza 15 min. */
const ADMIN_FAILS = new Map();
function adminBlocked(ip) {
  const f = ADMIN_FAILS.get(ip);
  return !!(f && f.until && Date.now() < f.until);
}
/* Koliko minuta još traje pauza — da poruka bude konkretna. Bez ovoga
   blokada izgleda isto kao pogrešna lozinka, pa čovjek misli da lozinka ne
   valja i mijenja je, iako je bila tačna. */
function adminBlockMin(ip) {
  const f = ADMIN_FAILS.get(ip);
  if (!f || !f.until) return 0;
  return Math.max(1, Math.ceil((f.until - Date.now()) / 60000));
}
function adminFail(ip) {
  const f = ADMIN_FAILS.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 10) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  ADMIN_FAILS.set(ip, f);
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket.remoteAddress || '?';
}

/* ── PROVJERA ULAZNIH PODATAKA ──
   Sve što stiže s interneta tretiramo kao nepouzdano, i kad dolazi iz naše
   aplikacije — jer zahtjev može poslati bilo ko, ne samo naša stranica. */
function okLat(v) { return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90; }
function okLng(v) { return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180; }

/* Fotografija dolazi kao data-URL tekst. Provjeravamo da je stvarno slika
   dozvoljenog tipa, a ne skripta ili nešto treće preobučeno u sliku, i da
   nije prevelika. MAX je u znakovima base64 zapisa (~3/4 toga su bajti). */
const PHOTO_MAX = 8e6;
function okPhoto(v, max) {
  if (typeof v !== 'string') return false;
  if (v.length > (max || PHOTO_MAX)) return false;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(v)) return false;

  /* ── PROVJERA STVARNOG SADRŽAJA ──
     Zaglavlje "data:image/jpeg" napiše pošiljalac i može lagati. Zato gledamo
     prve bajte samog fajla — svaki format ima svoj potpis:
       JPEG → FF D8 FF        PNG → 89 50 4E 47        WEBP → RIFF....WEBP
     Ako se potpis ne poklapa, ovo nije slika nego nešto drugo preobučeno u
     sliku, i odbijamo ga. */
  try {
    const b64 = v.slice(v.indexOf(',') + 1).replace(/\s/g, '');
    const head = Buffer.from(b64.slice(0, 32), 'base64');
    if (head.length < 12) return false;
    const jpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
    const png  = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
    const webp = head.slice(0, 4).toString('ascii') === 'RIFF' &&
                 head.slice(8, 12).toString('ascii') === 'WEBP';
    return jpeg || png || webp;
  } catch (e) { return false; }
}
/* Vrati sliku ako je ispravna, inače null — nikad polovičan zapis. */
function cleanPhoto(v, max) { return okPhoto(v, max) ? v : null; }


/* razdaljina u metrima između dvije GPS tačke */
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const q = Math.sin(dLa / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
}
/* Traži RIJEŠENU prijavu istog tipa na istoj lokaciji — znak da se kvar vratio.
   Prozor: 1–180 dana nakon popravke. Ispod 1 dana je vjerovatno duplikat, ne ponavljanje. */
const RECUR_RADIUS_M = 120, RECUR_MIN_DAYS = 1, RECUR_MAX_DAYS = 180;
function findRecurrence(r) {
  if (typeof r.lat !== 'number' || typeof r.lng !== 'number') return null;
  let best = null, bestD = Infinity;
  for (const p of DB.reports) {
    if (p.status !== 3 || !p.resolvedAt) continue;
    if (p.cat !== r.cat) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const days = (r.ts - p.resolvedAt) / 864e5;
    if (days < RECUR_MIN_DAYS || days > RECUR_MAX_DAYS) continue;
    const d = distM(p, r);
    if (d <= RECUR_RADIUS_M && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/* ══════════════════════════════════════════════════════════════════
   POSTAVKE INSTITUCIJE
   Pravila koja su ranije bila zakucana u kodu, a sada ih administrator
   mijenja u Platformi → Postavke, bez programera. Sistem se isporučuje s
   polaznim vrijednostima ispod; institucija ih prepravlja po svojoj mjeri.
   Server stvarno koristi: rokove, pravila duplikata i pravila hitnosti.
   Ostalo (poeni, pogodnosti, zadržavanje…) je zapisana odluka institucije
   koju prikazuju aplikacije.
   ══════════════════════════════════════════════════════════════════ */
const POSTAVKE_POLAZNE = {
  institucija: { naziv: 'Grad Sarajevo', adresa: '', kontakt: '', grad: 'Sarajevo',
                 zaglavlje: 'Izvještaj o komunalnim prijavama' },
  sluzbe: [
    { id: 'putevi',  naziv: 'JKP Putevi',        aktivna: true, zona: null },
    { id: 'voda',    naziv: 'JKP Vodovod',       aktivna: true, zona: null },
    { id: 'elektro', naziv: 'JP Elektroprivreda', aktivna: true, zona: null },
    { id: 'cistoca', naziv: 'JKP Čistoća',       aktivna: true, zona: null }
  ],
  /* kategorija → služba koja dobija posao */
  kategorije: { putevi: 'putevi', predmet: 'putevi', staklo: 'putevi', ostalo: 'putevi',
                voda: 'voda', poplava: 'voda', rasveta: 'elektro', rasvjeta: 'elektro',
                elektro: 'elektro', otpad: 'cistoca' },
  rokovi: { staklo: 4, poplava: 12, voda: 24, predmet: 24, putevi: 72, otpad: 48,
            rasveta: 168, elektro: 168, ostalo: 72 },
  hitnost: { glasovaSrednje: 10, glasovaHitno: 25, hitnoPrepolovi: true, hitneKategorije: ['staklo'] },
  duplikati: { radiusM: 100, prozorDana: 30 },
  razgovori: { autoOtvaranje: true, autoArhiviranje: true, prikaziOpterecenje: true },
  poeni: { ukljuceni: true, prijava: 10, potvrdaNaTerenu: 20, potvrdaTudje: 5, ocjena: 5, prvihPet: true },
  sadrzaj: { pravila: 'Na fotografiji smije biti samo problem koji prijavljuješ. ' +
    'Ne šalji fotografije na kojima se prepoznaju osobe ili registarske tablice, ' +
    'eksplicitan ni uvredljiv sadržaj.' },
  pogodnosti: [
    { naziv: 'Karta za javni prevoz', cijena: 150, kolicina: 200, anonimno: true },
    { naziv: 'Sat besplatnog parkinga', cijena: 80, kolicina: 500, anonimno: true },
    { naziv: 'Umanjenje administrativne takse', cijena: 300, kolicina: 50, anonimno: false }
  ],
  obavjestenja: { novaPrijava: true, poruka: true, istekaoRok: true, dodjela: true },
  /* Mjesečni izvještaj: kome ide (e-pošta, odvojeno zarezom). */
  izvjestaj: { primaoci: '', naslov: 'Mjesečni izvještaj o komunalnim prijavama' },
  /* Imenovana područja (mjesne zajednice, općine) sa stanovništvom — za
     poređenje prijava i čekanja na 1.000 stanovnika. */
  podrucja: [],
  zadrzavanje: { arhivaMjeseci: 24, dokaziMjeseci: 120 },
  /* prosječan trošak jednog izlaska ekipe (KM) — za trošak odgađanja */
  trosakIzlaska: { putevi: 180, voda: 240, elektro: 120, cistoca: 90 },
  trosakZahvata: { putevi: 2400, voda: 3800, elektro: 900, cistoca: 600 },
  /* PINIT Drive: prag ispod kojeg dionica ide u plan, širina kolovoza za
     površinu i cijena zahvata po m² — unosi institucija, sistem ne pretpostavlja. */
  drive: { prag: 50, sirinaM: 7, krpljenje: 12, presvlacenje: 38, rekonstrukcija: 95, budzet: 150000 },
  log: []
};
/* Postavke uvijek vraćamo kompletne: ono što institucija nije dirala uzima se
   iz polaznih vrijednosti. Tako novo polje u kasnijoj verziji ne ostaje prazno. */
function postavke() {
  const s = DB.postavke || {};
  const out = {};
  for (const k of Object.keys(POSTAVKE_POLAZNE)) {
    const d = POSTAVKE_POLAZNE[k], v = s[k];
    if (v === undefined || v === null) out[k] = JSON.parse(JSON.stringify(d));
    else if (Array.isArray(d)) out[k] = Array.isArray(v) ? v : JSON.parse(JSON.stringify(d));
    else if (typeof d === 'object' && d !== null) out[k] = Object.assign({}, d, v);
    else out[k] = v;
  }
  return out;
}
/* Ono što smije vidjeti svako (građanska aplikacija): bez dnevnika izmjena
   i bez internih troškova. */
function postavkeJavne() {
  const s = postavke();
  return { institucija: { naziv: s.institucija.naziv, grad: s.institucija.grad },
           sadrzaj: s.sadrzaj, poeni: s.poeni,
           pogodnosti: s.poeni.ukljuceni ? s.pogodnosti : [] };
}
/* Čišćenje onoga što administrator pošalje: samo poznati ključevi, brojevi
   ostaju brojevi, tekst ima granicu dužine. Ništa drugo ne ulazi u bazu. */
function ocistiPostavke(ul) {
  const out = {};
  const tekst = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
  const broj = (v, min, max) => { const x = Number(v); return isFinite(x) ? Math.min(max, Math.max(min, x)) : null; };
  const bool = v => v === true;
  if (ul.institucija && typeof ul.institucija === 'object') {
    out.institucija = {}; ['naziv', 'adresa', 'kontakt', 'grad', 'zaglavlje']
      .forEach(k => { if (k in ul.institucija) out.institucija[k] = tekst(ul.institucija[k], 160); });
  }
  if (Array.isArray(ul.sluzbe)) out.sluzbe = ul.sluzbe.slice(0, 12).map(x => ({
    id: tekst(x.id, 20).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'sluzba',
    naziv: tekst(x.naziv, 60), aktivna: x.aktivna !== false,
    zona: (x.zona && okLat(x.zona.lat) && okLng(x.zona.lng))
      ? { lat: x.zona.lat, lng: x.zona.lng, km: broj(x.zona.km, 0.2, 80) || 2 } : null
  }));
  if (ul.kategorije && typeof ul.kategorije === 'object') {
    out.kategorije = {}; Object.keys(ul.kategorije).slice(0, 30)
      .forEach(k => { out.kategorije[tekst(k, 20)] = tekst(ul.kategorije[k], 20); });
  }
  if (ul.rokovi && typeof ul.rokovi === 'object') {
    out.rokovi = {}; Object.keys(ul.rokovi).slice(0, 30).forEach(k => {
      const v = broj(ul.rokovi[k], 1, 24 * 60); if (v != null) out.rokovi[tekst(k, 20)] = Math.round(v); });
  }
  const brojevi = (src, kljucevi, min, max) => {
    const o = {}; kljucevi.forEach(k => { if (k in src) { const v = broj(src[k], min, max); if (v != null) o[k] = v; } }); return o; };
  if (ul.hitnost) out.hitnost = Object.assign(brojevi(ul.hitnost, ['glasovaSrednje', 'glasovaHitno'], 1, 10000),
    'hitnoPrepolovi' in ul.hitnost ? { hitnoPrepolovi: bool(ul.hitnost.hitnoPrepolovi) } : {},
    Array.isArray(ul.hitnost.hitneKategorije) ? { hitneKategorije: ul.hitnost.hitneKategorije.slice(0, 20).map(x => tekst(x, 20)) } : {});
  if (ul.duplikati) out.duplikati = brojevi(ul.duplikati, ['radiusM', 'prozorDana'], 5, 5000);
  if (ul.razgovori) { out.razgovori = {}; ['autoOtvaranje', 'autoArhiviranje', 'prikaziOpterecenje']
    .forEach(k => { if (k in ul.razgovori) out.razgovori[k] = bool(ul.razgovori[k]); }); }
  if (ul.poeni) out.poeni = Object.assign(
    brojevi(ul.poeni, ['prijava', 'potvrdaNaTerenu', 'potvrdaTudje', 'ocjena'], 0, 10000),
    'ukljuceni' in ul.poeni ? { ukljuceni: bool(ul.poeni.ukljuceni) } : {},
    'prvihPet' in ul.poeni ? { prvihPet: bool(ul.poeni.prvihPet) } : {});
  if (ul.sadrzaj && 'pravila' in ul.sadrzaj) out.sadrzaj = { pravila: tekst(ul.sadrzaj.pravila, 2000) };
  if (Array.isArray(ul.pogodnosti)) out.pogodnosti = ul.pogodnosti.slice(0, 40).map(x => ({
    naziv: tekst(x.naziv, 80), cijena: broj(x.cijena, 0, 1e6) || 0,
    kolicina: broj(x.kolicina, 0, 1e7) || 0, anonimno: x.anonimno !== false }));
  if (ul.obavjestenja) { out.obavjestenja = {}; ['novaPrijava', 'poruka', 'istekaoRok', 'dodjela']
    .forEach(k => { if (k in ul.obavjestenja) out.obavjestenja[k] = bool(ul.obavjestenja[k]); }); }
  if (ul.izvjestaj && typeof ul.izvjestaj === 'object') out.izvjestaj = { primaoci: tekst(ul.izvjestaj.primaoci, 400), naslov: tekst(ul.izvjestaj.naslov, 120) };
  if (Array.isArray(ul.podrucja)) out.podrucja = ul.podrucja.slice(0, 60).map(x => ({ naziv: tekst(x.naziv, 60),
    lat: okLat(x.lat) ? x.lat : null, lng: okLng(x.lng) ? x.lng : null, km: broj(x.km, 0.1, 50) || 1.5, stanovnika: broj(x.stanovnika, 0, 1e7) || 0 }))
    .filter(x => x.naziv && x.lat != null && x.lng != null);
  if (ul.zadrzavanje) out.zadrzavanje = brojevi(ul.zadrzavanje, ['arhivaMjeseci', 'dokaziMjeseci'], 1, 600);
  if (ul.drive && typeof ul.drive === 'object')
    out.drive = brojevi(ul.drive, ['prag', 'sirinaM', 'krpljenje', 'presvlacenje', 'rekonstrukcija', 'budzet'], 0, 1e9);
  ['trosakIzlaska', 'trosakZahvata'].forEach(key => {
    if (ul[key] && typeof ul[key] === 'object') { out[key] = {}; Object.keys(ul[key]).slice(0, 20).forEach(k => {
      const v = broj(ul[key][k], 0, 1e7); if (v != null) out[key][tekst(k, 20)] = v; }); }
  });
  return out;
}

/* Služba kojoj prijava pripada: ako je dispečer proslijedio, važi to;
   inače odlučuje kategorija po Postavkama. */
function sluzbaOf(r) {
  if (r.dept) return r.dept;
  return postavke().kategorije[String(r.cat || '').toLowerCase()] || 'putevi';
}
/* Ko smije vidjeti i pisati u Razgovoru naloga: dispečer, dodijeljeni radnik,
   članovi ekipe i učesnici koje je dispečer dodao. */
function ucesnikNaloga(r, w) {
  if (!r || !w) return false;
  return r.worker === w.id ||
         (Array.isArray(r.crew) && r.crew.indexOf(w.id) >= 0) ||
         (Array.isArray(r.participants) && r.participants.indexOf(w.id) >= 0);
}
/* Radnik može mijenjati stanje naloga ako je on izvršilac ili član ekipe
   (nalog dodijeljen grupi ima zajedničko stanje). Učesnik razgovora ne može. */
function izvrsilacNaloga(r, w) {
  if (!r || !w) return false;
  return r.worker === w.id || (Array.isArray(r.crew) && r.crew.indexOf(w.id) >= 0);
}

/* ── SLA ROKOVI PO KATEGORIJI (sati) ──
   Vrijednosti prate praksu gradskih službi: hitna opasnost odmah, rupe 72 h
   (Washington DC / San Francisco standard), otpad 48 h, rasvjeta 7 dana.
   Hitan prioritet (puno potvrda građana) prepolovi rok. */
const SLA_CAT = { staklo:4, poplava:12, voda:24, predmet:24, putevi:72, otpad:48,
                  rasveta:168, rasvjeta:168, elektro:168, ostalo:72 };
function slaFor(cat, pri) {
  const k = String(cat||'').toLowerCase();
  const rok = postavke().rokovi || {};
  const base = (typeof rok[k] === 'number' && rok[k] > 0) ? rok[k] : (SLA_CAT[k] || 72);
  const pola = postavke().hitnost.hitnoPrepolovi !== false;
  return (pri === 'urgent' && pola) ? Math.max(2, Math.round(base / 2)) : base;
}

/* ── PROVJERA DUPLIKATA ──
   Ista praksa kao FixMyStreet / SeeClickFix: ako u krugu od 100 m već postoji
   OTVORENA prijava istog tipa, bolje je potvrditi postojeću nego otvoriti novu. */
const DUP_RADIUS_M = 100;
function findOpenDuplicate(cat, lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  /* Poluprečnik i vremenski prozor podešava institucija u Postavkama,
     jer se gustina naseljenosti razlikuje od grada do grada. */
  const dp = postavke().duplikati || {};
  const R = (typeof dp.radiusM === 'number' && dp.radiusM > 0) ? dp.radiusM : DUP_RADIUS_M;
  const od = Date.now() - ((typeof dp.prozorDana === 'number' && dp.prozorDana > 0) ? dp.prozorDana : 30) * 864e5;
  let best = null, bestD = Infinity;
  for (const p of DB.reports) {
    if (p.status === 3) continue;                       // riješene ne broji
    if (p.mergedInto) continue;                         // spojena je dio druge prijave
    if ((p.ts || 0) < od) continue;                     // izvan prozora
    if (String(p.cat) !== String(cat)) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const d = distM(p, { lat, lng });
    if (d <= R && d < bestD) { best = p; bestD = d; }
  }
  return best ? { report: best, dist: Math.round(bestD) } : null;
}

/* ── ZAŠTITA OD ZLOUPOTREBE ──
   Provjere se rade NA SERVERU jer se sve u aplikaciji može izmijeniti.
   Ne odbacujemo olako — sumnjivo označimo, a očito lažno odbijemo. */
const MAX_REPORTS_PER_DAY = 30;
function abuseCheck(b, ip) {
  const flags = [];
  const dayAgo = Date.now() - 864e5;
  const who = b.token || b.deviceId || ip;
  const mine = DB.reports.filter(r =>
    (r._who === who) && (r.ts || 0) > dayAgo);
  if (mine.length >= MAX_REPORTS_PER_DAY)
    return { reject: 'previše prijava u 24 h', flags };
  // isti korisnik, isti tip, isto mjesto, unutar 2 h → to je duplikat, ne nova prijava
  if (typeof b.lat === 'number') {
    const near = mine.find(r => r.cat === b.cat && typeof r.lat === 'number' &&
      distM(r, { lat: b.lat, lng: b.lng }) < 50 && (Date.now() - r.ts) < 2 * 3600e3);
    if (near) return { reject: 'isti problem si već prijavio prije manje od 2 h', flags };
  }
  if (typeof b.lat !== 'number') flags.push('bez-gps');
  else if (typeof b.acc === 'number' && b.acc > 200) flags.push('slab-gps');
  return { reject: null, flags };
}

/* ── VALIDACIJA VOŽNJE ──
   Bodovi se dijele po kilometru, pa lažna vožnja = lažni bodovi. Zato server
   provjeri putanju: da li kilometraža odgovara stvarnom GPS tragu i da li su
   brzine moguće. Ne vjerujemo brojci koju pošalje telefon. */
function validateDrive(d) {
  const flags = [];
  const path = Array.isArray(d.path) ? d.path.filter(p =>
    p && typeof p.lat === 'number' && typeof p.lng === 'number') : [];
  const km = Number(d.km) || 0;
  if (km > 500) return { reject: 'nemoguća kilometraža', flags, pathKm: 0 };
  if (d.test) flags.push('test');

  let pathM = 0, maxSpeed = 0, jumps = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dist = distM(a, b);
    const dt = (Number(b.t) - Number(a.t)) || 1;          // sekunde
    const sp = dt > 0 ? (dist / dt) * 3.6 : 0;            // km/h
    if (dist > 300) { jumps++; continue; }                 // GPS skok — ne broji
    pathM += dist;
    if (sp > maxSpeed) maxSpeed = sp;
  }
  const pathKm = +(pathM / 1000).toFixed(2);

  if (maxSpeed > 200) flags.push('nemoguća brzina');
  if (jumps > path.length * 0.2 && path.length > 10) flags.push('GPS skakao');
  if (path.length < 2) {
    flags.push('bez putanje');                             // stara verzija app-a ili bez GPS-a
  } else if (km > 2 && pathKm > 0.3 && Math.abs(pathKm - km) > Math.max(2, km * 0.7)) {
    /* Putanju računamo iz GPS-tačaka koje stižu povremeno (svakih par sekundi),
       pa je uvijek nešto kraća od stvarne kilometraže — to je normalno i nije
       greška. Upozorenje palimo tek kad je razlika stvarno velika, da ne visi
       na svakoj gradskoj vožnji. */
    flags.push('kilometraža ne odgovara putanji');
  }
  return { reject: null, flags, pathKm };
}

/* ══════════════════════════════════════════════════════════════════
   NALOZI RADNIKA — prijava, lozinka (PIN), sesija

   Kako radi:
     1. Dispečer u Platformi doda radnika  → server napravi KOD (npr. PUT-4821)
        i nasumičan 6-cifreni PIN. PIN se prikaže dispečeru SAMO TADA.
     2. Radnik u svojoj aplikaciji upiše kod + PIN → dobije token (sesiju).
     3. Svaka akcija radnika (lokacija, izmjena profila, završetak zadatka)
        nosi taj token. Bez tokena — nema pristupa.

   PIN se NE čuva u čistom obliku: čuva se sha256(salt + pin).
   Za pilot je ovo dovoljno; kod prelaska na Supabase preseliti na bcrypt/argon2.
   ══════════════════════════════════════════════════════════════════ */
const DEPT_PREFIX = { putevi: 'PUT', voda: 'VOD', elektro: 'ELE', cistoca: 'CIS' };
const SESSION_MS = 30 * 864e5;                    // sesija traje 30 dana

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(pin)).digest('hex');
}
function newPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function newCode(dept) {
  const pre = DEPT_PREFIX[String(dept || '').toLowerCase()] || 'RAD';
  let code;
  do { code = pre + '-' + String(crypto.randomInt(1000, 10000)); }
  while (DB.workers.some(w => w.code === code));
  return code;
}
function setPin(w, pin) {
  w.salt = crypto.randomBytes(8).toString('hex');
  w.pinHash = hashPin(pin, w.salt);
  w.pinAt = Date.now();
}
/* Radnik kakvog vide dispečer i ostali — bez ijednog tajnog polja. */
/* ── ŠTA JAVNOST SMIJE VIDJETI O PRIJAVI ──
   Prijave su javne namjerno — u tome je i smisao: građani vide da se problemi
   rješavaju. Ali dosad je svako mogao preuzeti listu i dobiti PUNO IME uz
   TAČNU adresu, pa vezati osobu za kuću ("rupa pred mojom kućom, Titova 14").
   Zato javnosti dajemo skraćeno ime (Ana P.), a dispečer i dalje vidi sve.
   Nikad ne izlaze: lista glasača (sadrži IP adrese), token i userId. */
function shortName(n) {
  var s = String(n || '').trim();
  if (!s) return '';
  var d = s.split(/\s+/);
  return d.length < 2 ? d[0] : d[0] + ' ' + d[1].charAt(0).toUpperCase() + '.';
}
function pubReport(r) {
  var o = {};
  for (var k in r) {
    if (k === 'voters' || k === 'token' || k === 'userId' || k === 'ip') continue;
    /* Razgovor naloga i telefon pozivaoca su interni — javnost ih ne vidi. */
    if (k === 'chat' || k === 'phone' || k === '_who' || k === 'participants') continue;
    o[k] = r[k];
  }
  o.name = shortName(r.name);

  /* ── FOTOGRAFIJE SE PRVO PREGLEDAJU ──
     Svako može poslati sliku, pa i neprimjerenu. Dok je dispečer ne odobri,
     javnost je ne vidi — prijava se prikazuje normalno, samo bez slike.
     Ovo je jedina pouzdana zaštita koja ne košta ništa: provjera u pregledaču
     se zaobiđe u deset sekundi, a vanjski servisi za prepoznavanje traže
     plaćeni ključ. Dispečer ionako gleda svaku prijavu. */
  if (r.photoOk !== true) {
    o.photo = null;
    o.photoPending = !!r.photo;      // aplikacija može reći "slika se pregleda"
  }
  if (r.photoRejected) { o.photo = null; o.photoPending = false; }
  if (r.work && r.work.byName) {
    o.work = Object.assign({}, r.work, { byName: shortName(r.work.byName) });
  }
  return o;
}
function pubWorker(w) {
  return {
    id: w.id, code: w.code, name: w.name, role: w.role, dept: w.dept, city: w.city,
    av: w.av, phone: w.phone || '', vehicle: w.vehicle || '',
    shiftFrom: w.shiftFrom || '', shiftTo: w.shiftTo || '', photo: w.photo || null,
    active: w.active !== false, lat: w.lat, lng: w.lng, locTs: w.locTs,
    lastSeen: w.lastSeen || null, created: w.created,
    guest: !!w.guest, guestUntil: w.guestUntil || null,
    shifts: Array.isArray(w.shifts) ? w.shifts : null
  };
}
/* Nađi radnika po tokenu iz tijela zahtjeva ili iz ?token= u URL-u. */
function authWorker(b, u, req) {
  /* Token NE primamo kroz adresu (?token=...). Adrese se zapisuju u serverske
     logove, u historiju pregledača i šalju se stranim sajtovima kroz Referer
     zaglavlje — token bi tako procurio i tuđa osoba bi se mogla prijaviti kao
     radnik. Prima se samo iz tijela zahtjeva ili iz zaglavlja X-Pinit-Token. */
  const t = (b && b.token) ||
            (req && req.headers && req.headers['x-pinit-token']) || null;
  if (!t) return null;
  const w = DB.workers.find(x => x.token === t);
  if (!w) return null;
  if (w.tokenAt && Date.now() - w.tokenAt > SESSION_MS) return null;   // sesija istekla
  if (w.active === false) return null;                                 // nalog ugašen
  /* Vanjski izvođač ima pristup samo do datuma koji je dispečer upisao.
     Poslije toga se prijava sama gasi, a njegovi nalozi ostaju u evidenciji. */
  if (w.guestUntil && Date.now() > w.guestUntil) return null;
  w.lastSeen = Date.now();
  return w;
}
/* Zaštita od pogađanja PIN-a: 8 pokušaja, pa pauza od 15 min. */
const LOGIN_TRIES = 8, LOGIN_LOCK_MS = 15 * 60e3;
function loginBlocked(w) {
  return w.lockUntil && Date.now() < w.lockUntil;
}
function loginFailed(w) {
  w.fails = (w.fails || 0) + 1;
  if (w.fails >= LOGIN_TRIES) { w.lockUntil = Date.now() + LOGIN_LOCK_MS; w.fails = 0; }
}

/* Migracija: radnici napravljeni prije ove verzije nemaju kod ni PIN.
   Dodijeli im ih pri pokretanju da prijava radi i za njih. Novi PIN se
   ispiše u konzolu servera — dispečer ga može i resetovati iz Platforme. */
/* ── BROJ NALOGA ──
   Interni ID prijave je dug broj iz vremena; ljudi trebaju kratak broj koji
   se izgovori preko telefona („nalog N-1042"). Dodjeljuje se jednom i nikad
   se ne mijenja. Starijim prijavama se dodijeli redom po vremenu prijema. */
function sljedeciBroj() {
  let max = 1000;
  for (const r of DB.reports) if (typeof r.no === 'number' && r.no > max) max = r.no;
  return max + 1;
}
function migrateReports() {
  let changed = 0;
  DB.reports.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).forEach(r => {
    if (typeof r.no !== 'number') { r.no = sljedeciBroj(); changed++; }
  });
  if (changed) save();
}
function migrateWorkers() {
  let changed = 0;
  DB.workers.forEach(w => {
    if (!w.code) { w.code = newCode(w.dept); changed++; }
    if (!w.pinHash) {
      const pin = newPin(); setPin(w, pin); changed++;
      console.log('🔑 Radnik bez naloga: ' + w.name + ' → kod ' + w.code + ' · PIN ' + pin);
    }
    if (w.active === undefined) w.active = true;
  });
  if (changed) save();
}

/* ── SIGURNOSNA ZAGLAVLJA ──
   Ovo su upute pregledaču šta smije, a šta ne. Bez njih:
     • pregledač može "pogađati" tip fajla i izvršiti sliku kao skriptu,
     • tuđa stranica može učitati platformu u nevidljivi okvir i navesti
       dispečera da klikne nešto što ne vidi (clickjacking),
     • adresa s podacima o prijavi šalje se stranim sajtovima kroz Referer.

   X-Frame-Options je SAMEORIGIN, a ne DENY, jer platforma NAMJERNO učitava
   komandni centar u okvir — DENY bi razbio Drive karticu.

   Content-Security-Policy dozvoljava tačno ono što aplikacija koristi:
   MapLibre i Chart.js s CDN-a, karte s MapTilera/OSM-a, fotografije kao
   data-URL. Sve ostalo je zabranjeno, pa i kad bi napadač ubacio skriptu,
   ona ne bi mogla poslati podatke na svoj server. */
/* Traka koja stoji preko vrha svake stranice dok je PINIT_NO_AUTH uključen. */
const NOAUTH_BAR =
  '<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
  'background:#B42318;color:#fff;font:600 12px/1.35 system-ui,sans-serif;' +
  'padding:7px 12px;text-align:center;letter-spacing:.2px">' +
  'ZAŠTITA ISKLJUČENA — svako s ovom adresom ima pun pristup. ' +
  'Obriši PINIT_NO_AUTH prije nego pustiš stranicu u rad.' +
  '</div><div style="height:29px"></div>';

function secHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://api.maptiler.com https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
      "connect-src 'self' https://api.maptiler.com https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
      "worker-src 'self' blob:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  };
}
/* Stranica za prijavu dispečera. Namjerno je ugrađena u server, a ne
   poseban fajl u /public — tako se ne može zaobići ni slučajno. */
function loginPage(next) {
  return `<!DOCTYPE html><html lang="bs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>PINIT — prijava</title>
<link rel="icon" href="/icon-192.png">
<script src="/jezik.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
 font:400 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
 background:linear-gradient(165deg,#1d7a38,#0d4520);color:#12151a}
.c{background:#fff;border-radius:22px;padding:30px 26px;width:100%;max-width:360px;
 box-shadow:0 22px 60px rgba(0,0,0,.34)}
img{height:34px;display:block;margin-bottom:20px}
h1{font-size:20px;font-weight:800;letter-spacing:-.4px}
p{font-size:13px;color:#8a9099;margin:7px 0 20px}
label{font-size:10.5px;font-weight:800;color:#8a9099;text-transform:uppercase;letter-spacing:.6px}
input{width:100%;margin-top:7px;background:#f2f2f7;border:1.5px solid transparent;border-radius:12px;
 padding:13px 14px;font-size:16px;font-family:inherit;color:#12151a;outline:none}
input:focus{border-color:#1a7a34;background:#fff}
button{width:100%;margin-top:16px;padding:15px;border:none;border-radius:13px;background:#1a7a34;
 color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer}
button:disabled{opacity:.5}
.e{background:#fdecea;color:#a8261d;font-size:12.5px;font-weight:600;border-radius:11px;
 padding:11px 13px;margin-bottom:14px;display:none}
.e.on{display:block}
.n{font-size:11.5px;color:#8a9099;margin-top:16px;line-height:1.55}
</style></head><body>
<div class="c">
  <img src="/logo.png" alt="PINIT">
  <h1>Pristup za službe</h1>
  <p>Ova strana je samo za dispečere i komunalna preduzeća. Građani koriste
     <a href="/" style="color:#1a7a34">glavnu aplikaciju</a>.</p>
  <div class="e" id="e"></div>
  <label for="p">Lozinka</label>
  <input id="p" type="password" autocomplete="current-password" autofocus>
  <button id="b">Prijavi se</button>
  ${ADMIN_GENERATED ? `<div style="margin-top:16px;padding:11px 13px;background:#fff8e6;
    border:1px solid #f0d9a0;border-radius:10px;font-size:12.5px;color:#6b4e00;line-height:1.5">
    <b>Lozinka nije postavljena.</b> Server je smislio privremenu — piše u logu
    servisa pri pokretanju (Render → Logs). Ostaje ista i nakon restarta.<br><br>
    Da postaviš svoju: Render → Environment → dodaj <b>PINIT_ADMIN_PASS</b>.
  </div>` : ''}
  <div class="n">Radnici na terenu se prijavljuju svojim kodom i PIN-om u
    <a href="/radnik" style="color:#1a7a34">aplikaciji za radnike</a>.</div>
</div>
<script>
var next=${JSON.stringify(next || '/platforma')};
function go(){
  var b=document.getElementById('b'),e=document.getElementById('e');
  b.disabled=true;b.textContent='Provjeravam...';e.className='e';
  fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({pass:document.getElementById('p').value})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
  .then(function(x){
    if(x.ok){location.href=next;return;}
    e.textContent=x.j.error||'Prijava nije uspjela.';e.className='e on';
    b.disabled=false;b.textContent='Prijavi se';
    document.getElementById('p').value='';
  })
  .catch(function(){
    e.textContent='Nema veze sa serverom.';e.className='e on';
    b.disabled=false;b.textContent='Prijavi se';
  });
}
document.getElementById('b').onclick=go;
document.getElementById('p').addEventListener('keydown',function(ev){if(ev.key==='Enter')go();});
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  /* CORS: sve tri aplikacije servira ovaj isti server, pa im CORS ne treba.
     Dok je stajalo '*', bilo koja tuđa stranica mogla je zvati ovaj API iz
     preglednika posjetioca. Ako ikad zatreba pristup s druge adrese, upiši
     je u varijablu PINIT_ALLOW_ORIGIN (može više, odvojeno zarezom). */
  const ALLOWED = (process.env.PINIT_ALLOW_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    const h = { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Vary': 'Origin' };
    if (origin && ALLOWED.indexOf(origin) >= 0) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Allow-Credentials'] = 'true';
    }
    res.writeHead(204, h);
    return res.end();
  }

  /* ── PRIJAVA DISPEČERA ── */
  if (p === '/api/admin/login' && req.method === 'POST') {
    return readBody(req, b => {
      const ip = clientIp(req);
      if (adminBlocked(ip))
        return json(res, 429, { error: 'Previše pogrešnih pokušaja. Pristup je pauziran još ' +
          adminBlockMin(ip) + ' min. Lozinka je možda tačna — sačekaj pa probaj jednom.' });
      if (!b || !sameSecret(b.pass || '', ADMIN_PASS)) {
        adminFail(ip);
        log('⛔ Neuspjela prijava na platformu (' + ip + ')');
        return json(res, 401, { error: 'Pogrešna lozinka.' });
      }
      ADMIN_FAILS.delete(ip);
      const t = crypto.randomBytes(24).toString('hex');
      ADMIN_SESSIONS.set(t, Date.now() + ADMIN_SESSION_MS);
      zapamtiSesije();
      setAdminCookie(res, t, req, ADMIN_SESSION_MS / 1000);
      log('🔓 Prijava na platformu (' + ip + ')');
      json(res, 200, { ok: true });
    });
  }
  if (p === '/api/admin/logout' && req.method === 'POST') {
    const t = adminCookie(req);
    if (t) { ADMIN_SESSIONS.delete(t); zapamtiSesije(); }
    setAdminCookie(res, '', req, 0);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/verzija' && req.method === 'GET') {
    return json(res, 200, { verzija: PINIT_VERZIJA, vrijeme: new Date().toISOString() });
  }

  if (p === '/api/admin/me' && req.method === 'GET') {
    return json(res, isAdmin(req) ? 200 : 401, { ok: isAdmin(req) });
  }

  /* Zaštita dispečerskih ruta. Sve ispod ovoga smije samo prijavljen
     dispečer; radnička i građanska strana imaju svoje provjere. */
  function needAdmin() {
    if (isAdmin(req)) return false;
    json(res, 401, { error: 'Potrebna prijava dispečera.' });
    return true;
  }

  /* ── API ── */
  if (p === '/api/register' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.name || !b.city) return json(res, 400, { error: 'name i city su obavezni' });
      const user = {
        id: 'u_' + crypto.randomBytes(5).toString('hex'),
        token: crypto.randomBytes(16).toString('hex'),
        name: String(b.name).slice(0, 60),
        city: String(b.city).slice(0, 60),
        created: Date.now()
      };
      DB.users.push(user); save();
      log('👤 Novi nalog: ' + user.name + ' (' + user.city + ')');
      json(res, 200, { userId: user.id, token: user.token });
    });
  }

  if (p === '/api/reports' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    let list = DB.reports;
    if (city) list = list.filter(r => r.city === city);
    /* Dispečer dobija sve; svi ostali dobijaju očišćenu verziju. */
    const adm = isAdmin(req);
    /* Bez ovoga aplikacija nije mogla prepoznati vlastite prijave (userId se
       ne šalje javno), pa su „Moje prijave" i brojevi u profilu bili prazni. */
    const meUser = DB.users.find(u2 => u2.token === (u.searchParams.get('token') || '\u0000'));
    /* Dispečer dobija CIJELU evidenciju (treba mu za statistiku kroz godinu),
       ali bez fotografija — one se učitavaju tek kad otvori nalog, preko
       /api/reports/:id. Ranije je lista sa slikama išla svakih 12 sekundi
       i rasla na stotine megabajta. */
    if (adm) list = list.slice();
    else list = list.slice(-300);
    return json(res, 200, list.map(r => {
      /* Dispečeru ide sve, osim samih poruka razgovora — one se čitaju po
         kanalu, a ovdje je dovoljan broj i posljednja poruka za oznake. */
      if (adm) {
        const o = Object.assign({}, r);
        delete o.voters; delete o._who;
        const c = Array.isArray(r.chat) ? r.chat : [];
        delete o.chat;
        o.chatN = c.length;
        /* Broj poruka s terena (ne računa dispečerove ni sistemske) — po njemu
           platforma zna koliko je nepročitanih. */
        o.chatIn = c.filter(x => !x.sys && x.by !== 'disp').length;
        const z = c.length ? c[c.length - 1] : null;
        o.chatLast = z ? { t: z.t, byName: z.byName || '', text: z.sys ? z.text : String(z.text || (z.photo ? 'Fotografija' : '')).slice(0, 90), sys: !!z.sys, by: z.by || null } : null;
        o.hasPhoto = !!r.photo; o.hasBefore = !!r.photoBefore; o.hasAfter = !!r.photoAfter;
        delete o.photo; delete o.photoBefore; delete o.photoAfter;
        if (Array.isArray(r.invoices)) o.invoices = r.invoices.map(x => ({ amount: x.amount, at: x.at, hasImg: !!x.img }));
        if (Array.isArray(r.workLog)) o.workLog = r.workLog.map(x => Object.assign({}, x));
        return o;
      }
      const o = pubReport(r);
      o.mine = !!(meUser && r.userId === meUser.id);
      return o;
    }));
  }

  /* ── PROVJERA DUPLIKATA prije slanja ── */
  if (p === '/api/reports/check' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.cat) return json(res, 400, { error: 'cat je obavezan' });
      const d = findOpenDuplicate(b.cat, b.lat, b.lng);
      if (!d) return json(res, 200, { found: null });
      const r = d.report;
      json(res, 200, { found: {
        id: r.id, ts: r.ts, votes: r.votes || 0, confirms: r.confirms || 0,
        note: r.note || '', name: r.name || 'anonimno', status: r.status,
        dist: d.dist
      }});
    });
  }

  if (p === '/api/reports' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.cat) return json(res, 400, { error: 'cat je obavezan' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      /* Dispečer ručno unosi prijavu koja je stigla telefonom — nju ne
         ograničavamo brojem prijava po danu, inače bi dispečerski centar
         poslije tridesetog poziva ostao bez mogućnosti unosa. */
      const adm = isAdmin(req);
      /* Radnik koji prijavi problem s terena: prijava nosi oznaku službe,
         jer dolazi od stručne osobe. Nalog i dalje izdaje dispečer. */
      const wkr = (!adm && b.token) ? authWorker(b, u, req) : null;
      const chk = adm ? { reject: null, flags: [] } : abuseCheck(b, ip);
      if (chk.reject) { log('⛔ Odbijena prijava (' + chk.reject + ')'); return json(res, 429, { error: chk.reject }); }
      const user = wkr ? null : (DB.users.find(x => x.token === b.token) || null);
      const pri = null;
      const r = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 999),
        userId: user ? user.id : null,
        _who: b.token || b.deviceId || ip,
        name: user ? user.name : (wkr ? wkr.name + ' (radnik)' : String(b.name || 'anonimno').slice(0, 60)),
        izSluzbe: !!wkr, izWorker: wkr ? wkr.id : null,
        /* Lokacija izabrana na karti ili adresom, a ne GPS-om na licu mjesta (PRD AP-11). */
        lokRucno: b.lokRucno === true,
        source: adm ? String(b.source || 'telefon').slice(0, 20) : (wkr ? 'radnik' : 'aplikacija'),
        phone: adm ? String(b.phone || '').slice(0, 30) : undefined,
        addr: String(b.addr || '').slice(0, 120),
        city: b.city || (user && user.city) || '',
        cat: String(b.cat).slice(0, 30),
        note: String(b.note || '').slice(0, 1000),
        photo: cleanPhoto(b.photo),
        /* Besmislene koordinate (lat 9999) rušile bi kartu i računanje
           udaljenosti — takva prijava se prima, ali bez lokacije. */
        lat: okLat(b.lat) ? b.lat : null,
        lng: okLng(b.lng) ? b.lng : null,
        acc: (typeof b.acc === 'number' && isFinite(b.acc) && b.acc >= 0)
               ? Math.min(Math.round(b.acc), 100000) : null,
        /* Vrijeme prijave dolazi s telefona; ako je sat pogrešno namješten,
           prijava bi ispala iz svih izvještaja. Držimo je u razumnom rasponu. */
        ts: (typeof b.ts === 'number' && b.ts > 15e11 && b.ts < Date.now() + 6e5)
               ? b.ts : Date.now(),
        status: 0, votes: 0, confirms: 0, resolvedAt: null,
        worker: null, cost: null, costAt: null, invoices: [], pri: pri,
        sla: slaFor(b.cat, pri),
        flags: chk.flags,
        rating: null, ratedAt: null,
        recurOf: null, recurDays: null, recurConfirmed: null,
        history: [{ status: 0, t: Date.now(), by: adm ? String(b.byName || 'Dispečer').slice(0, 60) : null }]
      };
      if (adm && b.pri && ['urgent', 'med', 'low'].indexOf(b.pri) >= 0) { r.pri = b.pri; r.sla = slaFor(r.cat, r.pri); }
      /* ── PONOVLJENI KVAR ──
         Ako je na istoj lokaciji (≤120 m) isti tip kvara već bio RIJEŠEN, a sada
         opet stiže prijava — to je ponavljanje: popravka nije izdržala.
         Vezujemo novu prijavu na staru; radnik na terenu to još mora potvrditi. */
      const prev = findRecurrence(r);
      if (prev) {
        r.recurOf = prev.id;
        r.recurDays = Math.round((r.ts - prev.resolvedAt) / 864e5);
        prev.recurredBy = (prev.recurredBy || []).concat([r.id]);
        log('🔁 PONOVLJENI KVAR: ' + r.cat + ' se vratio nakon ' + r.recurDays +
            ' dana (prijava ' + prev.id + ' bila označena riješenom)');
      }
      r.no = sljedeciBroj();
      DB.reports.push(r); save();
      log('📨 Nova prijava: ' + r.cat + ' · ' + r.city + ' · ' + r.name +
          (r.lat ? ' @ ' + r.lat.toFixed(5) + ',' + r.lng.toFixed(5) : ' (bez GPS-a)'));
      json(res, 200, { ok: true, id: r.id, no: r.no, recurOf: r.recurOf, recurDays: r.recurDays });
    });
  }

  /* ── OCJENA GRAĐANINA (zatvara krug: prijava → popravka → ocjena) ── */
  let mr = p.match(/^\/api\/reports\/(\d+)\/rate$/);
  if (mr && req.method === 'POST') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === mr[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });
      const s = b && Number(b.score);
      if (!(s >= 1 && s <= 5)) return json(res, 400, { error: 'score 1-5' });
      r.rating = Math.round(s); r.ratedAt = Date.now();
      save();
      log('⭐ Ocjena građanina: ' + r.cat + ' → ' + r.rating + '/5');
      json(res, 200, { ok: true, rating: r.rating });
    });
  }

  let m = p.match(/^\/api\/reports\/(\d+)\/vote$/);
  if (m && req.method === 'POST') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });

      /* ── JEDAN GLAS PO KORISNIKU ──
         Dosad je isti pozivalac mogao poslati trideset zahtjeva i dodati
         trideset glasova. Glasovi određuju prioritet, pa je to značilo da se
         redoslijed radova mogao naručiti — jedna osoba dovede svoju ulicu na
         vrh liste pred stvarnim hitnim slučajevima.
         Sada pamtimo KO je glasao. Ako nema tokena, korisnik se prepoznaje po
         adresi; nije savršeno (dijeljena mreža), ali zaustavlja pumpanje. */
      const voter = (b && typeof b.token === 'string' && b.token)
        ? 'u:' + b.token.slice(0, 32)
        : 'ip:' + clientIp(req);
      if (!Array.isArray(r.voters)) r.voters = [];

      const had = r.voters.indexOf(voter) >= 0;
      const wantsDown = !!(b && b.delta === -1);

      if (wantsDown) {
        if (!had) return json(res, 200, { ok: true, votes: r.votes || 0, voted: false });
        r.voters.splice(r.voters.indexOf(voter), 1);
        r.votes = Math.max(0, (r.votes || 0) - 1);
        r.confirms = Math.max(0, (r.confirms || 0) - 1);
      } else {
        if (had) return json(res, 200, { ok: true, votes: r.votes || 0, voted: true });
        r.voters.push(voter);
        r.votes = Math.max(0, (r.votes || 0) + 1);
        r.confirms = Math.max(0, (r.confirms || 0) + 1);
      }
      save();
      json(res, 200, { ok: true, votes: r.votes, voted: !wantsDown });
    });
  }

  /* ── PREGLED FOTOGRAFIJA (dispečer) ──
     Lista prijava koje čekaju pregled slike, i odluka odobri/odbij.
     Odbijena slika se BRIŠE iz baze, ne samo skriva — nema smisla čuvati
     neprimjeren sadržaj, a i baza je ograničena. */
  if (p === '/api/photos/pending' && req.method === 'GET') {
    if (needAdmin()) return;
    const list = DB.reports
      .filter(r => r.photo && r.photoOk !== true && !r.photoRejected)
      .slice(-100)
      .map(r => ({ id: r.id, cat: r.cat, city: r.city, ts: r.ts,
                   name: r.name || '', note: r.note || '', photo: r.photo,
                   flags: (r.photoFlags || []).length }));
    return json(res, 200, list);
  }
  m = p.match(/^\/api\/reports\/(\d+)\/photo$/);
  if (m && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });
      if (b && b.ok === true) {
        r.photoOk = true; r.photoRejected = false;
        log('🖼  Fotografija odobrena (prijava ' + r.id + ')');
      } else {
        r.photo = null;                 // briši sadržaj, ne samo označi
        r.photoOk = false; r.photoRejected = true;
        r.photoRejectedAt = Date.now();
        log('🚫 Fotografija odbijena i obrisana (prijava ' + r.id + ')');
      }
      save();
      json(res, 200, { ok: true, photoOk: !!r.photoOk, rejected: !!r.photoRejected });
    });
  }
  /* ── PRIJAVA NEPRIMJERENE SLIKE (bilo ko) ──
     Ako neprimjerena slika prođe pregled, svaki korisnik je može prijaviti.
     Nakon tri prijave slika se automatski skriva do ponovnog pregleda —
     bolje pogriješiti u korist skrivanja nego ostaviti nešto ružno na ekranu. */
  m = p.match(/^\/api\/reports\/(\d+)\/flag$/);
  if (m && req.method === 'POST') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });
      if (!Array.isArray(r.photoFlags)) r.photoFlags = [];
      const who = (b && typeof b.token === 'string' && b.token)
        ? 'u:' + b.token.slice(0, 32) : 'ip:' + clientIp(req);
      if (r.photoFlags.indexOf(who) < 0) r.photoFlags.push(who);
      if (r.photoFlags.length >= 3 && r.photoOk === true) {
        r.photoOk = false;              // vrati na pregled
        log('⚠  Slika vraćena na pregled nakon ' + r.photoFlags.length + ' prijava (' + r.id + ')');
      }
      save();
      json(res, 200, { ok: true, flags: r.photoFlags.length });
    });
  }

  m = p.match(/^\/api\/reports\/(\d+)$/);
  if (m && req.method === 'GET') {
    /* Jedan nalog s fotografijama. Dispečer vidi sve osim poruka (one idu
       kroz /chat); svi ostali vide javnu verziju. */
    const r = DB.reports.find(x => String(x.id) === m[1]);
    if (!r) return json(res, 404, { error: 'Nalog nije pronađen.' });
    if (isAdmin(req)) {
      const o = Object.assign({}, r); delete o.voters; delete o._who; delete o.chat;
      o.chatN = Array.isArray(r.chat) ? r.chat.length : 0;
      return json(res, 200, o);
    }
    return json(res, 200, pubReport(r));
  }
  if (m && req.method === 'PATCH') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });

      /* Ovu rutu koriste i dispečer i radnik, pa se ne može zaključati u
         cjelini — provjeravamo polje po polje.

           dispečer  → dodjela radnika, računi, prioritet
           radnik    → samo NA SVOJOJ prijavi: status, foto dokaz, izvještaj
           niko drugi→ ništa

         Radnik smije mijenjati samo prijavu koja je njemu dodijeljena. Bez
         te provjere bi jedan radnik mogao zatvarati tuđe zadatke. */
      const adm = isAdmin(req);
      const wk  = authWorker(b, u, req);
      const mine = !!(wk && izvrsilacNaloga(r, wk));
      if (!adm && !mine)
        return json(res, 403, { error: 'Nemaš pravo mijenjati ovu prijavu.' });

      const dispatcherOnly = ['worker', 'cost', 'invoices', 'pri', 'sla', 'dept', 'crew', 'participants', 'reworkReason', 'addr', 'close'];
      if (!adm) {
        for (const k of dispatcherOnly) {
          if (b && k in b)
            return json(res, 403, { error: 'Polje "' + k + '" mijenja samo dispečer.' });
        }
      }

      const ko = adm ? String((b && b.byName) || 'Dispečer').slice(0, 60) : (wk ? wk.name : null);
      if (!Array.isArray(r.history)) r.history = [];

      /* ── PRAVILA ZATVARANJA I DORADE (provjera prije ijedne izmjene) ──
         1) Nalog se ne zatvara bez fotografije stanja poslije — ni kad
            zatvara dispečer. To je dokaz koji traži pravna služba.
         2) Riješen nalog vraća u rad samo dispečer/nadzornik, i to uz
            obrazloženje koje ostaje trajno zapisano. */
      if (b && typeof b.status === 'number' && b.status === 3 && r.status !== 3) {
        const imaFoto = !!(r.photoAfter || cleanPhoto(b.photoAfter));
        if (!imaFoto)
          return json(res, 400, { error: 'Nalog se ne može zatvoriti bez fotografije stanja poslije intervencije.' });
      }
      if (b && typeof b.status === 'number' && r.status === 3 && b.status < 3) {
        if (!adm) return json(res, 403, { error: 'Riješen nalog vraća u rad samo nadzornik.' });
        const razlog = String(b.reworkReason || '').trim();
        if (razlog.length < 3) return json(res, 400, { error: 'Upiši obrazloženje zašto se nalog vraća na doradu.' });
      }
      if (b && typeof b.dept === 'string' && b.dept !== sluzbaOf(r)) {
        if (String(b.forwardReason || '').trim().length < 3)
          return json(res, 400, { error: 'Prosljeđivanje drugoj službi traži obrazloženje.' });
      }

      /* ── ODOBRENO ZATVARANJE ──
         Radnik javi Riješeno (uz fotografiju). Nadzornik/dispečer to potvrdi
         i nalog postaje Zatvoren. Tek tada građanin dobija poziv da ocijeni. */
      if (b && b.close === true) {
        if (!adm) return json(res, 403, { error: 'Nalog zatvara samo dispečer ili nadzornik.' });
        const bice3 = (typeof b.status === 'number' && b.status === 3) || r.status === 3;
        if (!bice3) return json(res, 400, { error: 'Zatvara se samo nalog koji je riješen.' });
      }
      if (b && typeof b.status === 'number' && b.status >= 0 && b.status <= 3 && b.status !== r.status) {
        const bio = r.status;
        if (b.status < 3) r.closedAt = null;
        r.status = b.status;
        const h = { status: b.status, t: Date.now(), by: ko };
        if (bio === 3 && b.status < 3) {
          h.note = 'Vraćeno na doradu: ' + String(b.reworkReason).trim().slice(0, 500);
          r.resolvedAt = null; r.reworks = (r.reworks || 0) + 1;
        }
        r.history.push(h);
        if (b.status === 3) r.resolvedAt = Date.now();
        log('🔧 Status prijave ' + r.cat + ' → ' + ['čeka', 'zaprimljeno', 'u toku', 'riješeno'][b.status] + (ko ? ' (' + ko + ')' : ''));
      }
      if (b && 'worker' in b) {
        const w = DB.workers.find(x => x.id === b.worker);
        r.worker = w ? w.id : null;
        r.assignedAt = w ? Date.now() : null;
        r.history.push({ t: Date.now(), by: ko, note: w ? 'Dodijeljeno: ' + w.name : 'Dodjela uklonjena' });
        /* Razgovor nastaje sam u trenutku dodjele — niko ga ne otvara ručno. */
        if (w && postavke().razgovori.autoOtvaranje !== false) {
          if (!Array.isArray(r.chat)) r.chat = [];
          r.chat.push({ id: crypto.randomBytes(5).toString('hex'), t: Date.now(), sys: true,
                        text: 'Nalog dodijeljen: ' + w.name + '.' });
        }
        log('👷 Dodijeljeno: ' + r.cat + ' → ' + (w ? w.name : 'nitko'));
      }
      if (b && b.close === true && adm && r.status === 3 && !r.closedAt) {
        r.closedAt = Date.now();
        r.history.push({ t: Date.now(), by: ko, note: 'Nalog zatvoren — izvršenje potvrđeno.' });
        log('✅ Zatvoren nalog ' + (r.no || r.id));
      }
      if (b && Array.isArray(b.crew) && adm) {
        r.crew = b.crew.filter(id => DB.workers.some(w => w.id === id) && id !== r.worker).slice(0, 10);
      }
      if (b && Array.isArray(b.participants) && adm) {
        const bili = Array.isArray(r.participants) ? r.participants : [];
        r.participants = b.participants.filter(id => DB.workers.some(w => w.id === id)).slice(0, 20);
        const novi = r.participants.filter(id => bili.indexOf(id) < 0);
        const otisli = bili.filter(id => r.participants.indexOf(id) < 0);
        const ime = id => (DB.workers.find(w => w.id === id) || {}).name || '?';
        if (!Array.isArray(r.chat)) r.chat = [];
        novi.forEach(id => r.chat.push({ id: crypto.randomBytes(5).toString('hex'), t: Date.now(), sys: true, text: ime(id) + ' je dodan u razgovor.' }));
        otisli.forEach(id => r.chat.push({ id: crypto.randomBytes(5).toString('hex'), t: Date.now(), sys: true, text: ime(id) + ' je uklonjen iz razgovora.' }));
      }
      /* ── PROSLJEĐIVANJE DRUGOJ SLUŽBI ── obrazloženje je obavezno
         i ostaje u historiji; nalog kod nove službe kreće bez izvršioca. */
      if (b && typeof b.dept === 'string' && adm && b.dept !== sluzbaOf(r)) {
        const razlog = String(b.forwardReason).trim().slice(0, 500);
        const od = sluzbaOf(r);
        r.dept = String(b.dept).slice(0, 20);
        r.worker = null; r.crew = [];
        if (r.status > 1) r.status = 1;
        r.forwards = (r.forwards || []).concat([{ t: Date.now(), from: od, to: r.dept, reason: razlog, by: ko }]);
        r.history.push({ status: r.status, t: Date.now(), by: ko, note: 'Proslijeđeno: ' + od + ' → ' + r.dept + '. ' + razlog });
        log('➡  Proslijeđeno ' + r.cat + ': ' + od + ' → ' + r.dept);
      }
      if (b && typeof b.cost === 'number') {
        r.cost = (b.cost < 0) ? null : b.cost;          // -1 = obriši račun
        r.costAt = r.cost == null ? null : Date.now();
        log('🧾 Račun ' + (r.cost == null ? 'obrisan' : r.cost + ' KM') + ' · ' + r.cat);
      }
      if (b && typeof b.pri === 'string' && ['urgent', 'med', 'low'].indexOf(b.pri) >= 0) {
        r.pri = b.pri; r.sla = slaFor(r.cat, r.pri);
        r.history.push({ t: Date.now(), by: ko, note: 'Stepen hitnosti: ' + ({ urgent: 'hitno', med: 'srednje', low: 'nisko' })[r.pri] });
      }
      /* Radnik na terenu potvrđuje da se kvar STVARNO ponovio (ili da nije isti kvar).
         Tek potvrđeno ponavljanje ulazi u statistiku kao propala popravka. */
      if (b && typeof b.recurConfirmed === 'boolean') {
        r.recurConfirmed = b.recurConfirmed;
        r.recurConfirmedAt = Date.now();
        const w = DB.workers.find(x => x.id === r.worker);
        log('🔁 Radnik ' + (w ? w.name : '?') + ' ' +
            (b.recurConfirmed ? 'POTVRDIO' : 'odbacio') + ' ponavljanje kvara: ' + r.cat);
      }
      if (b && Array.isArray(b.invoices)) {
        r.invoices = b.invoices.slice(0, 12).map(x => ({
          amount: (typeof x.amount === 'number' && x.amount >= 0) ? Math.round(x.amount * 100) / 100 : 0,
          img: cleanPhoto(x.img),
          at: x.at || Date.now()
        }));
        r.cost = r.invoices.length ? r.invoices.reduce((a, x) => a + x.amount, 0) : null;
        r.costAt = r.cost == null ? null : Date.now();
        log('🧾 Računi (' + r.invoices.length + ') · ukupno ' + (r.cost || 0) + ' KM · ' + r.cat);
      }
      /* Adresu upisuje dispečer (ili je platforma sama pročita s karte) — da
         se nalog izgovori ulicom, a ne koordinatama. */
      if (b && typeof b.addr === 'string' && adm) r.addr = b.addr.trim().slice(0, 120);
      if (b && 'photoBefore' in b) r.photoBefore = cleanPhoto(b.photoBefore);
      if (b && 'photoAfter'  in b) r.photoAfter  = cleanPhoto(b.photoAfter);

      /* ── IZVJEŠTAJ S TERENA ──
         Ovo je ono što radnik napiše kad završi: šta je zatekao, šta je uradio,
         šta je potrošio i koliko je trajalo. Ide pravo dispečeru u Platformu.
         Potpisuje se imenom radnika sa servera, ne onim što pošalje telefon —
         da se izvještaj ne može potpisati tuđim imenom. */
      if (b && b.work && typeof b.work === 'object') {
        const wk = authWorker(b, u, req);
        const entry = {
          note: String(b.work.note || '').slice(0, 1500),
          materials: String(b.work.materials || '').slice(0, 500),
          cost: (typeof b.work.cost === 'number' && b.work.cost >= 0) ? Math.round(b.work.cost * 100) / 100 : null,
          minutes: (typeof b.work.minutes === 'number' && b.work.minutes >= 0)
            ? Math.min(Math.round(b.work.minutes), 60 * 24 * 7) : null,
          startedAt: (typeof b.work.startedAt === 'number') ? b.work.startedAt : null,
          at: Date.now(),
          by: wk ? wk.id : (r.worker || null),
          byName: wk ? wk.name : null,
          lat: (typeof b.work.lat === 'number') ? b.work.lat : null,
          lng: (typeof b.work.lng === 'number') ? b.work.lng : null
        };
        r.work = entry;
        r.workLog = (r.workLog || []).concat([entry]).slice(-20);
        log('📋 Izvještaj s terena · ' + r.cat + ' · ' + (entry.byName || '?') +
            (entry.minutes != null ? ' · ' + entry.minutes + ' min' : '') +
            (entry.note ? ' · "' + entry.note.slice(0, 60) + '"' : ''));
      }
      save();
      json(res, 200, { ok: true, status: r.status, worker: r.worker });
    });
  }

  /* ── SPAJANJE ISTOVJETNIH PRIJAVA (dispečer) ──
     Duplikat ne nestaje: ostaje u evidenciji s oznakom u koju je prijavu
     spojen, a njegovi glasovi se pridodaju glavnoj. Građanin koji je poslao
     duplikat vidi obrazloženje umjesto tišine. */
  m = p.match(/^\/api\/reports\/(\d+)\/merge$/);
  if (m && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      const src = DB.reports.find(x => String(x.id) === m[1]);
      const dst = b && DB.reports.find(x => String(x.id) === String(b.into));
      if (!src || !dst) return json(res, 404, { error: 'Prijava nije pronađena.' });
      if (src === dst) return json(res, 400, { error: 'Prijava se ne može spojiti sama sa sobom.' });
      if (src.mergedInto) return json(res, 400, { error: 'Ova prijava je već spojena.' });
      const ko = String((b && b.byName) || 'Dispečer').slice(0, 60);
      dst.votes = (dst.votes || 0) + (src.votes || 0) + 1;
      dst.confirms = (dst.confirms || 0) + (src.confirms || 0) + 1;
      dst.merged = (dst.merged || []).concat([src.id]);
      if (!dst.photo && src.photo) { dst.photo = src.photo; dst.photoOk = src.photoOk; }
      src.mergedInto = dst.id;
      src.history = (src.history || []).concat([{ t: Date.now(), by: ko, note: 'Spojeno s prijavom ' + dst.id + ' — isti problem je već prijavljen.' }]);
      dst.history = (dst.history || []).concat([{ t: Date.now(), by: ko, note: 'Pridružena istovjetna prijava ' + src.id + '.' }]);
      save();
      log('🔗 Spojeno: ' + src.id + ' → ' + dst.id);
      json(res, 200, { ok: true, into: dst.id, votes: dst.votes });
    });
  }

  /* ── RAZGOVOR NALOGA ──
     Svaki nalog ima tačno jedan kanal. Čitati i pisati smiju dispečer i
     ljudi na nalogu. Kad se nalog zatvori, kanal ostaje čitljiv kao dio
     evidencije, ali se u njega više ne piše. */
  m = p.match(/^\/api\/reports\/(\d+)\/chat$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    const r = DB.reports.find(x => String(x.id) === m[1]);
    if (!r) return json(res, 404, { error: 'Nalog nije pronađen.' });
    const posalji = b => {
      const adm = isAdmin(req);
      const wk = adm ? null : authWorker(b, u, req);
      if (!adm && !ucesnikNaloga(r, wk))
        return json(res, 403, { error: 'Nisi učesnik ovog razgovora.' });
      if (req.method === 'GET')
        return json(res, 200, { chat: r.chat || [], zakljucan: r.status === 3 && postavke().razgovori.autoArhiviranje !== false });
      if (r.status === 3 && postavke().razgovori.autoArhiviranje !== false)
        return json(res, 409, { error: 'Nalog je zatvoren — razgovor je arhiviran i u njega se više ne piše.' });
      const text = String((b && b.text) || '').trim().slice(0, 2000);
      const foto = b && b.photo ? cleanPhoto(b.photo) : null;
      if (!text && !foto) return json(res, 400, { error: 'Poruka je prazna.' });
      if (!Array.isArray(r.chat)) r.chat = [];
      const msg = { id: crypto.randomBytes(5).toString('hex'), t: Date.now(), text: text,
        photo: foto, by: adm ? 'disp' : wk.id,
        byName: adm ? String((b && b.byName) || 'Dispečer').slice(0, 60) : wk.name,
        role: adm ? 'dispečer' : (wk.guest ? 'izvođač' : 'radnik') };
      r.chat.push(msg);
      if (r.chat.length > 500) r.chat = r.chat.slice(-500);
      save();
      json(res, 200, { ok: true, msg: msg });
    };
    if (req.method === 'GET') {
      /* Radnik šalje token u zaglavlju X-Pinit-Token (GET nema tijelo). */
      return posalji(null);
    }
    return readBody(req, posalji);
  }

  /* ── POSTAVKE ── čita i mijenja samo dispečer/administrator;
     građanska aplikacija dobija samo javni dio. Svaka izmjena ide u dnevnik. */
  if (p === '/api/settings/public' && req.method === 'GET') {
    return json(res, 200, postavkeJavne());
  }
  if (p === '/api/settings' && req.method === 'GET') {
    if (needAdmin()) return;
    return json(res, 200, postavke());
  }
  if (p === '/api/settings' && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      if (!b || typeof b !== 'object') return json(res, 400, { error: 'Nema podataka.' });
      const cisto = ocistiPostavke(b);
      const kljucevi = Object.keys(cisto);
      if (!kljucevi.length) return json(res, 400, { error: 'Ništa od poslanog nije poznata postavka.' });
      const cur = DB.postavke || {};
      kljucevi.forEach(k => { cur[k] = cisto[k]; });
      cur.log = (Array.isArray(cur.log) ? cur.log : []).concat([{ t: Date.now(),
        by: String(b.byName || 'Administrator').slice(0, 60), sta: kljucevi.join(', ') }]).slice(-200);
      DB.postavke = cur;
      save();
      log('⚙  Postavke izmijenjene: ' + kljucevi.join(', '));
      json(res, 200, postavke());
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     OPREMA — vozila, alati, mašine, materijal i zaštitna oprema službe.
     Dispečer vodi evidenciju; radnik vidi opremu svoje službe, uzme je
     (uz nalog na kojem je koristi), vrati je ili prijavi kvar.
     Stanje: dostupno · zauzeto · servis. Svaka promjena ide u dnevnik
     stavke, da se zna ko je šta imao i kada.
     ══════════════════════════════════════════════════════════════════ */
  const TIPOVI_OPREME = ['vozilo', 'masina', 'alat', 'materijal', 'zastita'];
  const pubOprema = o => { const w = o.kod ? DB.workers.find(x => x.id === o.kod) : null, r = o.nalog ? DB.reports.find(x => x.id === o.nalog) : null;
    return Object.assign({}, o, { log: (o.log || []).slice(-15), kodIme: w ? w.name : null, nalogNo: r ? r.no : null }); };
  const logOprema = (o, by, sta) => { o.log = (o.log || []).concat([{ t: Date.now(), by, sta }]).slice(-40); o.updated = Date.now(); };
  if (p === '/api/equipment' && req.method === 'GET') {
    if (isAdmin(req)) return json(res, 200, DB.oprema.map(pubOprema));
    const w = authWorker(null, u, req);
    if (!w) return json(res, 401, { error: 'Prijavi se u aplikaciju.' });
    return json(res, 200, DB.oprema.filter(o => o.sluzba === w.dept || o.kod === w.id).map(pubOprema));
  }
  if (p === '/api/equipment' && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      if (!b || !String(b.naziv || '').trim()) return json(res, 400, { error: 'Upiši naziv opreme.' });
      const o = { id: 'o_' + crypto.randomBytes(5).toString('hex'), naziv: String(b.naziv).trim().slice(0, 80),
        tip: TIPOVI_OPREME.indexOf(b.tip) >= 0 ? b.tip : 'alat', sluzba: String(b.sluzba || 'putevi').slice(0, 20),
        oznaka: String(b.oznaka || '').slice(0, 40), napomena: String(b.napomena || '').slice(0, 300),
        kolicina: typeof b.kolicina === 'number' && b.kolicina >= 0 ? b.kolicina : null, jedinica: String(b.jedinica || '').slice(0, 12),
        stanje: 'dostupno', kod: null, nalog: null, od: Date.now(), created: Date.now(), log: [] };
      logOprema(o, String(b.byName || 'Dispečer').slice(0, 60), 'Dodano u evidenciju');
      DB.oprema.push(o); save();
      json(res, 200, { ok: true, item: pubOprema(o) });
    });
  }
  m = p.match(/^\/api\/equipment\/(o_[a-f0-9]+)$/);
  if (m && req.method === 'DELETE') {
    if (needAdmin()) return;
    const i = DB.oprema.findIndex(o => o.id === m[1]);
    if (i < 0) return json(res, 404, { error: 'Oprema nije pronađena.' });
    DB.oprema.splice(i, 1); save(); return json(res, 200, { ok: true });
  }
  if (m && req.method === 'PATCH') {
    return readBody(req, b => {
      const o = DB.oprema.find(x => x.id === m[1]);
      if (!o) return json(res, 404, { error: 'Oprema nije pronađena.' });
      b = b || {};
      const adm = isAdmin(req);
      const w = adm ? null : authWorker(b, u, req);
      if (!adm && !w) return json(res, 401, { error: 'Prijavi se u aplikaciju.' });
      const ko = adm ? String(b.byName || 'Dispečer').slice(0, 60) : w.name;
      const nalog = b.nalog ? DB.reports.find(r => String(r.id) === String(b.nalog)) : null;
      const akcija = b.akcija;
      if (akcija === 'uzmi') {
        /* Radnik uzima za sebe; dispečer može zadužiti bilo kog radnika. */
        const za = adm ? DB.workers.find(x => x.id === b.kod) : w;
        if (!za) return json(res, 400, { error: 'Izaberi radnika koji zadužuje opremu.' });
        if (o.stanje === 'servis') return json(res, 409, { error: 'Oprema je na servisu.' });
        if (o.stanje === 'zauzeto' && o.kod !== za.id) {
          const ima = DB.workers.find(x => x.id === o.kod);
          return json(res, 409, { error: 'Opremu već ima ' + (ima ? ima.name : 'drugi radnik') + '.' });
        }
        if (!adm && o.sluzba !== w.dept) return json(res, 403, { error: 'Oprema pripada drugoj službi.' });
        o.stanje = 'zauzeto'; o.kod = za.id; o.nalog = nalog ? nalog.id : null; o.od = Date.now();
        logOprema(o, ko, 'Zaduženo: ' + za.name + (nalog ? ' · nalog N-' + nalog.no : ''));
      } else if (akcija === 'vrati') {
        if (!adm && o.kod !== w.id) return json(res, 403, { error: 'Vratiti može samo onaj ko je opremu zadužio, ili dispečer.' });
        o.stanje = 'dostupno'; o.kod = null; o.nalog = null; o.od = Date.now();
        logOprema(o, ko, 'Vraćeno' + (b.napomena ? ': ' + String(b.napomena).slice(0, 200) : ''));
      } else if (akcija === 'kvar') {
        if (!adm && o.sluzba !== w.dept && o.kod !== w.id) return json(res, 403, { error: 'Oprema pripada drugoj službi.' });
        const opis = String(b.napomena || '').trim();
        if (opis.length < 3) return json(res, 400, { error: 'Opiši kvar u par riječi.' });
        o.stanje = 'servis'; o.kod = null; o.nalog = null; o.od = Date.now(); o.napomena = opis.slice(0, 300);
        logOprema(o, ko, 'Prijavljen kvar: ' + opis.slice(0, 200));
      } else if (akcija === 'ispravno') {
        if (!adm) return json(res, 403, { error: 'Opremu iz servisa vraća u upotrebu dispečer.' });
        o.stanje = 'dostupno'; o.od = Date.now(); logOprema(o, ko, 'Vraćeno iz servisa');
      } else {
        if (!adm) return json(res, 403, { error: 'Podatke o opremi mijenja dispečer.' });
        ['naziv', 'oznaka', 'napomena', 'jedinica'].forEach(k => { if (typeof b[k] === 'string') o[k] = b[k].trim().slice(0, k === 'napomena' ? 300 : 80); });
        if (typeof b.sluzba === 'string') o.sluzba = b.sluzba.slice(0, 20);
        if (TIPOVI_OPREME.indexOf(b.tip) >= 0) o.tip = b.tip;
        if ('kolicina' in b) o.kolicina = typeof b.kolicina === 'number' && b.kolicina >= 0 ? b.kolicina : null;
        logOprema(o, ko, 'Podaci izmijenjeni');
      }
      save();
      json(res, 200, { ok: true, item: pubOprema(o) });
    });
  }

  /* ── RADNICI ── */
  if (p === '/api/workers' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    let list = DB.workers;
    if (city) list = list.filter(w => w.city === city);
    return json(res, 200, list.map(pubWorker));      // nikad PIN ni token napolje
  }

  /* Dispečer dodaje radnika. Odgovor sadrži PIN — jedini put kad se vidi. */
  if (p === '/api/workers' && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      if (!b || !b.name) return json(res, 400, { error: 'name je obavezan' });
      const initials = String(b.name).trim().split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase();
      const w = {
        id: 'w_' + crypto.randomBytes(4).toString('hex'),
        name: String(b.name).slice(0, 60),
        role: String(b.role || 'Terenac').slice(0, 40),
        dept: String(b.dept || 'putevi').slice(0, 20),
        city: String(b.city || '').slice(0, 60),
        phone: String(b.phone || '').slice(0, 30),
        vehicle: String(b.vehicle || '').slice(0, 60),
        shiftFrom: String(b.shiftFrom || '').slice(0, 5),
        shiftTo: String(b.shiftTo || '').slice(0, 5),
        photo: null,
        av: initials || '?',
        active: true,
        created: Date.now(),
        /* Vanjski izvođač: gostujući pristup koji se sam gasi na ovaj datum. */
        guest: b.guest === true,
        guestUntil: (b.guest === true && typeof b.guestUntil === 'number' && b.guestUntil > Date.now())
          ? b.guestUntil : null
      };
      w.code = newCode(w.dept);
      const pin = newPin(); setPin(w, pin);
      DB.workers.push(w); save();
      log('➕ Novi radnik: ' + w.name + ' (' + w.role + ', ' + w.dept + ') · kod ' + w.code);
      json(res, 200, { ok: true, worker: pubWorker(w), code: w.code, pin: pin });
    });
  }

  /* Dispečer resetuje PIN (radnik ga zaboravio). Novi PIN se vraća jednom. */
  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)\/pin$/);
  if (m && req.method === 'POST') {
    if (needAdmin()) return;
    const w = DB.workers.find(x => x.id === m[1]);
    if (!w) return json(res, 404, { error: 'nema radnika' });
    const pin = newPin(); setPin(w, pin);
    w.token = null; w.fails = 0; w.lockUntil = 0;      // stara sesija se gasi
    save();
    log('🔑 Reset PIN-a: ' + w.name + ' (' + w.code + ')');
    return json(res, 200, { ok: true, code: w.code, pin: pin });
  }

  /* ── PRIJAVA RADNIKA ── */
  if (p === '/api/worker/login' && req.method === 'POST') {
    return readBody(req, b => {
      const code = String((b && b.code) || '').trim().toUpperCase();
      const pin = String((b && b.pin) || '').trim();

      /* Prekidač za podešavanje: ulazi se samo kodom, bez PIN-a. Ako nema
         nijednog radnika, napravi se privremeni da aplikacija ima šta
         prikazati. Vidi objašnjenje uz NO_AUTH na vrhu fajla. */
      if (NO_AUTH) {
        let w0 = code ? DB.workers.find(x => String(x.code).toUpperCase() === code)
                      : DB.workers[0];
        if (!w0) {
          w0 = {
            id: 'w' + Date.now().toString(36),
            code: 'TEST-0001', name: 'Radnik (podešavanje)',
            role: 'Radnik', dept: 'opšte', city: '', av: '👷',
            active: true, created: Date.now(), salt: '', pinHash: ''
          };
          DB.workers.push(w0);
        }
        w0.token = crypto.randomBytes(24).toString('hex');
        w0.tokenAt = Date.now(); w0.lastSeen = Date.now();
        save();
        log('🔓 Prijava radnika BEZ PIN-a (PINIT_NO_AUTH): ' + w0.name);
        return json(res, 200, { ok: true, token: w0.token, worker: pubWorker(w0) });
      }

      if (!code || !pin) return json(res, 400, { error: 'Upiši kod i PIN.' });
      const w = DB.workers.find(x => String(x.code).toUpperCase() === code);
      /* Ista poruka za pogrešan kod i pogrešan PIN — da se ne može
         "pecanjem" saznati koji kodovi postoje. */
      if (!w) return json(res, 401, { error: 'Pogrešan kod ili PIN.' });
      if (w.active === false) return json(res, 403, { error: 'Nalog je ugašen. Javi se dispečeru.' });
      if (loginBlocked(w)) {
        const min = Math.ceil((w.lockUntil - Date.now()) / 60e3);
        return json(res, 429, { error: 'Previše pokušaja. Pokušaj za ' + min + ' min.' });
      }
      if (hashPin(pin, w.salt) !== w.pinHash) {
        loginFailed(w); save();
        log('⛔ Neuspjela prijava radnika (' + code + ')');
        return json(res, 401, { error: 'Pogrešan kod ili PIN.' });
      }
      w.fails = 0; w.lockUntil = 0;
      w.token = crypto.randomBytes(24).toString('hex');
      w.tokenAt = Date.now(); w.lastSeen = Date.now();
      save();
      log('👷 Prijava radnika: ' + w.name + ' (' + w.code + ')');
      json(res, 200, { ok: true, token: w.token, worker: pubWorker(w) });
    });
  }

  if (p === '/api/worker/logout' && req.method === 'POST') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (w) { w.token = null; save(); log('👋 Odjava: ' + w.name); }
      json(res, 200, { ok: true });
    });
  }

  /* Aplikacija ovim provjerava je li sačuvana sesija još važeća. */
  if (p === '/api/worker/me' && req.method === 'GET') {
    const w = authWorker(null, u, req);
    if (!w) return json(res, 401, { error: 'Sesija je istekla. Prijavi se ponovo.' });
    save();
    return json(res, 200, { ok: true, worker: pubWorker(w) });
  }

  /* Radnik mijenja svoj PIN. */
  if (p === '/api/worker/pin' && req.method === 'POST') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (!w) return json(res, 401, { error: 'Sesija je istekla.' });
      const oldP = String((b && b.oldPin) || ''), newP = String((b && b.newPin) || '');
      if (hashPin(oldP, w.salt) !== w.pinHash) return json(res, 401, { error: 'Trenutni PIN nije tačan.' });
      if (!/^\d{4,8}$/.test(newP)) return json(res, 400, { error: 'Novi PIN mora imati 4–8 cifara.' });
      setPin(w, newP); save();
      log('🔑 Radnik promijenio PIN: ' + w.name);
      json(res, 200, { ok: true });
    });
  }

  /* ── RADNIK UREĐUJE SVOJ PROFIL ──
     Mijenja samo ono što je njegovo: ime, uloga, telefon, vozilo, smjena, slika.
     Službu (dept) i grad postavlja dispečer — radnik ih ne može sam mijenjati. */
  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)$/);
  if (m && req.method === 'PATCH' && isAdmin(req)) {
    /* Dispečer uređuje radnika: službu, ulogu, smjenu, raspored po danima,
       gašenje naloga i rok gostujućeg pristupa. PIN se ovdje ne dira. */
    return readBody(req, b => {
      const w = DB.workers.find(x => x.id === m[1]);
      if (!w) return json(res, 404, { error: 'Radnik nije pronađen.' });
      if (!b) return json(res, 400, { error: 'Nema podataka.' });
      ['name', 'role', 'dept', 'city', 'phone', 'vehicle'].forEach(k => {
        if (typeof b[k] === 'string') w[k] = b[k].trim().slice(0, k === 'dept' ? 20 : 60); });
      if (typeof b.shiftFrom === 'string') w.shiftFrom = b.shiftFrom.slice(0, 5);
      if (typeof b.shiftTo === 'string') w.shiftTo = b.shiftTo.slice(0, 5);
      if (Array.isArray(b.shifts)) w.shifts = b.shifts.slice(0, 7).map(x => ['J', 'P', 'N', 'O'].indexOf(x) >= 0 ? x : 'O');
      if (typeof b.active === 'boolean') { w.active = b.active; if (!b.active) w.token = null; }
      if ('guestUntil' in b) w.guestUntil = (typeof b.guestUntil === 'number') ? b.guestUntil : null;
      if (typeof b.name === 'string' && b.name.trim())
        w.av = w.name.split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase() || '?';
      w.updated = Date.now();
      save();
      log('✎ Dispečer ažurirao radnika: ' + w.name);
      json(res, 200, { ok: true, worker: pubWorker(w) });
    });
  }
  if (m && req.method === 'PATCH') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (!w || w.id !== m[1]) return json(res, 403, { error: 'Nemaš pravo mijenjati ovaj profil.' });
      if (b && typeof b.name === 'string' && b.name.trim()) {
        w.name = b.name.trim().slice(0, 60);
        w.av = w.name.split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';
      }
      if (b && typeof b.role === 'string') w.role = b.role.trim().slice(0, 40);
      if (b && typeof b.phone === 'string') w.phone = b.phone.trim().slice(0, 30);
      if (b && typeof b.vehicle === 'string') w.vehicle = b.vehicle.trim().slice(0, 60);
      if (b && typeof b.shiftFrom === 'string') w.shiftFrom = b.shiftFrom.slice(0, 5);
      if (b && typeof b.shiftTo === 'string') w.shiftTo = b.shiftTo.slice(0, 5);
      if (b && 'photo' in b) w.photo = (b.photo === null) ? null : cleanPhoto(b.photo, 3e6);
      w.updated = Date.now();
      save();
      log('✎ Profil ažuriran: ' + w.name);
      json(res, 200, { ok: true, worker: pubWorker(w) });
    });
  }

  /* Lokacija radnika — samo radnik za sebe, i samo sa tokenom. */
  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)\/loc$/);
  if (m && req.method === 'POST') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (!w || w.id !== m[1]) return json(res, 403, { error: 'nije dozvoljeno' });
      if (b && okLat(b.lat) && okLng(b.lng)) {
        w.lat = b.lat; w.lng = b.lng;
        w.acc = (typeof b.acc === 'number' && isFinite(b.acc) && b.acc >= 0)
                  ? Math.min(Math.round(b.acc), 100000) : null;
        w.locTs = Date.now(); save();
      }
      json(res, 200, { ok: true });
    });
  }

  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)$/);
  if (m && req.method === 'DELETE') {
    if (needAdmin()) return;
    const i = DB.workers.findIndex(w => w.id === m[1]);
    if (i < 0) return json(res, 404, { error: 'nema radnika' });
    const w = DB.workers.splice(i, 1)[0];
    (DB.oprema || []).forEach(o => { if (o.kod === w.id) { o.kod = null; o.nalog = null; o.stanje = 'dostupno'; } });
    DB.reports.forEach(r => {
      if (r.worker === w.id) r.worker = null;
      if (Array.isArray(r.crew)) r.crew = r.crew.filter(x => x !== w.id);
      if (Array.isArray(r.participants)) r.participants = r.participants.filter(x => x !== w.id);
    });
    save();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/drives' && req.method === 'GET') {
    /* Vožnje sadrže GPS putanje vozila i oznake uređaja — to nije javni
       podatak. Čita ih samo prijavljeni dispečer (PINIT Drive komandni), i to
       cijelu evidenciju, jer se propadanje dionice prati kroz sve vožnje. */
    if (needAdmin()) return;
    const city = u.searchParams.get('city');
    let list = DB.drives;
    if (city) list = list.filter(d => d.city === city);
    return json(res, 200, list);
  }

  if (p === '/api/drives' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.drive) return json(res, 400, { error: 'drive je obavezan' });
      const v = validateDrive(b.drive);
      if (v.reject) { log('⛔ Odbijena vožnja (' + v.reject + ')'); return json(res, 400, { error: v.reject }); }
      const rec = {
        id: 'd_' + Date.now() + '_' + Math.floor(Math.random() * 999),
        ts: Date.now(),
        deviceId: b.deviceId || null,
        city: b.city || '',
        name: b.name || '',
        flags: v.flags,
        pathKm: v.pathKm,
        drive: b.drive
      };
      DB.drives.push(rec); save();
      const d = b.drive;
      log('🚗 Nova vožnja: ' + (d.km || 0) + ' km · ' +
          ((d.segments || []).length) + ' segmenata · ' + ((d.bumps || []).length) + ' udara · ' + rec.city +
          (v.flags.length ? ' · ⚠ ' + v.flags.join(', ') : ''));
      json(res, 200, { ok: true, id: rec.id, flags: v.flags });
    });
  }

  if (p === '/api/stats' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    const R = city ? DB.reports.filter(r => r.city === city) : DB.reports;
    const D = city ? DB.drives.filter(d => d.city === city) : DB.drives;
    return json(res, 200, {
      users: DB.users.length, reports: R.length,
      resolved: R.filter(r => r.status === 3).length,
      inProgress: R.filter(r => r.status === 1 || r.status === 2).length,
      drives: D.length,
      km: +D.reduce((s, d) => s + (d.drive.km || 0), 0).toFixed(1),
      bumps: D.reduce((s, d) => s + (d.drive.bumps || []).length, 0)
    });
  }

  /* ── statika ── */
  let file = null;
  if (p === '/' || p === '/app') file = 'app.html';
  else if (p === '/komandni') file = 'komandni.html';
  else if (p === '/platforma' || p === '/platform') file = 'platforma.html';
  else if (p === '/radnik') file = 'radnik.html';
  else file = p.replace(/^\/+/, '').replace(/\.\./g, '');

  /* Dispečerske stranice se ne serviraju bez prijave. Skrivanje ekrana u
     pregledniku ne bi bilo dovoljno — cijeli HTML bi se ipak preuzeo, a s
     njim i sve što je u njemu. Zato ih server uopšte ne šalje. */
  const LOCKED = ['platforma.html', 'komandni.html'];
  if (LOCKED.indexOf(file) >= 0 && !isAdmin(req)) {
    res.writeHead(200, Object.assign({ 'Content-Type': MIME['.html'] }, secHeaders()));
    return res.end(loginPage(p));
  }

  const fp = path.join(PUB, file);
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(fp);

    /* Oznake za pregled linka (og:image, og:url) moraju sadržavati punu adresu.
       Ona ovisi o tome gdje sistem radi — localhost, lokalna mreža ili Render —
       pa je upisujemo ovdje, iz zaglavlja zahtjeva. Čitači pregleda (Viber,
       WhatsApp, Facebook) ne izvršavaju JavaScript, pa se to ne može riješiti
       u pregledniku. */
    if (ext === '.html') {
      let html = buf.toString('utf8');
      if (html.indexOf('__PINIT_ORIGIN__') >= 0) {
        const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
                      (req.socket.encrypted ? 'https' : 'http');
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        const origin = host ? proto + '://' + host : '';
        html = html.split('__PINIT_ORIGIN__').join(origin);
      }
      /* Vidljiva traka dok je zaštita isključena — log se previdi, ovo ne.
         Bez ovoga je lako zaboraviti PINIT_NO_AUTH i ostaviti platformu
         otvorenu na javnoj adresi. */
      if (NO_AUTH) html = html.replace(/<body([^>]*)>/i, '<body$1>' + NOAUTH_BAR);
      res.writeHead(200, Object.assign({ 'Content-Type': MIME['.html'],
        'Cache-Control': 'no-cache, must-revalidate' }, secHeaders()));
      return res.end(html);
    }

    /* Slike se rijetko mijenjaju, a čitači pregleda ih dovlače više puta —
       neka ih drže u kešu jedan dan da se ne prenose bez potrebe. */
    const head = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.png' || ext === '.svg') head['Cache-Control'] = 'public, max-age=86400';
    /* Skripte i podešavanja moraju se provjeriti pri svakom otvaranju — dok se
       ovo keširalo, izmjene (npr. prijevodi u jezik.js) nisu stizale do telefona. */
    else head['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, head);
    res.end(buf);
  });
});

/* Server se ne smije javiti prije nego su podaci u memoriji — inače bi prvi
   posjetilac vidio prazan sistem, a prvi upis pregazio sve što je u bazi. */
loadDB().then(izvor => {
  migrateWorkers();
  migrateReports();
  pripremiLozinku();          // tek sad, kad znamo šta je u bazi
  ucitajSesije();
  log('PINIT verzija ' + PINIT_VERZIJA);
  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces(); let lan = null;
    for (const k of Object.keys(nets)) for (const n of nets[k])
      if (n.family === 'IPv4' && !n.internal) { lan = n.address; break; }
    console.log('════════════════════════════════════════════════');
    console.log(' PINIT server radi.');
    console.log('   Na ovom računaru:  http://localhost:' + PORT);
    if (lan) {
      console.log('   Sa telefona (ista Wi-Fi mreža):');
      console.log('       aplikacija:      http://' + lan + ':' + PORT);
      console.log('       komandni (Drive): http://' + lan + ':' + PORT + '/komandni');
      console.log('       platforma (prijave): http://' + lan + ':' + PORT + '/platforma');
    }
    console.log('   Podaci: ' + izvor);
    console.log('           ' + DB.reports.length + ' prijava · ' +
                DB.workers.length + ' radnika · ' + DB.drives.length + ' vožnji');
    if (!SB_ON) {
      console.log('   ⚠  SUPABASE_URL/SUPABASE_KEY nisu postavljeni.');
      console.log('      Podaci se čuvaju u data.json i BRIŠU se pri svakom deployu.');
    }
    console.log('   ──────────────────────────────────────────────');
    /* ── DIJAGNOSTIKA LOZINKE ──
       Kad čovjek postavi PINIT_ADMIN_PASS a server je i dalje ne vidi, uzrok
       je skoro uvijek greška u NAZIVU varijable, razmak u nazivu, ili je
       postavljena na drugom servisu. Zato ispisujemo šta program STVARNO
       vidi u okruženju. Vrijednosti se NE ispisuju, samo nazivi i dužina. */
    var envPass = process.env.PINIT_ADMIN_PASS;
    if (typeof envPass === 'string' && envPass.length) {
      console.log('   🔑 Lozinka: iz PINIT_ADMIN_PASS (' + envPass.length + ' znakova)');
      if (/^["'].*["']$/.test(envPass))
        console.log('      ⚠  Vrijednost je u navodnicima — oni su DIO lozinke.');
      if (envPass !== envPass.trim())
        console.log('      ⚠  Ima razmak na početku ili kraju — i on je dio lozinke.');
    } else {
      console.log('   🔑 Lozinka: ugrađena u server.js  →  ' + ADMIN_PASS);
      console.log('      Mijenja se u server.js (UGRADJENA_LOZINKA), ili');
      console.log('      postavi PINIT_ADMIN_PASS ako ne želiš da stoji u kodu.');
    }
    console.log('   ──────────────────────────────────────────────');
    if (NO_AUTH) {
      console.log('');
      console.log('   ██████████████████████████████████████████████');
      console.log('   ██  ZAŠTITA JE ISKLJUČENA  (PINIT_NO_AUTH)  ██');
      console.log('   ██████████████████████████████████████████████');
      console.log('      Platforma i komandni centar se otvaraju BEZ lozinke.');
      console.log('      Radnička aplikacija ulazi BEZ PIN-a.');
      console.log('      Svako ko zna adresu može brisati radnike i vidjeti');
      console.log('      puna imena i fotografije građana.');
      console.log('');
      console.log('      Ovo je samo za podešavanje. Kad završiš, obriši');
      console.log('      varijablu PINIT_NO_AUTH i sve se vraća samo od sebe.');
      console.log('');
    } else if (ADMIN_GENERATED) {
      console.log('   ⚠  PINIT_ADMIN_PASS nije postavljen.');
      console.log('      Lozinka za platformu i komandni centar:');
      console.log('');
      console.log('          ' + ADMIN_PASS);
      console.log('');
      console.log('      Ova lozinka OSTAJE ista i nakon restarta — zapamćena je.');
      console.log('      Da postaviš svoju: dodaj PINIT_ADMIN_PASS u okruženje');
      console.log('      (Render → Environment) i restartuj servis.');
    } else {
      console.log('   🔒 Platforma i komandni centar traže lozinku (PINIT_ADMIN_PASS).');
    }
    console.log('════════════════════════════════════════════════');
  });
}).catch(e => {
  console.error('════════════════════════════════════════════════');
  console.error(' Podaci se ne mogu učitati — server se NEĆE pokrenuti.');
  console.error(' ' + e.message);
  console.error('');
  console.error(' Provjeri SUPABASE_URL i SUPABASE_KEY, i jesu li tabele');
  console.error(' napravljene (vidi SUPABASE.md u folderu projekta).');
  console.error('════════════════════════════════════════════════');
  process.exit(1);
});

/* Render gasi instancu signalom — pokušaj upisati sve što još čeka. */
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  clearTimeout(saveT);
  Promise.resolve(SB_ON ? flushSB() : fs.writeFileSync(DATA, JSON.stringify(DB)))
    .catch(() => {}).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
}));
