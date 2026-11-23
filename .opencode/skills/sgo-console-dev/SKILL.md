# SGO Console Dev

Aturan baku pengembangan proyek Executive AI Console Rahmah Travel.

## 1. Ruang lingkup baca
- Baca hanya file yang terkait tugas.
- Gunakan pencarian terarah; jangan scan seluruh repository jika tidak perlu.
- Periksa kontrak data di route/service yang relevan sebelum mengubah UI.

## 2. Modularitas
- Pisahkan logika ke file kecil sesuai tanggung jawab:
  - UI/komponen: `public/js/*.js`, `public/css/*.css`
  - storage/state: `public/js/*-cookie.js`, `public/js/*-store.js`
  - parser/validator: `services/*.js`
  - service/API: `routes/*.js`, `services/*.js`
- Jangan menumpuk DOM, penyimpanan, parsing, dan request dalam satu file.
- Contoh pemisahan cookie SGO: `services/sgoCookie.js`, `services/sgoRequestContext.js`, `public/js/sgo-cookie.js`.

## 3. Gaya kode
- Dilarang menulis komentar inline di dalam kode.
- Gunakan nama fungsi dan variabel yang menjelaskan maksud.
- Pertahankan pola error response `{ success: false, error, code }`.

## 4. Isolasi Cookie SGO
- Cookie SGO adalah milik perangkat/browser, bukan milik server global.
- Nilai mentah disimpan sebagai cookie HttpOnly origin konsol yang diset server; localStorage hanya menyimpan metadata status non-sensitif.
- Server membaca cookie perangkat pada setiap request dan meneruskannya ke service SGO. Jangan memakai satu token global untuk semua laptop.
- Fallback `.env` hanya untuk proses eksplisit seperti login portal, bukan untuk modul konsol.
- Jangan hardcode cookie di source code, URL, log, atau response API.
- Jangan saling menimpa cookie antar perangkat.
- Setiap request modul SGO wajib memakai cookie aktif perangkat.
- Header menampilkan status aktif, kosong, atau kedaluwarsa.
- Modal header menyediakan tempel, simpan, tes, dan reset cookie perangkat.

## 5. Format pesan WhatsApp/FU
- Pertahankan spasi baris kosong sebagai `\n\n`.
- Jangan memakai `.replace(/\s+/g, ' ')` pada isi pesan.
- Jangan mengubah `\n\n` menjadi `\n`, spasi, atau escape `\\n`.
- Baris rincian FU memakai satu newline; antar-blok memakai dua newline.
- Uji hasil salin dan payload WhatsApp dengan string persis.

## 6. Penutup tugas
- Berikan ringkasan file yang diubah.
- Berikan cara tes singkat dan hasil yang diharapkan.
