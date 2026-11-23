export const FU_PELUNASAN_MINIMAL = 'Rp 5.000.000/pax';

const SALAM = "Assalamu'alaikum Warahmatullahi Wabarakatuh 😊";
const DEFAULT_GREETING = 'Yth. Bapak/Ibu,';
const DEFAULT_INTRO =
  'Semoga Bapak/Ibu senantiasa sehat dan dalam lindungan Allah SWT. Kami dari Rahmah Travel ingin menyampaikan informasi mengenai sisa pembayaran umroh Bapak/Ibu.';
const DEFAULT_CLOSING =
  'Jika Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini. Kami siap membantu bila ada pertanyaan.';
const DEFAULT_THANKS =
  'Terima kasih atas perhatian dan kerja sama Bapak/Ibu. 🙏';
const SIGNATURE_LINES = ['Salam hangat,', 'Rahmah Travel'];

const DETAIL_ORDER = ['sisa', 'status', 'pembayaran', 'invoice'];
const DETAIL_ICONS = {
  sisa: '📌',
  status: '📅',
  pembayaran: '💳',
  invoice: '🔗',
};
const DETAIL_LABEL_PATTERN =
  'Sisa\\s+(?:Tagihan|Pembayaran)\\s*:|Status\\s+Keberangkatan\\s*:|Keberangkatan\\s*:|(?:Tautan\\s+)?Invoice\\s*:|(?:(?:Opsi|Pilihan|Ketentuan|Informasi)\\s+)?Pembayaran\\s*:|Kode\\s+Order\\s*:';

function text(value = '') {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim();
}

function oneLine(value = '') {
  return text(value).replace(/\s+/g, ' ');
}

function formatRupiah(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 'Rp 0';
  return `Rp ${number.toLocaleString('id-ID')}`;
}

function stripBold(value = '') {
  return String(value).replace(/^\*+|\*+$/g, '').trim();
}

function trimSeparators(value = '') {
  return String(value).replace(/[\s|;]+$/g, '').trim();
}

