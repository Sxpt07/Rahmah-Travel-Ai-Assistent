# Umrah & Hajj AI Assistant (Backend)

Backend lokal single-user untuk asisten chat Umrah/Hajj dengan data jamaah langsung dari SGO Admin. Seluruh sinkronisasi berjalan **di dalam satu proses Node.js lokal**: tanpa Vercel/serverless, tanpa request batch bertahap, dan tanpa batas buatan jumlah halaman atau record.

## Menjalankan secara lokal

Butuh Node.js 22 atau lebih baru.

```bash
cd umrah-ai-backend
npm install
cp .env.example .env
# Isi GEMINI_API_KEY di .env (opsional untuk chat AI; fitur lain tetap jalan)
node server.js
```

Server: `http://localhost:3000`
Health check: `GET http://localhost:3000/api/health`

Mode development dengan auto-reload:

```bash
npm run dev
```

## Cookie SGO (perangkat lokal)

Data jamaah hanya diambil dari SGO Admin memakai cookie sesi yang disimpan **per perangkat** sebagai HttpOnly cookie (`sgo_device_session`, nama dapat diubah lewat `SGO_DEVICE_COOKIE_NAME`) lewat tombol **Cookie SGO** di header UI.

- Tempel cookie dari SGO Admin (mis. `sgo_admin_session=...` atau token sesinya), lalu klik Simpan Cookie.
- Cookie dipakai ulang untuk setiap request SGO dalam satu sesi sinkronisasi.
- Tidak ada cookie fallback dari `.env` dan tidak ada variabel `SGO_ADMIN_SESSION`.
- Cookie tidak pernah dikirim ke prompt AI atau ditulis ke log.

## Sinkronisasi penuh (satu request)

```http
POST /api/jamaah/full-sync
Content-Type: application/json

{}
```

Body opsional:

| Field | Keterangan |
| --- | --- |
| `focusModule` | Batasi ke satu modul SGO (default: semua modul). |
| `url` | Override `SGO_BASE_URL`. |

Yang terjadi dalam satu request:

1. Halaman pertama `/ops/upload-documents` diambil untuk mengetahui total halaman.
2. Semua halaman berikutnya + modul lain diambil dengan pool paralel `SGO_PAGE_CONCURRENCY` (default `8`, rentang `1-10`).
3. Error transien (timeout, `429`, `5xx`) di-retry dengan exponential backoff; error autentikasi langsung menghentikan sinkronisasi.
4. Semua baris jamaah digabung, lalu **semua** manifest diperkaya (NIK/paspor) dengan worker paralel `SGO_MANIFEST_CONCURRENCY` (default `8`, rentang `1-16`) tanpa batas record.
5. Data normalisasi disimpan ke `jamaah_data.json`, cache manifest SQLite diperbarui, dan indeks AI lokal ditulis ke `data/jamaah_ai_index.json`.
6. Progress live dapat dipantau lewat polling `GET /api/jamaah/scrape-progress` (UI memakai endpoint ini).

Contoh ringkas:

```bash
curl -X POST http://localhost:3000/api/jamaah/full-sync \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Respons sukses memuat `count`, `storedJamaahCount`, `jamaahList`, `source`, `fieldCoverage`, `manifest`, `pagination`, `validation`, `syncSummary`, `aiIndex`, `cache`, `modules`, dan `errors`.
Respons gagal selalu berbentuk `{ "success": false, "error": "...", "code": "..." }` dengan HTTP status `400` (konfigurasi/modul), `401` (cookie kedaluwarsa), `428` (cookie belum diatur), `409` (sync lain berjalan), atau `502` (network/empty).

Endpoint terkait:

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/jamaah/full-sync` | Sinkronisasi penuh satu request + validasi semua manifest. |
| `GET /api/jamaah/scrape-progress` | Status progres real-time (tanpa PII). |
| `POST /api/jamaah/sync-one` | Sinkronisasi ulang satu jamaah dari Upload Manifest. |
| `POST /api/sgo/cookie` | Simpan cookie SGO per perangkat (HttpOnly). |
| `POST /api/sgo/cookie/test` | Uji cookie tersimpan. |
| `GET /api/jamaah/status` | Status data + ringkasan indeks AI lokal. |
| `GET /api/ai/status` | Status Gemini + ringkasan indeks AI lokal. |
| `GET /api/health` | Health check server. |

