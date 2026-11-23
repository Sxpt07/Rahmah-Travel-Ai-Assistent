/**
 * Normalisasi tanggal keberangkatan SGO.
 *
 * SGO menampilkan tanggal dalam beberapa bentuk:
 * - opsi paket: `RTB-203 · ... (2026-09-01)`
 * - header manifest: `Berangkat 13 Dec 2026`
 * - data Monitoring Jamaah: `24 Dec 2026`
 * - label Indonesia: `13 Desember 2026`
 *
 * Semua bentuk dinormalisasi ke ISO `YYYY-MM-DD` agar bisa di-query SQLite,
 * dengan label bulan Indonesia untuk dropdown dan kartu.
 */

const MONTH_NAMES = [
  '',
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

const MONTH_ALIASES = new Map();

const MONTH_ALIASES_LIST = [
  [1, ['jan', 'january', 'januari']],
  [2, ['feb', 'february', 'februari', 'pebruari']],
  [3, ['mar', 'march', 'maret']],
  [4, ['apr', 'april']],
  [5, ['may', 'mei']],
  [6, ['jun', 'june', 'juni']],
  [7, ['jul', 'july', 'juli']],
  [8, ['aug', 'august', 'agu', 'agt', 'agustus']],
  [9, ['sep', 'sept', 'september']],
  [10, ['oct', 'oktober', 'okt']],
  [11, ['nov', 'november', 'nopember']],
  [12, ['dec', 'desember', 'des']],
];

for (const [month, aliases] of MONTH_ALIASES_LIST) {
  for (const alias of aliases) MONTH_ALIASES.set(alias, month);
}

const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const DAY_MONTH_YEAR_RE =
  /\b(\d{1,2})(?:st|nd|rd|th)?[\s./-]+([A-Za-z]{3,10})[\s,./-]+(\d{4})\b/i;
const NUMERIC_DATE_RE = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/;

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return null;
  }
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }

  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() + 1 !== m ||
    check.getUTCDate() !== d
  ) {
    return null;
  }

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function detailFromIso(iso) {
  if (!iso) {
    return {
      iso: '',
      year: null,
      month: null,
      day: null,
      monthKey: '',
      monthLabel: '',
      monthShortLabel: '',
      displayDate: '',
    };
  }

  const [year, month, day] = iso.split('-').map(Number);
  const monthLabel = `${MONTH_NAMES[month]} ${year}`;

  return {
    iso,
    year,
    month,
    day,
    monthKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    monthLabel,
    monthShortLabel: `${MONTH_NAMES[month].slice(0, 3)} ${year}`,
    displayDate: `${day} ${MONTH_NAMES[month]} ${year}`,
  };
}

/**
 * Tanggal placeholder SGO untuk order yang reschedule tanpa tanggal pasti.
 * Nilai ini tidak boleh muncul sebagai "Desember 2099" pada filter FU.
 */
export function isPlaceholderDepartureIso(iso = '') {
  return /^(?:2099|2100)-12-31$/.test(cleanText(iso));
}

export function extractIsoDateFromText(value = '') {
  const text = cleanText(value);
  if (!text) return '';

  const isoMatch = text.match(ISO_DATE_RE);
  if (isoMatch) return toIso(isoMatch[1], isoMatch[2], isoMatch[3]) || '';

  const namedMatch = text.match(DAY_MONTH_YEAR_RE);
  if (namedMatch) {
    const month = MONTH_ALIASES.get(namedMatch[2].toLowerCase());
    return toIso(namedMatch[3], month, namedMatch[1]) || '';
  }

  const numericMatch = text.match(NUMERIC_DATE_RE);
  if (numericMatch) {
    return toIso(numericMatch[3], numericMatch[2], numericMatch[1]) || '';
  }

  return '';
}

/**
 * @param {string} value teks yang memuat tanggal
 * @returns {ReturnType<typeof detailFromIso> & {sourceText: string}}
 */
export function parseDepartureDate(value = '') {
  const sourceText = cleanText(value);
  const iso = extractIsoDateFromText(sourceText);
  return {
    ...detailFromIso(iso || (isPlaceholderDepartureIso(sourceText) ? sourceText : '')),
    sourceText,
  };
}

export function formatDepartureDisplay(iso = '', fallback = '') {
  const cleanIso = cleanText(iso);
  if (cleanIso && isPlaceholderDepartureIso(cleanIso)) {
    return 'Belum ditentukan';
  }
  if (cleanIso && /^\d{4}-\d{2}-\d{2}$/.test(cleanIso)) {
    const detail = detailFromIso(cleanIso);
    if (detail.displayDate) return detail.displayDate;
  }
  return cleanText(fallback) || 'Belum terjadwal';
}

export function monthLabelFromKey(monthKey = '') {
  const match = cleanText(monthKey).match(/^(\d{4})-(\d{2})$/);
  if (!match) return '';
  const month = Number(match[2]);
  if (month < 1 || month > 12) return '';
  return `${MONTH_NAMES[month]} ${match[1]}`;
}

export function monthNumberFromName(value = '') {
  return MONTH_ALIASES.get(cleanText(value).toLowerCase()) || 0;
}

export {
  MONTH_NAMES,
  ISO_DATE_RE,
  DAY_MONTH_YEAR_RE,
  detailFromIso,
};
