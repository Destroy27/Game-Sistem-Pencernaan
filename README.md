# Petualangan Makanan (versi gratis)

Game edukasi sistem pencernaan untuk kelas. Siswa memilih makanan, menemani makanan itu dari mulut sampai anus, dan menjawab satu soal di tiap organ. Guru punya panel sendiri untuk mengelola murid, soal tambahan, token harian, dan melihat rekap nilai. Versi ini gratis: tidak ada pembayaran, langganan, atau kode aktivasi.

## Isi

| Berkas | Fungsi |
|---|---|
| `index.html` | Halaman awal: pilih Siswa atau Guru |
| `game-pencernaan.html` | Game untuk siswa |
| `admin.html`, `admin.css` | Panel guru |
| `ui.css`, `ui.js` | Gaya, suara, dan maskot makanan yang dipakai semua halaman |
| `worker.js`, `schema.sql`, `wrangler.toml` | API Cloudflare Worker + database D1 |
| `tests/` | Uji otomatis (`npm test`) |

## Cara pasang

### 1. Pasang API di Cloudflare (butuh Node.js)

```
npm i -g wrangler
wrangler login
wrangler d1 create pencernaan-gratis
```

1. Salin `database_id` yang muncul ke `wrangler.toml`.
2. Di `wrangler.toml`, ganti `ALLOWED_ORIGIN` menjadi `https://USERNAME-GITHUB-MU.github.io`.
3. Di `worker.js`, ganti `ADMIN_URL` menjadi alamat `admin.html` di GitHub Pages-mu.
4. Buat tabelnya dan pasang:
   ```
   wrangler d1 execute pencernaan-gratis --remote --file=schema.sql
   wrangler deploy
   ```
5. Catat URL Worker yang muncul, misalnya `https://pencernaan-gratis-api.akunmu.workers.dev`.

Opsional: `wrangler secret put ADMIN_KEY` untuk akses pemilik yang bisa menghapus data semua guru.

### 2. Isi alamat Worker

Di VS Code tekan Ctrl+Shift+H dan ganti `https://NAMA-WORKER.USERNAME.workers.dev` dengan URL Worker-mu di dua berkas ini:

- `admin.html` (variabel `API`)
- `game-pencernaan.html` (variabel `API_URL`)

### 3. Aktifkan GitHub Pages

Di repository GitHub: Settings, Pages, Source: Deploy from a branch, Branch: `main`, folder `/ (root)`, lalu Save. Tunggu 1 sampai 2 menit. Link yang dibagikan: `https://USERNAME.github.io/NAMA-REPO/`.

## Cara pakai

1. Guru membuka link utama, memilih Guru, lalu Daftar Baru (nama dan PIN).
2. Tambahkan murid, satu per satu atau banyak sekaligus.
3. Klik "Buat token hari ini" dan tulis token 6 karakter di papan tulis.
4. Siswa membuka link yang sama, memilih Siswa, memasukkan token, lalu bermain.
5. Guru membuka "Muat rekap" untuk melihat nilai, materi yang sulit, dan saran tindakan.

## Catatan

- Data tersimpan di database D1 milikmu sendiri, terpisah dari versi lain. Beri tahu siswa (dan orang tua bila perlu) bahwa nama, kelas, dan skor disimpan.
- Pendaftaran guru terbuka untuk siapa saja yang tahu alamatnya. Kalau tidak ingin terbuka, bagikan link hanya ke guru yang dituju.
- Jalankan uji otomatis dengan `npm ci` lalu `npm test`.
