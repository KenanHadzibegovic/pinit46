/* ══════════════════════════════════════════════════════════════════
   Prenos podataka iz data.json u Supabase — pokreće se jednom.

   Upotreba:
     SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=eyJ... node prenesi-u-supabase.js

   Sigurno je pokrenuti više puta: zapis s istim id-om se ne duplira nego
   prepisuje. Ništa se ne briše iz Supabasea — samo se dodaje i osvježava.
   ══════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const DATA = path.join(__dirname, 'data.json');
const TABLES = { users: 'pinit_users', reports: 'pinit_reports',
                 drives: 'pinit_drives', workers: 'pinit_workers' };

if (!SB_URL || !SB_KEY) {
  console.error('Nedostaju SUPABASE_URL i SUPABASE_KEY.');
  console.error('Primjer:');
  console.error('  SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=eyJ... node prenesi-u-supabase.js');
  process.exit(1);
}

let DB;
try {
  DB = JSON.parse(fs.readFileSync(DATA, 'utf8'));
} catch (e) {
  console.error('Ne mogu pročitati data.json (' + DATA + ').');
  console.error('Ako ga nema, nema ni šta prenositi — sve je u redu.');
  process.exit(1);
}

function sb(pathQ, opts) {
  return fetch(SB_URL + '/rest/v1/' + pathQ, {
    method: opts.method || 'GET',
    headers: Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, opts.headers || {}),
    body: opts.body
  }).then(async r => {
    const t = await r.text();
    if (!r.ok) throw new Error(r.status + ': ' + t.slice(0, 400));
    return t ? JSON.parse(t) : null;
  });
}

(async () => {
  console.log('Prenosim iz ' + DATA);
  console.log('u ' + SB_URL);
  console.log('');
  let total = 0;
  for (const key of Object.keys(TABLES)) {
    const rows = Array.isArray(DB[key]) ? DB[key] : [];
    if (!rows.length) { console.log('  ' + key.padEnd(9) + ' — prazno'); continue; }
    let done = 0;
    /* U paketima po 50, da veliki zapisi s fotografijama ne padnu na vremenu. */
    for (let i = 0; i < rows.length; i += 50) {
      const part = rows.slice(i, i + 50);
      await sb(TABLES[key], {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(part.map(o => ({ id: String(o.id), data: o })))
      });
      done += part.length;
      process.stdout.write('\r  ' + key.padEnd(9) + ' ' + done + '/' + rows.length);
    }
    console.log('\r  ' + key.padEnd(9) + ' ' + done + '/' + rows.length + ' ✓');
    total += done;
  }
  console.log('');
  console.log('Gotovo — preneseno ' + total + ' zapisa.');
  console.log('Provjeri u Supabase → Table Editor.');
  console.log('');
  console.log('data.json ostaje netaknut. Kad potvrdiš da je sve u bazi,');
  console.log('možeš ga preimenovati u data.json.staro za svaki slučaj.');
})().catch(e => {
  console.error('');
  console.error('Prenos nije uspio: ' + e.message);
  console.error('');
  console.error('Najčešći uzroci:');
  console.error('  • tabele nisu napravljene → pokreni SQL iz SUPABASE.md');
  console.error('  • korišten je "anon" ključ umjesto "service_role"');
  process.exit(1);
});