function normalizeWhatsAppRecipient(value = '') {
  let digits = String(value == null ? '' : value).replace(/\D+/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return digits;
}

export function normalizeMessageText(value = '') {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

export function sanitizeWhatsAppText(value = '') {
  let result = normalizeMessageText(value);

  result = result.replace(/^```[a-z0-9-]*[ \t]*$/gim, '');
  result = result.replace(
    /^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm,
    (_, title) => {
      const clean = String(title).trim();
      return clean ? `*${clean}*` : '';
    },
  );
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi,
    (_, label, url) => `${String(label).trim()}: ${url}`,
  );
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  result = result.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
  result = result.replace(/`([^`]+)`/g, '$1');

  return normalizeMessageText(result);
}

export function fuPelunasanFormatOptions(row = {}) {
  return {
    name: oneLine(row.name),
    sisa: oneLine(row.sisaLabel) || formatRupiah(row.sisaAmount),
    status:
      oneLine(row.departureDays) ||
      oneLine(row.departureDate) ||
      '',
    invoice: oneLine(row.invoiceUrl),
    minimal: oneLine(row.minimalInstallment) || FU_PELUNASAN_MINIMAL,
  };
}

export function buildFuPelunasanMessage(row = {}) {
  const options = fuPelunasanFormatOptions(row);
  const greeting = options.name
    ? `Yth. Bapak/Ibu ${options.name},`
    : DEFAULT_GREETING;
  const status = options.status || 'H-0';
  const sisa = options.sisa;
  const invoice = options.invoice;

  return [
    SALAM,
    '',
    greeting,
    '',
    DEFAULT_INTRO,
    '',
    `📌 Sisa tagihan: *${sisa}*`,
    `📅 Status keberangkatan: ${status}`,
    `💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal ${options.minimal}.`,
    `🔗 Invoice: ${invoice}`,
    '',
    DEFAULT_CLOSING,
    '',
    DEFAULT_THANKS,
    '',
    ...SIGNATURE_LINES,
  ].join('\n');
}

function stripBullet(value = '') {
  return String(value).replace(/^[ \t]*[-*+•][ \t]+/, '');
}

function stripDetailIcon(value = '') {
  return String(value).replace(/^(?:📌|📅|🗓️?|📆|💳|🔗|🧾)[ \t]*/u, '');
}

function detailBody(value = '') {
  return stripDetailIcon(stripBullet(String(value).trim()))
    .replace(/^[*_~]+/, '')
    .trim();
}

function detailKind(value = '') {
  const body = detailBody(value);

  if (/^Sisa\s+(?:Tagihan|Pembayaran)\s*:/i.test(body)) return 'sisa';
  if (/^(?:Status\s+Keberangkatan|Keberangkatan)\s*:/i.test(body)) {
    return 'status';
  }
  if (
    /^(?:(?:Opsi|Pilihan|Ketentuan|Informasi)\s+)?Pembayaran\b/i.test(body)
  ) {
    return 'pembayaran';
  }
  if (/^(?:Tautan\s+)?Invoice\b/i.test(body)) return 'invoice';
  return '';
}

function normalizeDetailLine(kind, value = '') {
  const body = detailBody(value);
  const icon = DETAIL_ICONS[kind];

  if (kind === 'sisa') {
    const amount = trimSeparators(
      stripBold(
        body.replace(/^Sisa\s+(?:Tagihan|Pembayaran)\s*:\s*/i, ''),
      ),
    );
    return `${icon} Sisa tagihan: *${amount}*`;
  }
  if (kind === 'status') {
    const status = trimSeparators(
      stripBold(
        body.replace(/^(?:Status\s+Keberangkatan|Keberangkatan)\s*:\s*/i, ''),
      ),
    );
    return `${icon} Status keberangkatan: ${status}`;
  }
  if (kind === 'pembayaran') {
    const sentence = trimSeparators(
      stripBold(
        body.replace(
          /^(?:(?:Opsi|Pilihan|Ketentuan|Informasi)\s+)?Pembayaran\s*:?\s*/i,
          '',
        ),
      ),
    ).replace(/\.+$/g, '');
    return `${icon} Pembayaran ${sentence}.`;
  }
  if (kind === 'invoice') {
    const invoice = trimSeparators(
      stripBold(body.replace(/^(?:Tautan\s+)?Invoice\s*:\s*/i, '')),
    );
    return `${icon} Invoice: ${invoice}`;
  }

  return `${icon} ${body}`;
}

function hardenDetailLine(kind, value = '', options = {}) {
  if (kind === 'sisa' && options.sisa) {
    return `📌 Sisa tagihan: *${trimSeparators(oneLine(options.sisa))}*`;
  }
  if (kind === 'status' && options.status) {
    return `📅 Status keberangkatan: ${trimSeparators(oneLine(options.status))}`;
  }
  if (kind === 'pembayaran' && options.minimal) {
    return `💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal ${trimSeparators(oneLine(options.minimal))}.`;
  }
  if (kind === 'invoice' && options.invoice) {
    return `🔗 Invoice: ${trimSeparators(oneLine(options.invoice))}`;
  }
  return normalizeDetailLine(kind, value);
}

function splitInlineBlocks(value = '') {
  return String(value)
    .replace(/([.!?])\s+(?=Yth\.\s+Bapak\/Ibu)/gi, '$1\n')
    .replace(/([.!?🙏])\s+(?=Terima kasih\b)/gi, '$1\n')
    .replace(/([.!?])\s+(?=(?:Apabila|Jika)\b)/gi, '$1\n')
    .replace(/(https?:\/\/\S+)\s+(?=(?:Apabila|Jika|Terima kasih)\b)/gi, '$1\n')
    .replace(/([^\n])(?=[ \t]*Salam hangat[ \t]*,?[ \t]*$)/gim, '$1\n')
    .replace(/(.)(?=(?:📌|📅|🗓️?|📆|💳|🔗)\s*)/gu, '$1\n')
    .replace(
      new RegExp(
        `\\s*•\\s*[*_~]*\\s*(?=(?:${DETAIL_LABEL_PATTERN}))`,
        'gi',
      ),
      '\n',
    )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitConcatenatedDetails(line = '') {
  const value = String(line).trim();
  if (!value) return [];

  const keywordMatches = value.match(
    new RegExp(DETAIL_LABEL_PATTERN, 'gi'),
  );
  if (!keywordMatches || keywordMatches.length < 2) return [value];

  return value
    .replace(
      new RegExp(
        `\\s*[|;•]\\s*[*_~]*\\s*(?=(?:${DETAIL_LABEL_PATTERN}))`,
        'gi',
      ),
      '\n',
    )
    .replace(
      new RegExp(
        `([^\\n])\\s+[*_~]*\\s*(?=(?:${DETAIL_LABEL_PATTERN}))`,
        'gi',
      ),
      '$1\n',
    )
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
}

function canonicalGreeting(value = '', options = {}) {
  const name = oneLine(options.name);
  if (name) return `Yth. Bapak/Ibu ${name},`;

  const line = String(value).trim();
  if (!line) return DEFAULT_GREETING;

  const cleaned = line.replace(/^Yth\.?\s*/i, '').trim();
  if (!cleaned || /^Bapak\/Ibu,?$/i.test(cleaned)) return DEFAULT_GREETING;

  return /,$/.test(line) ? line : `${line},`;
}

function cleanIntro(value = '') {
  const line = oneLine(value);
  if (!line) return DEFAULT_INTRO;
  if (
    /(?:Kode\s+Order|Sisa\s+(?:Tagihan|Pembayaran)|Status\s+Keberangkatan|(?:Tautan\s+)?Invoice)\s*:/i.test(
      line,
    )
  ) {
    return DEFAULT_INTRO;
  }
  if (/https?:\/\//i.test(line)) return DEFAULT_INTRO;
  if (/[•]/u.test(line)) return DEFAULT_INTRO;
  return line;
}

function cleanClosing(value = '') {
  let line = oneLine(value);
  line = line
    .replace(/\s*\*?(?:Salam\s+hangat,?|Rahmah\s+Travel)\*?\s*$/i, '')
    .trim();
  return line || DEFAULT_CLOSING;
}

function cleanThanks(value = '') {
  let line = oneLine(value);
  line = line
    .replace(/\s*\*?(?:Salam\s+hangat,?|Rahmah\s+Travel)\*?\s*$/i, '')
    .trim();
  if (!line) return DEFAULT_THANKS;
  return /🙏/u.test(line) ? line : `${line} 🙏`;
}

export function canonicalizeFuPelunasanText(value = '', options = {}) {
  const settings = {
    minimal: FU_PELUNASAN_MINIMAL,
    ...options,
  };
  const source = normalizeMessageText(value);
  const lines = source
    .split('\n')
    .flatMap(splitInlineBlocks)
    .flatMap(splitConcatenatedDetails);

  const greetings = [];
  const intro = [];
  const details = new Map();
  const closing = [];
  const thanks = [];
  let seenDetail = false;

  for (const line of lines) {
    if (/^Assalamu/i.test(line)) continue;
    if (/^Yth\./i.test(line)) {
      greetings.push(line);
      continue;
    }

    const kind = detailKind(line);
    if (kind) {
      seenDetail = true;
      if (!details.has(kind)) details.set(kind, line);
      continue;
    }

    if (/^Terima kasih\b/i.test(line)) {
      thanks.push(line);
      continue;
    }

    if (/^\*?(?:Salam hangat,?|Rahmah Travel)\*?\s*$/i.test(line)) continue;
    if (/^\*?Kode\s+Order\b/i.test(line)) continue;
    if (/^\*?Ketentuan\b/i.test(line)) continue;

    if (seenDetail) {
      if (/https?:\/\//i.test(line)) {
        const last = closing[closing.length - 1] || '';
        if (/[:：]\s*$/.test(last) || /\b(?:tautan|link)\b/i.test(last)) {
          closing.pop();
        }
        continue;
      }
      closing.push(line);
    } else {
      intro.push(line);
    }
  }

  const detailLines = DETAIL_ORDER.map((kind) => {
    const line = details.get(kind) || '';
    const fallback =
      options[kind] || (kind === 'pembayaran' ? settings.minimal : '');
    if (!line && !fallback) return '';
    return hardenDetailLine(kind, line, settings);
  }).filter(Boolean);

  const greeting = canonicalGreeting(greetings[0] || '', options);
  const introText = cleanIntro(intro.join(' '));
  const closingText = cleanClosing(closing.join(' '));
  const thanksText = cleanThanks(thanks.join(' '));

  const blocks = [
    SALAM,
    greeting,
    introText,
    detailLines.join('\n'),
    closingText,
    thanksText,
    SIGNATURE_LINES.join('\n'),
  ].filter(Boolean);

  return blocks.join('\n\n');
}

export function buildWhatsAppTextPayload({ phone, text: body } = {}) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeWhatsAppRecipient(phone),
    type: 'text',
    text: {
      preview_url: true,
      body: normalizeMessageText(body),
    },
  };
}

export function buildWhatsAppDeepLink({ phone, text: body } = {}) {
  const recipient = normalizeWhatsAppRecipient(phone);
  const message = normalizeMessageText(body);
  return `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`;
}

export const RahmahMessageFormat = {
  FU_PELUNASAN_MINIMAL,
  normalizeMessageText,
  sanitizeWhatsAppText,
  fuPelunasanFormatOptions,
  buildFuPelunasanMessage,
  canonicalizeFuPelunasanText,
  buildWhatsAppTextPayload,
  buildWhatsAppDeepLink,
};

if (typeof window !== 'undefined') {
  window.RahmahMessageFormat = RahmahMessageFormat;
  window.dispatchEvent(new CustomEvent('rahmah-message-format-ready'));
}
