  import dotenv from 'dotenv';
dotenv.config();

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  findJamaah,
  getAllJamaah,
  getJamaahSource,
  hasJamaahNameMatch,
  hasJamaahPackageMatch,
  hasJamaahPassportMatch,
  hasJamaahRtbMatch,
  hasRealJamaahData,
  warnIfJamaahStoreEmpty,
} from '../data/jamaahStore.js';

const apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'gemini')
  .trim()
  .toLowerCase() || 'gemini';

/**
 * Model Gemini dibaca dari .env. `gemini-2.0-flash` sudah dihentikan Google,
 * sehingga default diganti ke model Flash yang tersedia. Pencarian jamaah tetap
 * dilakukan lokal tanpa memanggil Gemini.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_MODEL =
  String(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim() ||
  DEFAULT_GEMINI_MODEL;

// Fallback dipakai otomatis bila model utama 404/503/quota. Bisa berisi lebih
// dari satu model dengan pemisah koma.
const GEMINI_FALLBACK_MODELS = String(
  process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash,gemini-flash-latest',
)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const GEMINI_MODEL_CANDIDATES = [
  ...new Set([GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]),
];
let activeGeminiModel = GEMINI_MODEL;

function envPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

// Timeout Gemini dibatasi 1-10 detik agar nilai .env yang tidak valid tidak
// menghasilkan setTimeout(NaN) atau menggantung terlalu lama.
const REQUEST_TIMEOUT_MS = Math.min(
  Math.max(envPositiveInt('GEMINI_TIMEOUT_MS', 6000), 1000),
  10000,
);
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const AI_ENABLED = Boolean(genAI) && AI_PROVIDER === 'gemini';
const LIST_LIMIT = 20;
let geminiDisabledUntil = 0;

function withTimeout(promise, ms, label = 'Gemini request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function orderOf(j = {}) {
  const full = j.orderId || j.kodeOrder || j.orderCode || '';
  const short = j.shortCode || j.orderShort || '';
  if (full && short && !String(full).includes(short)) return `${full} (${short})`;
  return full || short || '-';
}

function paymentOf(j = {}) {
  return j.statusPembayaran || j.pembayaran || j.status || '';
}

function nikOf(j = {}) {
  return j.nik || j.ktp || j.noKtp || '';
}

function passportOf(j = {}) {
  return j.passport || j.paspor || j.noPaspor || j.nomorPaspor || '';
}

function formatJamaahContext() {
  if (!hasRealJamaahData()) return 'Belum ada data jamaah hasil auto-scrape.';
  const src = getJamaahSource() || {};
  return `Sumber data: SGO Admin (auto-scrape). Total data: ${src.count || 0}.`;
}

function formatJamaahDetail(j = {}) {
  const lines = [
    '📌 **Data Jamaah Ditemukan:**',
    `- **Nama Lengkap:** ${j.nama || j.name || '-'}`,
    `- **Kode Order / No. Pendaftaran:** ${orderOf(j)}`,
    `- **Kode RTB:** ${j.rtb || j.noRtb || '-'}`,
    `- **Paket:** ${j.paket || '-'}`,
    `- **Status Pembayaran / Progress:** ${paymentOf(j) || '-'}`,
  ];

  if (j.statusDokumen || j.dokumen) {
    lines.push(`- **Status Dokumen:** ${j.statusDokumen || j.dokumen}`);
  }
  if (j.keberangkatan) lines.push(`- **Keberangkatan:** ${j.keberangkatan}`);
  if (j.hotel) lines.push(`- **Hotel:** ${j.hotel}`);

  const nik = nikOf(j);
  if (nik) lines.push(`- **NIK:** ${nik}`);

  const passport = passportOf(j);
  if (passport) lines.push(`- **Paspor:** ${passport}`);

  if (j.noHp || j.hp) lines.push(`- **No. HP:** ${j.noHp || j.hp}`);
  return lines.join('\n');
}

function formatJamaahResult(rows, { filterLabel = '' } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return 'Data tidak ditemukan.';
  if (list.length === 1) return formatJamaahDetail(list[0]);

  const lines = [
    `📌 Ditemukan ${list.length} jamaah${filterLabel ? ` (${filterLabel})` : ''}:`,
  ];
  list.slice(0, 10).forEach((j, index) => {
    lines.push(`${index + 1}. **${j.nama || '-'}**`);
    lines.push(`   - Kode Order: ${orderOf(j)}`);
    lines.push(`   - Kode RTB: ${j.rtb || j.noRtb || '-'}`);
    lines.push(`   - Paket: ${j.paket || '-'}`);
    lines.push(`   - Status Pembayaran: ${paymentOf(j) || '-'}`);
    const nik = nikOf(j);
    if (nik) lines.push(`   - NIK: ${nik}`);
    const passport = passportOf(j);
    if (passport) lines.push(`   - Paspor: ${passport}`);
    if (j.statusDokumen || j.dokumen) {
      lines.push(`   - Status Dokumen: ${j.statusDokumen || j.dokumen}`);
    }
  });
  if (list.length > 10) {
    lines.push(`…dan ${list.length - 10} jamaah lainnya. Persempit pencarian dengan nama lengkap atau kode order.`);
  }
  return lines.join('\n');
}

function formatJamaahListReply(rows, { filterLabel = '' } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return 'Belum ada data jamaah. Jalankan scrape modul Monitoring Jamaah terlebih dahulu.';
  }

  const source = hasRealJamaahData()
    ? 'SGO Admin (auto-scrape)'
    : 'belum ada data SGO';
  const lines = [
    `📋 **Daftar Jamaah — ${source}** (${list.length} data${
      filterLabel ? `, ${filterLabel}` : ''
    }):`,
  ];
  list.slice(0, LIST_LIMIT).forEach((j, index) => {
    lines.push(
      `${index + 1}. ${j.nama || '-'} • ${orderOf(j)} • ${j.rtb || j.noRtb || '-'} • ${
        j.paket || '-'
      } • ${paymentOf(j) || '-'}`,
    );
  });
  if (list.length > LIST_LIMIT) {
    lines.push(
      `…dan ${list.length - LIST_LIMIT} jamaah lainnya. Sebutkan nama, NIK, paspor, kode order, atau RTB untuk detail.`,
    );
  }
  return lines.join('\n');
}

function formatJamaahCountReply(rows, { filterLabel = '' } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const source = hasRealJamaahData()
    ? 'SGO Admin (auto-scrape)'
    : 'belum ada data SGO';
  return `📊 Total jamaah${filterLabel ? ` ${filterLabel}` : ''}: **${list.length} data** (sumber: ${source}).`;
}

const GREETING_PREFIXES = [
  /^assalamualaikum(?:\s+warahmatullahi?\s+wabarakatuh)?\b/,
  /^assalamu\s+alaikum(?:\s+warahmatullahi?\s+wabarakatuh)?\b/,
  /^assalam\b/,
  /^salam(?:\s+sejahtera)?\b/,
  /^selamat\s+(?:pagi|siang|sore|malam|datang)\b/,
  /^(?:halo|hallo|hello|hai|hi|hey)\b/,
  /^(?:pagi|siang|sore|malam)\b/,
  /^(?:pak|bapak|bu|ibu|mas|mbak|kak|min)\b/,
  /^p\b/,
];

const HONORIFIC_ONLY =
  /^(?:pak|bapak|bu|ibu|mas|mbak|kak|min|admin|bos|teman|semua)$/;

function stripGreetingPrefix(message = '') {
  let text = normalizeText(message);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of GREETING_PREFIXES) {
      const match = text.match(pattern);
      if (match && match[0]) {
        text = text.slice(match[0].length).replace(/^[\s,!.?-]+/, '').trim();
        changed = true;
        break;
      }
    }
  }
  return text;
}

function getGreetingReply(message = '') {
  if (/assalam|salam/i.test(message)) {
    return "Wa'alaikumussalam warahmatullahi wabarakatuh. 🌙\nSaya Asisten Umrah AI, siap membantu informasi umrah & haji serta pengecekan data jamaah SGO Admin. Ada yang bisa saya bantu?";
  }
  return 'Halo! 👋 Saya Asisten Umrah AI. Saya siap membantu informasi umrah & haji, serta mengecek data jamaah SGO Admin. Silakan sampaikan pertanyaan atau nama jamaah yang ingin dicek.';
}

function getSmallTalkReply(core = '', original = '') {
  if (!core) return getGreetingReply(original);

  if (/^(?:tes|test)(?:\s+koneksi)?$/.test(core)) {
    return 'Siap, koneksi chat berjalan normal. ✅ Silakan sampaikan pertanyaan seputar umrah/haji atau data jamaah yang ingin dicek.';
  }
  if (/^(?:apa kabar|bagaimana kabar(?:mu|anda)?|kabar baik)\b/.test(core)) {
    return 'Alhamdulillah baik, terima kasih. 😊 Semoga Anda juga dalam keadaan sehat. Ada yang bisa saya bantu seputar umrah/haji atau data jamaah?';
  }
  if (/^(?:terima kasih|makasih|thanks|thank you|syukron|jazakallah)\b/.test(core)) {
    return 'Sama-sama, senang bisa membantu. 🙏 Semoga urusan umrah/haji Anda dimudahkan. Jika ada yang ingin ditanyakan lagi, silakan.';
  }
  if (
    /^(?:kamu|anda)\s+(?:siapa|apa)\b/.test(core) ||
    /^siapa\s+(?:kamu|anda)\b/.test(core) ||
    /^nama\s+(?:kamu|anda)\b/.test(core)
  ) {
    return 'Saya Asisten Umrah AI. Tugas saya membantu informasi seputar umrah & haji dan mengecek data jamaah SGO Admin berdasarkan nama, NIK, paspor, kode order, atau RTB.';
  }
  if (
    /^(?:bisa|bisakah)\s+(?:bantu|membantu)\s+apa\b/.test(core) ||
    /^apa\s+(?:saja\s+)?yang\s+bisa\s+(?:kamu|anda)\s+(?:bantu|lakukan)\b/.test(core) ||
    /^(?:bantuan|help)\b/.test(core)
  ) {
    return 'Saya bisa membantu:\n- Informasi umum umrah & haji (syarat, rukun, dokumen, biaya, persiapan).\n- Cek data jamaah berdasarkan nama, NIK, paspor, kode order, atau RTB.\n- Menampilkan daftar dan status pembayaran jamaah.\nSilakan pilih salah satu.';
  }
  if (/^(?:bye|selamat tinggal|sampai jumpa|dadah)\b/.test(core)) {
    return 'Terima kasih, semoga safar dan ibadah Anda dimudahkan. Sampai jumpa! 👋';
  }
  if (/^(?:oke|ok|baik|siap|mantap|bagus|keren|alhamdulillah)$/.test(core)) {
    return 'Baik, siap. Silakan sampaikan pertanyaan seputar umrah/haji, atau sebutkan nama, NIK, paspor, kode order, atau RTB jamaah yang ingin dicek.';
  }
  if (/^(?:maaf|sorry)$/.test(core)) {
    return 'Tidak masalah. Silakan lanjutkan pertanyaannya, saya siap membantu.';
  }
  return null;
}

function isListIntent(message = '') {
  const text = normalizeText(message);
  if (!text || !/\b(?:jamaah|jamaahnya|peserta|pesertanya)\b/.test(text)) return false;
  if (/\b(?:nama|bernama|nik|ktp|paspor|passport|order|kode|rtb)\b/.test(text)) {
    return false;
  }
  if (
    text === 'jamaah' ||
    text === 'jamaahnya' ||
    text === 'para jamaah' ||
    text === 'peserta' ||
    text === 'pesertanya' ||
    text === 'para peserta'
  ) {
    return true;
  }
  if (
    !/\b(?:daftar|list|semua|seluruh|berapa|jumlah|total|banyak|tampilkan|lihat|data|siapa)\b/.test(
      text,
    )
  ) {
    return false;
  }

  const residual = text
    .replace(
      /\b(?:tolong|mohon|silakan|carikan|cari|tampilkan|lihat|berikan|beri|minta|daftar|list|data|semua|seluruh|berapa|jumlah|total|banyaknya|banyak|jamaah|jamaahnya|peserta|para|yang|ada|di|untuk|dari|saya|mau|ingin|siapa|saja)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return residual.length === 0;
}

function isCountIntent(message = '') {
  return /\b(?:berapa|jumlah|total|banyak)\b/.test(normalizeText(message));
}

const DATA_HINT = /\b(?:jamaah|jamaahnya|peserta|pesertanya)\b/;
const DEFINITIONAL =
  /^(?:apa|apakah|bagaimana|gimana|mengapa|kenapa|siapa|jelaskan|pengertian|arti|info|informasi|berapa|kapan|dimana|di mana)\b/;

function hasExplicitIdentityCue(message = '') {
  const text = normalizeText(message);
  return (
    /\b(?:nik|ktp|paspor|passport|pasport|order|kode|rtb|pendaftaran|booking|invoice)\b/.test(
      text,
    ) ||
    /\b(?:ord|umr)[-_ ]?\d{4}\b/.test(text) ||
    /\b[a-z]{1,2}\d{6,9}\b/.test(text) ||
    /\b\d{8,}\b/.test(text) ||
    /^\d{3,6}$/.test(text) ||
    /\b(?:cek|check|cari|carikan|temukan|lihat|tampilkan|order|kode)\b.*\b\d{3,6}\b/.test(
      text,
    )
  );
}

const NON_NAME_WORDS = new Set([
  'halo', 'hallo', 'hai', 'hi', 'hello', 'hey', 'assalamu', 'alaikum',
  'assalamualaikum', 'salam', 'selamat', 'pagi', 'siang', 'sore', 'malam',
  'apa', 'apakah', 'bagaimana', 'gimana', 'mengapa', 'kenapa', 'siapa',
  'kapan', 'dimana', 'mana', 'berapa', 'jelaskan', 'info', 'informasi',
  'syarat', 'rukun', 'kewajiban', 'prosedur', 'biaya', 'harga', 'tarif',
  'paket', 'program', 'umrah', 'umroh', 'haji', 'ihram', 'tawaf', 'thawaf',
  'sai', 'tahallul', 'makkah', 'mekkah', 'madinah', 'hotel', 'maskapai',
  'visa', 'paspor', 'passport', 'pasport', 'vaksin', 'kesehatan', 'doa',
  'manasik', 'persiapan', 'waktu', 'musim', 'anak', 'hamil', 'lansia',
  'mahram', 'muhrim', 'mahar', 'terima', 'kasih', 'makasih', 'thanks',
  'kamu', 'anda', 'saya', 'aku', 'bisa', 'bisakah', 'bantu', 'bantuan',
  'help', 'jamaah', 'peserta', 'nama', 'bernama', 'data', 'daftar', 'semua',
  'seluruh', 'jumlah', 'total', 'banyak', 'cari', 'carikan', 'temukan',
  'tampilkan', 'lihat', 'cek', 'check', 'status', 'lunas', 'belum', 'dp',
  'dokumen', 'berkas', 'lengkap', 'order', 'kode', 'nomor', 'rtb',
  'pendaftaran', 'booking', 'invoice', 'terdaftar', 'terdata', 'ada', 'itu',
  'ini', 'yang', 'dengan', 'untuk', 'dari', 'di', 'ke', 'dan', 'atau',
  'punya', 'milik', 'mau', 'ingin', 'tahu', 'tolong', 'mohon', 'silakan',
  'dong', 'ya', 'nih', 'kak', 'min', 'admin', 'bos', 'baru', 'lama', 'aktif',
  'nonaktif', 'kabar', 'baik', 'oke', 'ok', 'siap', 'mantap', 'bagus',
  'keren', 'alhamdulillah', 'maaf', 'sorry', 'bye', 'sampai', 'jumpa',
  'dadah', 'progres', 'progress', 'pembayaran', 'bayar', 'kategori', 'menu',
  'fitur', 'layanan', 'produk', 'jadwal', 'alamat', 'kontak', 'promo',
  'sistem', 'aplikasi', 'website', 'web', 'login', 'cookie', 'error', 'eror',
  'gagal', 'gabisa', 'gak', 'nggak', 'ngga', 'tidak', 'kok', 'knp',
  'bingung', 'masalah', 'kendala', 'stuck', 'lemot', 'lambat', 'rusak',
  'bug', 'tes', 'test', 'coba', 'scrape', 'scraper',
  'tanya', 'bertanya', 'nanya', 'tanyain', 'dibantu', 'membantu',
  'boleh', 'minta', 'soal', 'mengenai', 'perihal', 'tentang', 'seputar',
  'gitu', 'gini', 'kah', 'lah', 'sih', 'deh', 'kan', 'yah', 'adakah',
  'lagi', 'hari', 'hujan', 'panas', 'dingin', 'cerah', 'mendung', 'besok',
  'kemarin', 'sekarang', 'nanti', 'tadi', 'jam', 'menit', 'suka', 'makan',
  'minum', 'tidur', 'pergi', 'pulang', 'kerja', 'bekerja', 'sekolah',
  'kuliah', 'jalan', 'beli', 'jual', 'bikin', 'buat', 'ambil', 'kasih',
  'taruh', 'tinggal', 'datang', 'main', 'nonton', 'baca', 'tulis', 'dengar',
  'rasa', 'pikir', 'mulai', 'selesai', 'buka', 'tutup', 'kirim', 'pakai',
  'gunakan', 'butuh', 'perlu', 'makanan', 'minuman', 'koneksi', 'internet',
  'sinyal', 'jaringan', 'hp', 'telepon', 'komputer', 'laptop', 'halaman',
  'tombol', 'akun', 'password', 'sandi', 'email', 'kantor', 'rumah', 'uang',
  'diskon', 'jelek', 'enak', 'susah', 'sulit', 'mudah', 'senang', 'sedih',
  'capek', 'lelah', 'sibuk', 'kosong', 'penuh', 'benar', 'salah', 'sedang',
  'masih', 'sudah', 'pernah', 'harus', 'terjadi', 'cara', 'tutorial',
  'panduan', 'langkah', 'proses', 'saat', 'ketika', 'sembari', 'selagi',
]);

const NAME_NOISE =
  /\b(?:tolong|mohon|silakan|bisa|bisakah|apakah|apa|siapa|kapan|dimana|mengapa|kenapa|bagaimana|gimana|berapa|carikan|cari|temukan|tampilkan|lihat|cek|check|data|informasi|info|jamaah|jamaahnya|peserta|para|nama|bernama|atas|dengan|yang|itu|ini|ada|terdaftar|terdata|punya|milik|dari|untuk|saya|aku|mau|ingin|tahu|dong|ya|nih|kak|min|admin|bos|status|pembayaran|bayar|progres|progress|lunas|belum|dp)\b/g;

function extractNameQuery(message = '', { allowStopwordFilter = false } = {}) {
  const text = normalizeText(message)
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  let words = text.split(' ').filter((word) => word.length >= 2);
  if (allowStopwordFilter) {
    words = words.filter((word) => !NON_NAME_WORDS.has(word) && !/^\d+$/.test(word));
  }
  if (!words.length || words.length > 8) return '';
  if (words.some((word) => NON_NAME_WORDS.has(word) || /^\d+$/.test(word))) return '';
  return words.join(' ');
}

/**
 * Heuristik nama jamaah:
 * - satu kata hanya dianggap nama jika benar-benar cocok dengan data store;
 * - 2-6 kata tanpa stopword/angka dianggap kandidat nama.
 */
