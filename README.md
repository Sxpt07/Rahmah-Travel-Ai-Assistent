# 🕌 Umrah & Hajj AI Travel Assistant — Backend

Express.js backend for an AI-powered Umrah & Hajj travel assistant. It can:

1. **Index an agency website** (`/api/index-url`) — scrapes packages, facilities, prices, and FAQs into clean AI context.
2. **Chat** (`/api/chat`) — intent-aware replies: sapaan/obrolan/keluhan/FAQ dijawab Gemini `gemini-2.0-flash`, sedangkan pencarian jamaah dijalankan lokal dari data SGO.
3. **Real-time SGO scraping** (`/api/jamaah/scrape-cookie`, `/api/jamaah/fetch-env`) — HTTP request langsung ke `https://sgo.rahmahgrup.id` memakai `SGO_ADMIN_SESSION`, untuk satu modul atau seluruh 16 modul.
4. **Raw response persistence** — HTML asli dari lima modul operasional disimpan ke `sgo_raw/` dan bisa dicek metadatanya lewat `GET /api/sgo/responses`.
5. **No mock data** — bila belum ada hasil scrape atau SGO gagal diakses, response berisi `count: 0` dan daftar kosong. `/api/seats` juga kosong sampai sumber seat real terhubung.

> **Location:** this backend lives in `umrah-ai-backend/` so it does not overwrite the existing Electron app in the parent folder.

---

## 📁 Project structure

```
umrah-ai-backend/
├── .env                  # Local configuration (do not commit)
├── .env.example          # Configuration template
├── .gitignore
├── package.json          # ESM, start/dev scripts
├── server.js             # Express app + API endpoints
├── README.md
├── data/
│   ├── jamaahStore.js    # Store real SGO + findJamaah() + scoring
│   └── sgoRawStore.js    # Persistensi HTML asli 5 modul SGO
├── sgo_raw/              # Generated: respons mentah SGO (PII, ignored)
└── services/
    ├── scraper.js        # scrapeWebContext(url)
    ├── sgoScraper.js     # Cookie SGO, fetch 16 modul, parser, formatter
    └── aiEngine.js       # Gemini + local jamaah search
```

---

## 🚀 Quick start

### 1. Install dependencies

```powershell
cd umrah-ai-backend
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env`, lalu isi API key Gemini dan cookie SGO Admin:

```env
PORT=3000
AI_PROVIDER=gemini
GEMINI_API_KEY=your_real_key
GEMINI_MODEL=gemini-3.6-flash
GEMINI_FALLBACK_MODEL=gemini-3.8-flash,gemini-flash-latest
SGO_BASE_URL=https://sgo.rahmahgrup.id
SGO_ADMIN_SESSION=your_sgo_admin_session
SGO_PAGINATION_DELAY_MS=500
SGO_PAGINATION_MAX_PAGES=100
SGO_RAW_DIR=sgo_raw
```

> `gemini-2.0-flash` sudah dihentikan Google (404). Model utama dibaca dari
> `GEMINI_MODEL`; bila model itu 404/503/quota, `aiEngine.js` otomatis mencoba
> daftar `GEMINI_FALLBACK_MODEL` (dipisah koma) sebelum memakai fallback lokal.
> Pesan sapaan, obrolan, keluhan, dan FAQ dikirim ke Gemini lebih dulu; server
> tetap ramah bila seluruh model sedang tidak tersedia. Pencarian data jamaah
> selalu lokal.
> Pencarian nama memakai kecocokan **kata utuh** (semua kata kunci wajib ada),
> sehingga `juhandi` tidak akan cocok ke `Andi Fitria`. Semua pencarian bersifat
> case-insensitive dan mendukung NIK/paspor, order ID full/parsial (mis.
> `3693`, `ORD-2026-UMR-0053`), serta nomor RTB.

### 3. Start the server

```powershell
npm run dev     # nodemon, auto-restart
# or
npm start       # plain node
```

You should see:

