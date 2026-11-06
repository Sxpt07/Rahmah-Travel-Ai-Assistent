import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// File penyimpanan permanen. Bisa diarahkan lewat env JAMAAH_DATA_FILE.
const DATA_FILE = process.env.JAMAAH_DATA_FILE
  ? path.resolve(process.env.JAMAAH_DATA_FILE)
  : path.join(__dirname, '..', 'jamaah_data.json');
const DATA_FILE_VERSION = 1;

let activeJamaah = [];
let sourceInfo = null;
let lastEmptyWarningAt = 0;
const EMPTY_WARNING_INTERVAL_MS = 60 * 1000;

/**
 * Peringatan throttled agar terminal tidak banjir saat store kosong.
 * Dipanggil dari pencarian maupun chat umum.
 */
export function warnIfJamaahStoreEmpty(context = '') {
  if (activeJamaah.length > 0) return false;
  const now = Date.now();
  if (now - lastEmptyWarningAt < EMPTY_WARNING_INTERVAL_MS) return true;
  lastEmptyWarningAt = now;
  console.warn(
    `[jamaahStore] PERINGATAN: data jamaah kosong${context ? ` (${context})` : ''}. ` +
      'Data SGO belum di-scrape ulang; jalankan modul Monitoring Jamaah.',
  );
  return true;
}

