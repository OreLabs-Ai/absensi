# Absensi — Lotus Palace + RS Senjakala (satu server)

Satu proses **Node.js** menyajikan **dua web absensi** sekaligus:

| URL | Aplikasi |
|-----|----------|
| `/` | Halaman pemilih (landing) |
| `/coolbeans/` | **Lotus Palace Restaurant** (dulu Cool Beans — tema ungu/pink, ada penyesuaian warna) |
| `/senjakala/` | **RS Senjakala** (tema gold) |

Nyalakan **satu** `node server.js` → kedua web langsung aktif. Murni Node.js, **tanpa dependensi npm**.

## Struktur
```
server.js              # entry: router + landing, mount kedua app
lib/app-core.js        # logika bersama (API + storage), dipakai kedua app
apps/coolbeans/public  # web Lotus Palace (index.html, styles.css, app.js, dst)
apps/senjakala/public  # web RS Senjakala
apps/senjakala/seed.json   # data awal RS Senjakala (roster dipulihkan saat start bersih)
data/                  # data runtime (coolbeans.json, senjakala.json) — TIDAK di-commit
render.yaml            # blueprint deploy Render
```

## Jalankan lokal
Butuh Node.js ≥ 18.
```bash
node server.js
```
Buka http://localhost:3000 . Ubah port: `PORT=8080 node server.js`.
Lokasi data bisa dipindah: `DATA_DIR=/path/persisten node server.js`.

## Login dashboard (awal)
- Lotus Palace → sandi **`coolbeans`**
- RS Senjakala → sandi **`senjakala`**

Ganti di **Dashboard → Pengaturan** masing-masing. Token berlaku 8 jam.

## Penyimpanan data (Upstash Redis — gratis, tanpa kartu)
Secara default app menyimpan data ke **file lokal** (`data/`). Di hosting gratis
(Render) file ini *ephemeral* → bisa hilang saat restart. Supaya **data absensi
aman selamanya**, app otomatis memakai **Upstash Redis** jika dua env var ini diisi:

| Env var | Isi |
|---------|-----|
| `UPSTASH_REDIS_REST_URL` | URL REST dari database Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Token REST dari database Upstash |

Tanpa npm tambahan — app memanggil REST API Upstash via `fetch`. Lokal tanpa env
var ini = tetap pakai file (praktis untuk ngoprek).

**Bikin Upstash (sekali, ~2 menit):**
1. Daftar di **upstash.com** (gratis, tanpa kartu).
2. **Create Database** (Redis) → region terdekat (mis. Singapore).
3. Di tab **REST API**, salin **`UPSTASH_REDIS_REST_URL`** dan **`UPSTASH_REDIS_REST_TOKEN`**.

## Deploy ke Render (gratis)
1. Push repo ini ke GitHub (lihat di bawah).
2. render.com → **New** → **Blueprint** → pilih repo ini (`render.yaml` terbaca otomatis).
3. Saat diminta, isi **Environment**: tempel `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`.
4. Selesai. Akses di `https://<nama>.onrender.com/` → pilih web.

### Biar tidak "tidur" (hindari cold start ~50 dtk)
Render free tidur setelah ~15 menit idle. Pakai pinger gratis:
1. Daftar **cron-job.org** (gratis, tanpa kartu).
2. Buat cronjob: URL `https://<nama>.onrender.com/healthz`, interval **tiap 10 menit**.

> Backup tetap disarankan: **Pengaturan → Cadangkan JSON** di tiap web; pulihkan via **Import**.
> Mau benar-benar selalu-nyala tanpa trik & data permanen? VM gratis-selamanya
> (Google Cloud Always Free e2-micro / Oracle Always Free) — perlu kartu, setup ala-VPS.

## Push ke GitHub (aman, tanpa berbagi password)
```bash
git init
git add -A
git commit -m "Gabungkan Lotus Palace + RS Senjakala jadi satu server"
# buat repo & push — Git akan membuka browser untuk otorisasi (Git Credential Manager):
git branch -M main
git remote add origin https://github.com/<username-kamu>/absensi.git
git push -u origin main
```
Jangan pernah menaruh password di perintah atau file. Otorisasi cukup lewat browser.
