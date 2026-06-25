# Absensi — Cool Beans + RS Senjakala (satu server)

Satu proses **Node.js** menyajikan **dua web absensi** sekaligus:

| URL | Aplikasi |
|-----|----------|
| `/` | Halaman pemilih (landing) |
| `/coolbeans/` | **Cool Beans Restaurant** (tema ungu/pink, ada penyesuaian warna) |
| `/senjakala/` | **RS Senjakala** (tema gold) |

Nyalakan **satu** `node server.js` → kedua web langsung aktif. Murni Node.js, **tanpa dependensi npm**.

## Struktur
```
server.js              # entry: router + landing, mount kedua app
lib/app-core.js        # logika bersama (API + storage), dipakai kedua app
apps/coolbeans/public  # web Cool Beans (index.html, styles.css, app.js, dst)
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
- Cool Beans → sandi **`coolbeans`**
- RS Senjakala → sandi **`senjakala`**

Ganti di **Dashboard → Pengaturan** masing-masing. Token berlaku 8 jam.

## Deploy ke Render (gratis)
1. Push repo ini ke GitHub (lihat di bawah).
2. render.com → **New** → **Blueprint** → pilih repo ini (`render.yaml` terbaca otomatis).
3. Selesai. Akses di `https://<nama>.onrender.com/` → pilih web.

> ⚠️ **Penting soal data di Render free:** disk-nya *ephemeral*. Data di `data/`
> **hilang** saat service tidur (idle ~15 menit) atau redeploy. **Backup berkala**
> lewat **Pengaturan → Cadangkan JSON** di tiap web, pulihkan lewat **Import**.
> Kalau butuh data permanen tanpa ribet, naik ke disk berbayar Render atau pakai
> Fly.io (volume permanen).

## Push ke GitHub (aman, tanpa berbagi password)
```bash
git init
git add -A
git commit -m "Gabungkan Cool Beans + RS Senjakala jadi satu server"
# buat repo & push — Git akan membuka browser untuk otorisasi (Git Credential Manager):
git branch -M main
git remote add origin https://github.com/<username-kamu>/absensi.git
git push -u origin main
```
Jangan pernah menaruh password di perintah atau file. Otorisasi cukup lewat browser.
