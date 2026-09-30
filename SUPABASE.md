# Prelazak na Supabase — korak po korak

Ovo rješava jedini preostali veliki problem: **podaci više ne nestaju pri
deployu.** Traje petnaestak minuta i ne košta ništa.

Dok ovo ne uradiš, sistem radi kao i prije — preko `data.json`. Ništa se ne
kvari ako odgodiš.

---

## 1. Napravi tabele

U Supabase: lijevi meni → **SQL Editor** → **New query** → zalijepi ovo cijelo
i klikni **Run**.

```sql
-- PINIT: tabele za podatke
-- Svaki zapis se čuva kao jsonb dokument. Razlog: aplikacija često dobija
-- nova polja, a ovako ne treba mijenjati tabele pri svakoj izmjeni.

create table if not exists pinit_reports (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists pinit_workers (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists pinit_users (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists pinit_drives (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Zaključavanje: sve četiri tabele su nedostupne svima osim serveru.
-- Server koristi service_role ključ koji ova pravila zaobilazi.
-- Bez ovoga bi svako s javnim ključem mogao čitati i mijenjati podatke.
alter table pinit_reports enable row level security;
alter table pinit_workers enable row level security;
alter table pinit_users   enable row level security;
alter table pinit_drives  enable row level security;

-- Namjerno NE pravimo nijedno "policy" pravilo.
-- Prazan skup pravila + uključen RLS = niko osim service_role ne prolazi.

-- Ubrzanje za često korištena polja
create index if not exists pinit_reports_ts  on pinit_reports  ((data->>'ts'));
create index if not exists pinit_reports_wk  on pinit_reports  ((data->>'worker'));
create index if not exists pinit_workers_cd  on pinit_workers  ((data->>'code'));
```

Kad prođe, trebalo bi pisati **Success. No rows returned**.

---

## 2. Uzmi pristupne podatke

Supabase: **Project Settings** (zupčanik dolje lijevo) → **API**.

Trebaju ti dvije stvari:

| Šta | Gdje piše | Izgleda ovako |
|---|---|---|
| URL projekta | „Project URL" | `https://abcdefgh.supabase.co` |
| Tajni ključ | „Project API keys" → **service_role** | dugačak niz koji počinje s `eyJ...` |

> **service_role**, ne `anon`. Klikni „Reveal" da ga vidiš.

---

## 3. Upiši ih na Render

Render → tvoj servis → **Environment** → **Add Environment Variable**, dva puta:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Project URL iz koraka 2 |
| `SUPABASE_KEY` | service_role ključ iz koraka 2 |

Sačuvaj. Servis se sam ponovo pokrene.

---

## 4. Provjeri da je uspjelo

Render → kartica **Logs**. Pri pokretanju mora pisati:

```
Podaci: Supabase (abcdefgh.supabase.co)
        0 prijava · 0 radnika · 0 vožnji
```

Ako umjesto toga piše `data.json (lokalni fajl)` — varijable nisu stigle,
provjeri jesi li ih sačuvao i je li se servis restartovao.

Ako server uopšte ne krene i u logu piše da se podaci ne mogu učitati —
tabele nisu napravljene ili je ključ pogrešan. Vrati se na korak 1.

Zatim: otvori platformu, dodaj jednog radnika, pa u Supabase → **Table
Editor** → `pinit_workers`. Mora se vidjeti taj radnik. Onda uradi bilo kakav
deploy i provjeri da je i dalje tu — to je cijela poenta.

---

## Lokalni rad

Ako hoćeš i lokalno raditi nad istom bazom:

```bash
SUPABASE_URL=https://abcdefgh.supabase.co \
SUPABASE_KEY=eyJ... \
PINIT_ADMIN_PASS=nekalozinka \
node server.js
```

Bez tih varijabli server koristi `data.json` kao i dosad — zgodno za probe
kad ne želiš dirati prave podatke.

---

## Prenos postojećih podataka

Ako u `data.json` imaš nešto što vrijedi sačuvati, pokreni jednom:

```bash
SUPABASE_URL=... SUPABASE_KEY=... node prenesi-u-supabase.js
```

Skripta pročita `data.json` i prepiše sve u Supabase. Sigurna je za ponovno
pokretanje — isti zapis se ne duplira.

---

## Šta treba znati

**service_role ključ ne smije nikad završiti u pregledniku.** On zaobilazi
sva sigurnosna pravila baze. Drži ga isključivo u varijablama okruženja na
Renderu. Ako ikad procuri (npr. slučajno u commitu), odmah ga poništi:
Supabase → Project Settings → API → **Reset service_role key**.

**Besplatni Supabase pauzira projekat nakon sedmicu dana bez ijednog
zahtjeva.** Dobiješ email i vratiš ga jednim klikom, ali za vrijeme pauze
aplikacija ne radi. Dok traje pilot to nije problem jer se sistem koristi
svakodnevno.

**Fotografije su i dalje u bazi.** Besplatni plan daje 500 MB. Uz smanjivanje
slika na ~200 KB to je oko 2.000 prijava s fotografijama. Kad se približiš,
slike idu na Cloudflare R2 (besplatno do 10 GB), a u bazi ostaje samo link.

**Backup.** Supabase besplatni plan ne pravi automatske kopije. Jednom
sedmično: Table Editor → tabela → izvezi CSV. Traje minut.