function isNameLikeQuery(value = '') {
  const raw = String(value || '').trim();
  if (!raw || /[?!]/.test(raw)) return false;

  const words = normalizeText(raw).split(' ').filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (words.some((word) => /^\d+$/.test(word))) return false;

  // Nama yang benar-benar ada di store selalu diterima, termasuk nama yang
  // kebetulan mengandung kata umum (mis. "Haji Ali").
  if (hasJamaahNameMatch(raw)) return true;

  if (words.some((word) => NON_NAME_WORDS.has(word))) return false;
  if (words.length === 1) return false;
  return words.every((word) => word.length >= 2);
}

/** Cocokkan nilai status/dokumen tanpa ikut mencocokkan "belum ..." untuk kata positif. */
function matchesFieldStatus(value, wanted) {
  const text = normalizeText(value);
  if (!text) return false;
  if (wanted.startsWith('belum ')) return text.includes(wanted);
  return text.includes(wanted) && !text.includes(`belum ${wanted}`);
}

/** Filter kategori sederhana: status pembayaran, status dokumen, paket, hotel, kota. */
function getCategoryFilter(message) {
  const text = String(message || '');
  let match;

  if (
    (match = text.match(
      /\b(?:(?:status)(?:\s+pembayaran)?\s*[:=-]?\s*)?(belum\s+lunas|lunas|dp(?:\s*\d{1,3}\s*%)?)\b/i,
    ))
  ) {
    const wanted = normalizeText(match[1]);
    return {
      label: `status ${match[1].trim()}`,
      test: (j) =>
        matchesFieldStatus(j.statusPembayaran || j.status || j.pembayaran, wanted),
    };
  }

  if (
    (match = text.match(
      /\b(?:dokumen|berkas)\s*[:=-]?\s*(belum\s+lengkap|lengkap)\b/i,
    ))
  ) {
    const wanted = normalizeText(match[1]);
    return {
      label: `dokumen ${match[1].trim()}`,
      test: (j) => matchesFieldStatus(j.statusDokumen || j.dokumen, wanted),
    };
  }

  if ((match = text.match(/\b(?:paket|program)\s*[:=-]?\s*(.+)$/i))) {
    const phrase = match[1].split(/\b(?:yang|dengan|status|dan)\b/i)[0].trim();
    const wanted = normalizeText(phrase);
    if (wanted.length >= 4) {
      return {
        label: `paket "${phrase}"`,
        test: (j) => normalizeText(j.paket).includes(wanted),
      };
    }
  }

  if ((match = text.match(/\bhotel\s*[:=-]?\s*(.+)$/i))) {
    const wanted = normalizeText(match[1]);
    if (wanted.length >= 4) {
      return {
        label: `hotel "${match[1].trim()}"`,
        test: (j) => normalizeText(j.hotel).includes(wanted),
      };
    }
  }

  if ((match = text.match(/\b(?:kota|domisili|asal)\s*[:=-]?\s*(.+)$/i))) {
    const wanted = normalizeText(match[1]);
    if (wanted.length >= 3) {
      return {
        label: `kota "${match[1].trim()}"`,
        test: (j) => normalizeText(j.kotaAsal || j.kota).includes(wanted),
      };
    }
  }

  return null;
}