```
🕌 Umrah & Hajj AI Assistant
   Server   : http://localhost:3000
   AI       : gemini [READY] -> gemini-3.6-flash
   Models   : gemini-3.6-flash | gemini-3.8-flash | gemini-flash-latest
   SGO Cookie: SET (.env)
```

### 4. Ambil data jamaah dari SGO Admin

Di UI, pilih **Semua Modul (Unified Full Scrape)** lalu klik **Mulai Unified
Auto-Scrape**, atau pilih satu modul untuk scrape fokus. Isi **Base URL** dan
**Cookie** bila ingin menimpanya; biarkan **kosong** agar otomatis memakai
`SGO_BASE_URL` / `SGO_ADMIN_SESSION` dari `.env`.

16 modul SGO yang didukung:

| Modul | Endpoint | Sumber data jamaah |
| --- | --- | --- |
| Monitoring Jamaah | `/ops/monitoring-jamaah` | ✅ ya |
| Invoice Manual | `/ops/invoice-manual` | — |
| B2B Rahmah | `/ops/b2b-rahmah` | — |
| Penagihan & Aging | `/ops/penagihan-aging` | — |
| Add On Perbatch | `/ops/add-on?tab=perbatch` | — |
| Rahmah Miles | `/ops/rahmah-miles` | — |
| Nusuk Mutamer | `/ops/nusuk-mutamer` | — |
| Upload Documents | `/ops/upload-documents` | — |
| Approval Dokumen | `/ops/approval-dokumen` | — |
| Itinerary | `/ops/itinerary` | — |
| Bus Addon / Visa | `/ops/bus-addon/visa` | — |
| Hotel | `/ops/hotel` | — |
| Travel Dokumen Detail | `/ops/travel-dokumen-detail` | — |
| Travel Docs | `/ops/travel-docs` | — |
| Satgas Bandara | `/ops/satgas-bandara` | — |
| Stock Perlengkapan | `/ops/stock-perlengkapan` | — |

Modul di luar daftar tersebut ditolak `400` (`SGO_MODULE`). Pilihan **Semua
Modul** menjalankan unified scrape seluruh endpoint; pilihan fokus disimpan
di `localStorage` (`umrah_active_focus_v2`). Hanya Monitoring Jamaah yang
mengisi `jamaahStore`; modul lain menampilkan ringkasan halamannya.

> Upload file dan paste data **dinonaktifkan** (`410`). Satu-satunya jalur
> ingest jamaah adalah scrape real-time SGO. Hasil scrape Monitoring Jamaah
> yang valid otomatis disimpan ke **`jamaah_data.json`** di root backend (bisa
> diubah lewat `JAMAAH_DATA_FILE`) dan dimuat kembali saat server restart.
> Hasil scrape kosong **tidak** mengosongkan data real lama; response scrape
> tetap jujur berisi `count: 0`, sedangkan reset manual hanya lewat
> `POST /api/jamaah/clear`. File berisi data pribadi jamaah, sudah masuk
> `.gitignore`, dan jangan di-commit. Jika store kosong, terminal menampilkan
> peringatan agar Monitoring Jamaah di-scrape ulang.
>
> Scraper Monitoring Jamaah mengambil **semua halaman**: halaman 1 memakai URL
> asli, halaman 2 dan seterusnya memakai `?page=N` dengan jeda default 500 ms.
> Loop berhenti otomatis saat halaman kosong, HTML/baris berulang (server
> mengabaikan parameter `page`), terjadi error, atau batas
> `SGO_PAGINATION_MAX_PAGES` tercapai. Semua baris digabung dan di-dedupe,
> lalu disimpan **sekali** ke `jamaah_data.json`, sehingga pencarian membaca
> total data dari seluruh halaman.
>
> Setiap scrape Monitoring Jamaah juga mengambil NIK/paspor dari halaman
> manifest per jamaah. Ringkasan `fieldCoverage` (`nik`, `passport`,
> `manifestId`) dikembalikan di response dan ditampilkan di banner startup.
> Respons HTML asli untuk `/ops/monitoring-jamaah`, `/ops/upload-documents`,
> `/ops/travel-docs`, `/ops/stock-perlengkapan`, dan `/ops/hotel` disimpan di
> `sgo_raw/` (bisa diubah lewat `SGO_RAW_DIR`). Folder ini juga berisi PII dan
> sudah masuk `.gitignore`.
>
> File `nodemon.json` mengabaikan `jamaah_data*.json`, `sgo_raw/`, dan `*.tmp`,
> sehingga penulisan data tidak memicu restart di tengah request.