function normalizeKey(k = '') {
  return String(k)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function extractOrderShortCode(value = '') {
  const str = String(value || '');
  if (!str) return '';
  const patterns = [
    /ORD[-_ ]?\d{4}[-_ ]?[A-Z]{2,4}[-_ ]?(\d{4,6})/i,
    /ORDER[-_ ]?\d{4}[-_ ]?[A-Z]{2,4}[-_ ]?(\d{4,6})/i,
    /UMR[-_ ]?\d{4}[-_ ]?(\d{4,6})/i,
    /([A-Z]{2,4})[-_ ]?(\d{5,6})/i,
  ];
  for (const p of patterns) {
    const m = str.match(p);
    if (m) {
      const num = m[m.length - 1];
      if (num && num.length >= 4) {
        return num.slice(-5).replace(/^0+/, '') || num;
      }
    }
  }
  const all = str.match(/\d{4,6}/g);
  if (all && all.length) {
    const last = all[all.length - 1];
    return last.slice(-5).replace(/^0+/, '') || last;
  }
  return '';
}

export function getOrderAliases(value = '') {
  const str = String(value || '');
  const aliases = new Set();
  if (str) aliases.add(str.trim().toLowerCase());
  const sc = extractOrderShortCode(str);
  if (sc) {
    aliases.add(sc);
    aliases.add(sc.padStart(4, '0'));
    aliases.add(sc.padStart(5, '0'));
  }
  const nums = str.match(/\d{4,6}/g) || [];
  nums.forEach((n) => {
    aliases.add(n);
    aliases.add(n.slice(-4));
    aliases.add(n.slice(-5));
  });
  return Array.from(aliases).filter(Boolean);
}

function isNavNoise(line = '') {
  const t = line.trim();
  if (!t) return true;
  if (/^(cari|menu|beranda|dashboard|home|logout|profil|pengaturan|filter|export|excel|pdf|print|tambah|aksi|halaman|\d+)$/.test(t.toLowerCase())) return true;
  if (/penagihan|aging|monitoring|invoice|approval|upload.*dokumen|travel.*doc|itinerary|hotel|bus|visa|stock|perlengkapan|rahmah|nusuk|b2b/i.test(t) && t.split(' ').length <= 3) return true;
  if (/^no\.?|nama|alamat|telepon|email|aksi$/i.test(t)) return true;
  return false;
}

function parseRawText(row = {}) {
  const text = row.rawScrapedText || row.rawText || '';
  if (!text) return {};
  const lines = text.split(/\n+/).map((l) => l.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim()).filter((l) => l && !isNavNoise(l));
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const nikMatch = l.match(/\b(?:NIK|NO\.?\s*KTP|KTP)\b\s*[:#-]?\s*([0-9]{8,20})/i);
    if (nikMatch && !result.nik) {
      result.nik = nikMatch[1];
      continue;
    }
    const passportMatch = l.match(/\b(?:PASPOR|PASPORT|PASSPORT|NO\.?\s*PASPOR)\b\s*[:#-]?\s*([A-Z0-9]{5,15})/i);
    if (passportMatch && !result.passport) {
      result.passport = passportMatch[1].toUpperCase();
      continue;
    }
    if (!result.nama && /^[A-Z][A-Z\s\.'-]{4,}$/.test(l) && !/RTB|ORDER|PAKET|DOKUMEN|STATUS|PAID|LUNAS|BELUM/i.test(l)) {
      if (l.length > 5 && l.length < 60) { result.nama = l; continue; }
    }
    const ord = l.match(/ORD[-_ ]?\d{4}[-_ ]?[A-Z]{2,4}[-_ ]?(\d{4,6})/i);
    if (ord && !result.orderId && !result.kodeOrder) {
      result.kodeOrder = ord[0].replace(/\s+/g, '-').toUpperCase();
      result.orderId = result.kodeOrder;
      continue;
    }
    if ((/RTB/i.test(l)) && !result.rtb) {
      const m = l.match(/RTB[-_ ]?(\d{1,4})/i);
      if (m) result.rtb = `RTB ${m[1]}`.toUpperCase();
      else if (/\d{1,4}/.test(l)) {
        const nm = l.match(/(\d{1,4})/);
        if (nm) result.rtb = `RTB ${nm[1]}`;
      } else {
        result.rtb = l.replace(/RTB|NOMOR|:/gi, '').trim().toUpperCase();
      }
      continue;
    }
    if (/PAKET/i.test(l) && !result.paket && /UMRAH|HAJI|REGULER|VIP/i.test(l)) {
      result.paket = l.replace(/PAKET|:|-/gi, '').replace(/\s+/g, ' ').trim();
      continue;
    }
    if ((/KTP|KK|PASPOR|VAKSIN|FOTO/i.test(l) || /DOKUMEN/i.test(l)) && !result.statusDokumen) {
      if (/LENGKAP|SELESAI|VALID|OK/i.test(l)) result.statusDokumen = 'LENGKAP';
      else if (/BELUM|KURANG|TIDAK|MENUNGGU/i.test(l)) result.statusDokumen = 'BELUM LENGKAP';
      else result.statusDokumen = l.slice(0, 50);
      if (!result.dokumen) result.dokumen = result.statusDokumen;
      continue;
    }
    if ((/PEMBAYARAN|STATUS.*BAYAR|LUNAS|DP|BELUM.*BAYAR/i.test(l)) && !result.statusPembayaran && !result.status) {
      if (/LUNAS/i.test(l)) result.statusPembayaran = 'LUNAS'; else if (/DP|BELUM/i.test(l)) result.statusPembayaran = 'BELUM LUNAS';
      else result.statusPembayaran = l.replace(/STATUS|PEMBAYARAN|:/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      result.status = result.statusPembayaran;
    }
  }
  return result;
}

function mapRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.entries(row);
  const getByKeys = (keys) => {
    const wanted = keys.map((key) => normalizeKey(key));
    const readEntry = ([, value]) => {
      if (value === null || value === undefined) return '';
      return String(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    };

    // Prioritaskan nama kolom yang persis sama agar field baru seperti
    // identityType/kotaPaspor tidak salah terbaca sebagai tipe/kota asal.
    for (const entry of entries) {
      const nk = normalizeKey(entry[0]);
      if (!wanted.includes(nk)) continue;
      const s = readEntry(entry);
      if (s) return s;
    }

    for (const entry of entries) {
      const nk = normalizeKey(entry[0]);
      for (const kk of wanted) {
        if (nk.includes(kk)) {
          const s = readEntry(entry);
          if (s) return s;
        }
      }
    }
    return '';
  };

  const parsed = parseRawText(row);

  let orderCode = getByKeys(['order', 'no order', 'kode order', 'order id', 'ordercode', 'nomor order', 'invoice', 'booking', 'kode booking', 'no booking', 'orderid']) || row.orderCode || row.kodeOrder || row.orderId || row.order_id || parsed.orderId || parsed.kodeOrder || '';
  if (!orderCode && row.rawScrapedText) {
    const m = row.rawScrapedText.match(/ORD[-_ ]?\d{4}[-_ ]?[A-Z]{2,4}[-_ ]?(\d{4,6})/i);
    if (m) orderCode = m[0].replace(/\s+/g, '-').toUpperCase();
  }
  let shortCode = extractOrderShortCode(orderCode) || getByKeys(['shortcode', 'kode singkat']) || row.shortCode || '';
  if (!shortCode && orderCode) {
    const m2 = String(orderCode).match(/(\d{4,6})/g);
    if (m2 && m2.length) {
      const last = m2[m2.length - 1];
      shortCode = last.slice(-5).replace(/^0+/, '') || last;
    }
  }

  let nama = getByKeys(['nama', 'nama jamaah', 'jamaah', 'nama lengkap', 'full name', 'nama calon']) || row.nama || row.NAMA || row.name || parsed.nama || '';
  if (!nama && (row.rawText || row.rawScrapedText)) {
    const text = row.rawScrapedText || row.rawText || '';
    const lines = text.split('\n').map((l) => l.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim()).filter((l) => l && !isNavNoise(l));
    for (const l of lines) {
      if (/nama|jamaah/i.test(l) && /[A-Z]{3,}/.test(l)) {
        const cleaned = l.replace(/nama|jamaah|:/gi, '').replace(/\s+/g, ' ').trim();
        if (cleaned.length > 3 && cleaned.length < 60) { nama = cleaned; break; }
      }
    }
    if (!nama) {
      for (const l of lines) {
        if (/^[A-Z][A-Z\s\.']{5,}$/.test(l) && !/RTB|ORDER|PAKET|HOTEL|DOKUMEN|STATUS/i.test(l)) {
          nama = l; break;
        }
      }
    }
  }

  const rtbRaw = getByKeys(['no rtb', 'nortb', 'rtb', 'nomor rtb', 'no_registrasi']) || row.noRtb || row.rtb || parsed.rtb || '';
  let rtb = rtbRaw;
  if (rtb && !/^RTB/i.test(rtb)) {
    const m = String(rtb).match(/(\d{1,4})/);
    if (m) rtb = `RTB ${m[1]}`;
  }
  const paket = getByKeys(['paket', 'nama paket', 'program', 'produk']) || row.paket || parsed.paket || '';
  const dokumen = getByKeys(['dokumen', 'dokumen jamaah', 'berkas']) || row.dokumen || parsed.dokumen || '';
  const statusDokumen = getByKeys(['status dokumen', 'statusdokumen']) || row.statusDokumen || parsed.statusDokumen || '';
  const status = getByKeys(['status', 'status berangkat', 'status pembayaran']) || row.status || row.statusPembayaran || parsed.status || parsed.statusPembayaran || '';
  const nik = getByKeys(['nik', 'no ktp', 'nomor ktp', 'ktp', 'no nik']) || row.nik || row.ktp || parsed.nik || '';
  const passport =
    getByKeys(['passport', 'paspor', 'no paspor', 'nomor paspor', 'no passport']) ||
    row.passport ||
    row.paspor ||
    row.noPaspor ||
    parsed.passport ||
    '';
  const manifestId =
    getByKeys(['manifestid', 'manifest id', 'jamaahid', 'jamaah id']) ||
    row.manifestId ||
    row.jamaahId ||
    '';
  const identityType =
    getByKeys(['identitytype', 'identity type']) || row.identityType || '';
  const tempatLahir =
    getByKeys(['tempatlahir', 'tempat lahir']) || row.tempatLahir || '';
  const tanggalLahir =
    getByKeys(['tanggallahir', 'tanggal lahir']) || row.tanggalLahir || '';
  const kotaPaspor =
    getByKeys(['kotapaspor', 'kota paspor']) || row.kotaPaspor || '';
  const tanggalExpiredPaspor =
    getByKeys(['tanggalexpired', 'tanggal expired']) ||
    row.tanggalExpiredPaspor ||
    '';

  const obj = {
    ...row,
    orderId: orderCode || row.orderId || '',
    kodeOrder: orderCode || row.kodeOrder || '',
    orderCode: orderCode || row.orderCode || '',
    shortCode: shortCode || row.shortCode || '',
    orderShort: shortCode || row.orderShort || '',
    nama: nama || '',
    rtb: rtb || '',
    noRtb: rtb || row.noRtb || '',
    paket: paket || '',
    dokumen: dokumen || '',
    statusDokumen: statusDokumen || '',
    status: status || row.statusPembayaran || '',
    pembayaran: status || row.statusPembayaran || '',
    nik: nik || '',
    passport: passport || '',
    paspor: passport || '',
    noPaspor: passport || row.noPaspor || '',
    manifestId: manifestId || '',
    identityType: identityType || '',
    tempatLahir: tempatLahir || '',
    tanggalLahir: tanggalLahir || '',
    kotaPaspor: kotaPaspor || '',
    tanggalExpiredPaspor: tanggalExpiredPaspor || '',
    noHp: getByKeys(['no hp', 'no telp', 'telepon', 'hp', 'handphone', 'phone']) || row.noHp || row.hp || '',
    jenisKelamin: getByKeys(['jenis kelamin', 'jk', 'gender']) || row.jenisKelamin || '',
    tipe: row.tipe || getByKeys(['tipe']) || '',
    kotaAsal: row.kotaAsal || getByKeys(['kota asal', 'kota', 'domisili', 'asal']) || '',
    keberangkatan: getByKeys(['keberangkatan', 'tgl berangkat', 'tanggal berangkat', 'departure', 'jadwal']) || row.keberangkatan || '',
    rawScrapedText: (row.rawScrapedText || row.rawText || '').slice(0, 2200),
  };

  if (row.manifestFetched === true) obj.manifestFetched = true;

  if (!obj.shortCode && obj.orderCode) obj.shortCode = extractOrderShortCode(obj.orderCode);
  if (!obj.shortCode && obj.kodeOrder) obj.shortCode = extractOrderShortCode(obj.kodeOrder);
  if (!obj.shortCode && obj.orderId) obj.shortCode = extractOrderShortCode(obj.orderId);
  if (!obj.shortCode) obj.shortCode = '';

  Object.keys(obj).forEach((k) => {
    // Lima properti ini wajib selalu ada agar shape data konsisten, meskipun
    // nilainya kosong (mis. jamaah yang belum punya NIK/paspor).
    if (['nama', 'orderId', 'rtb', 'nik', 'paspor'].includes(k)) return;
    if (obj[k] === '' || obj[k] === null || obj[k] === undefined) delete obj[k];
  });

  if (!obj.nama && !obj.noRtb && !obj.rtb && !obj.orderCode && !obj.orderId && !obj.shortCode && !obj.rawScrapedText) return null;
  // Baris tanpa nama bukan data jamaah. Jangan pernah mengisi nama placeholder
  // karena itu sama saja dengan membuat data fiktif.
  if (!obj.nama) return null;
  if (!obj.jamaahList) obj.jamaahList = [];
  return obj;
}

export function getJamaahDataFilePath() {
  return DATA_FILE;
}

/**
 * Tulis JSON secara atomik: tulis ke file sementara lalu rename.
 * Fallback copy/write langsung dipakai bila Windows mengunci file target.
 */
function writeJsonAtomic(payload) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(payload, null, 2);
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, json, 'utf8');

  try {
    fs.renameSync(tmpFile, DATA_FILE);
    return;
  } catch {
    try {
      fs.copyFileSync(tmpFile, DATA_FILE);
      fs.unlinkSync(tmpFile);
      return;
    } catch {
      // Coba tulis langsung sebagai upaya terakhir.
    }
  }

  try {
    fs.writeFileSync(DATA_FILE, json, 'utf8');
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // File sementara mungkin sudah tidak ada.
    }
  }
}

/** Simpan data jamaah aktif + info sumber ke file JSON lokal. */
function persistJamaahData() {
  if (activeJamaah.length === 0) return false;
  try {
    writeJsonAtomic({
      version: DATA_FILE_VERSION,
      savedAt: new Date().toISOString(),
      source: sourceInfo,
      count: activeJamaah.length,
      jamaah: activeJamaah,
    });
    const nikCount = activeJamaah.filter((j) => j.nik || j.ktp).length;
    const passportCount = activeJamaah.filter(
      (j) => j.passport || j.paspor || j.noPaspor,
    ).length;
    console.log(
      `[jamaahStore] Tersimpan permanen: ${activeJamaah.length} jamaah ` +
        `(NIK ${nikCount}, Paspor ${passportCount}) -> ${DATA_FILE}`,
    );
    return true;
  } catch (error) {
    console.error(
      `[jamaahStore] GAGAL menyimpan data ke ${DATA_FILE}: ${error.message}. ` +
        'Data tetap tersedia di memori; periksa izin tulis folder.',
    );
    return false;
  }
}

/**
 * Baca data permanen dari file JSON. Data yang sudah ada di memori tidak
 * ditimpa kecuali dipanggil eksplisit saat store kosong/startup.
 */
export function loadJamaahDataFromDisk({ reason = 'startup' } = {}) {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;

    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!raw) return false;

    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.jamaah)
        ? parsed.jamaah
        : Array.isArray(parsed?.data)
          ? parsed.data
          : [];
    const storedSource =
      !Array.isArray(parsed) && parsed?.source && typeof parsed.source === 'object'
        ? parsed.source
        : null;

    // Tombstone dari clearJamaahData(): file sengaja tidak berisi jamaah.
    if (rows.length === 0) return false;

    const mapped = rows.map(mapRow).filter(Boolean);
    if (mapped.length === 0) {
      console.warn(
        `[jamaahStore] File ${DATA_FILE} tidak berisi baris jamaah valid. Store tetap kosong.`,
      );
      return false;
    }

    activeJamaah = mapped;
    sourceInfo = {
      type: storedSource?.type || 'file',
      url: storedSource?.url || null,
      filename: storedSource?.filename || null,
      modules: storedSource?.modules || null,
      count: mapped.length,
      fieldCoverage: {
        nik: mapped.filter((j) => j.nik || j.ktp).length,
        passport: mapped.filter((j) => j.passport || j.paspor || j.noPaspor).length,
        manifestId: mapped.filter((j) => j.manifestId).length,
      },
      loadedAt: storedSource?.loadedAt || new Date().toISOString(),
      savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : null,
      restoredAt: new Date().toISOString(),
      storage: 'local-json',
      dataFile: DATA_FILE,
    };
    lastEmptyWarningAt = 0;
    console.log(
      `[jamaahStore] Memuat ${mapped.length} jamaah permanen dari ${DATA_FILE}` +
        `${reason ? ` (${reason})` : ''}.`,
    );
    return true;
  } catch (error) {
    console.error(
      `[jamaahStore] Gagal membaca ${DATA_FILE}: ${error.message}. ` +
        'Store tetap kosong; jalankan scrape Monitoring Jamaah bila perlu.',
    );
    return false;
  }
}

/** Lazy-load saat store kosong, mis. data belum terbaca ketika startup. */
function ensureJamaahDataLoaded(context = '') {
  if (activeJamaah.length > 0) return false;
  return loadJamaahDataFromDisk({ reason: context || 'pencarian' });
}

/** Hapus file permanen; bila gagal, tulis tombstone agar data tidak hidup lagi. */
function removePersistedJamaahData(reason = 'manual') {
  try {
    if (fs.existsSync(DATA_FILE)) {
      fs.unlinkSync(DATA_FILE);
      console.log(`[jamaahStore] File data permanen dihapus: ${DATA_FILE}`);
    }
    return true;
  } catch (error) {
    console.error(
      `[jamaahStore] Gagal menghapus ${DATA_FILE}: ${error.message}. ` +
        'Menulis penanda kosong agar data lama tidak dimuat ulang.',
    );
    try {
      writeJsonAtomic({
        version: DATA_FILE_VERSION,
        clearedAt: new Date().toISOString(),
        reason,
        count: 0,
        source: null,
        jamaah: [],
      });
      return true;
    } catch (writeError) {
      console.error(
        `[jamaahStore] Gagal menulis penanda kosong: ${writeError.message}.`,
      );
      return false;
    }
  }
}

/**
 * Pertahankan NIK/paspor lama hanya untuk baris yang manifest-nya gagal
 * diambil pada scrape kali ini. Jika manifest berhasil dibaca (manifestFetched
 * true), data terbaru dari SGO yang dipakai — termasuk bila memang kosong.
 */
function preserveSensitiveFields(mapped = [], previous = []) {
  if (!mapped.length || !previous.length) return { nik: 0, passport: 0 };

  const index = new Map();
  const add = (key, row) => {
    if (key && !index.has(key)) index.set(key, row);
  };

  for (const prev of previous) {
    if (!prev) continue;
    const name = normalize(prev.nama);
    if (!name) continue;
    const order = normalize(prev.orderCode || prev.kodeOrder || prev.orderId);
    const rtb = rtbNumberOf(prev.rtb || prev.noRtb);
    if (order) add(`o:${order}|${name}`, prev);
    if (rtb) add(`r:${rtb}|${name}`, prev);
  }

  let nik = 0;
  let passport = 0;
  for (const row of mapped) {
    if (!row || row.manifestFetched === true) continue;
    const name = normalize(row.nama);
    if (!name) continue;
    const order = normalize(row.orderCode || row.kodeOrder || row.orderId);
    const rtb = rtbNumberOf(row.rtb || row.noRtb);
    const prev =
      (order && index.get(`o:${order}|${name}`)) ||
      (rtb && index.get(`r:${rtb}|${name}`));
    if (!prev) continue;

    const prevNik = prev.nik || prev.ktp || prev.noKtp || '';
    const prevPassport =
      prev.passport || prev.paspor || prev.noPaspor || prev.nomorPaspor || '';
    if (!(row.nik || row.ktp) && prevNik) {
      row.nik = prevNik;
      row.ktp = prevNik;
      nik += 1;
    }
    if (!(row.passport || row.paspor || row.noPaspor) && prevPassport) {
      row.passport = prevPassport;
      row.paspor = prevPassport;
      row.noPaspor = prevPassport;
      passport += 1;
    }
    if (!row.noHp && prev.noHp) row.noHp = prev.noHp;
    if (!row.tempatLahir && prev.tempatLahir) row.tempatLahir = prev.tempatLahir;
    if (!row.tanggalLahir && prev.tanggalLahir) row.tanggalLahir = prev.tanggalLahir;
    if (!row.kotaPaspor && prev.kotaPaspor) row.kotaPaspor = prev.kotaPaspor;
    if (!row.tanggalExpiredPaspor && prev.tanggalExpiredPaspor) {
      row.tanggalExpiredPaspor = prev.tanggalExpiredPaspor;
    }
    if (!row.identityType && prev.identityType) row.identityType = prev.identityType;
  }

  if (nik || passport) {
    console.log(
      `[jamaahStore] NIK/paspor lama dipertahankan untuk ${nik} NIK dan ${passport} paspor ` +
        '(manifest tidak berhasil dibaca pada scrape ini).',
    );
  }
  return { nik, passport };
}

export function setJamaahData(list = [], info = {}) {
  if (!Array.isArray(list)) {
    console.warn(
      '[jamaahStore] setJamaahData diabaikan: input bukan array. Data lama dipertahankan.',
    );
    return getActiveJamaah();
  }

  const mapped = list.map(mapRow).filter(Boolean);

  // Hasil scrape/upload yang kosong tidak boleh mengosongkan store.
  // Penghapusan data hanya boleh lewat clearJamaahData() yang eksplisit.
  if (mapped.length === 0) {
    if (activeJamaah.length > 0) {
      console.warn(
        `[jamaahStore] PERINGATAN: ${list.length} baris tidak menghasilkan data jamaah valid. ` +
          `Data lama (${activeJamaah.length} jamaah) tetap dipertahankan; store tidak di-reset ke kosong.`,
      );
    } else {
      warnIfJamaahStoreEmpty('setJamaahData tanpa data valid');
    }
    return getActiveJamaah();
  }

  preserveSensitiveFields(mapped, activeJamaah);

  if (info.merge && activeJamaah.length > 0) {
    const seen = new Set();
    for (const j of activeJamaah) {
      const key = (j.orderCode || j.noRtb || j.nama || '').toLowerCase();
      if (key) seen.add(key);
    }
    for (const m of mapped) {
      const key = (m.orderCode || m.noRtb || m.nama || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      activeJamaah.push(m);
    }
  } else {
    activeJamaah = mapped;
  }

  // Data valid sudah masuk; izinkan peringatan segera muncul lagi bila store
  // benar-benar dikosongkan pada request berikutnya.
  lastEmptyWarningAt = 0;

  sourceInfo = {
    type: info.type || 'manual',
    url: info.url || null,
    filename: info.filename || null,
    modules: info.modules || sourceInfo?.modules || null,
    count: activeJamaah.length,
    fieldCoverage: {
      nik: activeJamaah.filter((j) => j.nik || j.ktp).length,
      passport: activeJamaah.filter(
        (j) => j.passport || j.paspor || j.noPaspor,
      ).length,
      manifestId: activeJamaah.filter((j) => j.manifestId).length,
    },
    loadedAt: new Date().toISOString(),
    storage: 'local-json',
    dataFile: DATA_FILE,
  };

  // Wajib simpan ke disk setiap scrape/upload sukses agar tahan restart.
  persistJamaahData();
  return getActiveJamaah();
}

export function clearJamaahData(reason = 'manual') {
  const previousCount = activeJamaah.length;
  const previousType = sourceInfo?.type || 'tidak diketahui';
  activeJamaah = [];
  sourceInfo = null;
  lastEmptyWarningAt = 0;
  removePersistedJamaahData(reason);
  console.log(
    `[jamaahStore] Data jamaah dikosongkan (${reason}). ` +
      `Sebelumnya ${previousCount} jamaah dari ${previousType}. ` +
      'Jalankan scrape Monitoring Jamaah untuk mengisi ulang.',
  );
}

export function hasRealJamaahData() {
  return activeJamaah.length > 0;
}

export function getActiveJamaah() {
  // Bila server baru restart atau scrape dijalankan dari proses lain, pastikan
  // data permanen di jamaah_data.json dibaca sebelum status/daftar dikirim.
  if (!activeJamaah.length) ensureJamaahDataLoaded('getActiveJamaah');
  return activeJamaah.map((j) => ({ ...j }));
}

export function getJamaahSource() {
  return sourceInfo ? { ...sourceInfo } : null;
}

const safeString = (val) => {
  if (val === null || val === undefined) return '';
  return String(val);
};

const safeLower = (val) => safeString(val).toLowerCase();

function normalize(text = '') {
  return safeString(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(text = '') {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length >= 2);
}

const normalizeDocument = (value = '') =>
  safeLower(value).replace(/[^a-z0-9]/g, '');

const digitsOf = (value = '') => safeString(value).replace(/\D/g, '');

function numericTokensOf(value = '') {
  return safeString(value).match(/\d+/g) || [];
}

/** Ambil nomor RTB dari token angka terakhir: "RTB-2026-00123" -> "123". */
function rtbNumberOf(value = '') {
  const tokens = numericTokensOf(value);
  if (!tokens.length) return '';
  return tokens[tokens.length - 1].replace(/^0+/, '') || '0';
}

/**
 * Digit kode order tanpa tahun pembentuk order.
 * "ORD-2026-UMR-003693" -> "ordumr003693"
 */
function orderDigitsWithoutYear(value = '') {
  const text = safeString(value).trim();
  if (!text) return '';
  const parts = text.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  if (parts.length > 1) {
    return parts
      .filter((part) => !/^(?:19|20)\d{2}$/.test(part))
      .join('')
      .toLowerCase();
  }

  // Kode order tanpa pemisah: buang tahun yang mengikuti prefix ORD/ORDER/UMR.
  return text
    .toLowerCase()
    .replace(/^((?:ord|order|umr)[-_ ]?)(?:19|20)\d{2}/, '$1');
}

function orderFieldsOf(j = {}) {
  const full = safeString(
    j.orderCode || j.kodeOrder || j.orderId || j.order_id || '',
  );
  const short = safeString(
    j.shortCode || j.orderShort || extractOrderShortCode(full),
  );
  return {
    full,
    short,
    fullDoc: normalizeDocument(full),
    shortDoc: normalizeDocument(short),
  };
}

/** Cocokkan angka order: exact short code, suffix, atau potongan digit order. */
function matchesOrderNumber(j = {}, rawNumber = '') {
  const raw = safeString(rawNumber).replace(/\D/g, '');
  if (!raw) return false;
  const query = raw.replace(/^0+/, '') || raw;

  const { full, shortDoc } = orderFieldsOf(j);
  const shortDigits = shortDoc.replace(/^0+/, '') || shortDoc;

  if (shortDigits && (shortDigits === raw || shortDigits === query)) return true;

  const orderDigits = digitsOf(full);
  if (orderDigits && (orderDigits === raw || orderDigits === query)) return true;

  // Potongan minimal 4 digit agar angka pendek seperti "307" tidak cocok ke
  // banyak order sekaligus. Tahun order sudah dibuang oleh helper di atas.
  const withoutYear = orderDigitsWithoutYear(full);
  if (raw.length >= 4 && withoutYear.includes(raw)) return true;
  if (query.length >= 4 && withoutYear.includes(query)) return true;

  return false;
}

function documentValuesOf(j = {}) {
  return [
    j.nik,
    j.ktp,
    j.noKtp,
    j.passport,
    j.paspor,
    j.noPaspor,
    j.nomorPaspor,
  ]
    .map((value) => normalizeDocument(value))
    .filter(Boolean);
}

function matchesDocumentNumber(j = {}, target = '') {
  if (!target) return false;
  return documentValuesOf(j).some(
    (value) =>
      value === target || (target.length >= 6 && value.includes(target)),
  );
}

function isNumericQuery(value = '') {
  const text = safeString(value).trim();
  return Boolean(text) && /^[\d\s.\-_/]+$/.test(text);
}

/** RTB dibandingkan berdasarkan nomor terakhir, mis. "RTB-2026-00123" -> 123. */
function matchesRtbNumber(j = {}, rawNumber = '') {
  const target = rtbNumberOf(rawNumber);
  if (!target) return false;
  return [j.rtb, j.noRtb, j.no_registrasi]
    .map((value) => rtbNumberOf(value))
    .some((value) => value && value === target);
}

/** Order ID full/parsial, termasuk input "ORD-2026-UMR-0053" atau "order 3693". */
function matchesOrderQuery(j = {}, rawQuery = '') {
  const text = safeString(rawQuery).trim();
  if (!text) return false;

  const qDoc = normalizeDocument(text);
  const { fullDoc } = orderFieldsOf(j);
  if (qDoc && fullDoc) {
    if (qDoc === fullDoc) return true;
    if (qDoc.length >= 5 && fullDoc.includes(qDoc)) return true;
  }

  return numericTokensOf(text).some((token) => matchesOrderNumber(j, token));
}

const QUERY_STOPWORDS = new Set([
  'cari', 'carikan', 'tolong', 'mohon', 'silakan', 'data', 'jamaah', 'peserta',
  'nama', 'bernama', 'order', 'kode', 'nomor', 'no', 'rtb', 'paket', 'program',
  'tampilkan', 'lihat', 'cek', 'check', 'status', 'dari', 'untuk', 'yang',
  'dengan', 'itu', 'ini', 'apa', 'apakah', 'adalah', 'saya', 'aku', 'mau',
  'ingin', 'tahu', 'berapa', 'semua', 'seluruh', 'daftar', 'di', 'ke', 'dan',
  'atau', 'pada', 'punya', 'milik', 'terdaftar', 'terdata', 'ada', 'dong',
  'ya', 'nih', 'kak', 'min', 'admin', 'bos',
  // Label dokumen bukan bagian dari nama jamaah. Tanpa ini, query seperti
  // "NIK 320123" bisa salah cocok ke nama yang mengandung "nik".
  'nik', 'ktp', 'paspor', 'pasport', 'passport', 'booking', 'invoice',
  'pendaftaran',
]);

function nameWordsOf(value = '') {
  return tokenize(value).filter((t) => !QUERY_STOPWORDS.has(t) && !/^\d+$/.test(t));
}

const LOOKUP_CUE_RE =
  /\b(?:nik|ktp|no\.?\s*ktp|nomor\s+ktp|paspor|pasport|passport|no\.?\s*paspor|nomor\s+paspor|order|kode\s+order|no\.?\s*order|nomor\s+order|rtb|no\.?\s*rtb|nomor\s+rtb|pendaftaran|booking|invoice)\b/gi;
const LOOKUP_FILLER_RE =
  /\b(?:cari|carikan|tolong|mohon|silakan|tampilkan|lihat|cek|check|data|jamaah|jamaahnya|peserta|pesertanya|nama|bernama|dari|untuk|yang|ini|itu|saya|aku|mau|ingin|tahu|dong|ya|nih|kak|min|admin|bos)\b/gi;

/**
 * Pecah query menjadi beberapa bentuk sekaligus:
 * - nq           : teks ternormalisasi penuh
 * - cleanNorm    : tanpa label (NIK/order/RTB) dan kata perintah
 * - qDoc/qDocCore: hanya huruf+angka, untuk NIK/paspor/kode order
 * - qDigits...   : hanya angka, untuk order/RTB/NIK
 */
function buildQueryContext(query = '') {
  const raw = safeString(query).trim();
  const clean = raw
    .replace(LOOKUP_CUE_RE, ' ')
    .replace(LOOKUP_FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const qDigits = digitsOf(raw);
  const qDigitsCore = digitsOf(clean);
  const passportToken = (raw.match(/\b[A-Z]{1,2}\d{6,9}\b/i) || [])[0] || '';
  const hasNikCue = /\b(?:nik|ktp|no\.?\s*ktp|nomor\s+ktp)\b/i.test(raw);
  const hasPassportCue =
    /\b(?:paspor|pasport|passport|no\.?\s*paspor|nomor\s+paspor)\b/i.test(raw);
  const hasRtbCue = /\brtb\b/i.test(raw);
  const hasOrderCue =
    /\b(?:order|kode|booking|invoice|pendaftaran|no\.?\s*order|nomor\s+order)\b/i.test(
      raw,
    ) || /(?:^|[^a-z0-9])(?:ord|umr)[-_ ]?\d{4}/i.test(raw);

  // Query murni angka boleh dicocokkan ke nomor order/RTB. Query yang memuat
  // huruf (mis. "paspor B162" atau "A1234567") hanya boleh memakai angka untuk
  // field yang memang diberi label — supaya digit paspor tidak dianggap RTB.
  const cleanNorm = normalize(clean);
  const cleanHasLetters = /[a-z]/i.test(cleanNorm);
  const numericOnly = Boolean(qDigitsCore) && !cleanHasLetters;

  return {
    raw,
    nq: normalize(raw),
    cleanNorm,
    qDoc: normalizeDocument(raw),
    qDocCore: normalizeDocument(clean),
    qDigits,
    qDigitsCore,
    qDigitsTrim: qDigitsCore.replace(/^0+/, '') || qDigitsCore,
    passportToken,
    cleanHasLetters,
    numericOnly,
    allowNumericOrder: numericOnly || hasOrderCue,
    allowNumericRtb: numericOnly || hasRtbCue,
    nameTokens: nameWordsOf(raw),
    hasNikCue,
    hasPassportCue,
    hasRtbCue,
    hasOrderCue,
    rtbTarget: hasRtbCue ? rtbNumberOf(raw) : '',
  };
}

/**
 * Skor nama: exact/whole-word lebih tinggi, lalu substring (mis. "Nasmi"
 * cocok ke "NASMIATI", "Muh" cocok ke "MUHAMMAD").
 */
function nameMatchInfo(name = '', ctx = {}) {
  const nameNorm = normalize(name);
  if (!nameNorm) return { score: 0, type: '' };
  if (ctx.nq && nameNorm === ctx.nq) return { score: 1000, type: 'name' };

  const tokens = ctx.nameTokens || [];
  if (!tokens.length) return { score: 0, type: '' };

  const nameWords = nameNorm.split(' ').filter(Boolean);
  let allWord = true;
  let allHit = true;
  let usedPrefix = false;

  for (const token of tokens) {
    if (nameWords.includes(token)) continue;
    allWord = false;
    if (token.length >= 3 && nameNorm.includes(token)) continue;
    if (
      token.length === 2 &&
      tokens.length > 1 &&
      nameWords.some((word) => word.startsWith(token))
    ) {
      usedPrefix = true;
      continue;
    }
    allHit = false;
    break;
  }

  if (!allHit) return { score: 0, type: '' };
  if (allWord) {
    return { score: tokens.length > 1 ? 900 : 820, type: 'name' };
  }
  return { score: usedPrefix ? 700 : 750, type: 'name' };
}

/** Skor order: full code, potongan angka, short code, atau suffix. */
function orderMatchInfo(j = {}, ctx = {}) {
  const fields = orderFieldsOf(j);
  if (!fields.full && !fields.short) return { score: 0, type: '' };

  const fullDoc = fields.fullDoc;
  const shortDigits = fields.shortDoc.replace(/^0+/, '');
  const targets = [ctx.qDigitsTrim, ctx.qDigitsCore.replace(/^0+/, '')]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  // Buang hanya tahun yang menempel tepat setelah prefix ORD/ORDER/UMR,
  // supaya angka tahun tidak membuat "2026" cocok ke semua order.
  const withoutYearDoc = normalizeDocument(
    fields.full.replace(
      /^((?:ORD|ORDER|UMR)[-_ ]?)(?:19|20)\d{2}[-_ ]?/i,
      '$1',
    ),
  );

  let score = 0;
  if (ctx.nq && normalize(fields.full) === ctx.nq) score = 1000;
  else if (ctx.qDoc && fullDoc === ctx.qDoc) score = 1000;
  else if (ctx.qDocCore && fullDoc === ctx.qDocCore) score = 1000;
  else if (ctx.qDocCore.length >= 4 && withoutYearDoc.includes(ctx.qDocCore)) {
    score = 850;
  } else if (
    !/^(?:19|20)\d{2}$/.test(ctx.qDoc) &&
    ctx.qDoc.length >= 5 &&
    fullDoc.includes(ctx.qDoc)
  ) {
    score = 850;
  }

  if (
    ctx.allowNumericOrder !== false &&
    !score &&
    shortDigits &&
    targets.some(
      (target) =>
        target === shortDigits ||
        (target.length >= 3 && shortDigits.endsWith(target)),
    )
  ) {
    score = 900;
  }
  if (
    ctx.allowNumericOrder !== false &&
    !score &&
    targets.some((target) => matchesOrderNumber(j, target))
  ) {
    score = 800;
  }

  return score ? { score, type: 'order' } : { score: 0, type: '' };
}

/** Skor NIK/paspor: exact dulu, lalu substring minimal 4 karakter. */
function documentMatchInfo(j = {}, ctx = {}) {
  const nikValues = [j.nik, j.ktp, j.noKtp]
    .map((value) => normalizeDocument(value))
    .filter(Boolean);
  const passportValues = [
    j.passport,
    j.paspor,
    j.noPaspor,
    j.nomorPaspor,
  ]
    .map((value) => normalizeDocument(value))
    .filter(Boolean);

  const normalizeTargets = (values) => {
    const targets = [];
    for (const value of values) {
      const target = normalizeDocument(value);
      if (target && !targets.includes(target)) targets.push(target);
    }
    return targets;
  };

  const cleanText = ctx.cleanNorm || '';
  const queryHasLetters = /[a-z]/i.test(cleanText);

  // NIK selalu angka. Jika query berbentuk paspor (huruf+angka), jangan
  // memakai digitnya untuk mencocokkan NIK — mis. "A1234567" bukan NIK.
  const nikTargetValues = [ctx.qDocCore];
  if (!queryHasLetters) nikTargetValues.push(ctx.qDigitsCore);
  const nikTargets = normalizeTargets(nikTargetValues);

  // Paspor boleh dicocokkan dengan bentuk lengkap (huruf+angka). Bentuk angka
  // saja hanya dipakai bila query memang numerik murni.
  const passportTargetValues = [ctx.qDocCore, ctx.passportToken];
  if (!queryHasLetters) passportTargetValues.push(ctx.qDigitsCore);
  const passportTargets = normalizeTargets(passportTargetValues);

  for (const target of nikTargets) {
    for (const value of nikValues) {
      if (value === target && target.length >= 6) {
        return { score: 1000, type: 'nik' };
      }
      if (target.length >= 4 && value.includes(target)) {
        return { score: 850, type: 'nik' };
      }
      if (target.length > value.length && value.length >= 8 && target.includes(value)) {
        return { score: 800, type: 'nik' };
      }
    }
  }

  for (const target of passportTargets) {
    for (const value of passportValues) {
      if (value === target && target.length >= 5) {
        return { score: 1000, type: 'passport' };
      }
      if (target.length >= 4 && value.includes(target)) {
        return { score: 850, type: 'passport' };
      }
      if (target.length > value.length && value.length >= 6 && target.includes(value)) {
        return { score: 800, type: 'passport' };
      }
    }
  }

  return { score: 0, type: '' };
}

/** Skor RTB berdasarkan nomor terakhir, mis. "RTB 32" / "RTB-2026-0032". */
function rtbMatchInfo(j = {}, ctx = {}) {
  const values = [j.rtb, j.noRtb, j.no_registrasi]
    .map((value) => rtbNumberOf(value))
    .filter(Boolean);
  if (!values.length) return { score: 0, type: '' };

  const targets = [ctx.rtbTarget, ctx.allowNumericRtb ? ctx.qDigitsTrim : '']
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);

  for (const target of targets) {
    if (values.includes(target)) return { score: 1000, type: 'rtb' };
  }
  for (const target of targets) {
    if (target.length >= 2 && values.some((value) => value.startsWith(target))) {
      return { score: 650, type: 'rtb-partial' };
    }
    if (target.length >= 3 && values.some((value) => value.includes(target))) {
      return { score: 600, type: 'rtb-partial' };
    }
  }
  return { score: 0, type: '' };
}

/** Skor paket, mis. "Umroh Plus" atau "Qatar". */
function paketMatchInfo(j = {}, ctx = {}) {
  const paket = normalize(j.paket);
  if (!paket) return { score: 0, type: '' };

  for (const candidate of [ctx.cleanNorm, ctx.nq]) {
    if (candidate.length >= 4 && paket.includes(candidate)) {
      return { score: 450, type: 'paket' };
    }
  }
  if (
    ctx.nameTokens.length >= 2 &&
    ctx.nameTokens.every((token) => paket.includes(token))
  ) {
    return { score: 400, type: 'paket' };
  }
  return { score: 0, type: '' };
}

function scoreJamaahRow(j = {}, ctx = {}) {
  const parts = [
    nameMatchInfo(j.nama, ctx),
    orderMatchInfo(j, ctx),
    documentMatchInfo(j, ctx),
    rtbMatchInfo(j, ctx),
    paketMatchInfo(j, ctx),
  ].filter((part) => part.score > 0);

  if (!parts.length) return { score: 0, types: [] };
  const best = parts.reduce((top, part) => (part.score > top.score ? part : top));
  return {
    score: best.score,
    types: parts.map((part) => part.type),
  };
}

const matchCategory = (type = '') => type.replace(/-partial$/, '');

/**
 * Cek cepat apakah query cocok dengan nama jamaah (exact, whole-word, atau
 * substring). Dipakai aiEngine untuk membedakan nama dari obrolan umum.
 */
export function hasJamaahNameMatch(query = '') {
  const q = safeString(query).trim();
  if (!q) return false;
  const ctx = buildQueryContext(q);
  if (!ctx.nameTokens.length) return false;

  ensureJamaahDataLoaded('cek nama jamaah');
  return activeJamaah.some((j) => j && nameMatchInfo(j.nama, ctx).score > 0);
}

/**
 * Cek apakah query cocok dengan nama paket yang benar-benar ada di data SGO.
 * Dipakai agar nama paket penuh (mis. "Umroh Plus Thaif") diperlakukan sebagai
 * pencarian data, bukan FAQ umum.
 */
export function hasJamaahPackageMatch(query = '') {
  const q = normalize(query)
    .replace(/\b(?:paket|program|produk)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q || q.length < 4) return false;

  const tokens = q
    .split(' ')
    .filter((token) => token.length >= 3 && !['umrah', 'umroh', 'haji'].includes(token));
  if (!tokens.length) return false;

  ensureJamaahDataLoaded('cek paket jamaah');
  return activeJamaah.some((j) => {
    const paket = normalize(j?.paket);
    if (!paket) return false;
    return paket === q || paket.includes(q) || tokens.every((token) => paket.includes(token));
  });
}

/** Cek substring nomor paspor, termasuk pencarian parsial tanpa label. */
export function hasJamaahPassportMatch(query = '') {
  const q = normalizeDocument(query);
  if (!q || q.length < 4) return false;

  ensureJamaahDataLoaded('cek paspor jamaah');
  return activeJamaah.some((j) => {
    const passport = normalizeDocument(
      j?.passport || j?.paspor || j?.noPaspor || j?.nomorPaspor || '',
    );
    return Boolean(passport && passport.includes(q));
  });
}

/** Cek nomor RTB pendek/parsial, mis. "32" untuk RTB 32. */
export function hasJamaahRtbMatch(query = '') {
  const q = normalize(query);
  if (!/^\d{2,6}$/.test(q)) return false;

  ensureJamaahDataLoaded('cek RTB jamaah');
  return activeJamaah.some((j) => {
    const value = rtbNumberOf(j?.rtb || j?.noRtb || j?.no_registrasi || '');
    return Boolean(value && (value === q || value.startsWith(q) || value.includes(q)));
  });
}

function jamaahKey(j = {}) {
  return [
    normalize(j.nama),
    normalize(j.orderCode || j.kodeOrder || j.orderId || j.order_id),
    normalize(j.rtb || j.noRtb),
  ].join('|');
}

function notFound(query, matchType = '') {
  return {
    found: false,
    query,
    matchType,
    jamaah: null,
    matches: [],
    message: `Data jamaah dengan kata kunci '${query}' tidak ditemukan.`,
  };
}

/**
 * Pencarian universal, case-insensitive, dan substring:
 * nama, kode order (full/parsial), RTB, NIK, paspor, dan paket.
 * Exact/whole-word diberi skor lebih tinggi; substring tetap dicari.
 */
export function findJamaah(query = '') {
  const q = safeString(query).trim();
  if (!q) return notFound(q);

  // Bila server baru restart dan data belum terbaca, coba ambil dari disk dulu.
  ensureJamaahDataLoaded('pencarian jamaah');
  const isRealData = hasRealJamaahData();
  if (!isRealData) {
    warnIfJamaahStoreEmpty(`pencarian "${q}"`);
  }

  // Pencarian hanya memakai data asli hasil scrape SGO. Bila store kosong,
  // hasilnya benar-benar kosong dan tidak diisi data contoh.
  const safeSource = isRealData ? activeJamaah.filter(Boolean) : [];
  const ctx = buildQueryContext(q);

  let scored = safeSource
    .map((j) => ({ j, ...scoreJamaahRow(j, ctx) }))
    .filter((item) => item.score > 0);

  // Jika query memakai label eksplisit (NIK/paspor/RTB/order), utamakan field
  // tersebut. Bila tidak ada hasil, fallback ke pencarian universal agar data
  // yang tetap ada tidak dilaporkan "tidak ditemukan".
  const preferredCategories = [];
  if (ctx.hasNikCue) preferredCategories.push('nik');
  if (ctx.hasPassportCue || ctx.passportToken) preferredCategories.push('passport');
  if (ctx.hasRtbCue) preferredCategories.push('rtb');
  if (ctx.hasOrderCue) preferredCategories.push('order');

  if (preferredCategories.length) {
    const preferred = scored.filter((item) =>
      item.types.some((type) =>
        preferredCategories.includes(matchCategory(type)),
      ),
    );
    if (preferred.length) scored = preferred;
  }

  if (!scored.length) return notFound(q);

  const maxScore = Math.max(...scored.map((item) => item.score));
  let cutoff;
  if (maxScore >= 950) {
    const top = scored.find((item) => item.score === maxScore);
    const topCategories = top.types.map(matchCategory);
    const singleTokenName =
      topCategories.includes('name') &&
      ctx.nameTokens.length === 1 &&
      !topCategories.some((category) =>
        ['nik', 'passport', 'rtb', 'order'].includes(category),
      );
    cutoff = singleTokenName ? 750 : 900;
  } else if (maxScore >= 850) {
    cutoff = 750;
  } else if (maxScore >= 700) {
    cutoff = 600;
  } else if (maxScore >= 500) {
    cutoff = 400;
  } else {
    cutoff = 200;
  }

  scored = scored.filter((item) => item.score >= cutoff);

  const seen = new Set();
  scored = scored.filter(({ j }) => {
    const key = jamaahKey(j);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aName = normalize(a.j.nama);
    const bName = normalize(b.j.nama);
    const aExact = aName === ctx.nq ? 0 : 1;
    const bExact = bName === ctx.nq ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return aName.localeCompare(bName);
  });

  if (!scored.length) return notFound(q);

  const matches = scored.map((item) => item.j);
  const categories = [
    ...new Set(
      scored.flatMap((item) => item.types.map(matchCategory)),
    ),
  ];
  const matchType =
    categories.length === 1 ? categories[0] : categories.length > 1 ? 'universal' : '';

  return {
    found: true,
    query: q,
    matchType,
    jamaah: { ...matches[0] },
    matches: matches.map((j) => ({ ...j })),
    message: `Data jamaah ditemukan: ${matches[0].nama}.`,
  };
}

export { safeString, safeLower };

export function formatJamaahDetail(j = {}) {
  const lines = [];
  if (j.orderCode || j.kodeOrder || j.orderId) lines.push(`Kode Order: ${j.orderCode || j.kodeOrder || j.orderId}${j.shortCode ? ` (Short: ${j.shortCode})` : ''}`);
  if (j.nama) lines.push(`Nama: ${j.nama}`);
  if (j.noRtb || j.rtb) lines.push(`No. RTB: ${j.noRtb || j.rtb}`);
  if (j.nik || j.ktp) lines.push(`NIK/KTP: ${j.nik || j.ktp}`);
  if (j.passport || j.paspor || j.noPaspor) {
    lines.push(`Paspor: ${j.passport || j.paspor || j.noPaspor}`);
  }
  if (j.tempatLahir || j.tanggalLahir) {
    lines.push(`Tempat/Tanggal Lahir: ${[j.tempatLahir, j.tanggalLahir].filter(Boolean).join(', ')}`);
  }
  if (j.noHp || j.hp || j.telepon) lines.push(`No. HP: ${j.noHp || j.hp || j.telepon}`);
  if (j.jenisKelamin) lines.push(`Jenis Kelamin: ${j.jenisKelamin}`);
  if (j.tipe) lines.push(`Tipe: ${j.tipe}`);
  if (j.kotaAsal) lines.push(`Kota Asal: ${j.kotaAsal}`);
  if (j.paket) lines.push(`Paket: ${j.paket}${j.paketId ? ` (${j.paketId})` : ''}`);
  if (j.keberangkatan) lines.push(`Keberangkatan: ${j.keberangkatan}`);
  if (j.kamar) lines.push(`Kamar: ${j.kamar}`);
  if (j.maskapai) lines.push(`Maskapai: ${j.maskapai}`);
  if (j.hotelMekkah) lines.push(`Hotel Mekkah: ${j.hotelMekkah}`);
  if (j.hotelMadinah) lines.push(`Hotel Madinah: ${j.hotelMadinah}`);
  if (j.statusPembayaran) lines.push(`Status Pembayaran: ${j.statusPembayaran}`);
  if (j.statusBerangkat || j.status) lines.push(`Status Berangkat: ${j.statusBerangkat || j.status}`);
  if (j.agen) lines.push(`Agen: ${j.agen}`);
  if (j.tanggalDaftar) lines.push(`Tanggal Daftar: ${j.tanggalDaftar}`);
  for (const [k, v] of Object.entries(j)) {
    if (!v) continue;
    const known = [
      'id', 'nama', 'noRtb', 'rtb', 'nik', 'ktp', 'noKtp', 'passport',
      'paspor', 'noPaspor', 'nomorPaspor', 'manifestId', 'jamaahId',
      'manifestFetched', 'identityType', 'tempatLahir', 'tanggalLahir',
      'kotaPaspor', 'tanggalExpiredPaspor', 'noHp', 'hp', 'telepon',
      'jenisKelamin', 'tipe', 'kotaAsal', 'paket', 'paketId', 'keberangkatan',
      'kamar', 'maskapai', 'hotelMekkah', 'hotelMadinah', 'statusPembayaran',
      'statusBerangkat', 'status', 'agen', 'tanggalDaftar', 'orderCode',
      'orderId', 'kodeOrder', 'shortCode', 'orderShort',
    ];
    if (known.includes(k)) continue;
    if (typeof v === 'object') continue;
    lines.push(`${k.replace(/_/g, ' ')}: ${v}`);
  }
  return lines.join('\n');
}

export function getJamaahData() {
  return getActiveJamaah();
}

export function getAllJamaah() {
  // Tidak ada fallback mock. Store kosong berarti daftar jamaah kosong.
  return getActiveJamaah();
}

// Muat data permanen begitu modul diimpor (server start/restart).
loadJamaahDataFromDisk({ reason: 'startup' });

export default { setJamaahData, clearJamaahData, hasRealJamaahData, getActiveJamaah, getJamaahData, getJamaahSource, findJamaah, hasJamaahNameMatch, hasJamaahPackageMatch, hasJamaahPassportMatch, hasJamaahRtbMatch, formatJamaahDetail, getAllJamaah, extractOrderShortCode, getOrderAliases, loadJamaahDataFromDisk, getJamaahDataFilePath };