const FAQ_RULES = [
  {
    test: /\b(?:apa itu|apa yg dimaksud|apa yang dimaksud|pengertian|arti)\s+(?:umrah|umroh)\b|\b(?:umrah|umroh)\s+itu\s+apa\b/,
    answer:
      "🕋 **Umrah** adalah ibadah ke Baitullah di Makkah yang meliputi ihram, tawaf, sa'i, dan tahallul. Umrah bisa dilakukan kapan saja dan tidak ada wukuf seperti haji. Ada yang ingin ditanyakan soal syarat, dokumen, atau persiapan?",
  },
  {
    test: /\b(?:perbedaan|beda)\s+(?:umrah|umroh)\s+(?:dan|dengan)\s+haji\b|\b(?:perbedaan|beda)\s+haji\s+(?:dan|dengan)\s+(?:umrah|umroh)\b/,
    answer:
      '🕋 **Perbedaan umrah dan haji:**\n- Umrah bisa kapan saja; haji hanya pada bulan Dzulhijjah.\n- Haji memiliki wukuf di Arafah, mabit, dan melempar jumrah; umrah tidak.\n- Haji merupakan rukun Islam kelima dan wajib bagi yang mampu.',
  },
  {
    test: /\b(?:syarat|rukun|kewajiban)\b.*\b(?:umrah|umroh)\b|\b(?:umrah|umroh)\b.*\b(?:syarat|rukun|kewajiban)\b/,
    answer:
      "📋 **Syarat umrah:** Muslim, berakal, mampu secara fisik dan biaya, serta memenuhi dokumen perjalanan.\n**Rukun umrah:** ihram, tawaf, sa'i, dan tahallul.\nUntuk anak, ibu hamil, atau lansia, konsultasikan kondisi ke dokter dan travel.",
  },
  {
    test: /\b(?:dokumen|persyaratan|paspor|visa|vaksin|ktp|kk|foto)\b.*\b(?:umrah|umroh|haji)\b|\b(?:umrah|umroh|haji)\b.*\b(?:dokumen|persyaratan|paspor|visa|vaksin|ktp|kk|foto)\b/,
    answer:
      '📄 **Dokumen umrah yang umumnya diperlukan:**\n- Paspor valid (biasanya minimal 6–8 bulan)\n- Visa umrah\n- Tiket dan bukti akomodasi\n- Sertifikat vaksin sesuai ketentuan\n- Dokumen pendukung lain dari travel\nPastikan nama di semua dokumen sama.',
  },
  {
    test: /\b(?:biaya|harga|tarif|budget|anggaran)\b.*\b(?:umrah|umroh|haji)\b|\b(?:umrah|umroh|haji)\b.*\b(?:biaya|harga|tarif|budget|anggaran)\b/,
    answer:
      '💰 **Biaya umrah** bervariasi tergantung durasi, hotel, maskapai, dan musim. Saya tidak bisa memastikan harga tanpa data paket terbaru. Silakan cek daftar paket travel atau hubungi admin untuk harga resmi.',
  },
  {
    test: /\b(?:waktu|musim|bulan|kapan)\b.*\b(?:umrah|umroh|haji)\b|\b(?:umrah|umroh|haji)\b.*\b(?:waktu|musim|bulan|kapan)\b/,
    answer:
      '🗓️ **Waktu umrah** bisa sepanjang tahun. Ramadhan dan musim liburan biasanya lebih ramai dan mahal; di luar musim tersebut lebih tenang dan hemat. Pilih waktu yang sesuai kondisi fisik dan anggaran.',
  },
  {
    test: /\b(?:persiapan|bekal|tips|saran|latihan|manasik)\b.*\b(?:umrah|umroh|haji)\b|\b(?:umrah|umroh|haji)\b.*\b(?:persiapan|bekal|tips|saran|latihan|manasik)\b/,
    answer:
      '🎒 **Persiapan umrah:**\n- Dokumen: paspor, visa, vaksin, salinan berkas\n- Fisik: latihan jalan kaki dan stamina\n- Ibadah: manasik dan hafalan doa\n- Perlengkapan: ihram, alas kaki nyaman, obat pribadi\n- Keuangan dan komunikasi dengan keluarga',
  },
  {
    test: /\b(?:ihram|tawaf|thawaf|sa i|sai|tahallul|talbiyah|manasik)\b/,
    answer:
      "🕋 **Rangkaian umrah:** ihram (niat) → tawaf mengelilingi Ka'bah → sa'i antara Safa dan Marwah → tahallul (memotong rambut). Ikuti panduan pembimbing manasik agar urutannya benar.",
  },
  {
    test: /\b(?:doa|dzikir|talbiyah)\b.*\b(?:umrah|umroh|haji)\b|\b(?:umrah|umroh|haji)\b.*\b(?:doa|dzikir|talbiyah)\b/,
    answer:
      "🤲 **Doa umrah** yang utama adalah talbiyah saat ihram, dzikir saat tawaf, serta doa di Multazam dan Sa'i. Sebaiknya pelajari doa-doa pokok saat manasik dan bawa panduan doa.",
  },
  {
    test: /\b(?:anak|balita|hamil|kehamilan|lansia|sakit|kesehatan|fisik|kursi roda)\b.*\b(?:umrah|umroh|haji)\b|\b(?:umrah|umroh|haji)\b.*\b(?:anak|balita|hamil|kehamilan|lansia|sakit|kesehatan|fisik|kursi roda)\b/,
    answer:
      '🩺 Untuk **anak, ibu hamil, lansia, atau jamaah dengan kondisi khusus**, konsultasikan dulu ke dokter dan travel. Pastikan obat, kursi roda, pendamping, serta kebutuhan khusus sudah disiapkan.',
  },
  {
    test: /\b(?:apa itu|arti|pengertian)\s+(?:rtb|kode order|nomor pendaftaran)\b|\b(?:rtb|kode order)\s+itu\s+apa\b/,
    answer:
      '🔖 **RTB** adalah kode registrasi/rombongan jamaah di SGO Admin. **Kode order** adalah nomor pendaftaran jamaah. Untuk mengecek data, kirim nama, NIK, paspor, kode order, atau RTB jamaah.',
  },
  {
    test: /\b(?:apa itu|arti|pengertian)\s+status pembayaran\b|\bstatus pembayaran\s+itu\s+apa\b/,
    answer:
      '💳 **Status pembayaran** menunjukkan progress pembayaran jamaah, misalnya `LUNAS`, `DP 4%`, atau `BELUM LUNAS`. Untuk mengecek status jamaah tertentu, kirim nama, NIK, paspor, kode order, atau RTB.',
  },
  {
    test: /\b(?:cara|bagaimana|gimana)\b.*\b(?:cek|mencari|cari|lihat)\b.*\b(?:jamaah|data jamaah)\b|\b(?:cara|bagaimana|gimana)\b.*\b(?:jamaah|data jamaah)\b/,
    answer:
      '🔎 **Cara cek data jamaah:** kirim nama lengkap, NIK, nomor paspor, kode order, atau RTB. Saya akan menampilkan nama, kode order, RTB, paket, dan status pembayaran langsung dari data SGO Admin.',
  },
  {
    test: /\b(?:apa itu|pengertian)\s+haji\b|\bhaji\s+itu\s+apa\b/,
    answer:
      '🕋 **Haji** adalah rukun Islam kelima yang dilaksanakan pada bulan Dzulhijjah. Rangkaiannya meliputi ihram, wukuf di Arafah, mabit, melempar jumrah, tawaf ifadah, sa\'i, dan tahallul. Haji wajib bagi yang mampu.',
  },
  {
    test: /\b(?:mahram|muhrim)\b/,
    answer:
      '👨‍👩‍👧 **Mahram** adalah kerabat yang tidak boleh dinikahi dan menjadi pendamping dalam perjalanan menurut ketentuan syariat. Ketentuan mahram untuk umrah dapat berbeda tergantung regulasi dan travel; silakan konfirmasi ke travel.',
  },
  {
    test: /\b(?:umrah|umroh|haji|ihram|tawaf|thawaf|sa i|sai|tahallul|manasik|makkah|mekkah|madinah|talbiyah)\b/,
    answer:
      '🕋 Saya bisa membantu seputar **umrah & haji**: syarat, rukun, dokumen, biaya, waktu terbaik, persiapan, doa, dan kondisi khusus. Bagian mana yang ingin Anda tanyakan?',
  },
];