Endpoint yang tersedia:

- `POST /api/jamaah/scrape-cookie` — scrape modul terpilih, atau seluruh 16
  modul secara paralel bila `focusModule` kosong.
- `POST /api/jamaah/fetch-env` — fetch cepat modul tertentu memakai cookie `.env`.
- `GET /api/jamaah/status` — jumlah & sumber data aktif.
- `GET /api/jamaah` — seluruh data jamaah aktif beserta `jamaahList`.
- `POST /api/jamaah/clear` — hapus data aktif sekaligus file `jamaah_data.json`.
- `GET /api/sgo/modules` — daftar 16 modul beserta label dan `jamaahSource`.
- `GET /api/sgo/responses` — metadata respons mentah SGO per modul (tanpa HTML/PII).
- `POST /api/chat` - klasifikasi intent: sapaan/obrolan/keluhan/FAQ ke Gemini, pencarian jamaah lokal case-insensitive (nama / NIK / paspor / kode order full-parsial / RTB), hasil kosong dijawab ramah.

Restart the server after changing `.env`.

> On Windows PowerShell, use `curl.exe` (not `curl`, which aliases `Invoke-WebRequest`). In bash/macOS/Linux the examples work as-is.

---

## 🔌 API reference

### `GET /api/health`

```powershell
curl.exe http://localhost:3000/api/health
```

Returns server status, active provider/model, uptime, and the currently indexed context.

---

### `POST /api/index-url`

Scrapes a public agency page and stores it as the active AI context.

**Body**

```json
{ "url": "https://www.example-travel.com/paket-umrah" }
```

**cURL**

```powershell
curl.exe -X POST http://localhost:3000/api/index-url `
  -H "Content-Type: application/json" `
  -d "{\"url\":\"https://www.example-travel.com/paket-umrah\"}"
```

**Success response**

```json
{
  "success": true,
  "message": "Website berhasil diindeks sebagai AI context.",
  "context": {
    "url": "https://www.example-travel.com/paket-umrah",
    "characters": 8421,
    "indexedAt": "2026-10-24T10:00:00.000Z",
    "preview": "# WEBSITE CONTEXT\nSource URL: ..."
  }
}
```

**Error responses**

| Status | Cause |
| --- | --- |
| `400` | Missing/invalid `url` |
| `502` | Site unreachable, timeout, non-HTML, blocked, or too little readable text |

---

### `POST /api/chat`

Endpoint chat mengklasifikasikan pesan menjadi beberapa intent:

- `greeting`, `smalltalk`, `complaint`, `faq`, `general` → dijawab oleh Gemini
  (`GEMINI_MODEL`, lalu `GEMINI_FALLBACK_MODEL`) terlebih dahulu secara ramah
  dan natural, lalu fallback lokal bila semua model sedang tidak tersedia.
- `data-list`, `data-count`, `data-filter`, `data-lookup` → pencarian langsung
  ke data jamaah SGO. Nama dicocokkan per **kata utuh** dan case-insensitive;
  NIK/paspor, order ID full/parsial, dan RTB juga didukung. Query berupa angka
  dicari ke order, NIK/paspor, dan RTB sekaligus.
- `data-help` → panduan format pencarian.

Pesan obrolan/keluhan/FAQ **tidak** memicu pencarian jamaah. `data-lookup`
hanya dipilih jika ada ID/kode eksplisit, kata kunci pencarian (`cari`, `nama`,
`jamaah`, `status`, dll.), nama 2+ kata, atau nama tunggal yang benar-benar ada
di store. Sisa kata dari kalimat umum seperti `saya mau berangkat` atau
`ada apa aja` tidak lagi dianggap nama jamaah.