Endpoint batch lama tidak lagi tersedia; satu-satunya alur sinkronisasi penuh adalah `/api/jamaah/full-sync`.

## Indeks AI lokal

Setiap selesai sinkronisasi (atau saat startup bila belum ada), backend membangun/memperbarui `data/jamaah_ai_index.json` berisi:

- Total jamaah, order, RTB, serta paket.
- Jumlah manifest lengkap vs belum lengkap.
- Jumlah NIK/paspor terisi dan daftar ID yang missing (tanpa nilai NIK/paspor).
- Breakdown keberangkatan, RTB, dan paket (maksimal 20 item tiap breakdown).
- Lookup ringkas (`order`, `rtb`, `nama`, `paket`, `orderCounts`) dan ringkasan teks `summaryText`.

`services/aiEngine.js` menyisipkan `summaryText` ke konteks Gemini sebagai metadata agregat. Chat tidak pernah menerima daftar NIK, paspor, atau nomor HP. Kartu hasil chat dibangun lokal oleh `services/consoleJamaahBridge.js` dengan `buildSafeJamaahRow()`.

## Format pesan WhatsApp

Perintah Rapihin Kata mempertahankan pemisah paragraf literal `\n\n` dan tidak mengubah anti-leak: token sesi, cookie, NIK, paspor, dan nomor HP tidak pernah dikirim ke prompt AI maupun dicetak ke log.

## Konfigurasi

Lihat `.env.example`. Ringkasan yang relevan:

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port server lokal. |
| `GEMINI_API_KEY` | — | Kunci Gemini untuk chat AI. |
| `SGO_BASE_URL` | `https://sgo.rahmahgrup.id` | Base URL SGO Admin. |
| `SGO_REQUEST_TIMEOUT_MS` | `20000` | Timeout per request SGO (maks. 60000). |
| `SGO_PAGE_CONCURRENCY` | `8` | Paralel request halaman (1-10). |
| `SGO_MANIFEST_CONCURRENCY` | `8` | Paralel worker manifest (1-16). |
| `SGO_HTTP_RETRY_ATTEMPTS` | `4` | Percobaan ulang error transien. |
| `SGO_HTTP_RETRY_BASE_MS` | `1200` | Backoff dasar retry. |
| `SGO_MANIFEST_TIMEOUT_MS` | `20000` | Timeout request detail manifest. |
| `SGO_MANIFEST_CACHE_MS` | `300000` | TTL cache manifest. |
| `JAMAAH_DATA_FILE` | `jamaah_data.json` | Path data jamaah ternormalisasi. |
| `JAMAAH_AI_INDEX_FILE` | `data/jamaah_ai_index.json` | Path indeks/ringkasan AI lokal. |
| `SGO_RAW_DIR` | `sgo_raw` | Folder respons mentah SGO (berisi PII; jangan di-commit). |

Tidak ada `SGO_ADMIN_SESSION`, `SGO_BATCH_PAGES`, `SGO_SCRAPE_BUDGET_MS`, `SGO_SCRAPE_DEADLINE_MS`, atau `SGO_MANIFEST_BATCH_SIZE`.

## Tes

```bash
node --check server.js
node --check services/sgoScraper.js
node --check public/js/sgo-sync.js
node --test tests/fu-pelunasan-format.test.js
```

Semua file data (`jamaah_data.json`, `sgo_raw/`, `data/jamaah_ai_index.json`, SQLite cache) bersifat lokal dan tidak boleh di-commit.