function getFaqReply(message = '') {
  const text = normalizeText(message);
  if (!text) return null;
  const rule = FAQ_RULES.find((item) => item.test.test(text));
  return rule ? rule.answer : null;
}

const SEARCH_CUE =
  /\b(?:cari|carikan|temukan|tampilkan|lihat|cek|check|data|daftar|list|jamaah|jamaahnya|peserta|pesertanya|nama|bernama|nik|ktp|paspor|passport|pasport|order|kode|nomor|rtb|pendaftaran|booking|invoice|status|terdaftar|terdata)\b/;

const COMPLAINT_PATTERN =
  /\b(?:kok|gabisa|gak|nggak|ngga|tidak bisa|error|eror|gagal|rusak|bug|lemot|lambat|stuck|bingung|masalah|kendala)\b/;

const STATUS_FILTER_CUE =
  /^(?:status(?:\s+pembayaran)?\s*[:=-]?\s*)?(?:belum\s+lunas|lunas|dp(?:\s*\d{1,3}\s*%)?)\b/;

function getPackageOverviewReply() {
  const rows = getAllJamaah();
  if (!rows.length) {
    return 'Belum ada data paket umrah. Jalankan scrape modul Monitoring Jamaah terlebih dahulu.';
  }

  const counts = new Map();
  for (const j of rows) {
    const name = String(j.paket || '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const packages = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (!packages.length) {
    return 'Data paket belum tersedia pada hasil scrape saat ini.';
  }

  const lines = [`🧳 **Paket yang tersedia di data SGO** (${packages.length} paket):`];
  packages.slice(0, 8).forEach(([name, count], index) => {
    lines.push(`${index + 1}. ${name} — ${count} jamaah`);
  });
  if (packages.length > 8) {
    lines.push(`…dan ${packages.length - 8} paket lainnya.`);
  }
  lines.push('\nMau cek jamaah pada paket tertentu? Sebutkan nama paketnya.');
  return lines.join('\n');
}

function getLocalFaqReply(core = '') {
  const text = normalizeText(core);
  if (
    /\b(?:paket|program)\b/.test(text) &&
    /\b(?:umrah|umroh|haji)\b/.test(text) &&
    /\b(?:apa|saja|ada|tersedia|pilihan|daftar|list)\b/.test(text)
  ) {
    return getPackageOverviewReply();
  }
  return getFaqReply(core);
}

function getComplaintReply(message = '') {
  if (
    /\b(?:gabisa|gak bisa|nggak bisa|tidak bisa|gagal|error|eror|rusak|bug|lemot|lambat|stuck)\b/i.test(
      message,
    )
  ) {
    return 'Mohon maaf atas kendalanya. 🙏 Saya di sini untuk membantu.\n\nCoba jelaskan sedikit lagi: bagian mana yang tidak bisa? Jika kendalanya saat mencari jamaah, kirim nama lengkap, NIK, nomor paspor, kode order `ORD-...`, atau nomor RTB — nanti saya cek langsung dari data SGO Admin.';
  }
  return 'Baik, saya pahami. 🙏 Coba ceritakan lebih detail apa yang ingin Anda lakukan, supaya saya bisa bantu dengan tepat.';
}

function dataHelpReply() {
  return 'Siap, saya bantu cek data jamaah. 🔎\n\nKirim salah satu data berikut:\n- Nama lengkap jamaah\n- NIK / nomor paspor\n- Kode order (`ORD-...`) atau 4 digit terakhir\n- Nomor RTB\n\nContoh: "cari jamaah Andi Fitria" atau "RTB 307".';
}

function friendlyNotFound(intent = {}) {
  if (intent.filter?.label) {
    return `Saya belum menemukan jamaah dengan ${intent.filter.label} pada data saat ini. 🙏\n\nCoba kata kunci lain, atau kirim nama lengkap, NIK, paspor, kode order, atau RTB jamaah.`;
  }
  const query = intent.query || intent.core || '';
  return `Belum ada data yang cocok dengan "${query}" pada data jamaah saat ini. 🙏\n\nMungkin ejaannya sedikit berbeda, atau data Monitoring Jamaah belum di-scrape ulang. Coba kirim nama lengkap, NIK, nomor paspor, kode order \`ORD-...\`, atau nomor RTB.`;
}

function notFoundContext(intent = {}) {
  const target = intent.query || intent.filter?.label || intent.core || '';
  return [
    `Konteks internal: pengguna meminta pencarian data jamaah untuk "${target}", tetapi hasil pencarian di data SGO Admin kosong.`,
    'Jangan mengarang data jamaah.',
    'Jawab dengan ramah, akui data belum ditemukan, lalu bantu pengguna memperbaiki kata kunci atau tawarkan bantuan lain.',
  ].join(' ');
}

function buildLookupQuery(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const hasLabel =
    /\b(?:nik|ktp|paspor|passport|pasport|rtb|ord|umr|order|kode|pendaftaran|booking|invoice)\b/i.test(
      text,
    );
  if (hasLabel) return text;
  // Token paspor (huruf + angka) harus dipertahankan utuh. Jangan dipotong
  // menjadi digit saja, karena bisa salah cocok ke NIK/order/RTB.
  if (/^[A-Za-z]{1,2}\d{4,9}$/.test(text)) return text;
  const short = text.match(/\b\d{3,6}\b/);
  if (short) return short[0];
  return text;
}

/**
 * Klasifikasi intent:
 * - obrolan (greeting/smalltalk/complaint/faq/general) -> Gemini
 * - data-* -> pencarian lokal
 *
 * Prinsip utama: jangan pernah menganggap sisa kata dari kalimat umum sebagai
 * nama jamaah. Nama tunggal hanya masuk jalur data jika benar-benar ada di
 * store; kandidat nama 2+ kata tetap dicoba agar hasil kosong bisa dijawab
 * Gemini dengan ramah.
 */
function classifyIntent(message = '') {
  const original = String(message || '').trim();
  const core = stripGreetingPrefix(original);
  const text = normalizeText(core);
  const base = { original, core, text, query: '', filter: null, faq: null, count: false };

  if (!text) return { ...base, type: 'greeting' };

  // Salam yang diikuti sapaan honorifik saja, mis. "assalamualaikum pak".
  if (HONORIFIC_ONLY.test(text)) return { ...base, type: 'greeting' };

  const smallTalk = getSmallTalkReply(text, original);
  if (smallTalk) return { ...base, type: 'smalltalk', localReply: smallTalk };

  const faq = getLocalFaqReply(core);
  const definitional = DEFINITIONAL.test(text);
  if (faq && definitional) return { ...base, type: 'faq', faq };

  const hasDataHint = DATA_HINT.test(text);
  const searchCue = SEARCH_CUE.test(text);
  const explicitId = hasExplicitIdentityCue(text);
  const filter = getCategoryFilter(text);
  const statusFilter = STATUS_FILTER_CUE.test(text);
  const count = isCountIntent(text);
  const nameQuery = extractNameQuery(text);
  const cueNameQuery = searchCue
    ? extractNameQuery(text, { allowStopwordFilter: true })
    : '';
  const lookupQuery = cueNameQuery || nameQuery;
  const complaint = COMPLAINT_PATTERN.test(text);

  // Pencarian langsung yang hanya bisa dikenali dari isi data real:
  // paket penuh, paspor parsial, dan RTB pendek (mis. "32").
  const barePackageQuery =
    !definitional && !complaint && !searchCue && hasJamaahPackageMatch(core);
  const barePassportQuery =
    !definitional && !complaint && !searchCue && hasJamaahPassportMatch(core);
  const bareRtbQuery =
    !definitional && !complaint && !searchCue && hasJamaahRtbMatch(text);

  const systemQuestion =
    /\b(?:aplikasi|website|web|sistem|server|bot|login|cookie|fitur|menu|kategori|halaman|tombol|password|akun)\b/.test(
      text,
    ) &&
    !hasDataHint &&
    !explicitId;
  const bareNameQuery =
    Boolean(lookupQuery) &&
    !searchCue &&
    !explicitId &&
    !filter &&
    !complaint &&
    !faq &&
    !definitional &&
    isNameLikeQuery(lookupQuery);

  if (isListIntent(text)) {
    return { ...base, type: count ? 'data-count' : 'data-list', count };
  }

  if (filter && (hasDataHint || statusFilter) && (!definitional || count)) {
    return { ...base, type: count ? 'data-count' : 'data-filter', filter, count };
  }

  // ID/kode eksplisit selalu diprioritaskan sebagai pencarian data.
  if (explicitId) {
    return { ...base, type: 'data-lookup', query: buildLookupQuery(original) || text };
  }

  // Nama paket yang benar-benar ada di data SGO.
  if (barePackageQuery) {
    const packageQuery = core
      .replace(/\b(?:paket|program|produk)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ...base, type: 'data-lookup', query: packageQuery || core };
  }

  // Paspor parsial / RTB pendek yang cocok dengan data real.
  if (barePassportQuery || bareRtbQuery) {
    return { ...base, type: 'data-lookup', query: buildLookupQuery(core) || core };
  }

  // Keluhan umum tidak boleh masuk ke pencarian jamaah.
  if (complaint) return { ...base, type: 'complaint' };

  // Permintaan cari data yang jelas (ada kata cari/nama/status + target).
  if (searchCue && lookupQuery) {
    return { ...base, type: 'data-lookup', query: lookupQuery };
  }

  // FAQ tanpa nama/jamah konkret tidak boleh dianggap pencarian data.
  if (faq && !lookupQuery) return { ...base, type: 'faq', faq };

  // Pertanyaan tentang aplikasi/website, bukan data jamaah.
  if (systemQuestion) return { ...base, type: 'general' };

  if (searchCue) return { ...base, type: 'data-help' };

  if (definitional) {
    return { ...base, type: faq ? 'faq' : 'general', faq };
  }

  if (faq) return { ...base, type: 'faq', faq };

  if (bareNameQuery) {
    return { ...base, type: 'data-lookup', query: lookupQuery };
  }

  return { ...base, type: 'general' };
}

function answerDataIntent(intent = {}) {
  if (intent.type === 'data-list') {
    const rows = getAllJamaah();
    if (!rows.length) {
      return {
        reply:
          'Belum ada data jamaah. Jalankan scrape modul Monitoring Jamaah terlebih dahulu.',
        matchedCount: 0,
      };
    }
    return { reply: formatJamaahListReply(rows), matchedCount: rows.length };
  }

  if (intent.type === 'data-count') {
    const rows = intent.filter
      ? getAllJamaah().filter(intent.filter.test)
      : getAllJamaah();
    if (!rows.length) {
      if (!intent.filter) {
        return {
          reply:
            'Belum ada data jamaah. Jalankan scrape modul Monitoring Jamaah terlebih dahulu.',
          matchedCount: 0,
        };
      }
      return { reply: null, matchedCount: 0 };
    }
    return {
      reply: formatJamaahCountReply(rows, { filterLabel: intent.filter?.label }),
      matchedCount: rows.length,
    };
  }

  if (intent.type === 'data-filter') {
    const rows = getAllJamaah().filter(intent.filter.test);
    if (!rows.length) return { reply: null, matchedCount: 0 };
    if (intent.count) {
      return {
        reply: formatJamaahCountReply(rows, { filterLabel: intent.filter.label }),
        matchedCount: rows.length,
      };
    }
    if (rows.length > 10) {
      return {
        reply: formatJamaahListReply(rows, { filterLabel: intent.filter.label }),
        matchedCount: rows.length,
      };
    }
    return {
      reply: formatJamaahResult(rows, { filterLabel: intent.filter.label }),
      matchedCount: rows.length,
    };
  }

  if (intent.type === 'data-lookup') {
    const result = findJamaah(intent.query);
    if (!result.found) return { reply: null, matchedCount: 0 };
    return {
      reply: formatJamaahResult(result.matches),
      matchedCount: result.matches.length,
    };
  }

  if (intent.type === 'data-help') {
    return { reply: dataHelpReply(), matchedCount: null };
  }

  return null;
}

function localConversationReply(intent = {}, message = '') {
  switch (intent.type) {
    case 'greeting':
      return getGreetingReply(message);
    case 'smalltalk':
      return (
        intent.localReply ||
        getSmallTalkReply(intent.text, message) ||
        generalFallback()
      );
    case 'complaint':
      return getComplaintReply(intent.text);
    case 'faq':
      return intent.faq || getLocalFaqReply(intent.core) || generalFallback();
    case 'data-help':
      return dataHelpReply();
    default:
      return generalFallback();
  }
}

function buildSystemPrompt() {
  return [
    'Anda adalah Asisten Umrah AI yang ramah, natural, empatik, dan membantu.',
    'Jawab dalam bahasa Indonesia yang sopan dan tidak kaku.',
    'Boleh menjawab sapaan, obrolan ringan, keluhan, FAQ umrah/haji, dan pertanyaan umum lain.',
    'Gunakan markdown ringan (bold, bullet) bila membantu. Jangan terlalu panjang.',
    'Jangan pernah mengarang data jamaah. Data jamaah hanya boleh berasal dari hasil pencarian server.',
    'Jika konteks mengatakan data jamaah tidak ditemukan, akui dengan ramah dan jangan menampilkan data palsu.',
    'Jika pengguna mengeluh, dengarkan dan bantu arahkan solusinya dengan tenang.',
    formatJamaahContext(),
  ].join('\n');
}

async function callGemini(userMessage, context = '') {
  if (!genAI) {
    throw new Error('GEMINI_API_KEY belum diset di .env');
  }

  const prompt = context
    ? `${context}\n\nPesan pengguna: ${userMessage}`
    : userMessage;
  const candidates = [
    activeGeminiModel,
    ...GEMINI_MODEL_CANDIDATES.filter((name) => name !== activeGeminiModel),
  ];
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const modelName = candidates[index];
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: buildSystemPrompt(),
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
      });
      const result = await withTimeout(
        model.generateContent(prompt),
        REQUEST_TIMEOUT_MS,
        `Gemini ${modelName}`,
      );
      const text = String(result?.response?.text?.() || '').trim();
      if (!text) throw new Error('Respons Gemini kosong');

      // Model yang berhasil dipakai didahulukan pada request berikutnya.
      activeGeminiModel = modelName;
      return { text, model: modelName };
    } catch (error) {
      lastError = error;
      const canTryNext =
        index < candidates.length - 1 &&
        (isModelUnavailable(error) ||
          isModelOverloaded(error) ||
          isQuotaError(error));
      if (!canTryNext) throw error;

      const detail = String(error?.message || error)
        .replace(/\s+/g, ' ')
        .slice(0, 100);
      console.warn(
        `[aiEngine] Model ${modelName} gagal (${detail}); mencoba ${candidates[index + 1]}...`,
      );
    }
  }

  throw lastError || new Error('Tidak ada model Gemini yang bisa dipakai');
}