Jika pencarian data kosong, server meminta Gemini menjawab dengan konteks
"hasil 0" agar tetap ramah. Bila Gemini tidak tersedia, dipakai fallback lokal
yang ramah — bukan lagi pesan kaku `Data jamaah ... tidak ditemukan.`

**Body**

```json
{
  "message": "DARMA MADHIA SAPUTRA"
}
```

**cURL**

```powershell
curl.exe -X POST http://localhost:3000/api/chat `
  -H "Content-Type: application/json" `
  -d "{\"message\":\"DARMA MADHIA SAPUTRA\"}"
```

**Response**

```json
{
  "success": true,
  "reply": "📌 **Data Jamaah Ditemukan:**\n- **Nama Lengkap:** DARMA MADHIA SAPUTRA\n- **Kode Order / No. Pendaftaran:** ORD-2026-UMR-005304\n- **Kode RTB:** RTB 297\n- **Paket:** Umroh 2x Jumat + Thoif 12D By IndiGo\n- **Status Pembayaran / Progress:** BELUM LUNAS",
  "response": "📌 **Data Jamaah Ditemukan:** ...",
  "message": "📌 **Data Jamaah Ditemukan:** ...",
  "intent": "data-lookup",
  "source": "jamaah-data",
  "provider": "sgo",
  "model": null,
  "usedJamaahLookup": true,
  "matchedCount": 1,
  "latencyMs": 4
}
```

Nilai `source` yang mungkin: `jamaah-data`, `gemini`, `local-fallback`,
`local`, atau `error`. Field `intent`, `source`, `usedJamaahLookup`,
`matchedCount`, dan `latencyMs` dipakai UI untuk menampilkan badge jawaban.

---

### `POST /api/jamaah/scrape-cookie`

Scrape satu modul SGO fokus, atau seluruh 16 modul sekaligus bila
`focusModule` kosong.

**Body**

```json
{
  "url": "",
  "cookie": "",
  "focusModule": "/ops/monitoring-jamaah"
}
```

- `url` / `cookie` kosong → otomatis memakai `SGO_BASE_URL` dan
  `SGO_ADMIN_SESSION` dari `.env`.
- `focusModule` kosong → seluruh 16 modul (`SGO_MODULES`).
- `focusModule` harus salah satu dari 16 endpoint resmi. Nilai lain (mis.
  `/ops/tidak-ada`) ditolak `400` dengan kode `SGO_MODULE` dan daftar
  `supportedModules`.
- Variasi underscore (`/ops/monitoring_jamaah`) dinormalisasi ke endpoint
  resmi ber-hyphen. Query string seperti `/ops/add-on?tab=perbatch`
  dipertahankan.