function isQuotaError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const detail = String(error?.message || error || '');
  return (
    status === 429 ||
    /\b429\b|quota|resource[_\s-]?exhausted|too many requests|rate limit/i.test(detail)
  );
}

function isModelUnavailable(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const detail = String(error?.message || error || '');
  return (
    status === 404 ||
    /no longer available|model not found|is not found|unsupported model/i.test(detail)
  );
}

function isModelOverloaded(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const detail = String(error?.message || error || '');
  return (
    status === 503 ||
    /\b503\b|high demand|overloaded|service unavailable|temporarily unavailable/i.test(
      detail,
    )
  );
}

function generalFallback() {
  return '🙏 Terima kasih sudah menghubungi Asisten Umrah AI.\n\nSaya siap membantu informasi umrah & haji, obrolan seputar persiapan, serta pengecekan data jamaah SGO Admin. Silakan sampaikan pertanyaan atau nama/NIK/paspor/kode order/RTB jamaah yang ingin dicek.';
}

async function tryGemini(userMessage, { context = '', fallback = '' } = {}) {
  const safeFallback = String(fallback || '').trim() || generalFallback();

  if (!AI_ENABLED) {
    return { text: safeFallback, source: 'local-fallback', model: null };
  }
  if (Date.now() < geminiDisabledUntil) {
    return { text: safeFallback, source: 'local-fallback', model: null };
  }

  try {
    const { text, model } = await callGemini(userMessage, context);
    return { text, source: 'gemini', model };
  } catch (error) {
    const detail = String(error?.message || error);
    console.error('[aiEngine] Gemini error detail:', detail.slice(0, 200));

    if (isModelUnavailable(error)) {
      geminiDisabledUntil = Date.now() + 10 * 60 * 1000;
    } else if (isQuotaError(error)) {
      geminiDisabledUntil = Date.now() + 60 * 1000;
    } else if (isModelOverloaded(error)) {
      geminiDisabledUntil = Date.now() + 30 * 1000;
    } else if (/timeout/i.test(detail)) {
      // Jangan menunggu 6 detik berulang-ulang saat jaringan ke Gemini lambat.
      geminiDisabledUntil = Date.now() + 60 * 1000;
    }

    return { text: safeFallback, source: 'local-fallback', model: null };
  }
}