- Header setiap request: `Cookie: sgo_admin_session=...` +
  `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
  beserta header browser pendukung (`Accept`, `Accept-Language`, `Sec-Fetch-*`).
- Timeout request halaman SGO default **20000 ms** (`SGO_REQUEST_TIMEOUT_MS`,
  dibatasi 5–60 detik).
- Pagination hanya untuk modul sumber jamaah. Halaman 2+ memakai parameter
  `SGO_PAGE_PARAM` (default `page`) dan diberi jeda
  `SGO_PAGINATION_DELAY_MS` (default `500`). Batas halaman
  `SGO_PAGINATION_MAX_PAGES` (default `100`). Response menyertakan objek
  `pagination` berisi `pagesFetched`, `rows`, dan `stopReason`
  (`empty-page`, `duplicate-page`, `no-new-rows`, `auth-error`, dst.).
- Jika cookie dari UI gagal, server otomatis retry sekali memakai
  `SGO_ADMIN_SESSION` dari `.env` dan menandai `usedEnvCookie: true`.

**Success response — Monitoring Jamaah (ringkas)**

```json
{
  "success": true,
  "fallback": false,
  "empty": false,
  "count": 400,
  "storedJamaahCount": 400,
  "focusModule": "/ops/monitoring-jamaah",
  "modules": ["/ops/monitoring-jamaah"],
  "modulesFailed": [],
  "totalModules": 1,
  "pagination": {
    "enabled": true,
    "pagesFetched": 1,
    "pagesWithRows": 1,
    "rows": 400,
    "stopReason": "duplicate-page"
  },
  "rawResponse": {
    "modulePath": "/ops/monitoring-jamaah",
    "lastAttempt": { "ok": true, "status": 200 },
    "response": { "status": 200, "rows": 400, "htmlLength": 123456 }
  },
  "jamaahList": [
    {
      "nama": "DARMA MADHIA SAPUTRA",
      "orderId": "ORD-2026-UMR-005304",
      "shortCode": "5304",
      "rtb": "RTB 297",
      "paket": "Umroh 2x Jumat + Thoif 12D By IndiGo",
      "dokumen": "0/6",
      "statusDokumen": "BELUM LENGKAP",
      "statusPembayaran": "BELUM LUNAS"
    }
  ],
  "sample": ["..."]
}
```

**Success response — modul operasional**

Selain `/ops/monitoring-jamaah`, 15 modul lain tidak memiliki tabel jamaah.
Halaman yang berhasil dimuat dikembalikan sebagai:

```json
{
  "success": true,
  "fallback": false,
  "moduleLoaded": true,
  "jamaahSource": false,
  "focusModule": "/ops/hotel",
  "moduleSummary": {
    "modulePath": "/ops/hotel",
    "title": "Hotel — SGO Admin",
    "heading": "Hotel",
    "stats": [],
    "preview": "..."
  },
  "count": 400,
  "storedJamaahCount": 400,
  "jamaahList": [],
  "rawResponse": {
    "modulePath": "/ops/hotel",
    "lastAttempt": { "ok": true, "status": 200 },
    "response": { "status": 200, "rows": 0, "htmlLength": 54321 }
  }
}
```

Data jamaah lama **tidak dihapus dan tidak ditimpa** oleh modul non-jamaah
(`merge: true`). `count` tetap jumlah data Monitoring Jamaah yang aktif,
sehingga pencarian AI tetap berfungsi. Jalankan **Monitoring Jamaah** untuk
mengisi atau memperbarui data jamaah.

Jika SGO berhasil diakses tetapi modul tidak berisi baris jamaah, response
tetap `success: true` dengan `empty: true`, `count: 0`, dan `jamaahList: []`.
Jika koneksi/auth gagal, response berisi `success: false`, `count: 0`,
`jamaahList: []`, serta `401`/`502` dan `detail` penyebabnya. **Tidak ada
fallback ke data lokal sebagai pengganti hasil scrape.**

### `GET /api/sgo/responses`

Menampilkan metadata respons mentah SGO yang tersimpan untuk lima modul:
`/ops/monitoring-jamaah`, `/ops/upload-documents`, `/ops/travel-docs`,
`/ops/stock-perlengkapan`, dan `/ops/hotel`.

```json
{
  "success": true,
  "total": 5,
  "withResponse": 2,
  "modules": [
    {
      "modulePath": "/ops/hotel",
      "label": "Hotel",
      "updatedAt": "2026-10-26T10:00:00.000Z",
      "lastAttempt": { "ok": true, "status": 200, "error": "" },
      "response": {
        "status": 200,
        "contentType": "text/html; charset=utf-8",
        "htmlLength": 54321,
        "rows": 0,
        "summary": { "title": "Hotel — SGO Admin", "heading": "Hotel" }
      }
    }
  ]
}
```

HTML mentah **tidak** dikirim ke endpoint ini karena berisi PII. File aslinya
ada di `sgo_raw/` dan hanya untuk diagnostik lokal.

---

### `GET /api/seats`

Tidak ada sumber seat real yang terhubung. Endpoint ini sengaja
mengembalikan daftar kosong; tidak ada angka seat fiktif.

```powershell
curl.exe http://localhost:3000/api/seats
```

```json
{
  "success": true,
  "available": false,
  "source": null,
  "count": 0,
  "message": "Belum ada integrasi sumber data seat real. Data seat tidak ditampilkan agar tidak menampilkan angka fiktif.",
  "seats": []
}
```

---

## 🧪 Suggested Postman / manual test flow

1. `GET /api/health` → server is up.
2. `GET /api/jamaah/status` → `count: 0` bila belum ada scrape; tidak ada data contoh.
3. `GET /api/seats` → `seats: []` dan `available: false`; tidak ada angka seat fiktif.
4. `POST /api/jamaah/fetch-env` dengan `{"modulePath":"/ops/monitoring-jamaah"}` → scrape real SGO.
5. `GET /api/sgo/responses` → cek metadata respons mentah yang tersimpan.
6. `POST /api/chat` dengan nama/NIK/paspor/order/RTB dari hasil scrape → detail jamaah real.
7. Hapus cookie / gunakan cookie salah → response scrape `count: 0`, `jamaahList: []`, dan error jelas.

### Seat data

Belum ada integrasi seat real. Pesan tentang seat tidak boleh menghasilkan
angka fiktif/hardcoded; endpoint `/api/seats` mengembalikan kosong dan UI
menampilkan status "sumber data seat real belum terhubung". Jika nanti ada
API booking/POS real, sambungkan ke endpoint tersebut dan tampilkan hanya
angka yang benar-benar diterima.

---

## 🛡️ Error handling & fallback behaviour

| Scenario | Behaviour |
| --- | --- |
| URL SGO tidak valid / kosong | `400` dengan pesan jelas |
| Cookie SGO tidak ada | `400`; set `SGO_ADMIN_SESSION` atau isi di UI |
| Cookie dari UI kedaluwarsa | Retry otomatis sekali dengan cookie `.env`; sukses → `usedEnvCookie: true` + `warning` |
| Cookie `.env` juga kedaluwarsa | `401` + `count: 0` + `jamaahList: []`; tidak ada data pengganti |
| `SGO_ADMIN_SESSION` kosong | Log error jelas di terminal; `400` bila cookie UI juga kosong |
| Modul di luar 16 endpoint resmi | `400` + kode `SGO_MODULE` + `supportedModules`; tidak ada fallback |
| Modul non-jamaah berhasil dimuat | `success: true` + `moduleLoaded: true`; data jamaah lama dipertahankan dan ditandai `storedJamaahCount` |
| Modul error HTTP / timeout | Dicatat di `errors`; modul lain tetap diproses |
| Modul terbuka tetapi 0 baris jamaah | `success: true` + `empty: true` + `count: 0`; daftar kosong |
| Semua modul gagal / tidak terhubung | `401`/`502` + `count: 0` + `jamaahList: []`; tanpa fallback lokal |
| Upload/paste data | `410`; hanya scrape SGO yang diizinkan |
| `jamaah_data.json` korup / tidak valid | File diabaikan, store tetap kosong, error dicatat; scrape ulang |
| Gagal menulis `jamaah_data.json` | Scrape tetap sukses, data tetap di memori, error izin tulis dicatat |
| Gagal menulis `sgo_raw/*.json` | Scrape tetap sukses; warning dicatat, respons mentah tidak tersimpan |
| File tidak bisa dihapus saat clear | Ditulis tombstone `jamaah: []` agar data lama tidak dimuat ulang |
| Gemini quota / API error | Pesan ramah, server tetap hidup |
| Invalid JSON body | `400 Invalid JSON body` |
| Unknown route | `404` JSON response |
| Port already in use | Clear startup error and exit |

Semua error SGO dicatat di terminal dengan modul, kode, dan statusnya.

---

## 🧠 How it works

```
POST /api/jamaah/scrape-cookie | /api/jamaah/fetch-env
  └─ sgoScraper.js
       dotenv/config → SGO_ADMIN_SESSION + SGO_BASE_URL
       fetch paralel 16 modul (atau 1 modul fokus) dengan header:
         Cookie: `sgo_admin_session=...`
         User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
       jika cookie UI gagal / 0 baris → retry SEKALI dengan cookie `.env`
       resolveSgoModule(): hanya 16 endpoint resmi; lainnya `400 SGO_MODULE`
       extractSgoOrders(): pasangan baris order + baris jamaah
       → hanya baris ber-kode order yang disimpan (400 jamaah bersih)
       → setiap jamaah menyimpan manifestId dari `data-mj-open`
       → enrichJamaahWithManifest(): buka /ops/monitoring-jamaah/{id}/edit?embed=1
           no_identitas → NIK (hanya jika identity_type=nik; kitas/kitap tidak)
           no_paspor → paspor; juga no_hp, tempat/tanggal lahir, kota/expired paspor
           concurrency 8, timeout 20 dtk, retry 1x, cache 5 menit
           manifestFetched=true; NIK/paspor lama hanya dipertahankan bila fetch gagal
       → Monitoring Jamaah: setJamaahData() → response `jamaahList`
       → setJamaahData() menulis atomik ke jamaah_data.json + fieldCoverage
       → modul operasional: `moduleLoaded` + `moduleSummary`, data lama tetap
       → lima modul terpilih: saveSgoRawResponse() → sgo_raw/*.json (HTML asli)
       → jika kosong: Puppeteer hanya untuk 1 modul fokus (bukan data pengganti)
       → jika tetap kosong: `success: true`, `empty: true`, `count: 0`
       → jika koneksi/auth gagal: `success: false`, `count: 0`, tanpa fallback lokal
       → restart server: loadJamaahDataFromDisk() memulihkan data + source + coverage
       → setJamaahData() → formatJamaahList() → response `jamaahList`

POST /api/chat
  └─ aiEngine.js:
       1. classifyIntent()
            greeting / smalltalk / complaint / faq / general
              → Gemini (GEMINI_MODEL lalu fallback) lebih dulu, fallback lokal bila gagal
              → tidak pernah memanggil pencarian jamaah / mengubah store
            data-list / data-count / data-filter / data-lookup
              → hanya jika ada cue pencarian, ID/kode eksplisit, atau nama valid
              → pencarian lokal langsung (tanpa Gemini)
            data-help → panduan format pencarian
       2. Pencarian lokal dari data hasil scrape (memori + jamaah_data.json)
            nama: case-insensitive, exact/whole-word lalu substring
                  (mis. "Nasmi" cocok ke NASMIATI, "Muh" ke MUHAMMAD)
            NIK / paspor: exact atau substring (NIK min. 4 digit; paspor huruf+angka)
            order: full/parsial (mis. 005309, 5309, ORD-2026-UMR-005309)
            RTB: nomor terakhir (RTB-2026-00307 -> 307)
            query angka: union order + NIK/paspor + RTB
            query berlabel paspor/NIK tidak memakai digitnya untuk RTB/order
            daftar / jumlah / filter status, paket, hotel, kota
            store kosong saat dipanggil -> coba lazy-load dari jamaah_data.json
          jika ketemu → detail nama, kode order, RTB, paket, status pembayaran,
                       NIK, paspor, status dokumen, keberangkatan, hotel, no. HP
          jika tidak → Gemini diberi konteks hasil 0, lalu jawaban ramah
                         (fallback lokal ramah bila Gemini tidak tersedia)
          setJamaahData([]) tidak mengosongkan store; clear hanya via API clear
       3. Gemini
            model utama: GEMINI_MODEL (default gemini-3.6-flash)
            fallback: GEMINI_FALLBACK_MODEL (dipisah koma, dicoba berurutan)
            timeout default 6 dtk, dibatasi maksimal 10 dtk
       4. error 404 model / 503 overload / 429 quota / timeout
            → coba model berikutnya; bila semua gagal, fallback ramah
            (server tetap hidup, pencarian jamaah tetap berfungsi)
       5. response memuat intent, source, usedJamaahLookup, matchedCount,
          model, dan latencyMs untuk badge di UI
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `AI_PROVIDER` | `gemini` | Gemini only |
| `GEMINI_API_KEY` | — | Google AI Studio key |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model Gemini utama (dibaca dari `.env`) |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.8-flash,gemini-flash-latest` | Daftar model cadangan, dipisah koma |
| `GEMINI_TIMEOUT_MS` | `6000` | Timeout request Gemini (dibatasi 1–`10000` ms) |
| `SGO_BASE_URL` | — | Base URL SGO Admin |
| `SGO_ADMIN_SESSION` | — | Cookie sesi admin SGO |
| `JAMAAH_DATA_FILE` | `jamaah_data.json` (root backend) | Lokasi file penyimpanan permanen hasil scrape |
| `SGO_REQUEST_TIMEOUT_MS` | `20000` | Timeout fetch per modul SGO (5–60 detik) |
| `SGO_PAGINATION_ENABLED` | `true` | Pagination modul Monitoring Jamaah |
| `SGO_PAGINATION_DELAY_MS` | `500` | Jeda antar-fetch halaman (0–10000 ms) |
| `SGO_PAGINATION_MAX_PAGES` | `100` | Batas maksimum halaman yang diprobe (1–500) |
| `SGO_PAGE_PARAM` | `page` | Nama parameter query halaman SGO |
| `SGO_RAW_DIR` | `sgo_raw` (root backend) | Folder respons mentah 5 modul SGO (PII, ignored) |
| `SGO_MANIFEST_CONCURRENCY` | `8` | Jumlah manifest jamaah yang di-fetch paralel (1–20) |
| `SGO_MANIFEST_TIMEOUT_MS` | `20000` | Timeout per halaman manifest (5–60 detik) |
| `SGO_MANIFEST_CACHE_MS` | `300000` | Cache in-memory NIK/paspor per manifest (5 menit) |
| `SCRAPER_MAX_CHARS` | `30000` | Context size cap |
| `SCRAPER_TIMEOUT_MS` | `20000` | Website fetch timeout |

---

## 🔧 Menghubungkan sumber seat real

Saat ini tidak ada database/API seat. `data/mockSeats.js` sudah dihapus dan
`GET /api/seats` selalu mengembalikan `seats: []` dengan `available: false`.
Jangan menambahkan angka seat hardcoded.

Jika nanti tersedia API booking/POS real, sambungkan di route `/api/seats`
(atau service baru) dan kembalikan shape yang sama:

```json
{
  "id": "pkg-real-01",
  "name": "Nama paket dari API",
  "departure": "2026-12-15",
  "totalSeat": 45,
  "remainingSeat": 4,
  "price": "Rp 28.500.000"
}
```

Hanya kirim field yang benar-benar diterima dari sumber real. Bila API gagal,
kembalikan `seats: []` dan pesan error; jangan mengisi dengan data contoh.

---

## ⚠️ Production notes

- Hasil scrape jamaah disimpan permanen di `jamaah_data.json` dan dipulihkan saat restart. Web context lain masih **in-memory**; untuk multi-instance gunakan Redis/Postgres.
- Respons mentah lima modul SGO disimpan di `sgo_raw/` dan dimuat ulang saat dibutuhkan. Folder ini **wajib di-ignore** dan dibatasi aksesnya.
- Scrape penuh Monitoring Jamaah menambah satu request manifest per jamaah (±400 request). Atur `SGO_MANIFEST_CONCURRENCY`, `SGO_MANIFEST_TIMEOUT_MS`, dan `SGO_MANIFEST_CACHE_MS` bila server SGO membatasi trafik.
- Pagination Monitoring Jamaah menambah request halaman berurutan (`?page=2`, `?page=3`, dst.). Atur `SGO_PAGINATION_DELAY_MS` (default 500 ms) dan `SGO_PAGINATION_MAX_PAGES` bila server SGO membatasi trafik atau jumlah halaman bertambah.
- `jamaah_data.json` dan `sgo_raw/*.json` berisi data pribadi jamaah. Jangan di-commit, batasi akses folder, dan terapkan retensi/penghapusan sesuai kebijakan privasi.
- Add authentication/rate limiting before exposing publicly; CORS is currently open.
- Scraping must respect each website's Terms of Service and `robots.txt`.
- For JavaScript-heavy pages, replace the Cheerio fetch with a headless browser (Playwright/Puppeteer).
- Never commit `.env`; only `.env.example` belongs in version control.

---

## 📜 Scripts

```powershell
npm run dev     # nodemon server.js
npm start       # node server.js
```