/**
 * Pipeline utama:
 * 1. Klasifikasi intent.
 * 2. Intent data -> cari langsung di store.
 * 3. Data tidak ditemukan / obrolan umum -> Gemini, dengan fallback lokal ramah.
 */
export async function processChat(userMessage) {
  const startedAt = Date.now();
  const message = String(userMessage || '').trim();

  if (!message) {
    return {
      reply: 'Silakan kirim pertanyaan, salam, atau nama jamaah yang ingin dicek.',
      intent: 'empty',
      source: 'local',
      usedJamaahLookup: false,
      matchedCount: null,
      model: null,
      latencyMs: 0,
    };
  }

  // Peringatan ini hanya membaca status store; tidak pernah mengubah data.
  warnIfJamaahStoreEmpty('chat');

  let intent;
  try {
    intent = classifyIntent(message);
  } catch (error) {
    console.error('[aiEngine] classify error:', error.message);
    intent = { type: 'general', original: message, core: message, text: normalizeText(message) };
  }

  if (intent.type.startsWith('data-')) {
    let local = null;
    try {
      local = answerDataIntent(intent);
    } catch (error) {
      console.error('[aiEngine] local data error:', error.message);
    }

    if (local?.reply) {
      return {
        reply: local.reply,
        intent: intent.type,
        source: intent.type === 'data-help' ? 'local' : 'jamaah-data',
        usedJamaahLookup: intent.type !== 'data-help',
        matchedCount: local.matchedCount,
        model: null,
        latencyMs: Date.now() - startedAt,
      };
    }

    // Data tidak ditemukan: jawab lewat Gemini agar tetap ramah, bukan pesan kaku.
    const result = await tryGemini(message, {
      context: notFoundContext(intent),
      fallback: friendlyNotFound(intent),
    });

    return {
      reply: result.text,
      intent: intent.type,
      source: result.source,
      usedJamaahLookup: true,
      matchedCount: 0,
      model: result.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  const fallback = localConversationReply(intent, message);
  const context =
    intent.type === 'faq' && intent.faq
      ? `Konteks internal dari data server (gunakan bila relevan, rangkum dengan ramah):\n${intent.faq}`
      : '';
  const result = await tryGemini(message, { context, fallback });

  return {
    reply: result.text,
    intent: intent.type,
    source: result.source,
    usedJamaahLookup: false,
    matchedCount: null,
    model: result.model,
    latencyMs: Date.now() - startedAt,
  };
}

export async function processChatMessage(userMessage) {
  const result = await processChat(userMessage);
  return result.reply;
}

export function getAIStatus() {
  const fallbackActive = !AI_ENABLED || Date.now() < geminiDisabledUntil;
  return {
    ready: AI_ENABLED,
    fallbackActive,
    provider: AI_PROVIDER,
    keyConfigured: Boolean(apiKey),
    models: GEMINI_MODEL_CANDIDATES,
    configuredModel: GEMINI_MODEL,
    activeModel: activeGeminiModel,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

export { classifyIntent };
export default { processChat, processChatMessage, getAIStatus, classifyIntent };
