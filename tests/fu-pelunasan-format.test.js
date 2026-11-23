import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFuPelunasanMessage,
  buildWhatsAppDeepLink,
  buildWhatsAppTextPayload,
  canonicalizeFuPelunasanText,
  fuPelunasanFormatOptions,
  normalizeMessageText,
  sanitizeWhatsAppText,
} from '../public/js/rahmah-message-format.mjs';
import {
  buildLocalRahmahStyle,
  sanitizeForWhatsApp,
} from '../services/rahmahStyle.js';

const ROW = {
  name: 'Ahmad Fauzi',
  departureDays: 'H-14',
  sisaLabel: 'Rp 12.500.000',
  invoiceUrl: 'https://invoice.example.com/ABC123',
  phone: '0812-3456-7890',
};

const EXPECTED = [
  "Assalamu'alaikum Warahmatullahi Wabarakatuh 😊",
  '',
  'Yth. Bapak/Ibu Ahmad Fauzi,',
  '',
  'Semoga Bapak/Ibu senantiasa sehat dan dalam lindungan Allah SWT. Kami dari Rahmah Travel ingin menyampaikan informasi mengenai sisa pembayaran umroh Bapak/Ibu.',
  '',
  '📌 Sisa tagihan: *Rp 12.500.000*',
  '📅 Status keberangkatan: H-14',
  '💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.',
  '🔗 Invoice: https://invoice.example.com/ABC123',
  '',
  'Jika Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini. Kami siap membantu bila ada pertanyaan.',
  '',
  'Terima kasih atas perhatian dan kerja sama Bapak/Ibu. 🙏',
  '',
  'Salam hangat,',
  'Rahmah Travel',
].join('\n');

test('template FU Pelunasan mengikuti urutan dan spasi referensi', () => {
  const message = buildFuPelunasanMessage(ROW);
  assert.equal(message, EXPECTED);
  assert.ok(message.includes('\n\nYth. Bapak/Ibu Ahmad Fauzi,\n\n'));
  assert.ok(message.includes('\n\n📌 Sisa tagihan: *Rp 12.500.000*\n📅 Status keberangkatan: H-14\n💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.\n🔗 Invoice: https://invoice.example.com/ABC123\n\n'));
  assert.ok(!message.includes('🗓️'));
  assert.ok(!message.includes('\\n'));
});

test('nama kosong tidak menghasilkan sapaan ganda', () => {
  const message = buildFuPelunasanMessage({ ...ROW, name: '' });
  assert.ok(message.includes("\n\nYth. Bapak/Ibu,\n\n"));
  assert.ok(!message.includes('Yth. Bapak/Ibu Bapak/Ibu'));
});

test('normalisasi teks tidak mengubah paragraf menjadi satu baris', () => {
  assert.equal(normalizeMessageText('A\n\nB'), 'A\n\nB');
  assert.equal(normalizeMessageText('A\r\n\r\nB\r\n'), 'A\n\nB');
});

test('sanitizer klien mempertahankan baris kosong sebelum daftar', () => {
  const input = 'Paragraf pembuka.\n\n- Poin pertama\n- Poin kedua\n\nParagraf penutup.';
  const expected = 'Paragraf pembuka.\n\n• Poin pertama\n• Poin kedua\n\nParagraf penutup.';
  assert.equal(sanitizeWhatsAppText(input), expected);
});

test('sanitizer server mempertahankan baris kosong sebelum daftar', () => {
  const input = 'Paragraf pembuka.\n\n- Poin pertama\n- Poin kedua\n\nParagraf penutup.';
  const expected = 'Paragraf pembuka.\n\n• Poin pertama\n• Poin kedua\n\nParagraf penutup.';
  assert.equal(sanitizeForWhatsApp(input), expected);
});

test('pesan FU yang sudah kanonis tidak berubah setelah sanitasi', () => {
  assert.equal(sanitizeWhatsAppText(EXPECTED), EXPECTED);
  assert.equal(sanitizeForWhatsApp(EXPECTED), EXPECTED);
  assert.equal(buildLocalRahmahStyle(EXPECTED, { mode: 'fu' }), EXPECTED);
});

test('formatter kanonis mempertahankan pesan yang sudah benar', () => {
  const options = fuPelunasanFormatOptions(ROW);
  assert.equal(canonicalizeFuPelunasanText(EXPECTED, options), EXPECTED);
});

test('formatter kanonis memperbaiki hasil AI yang mengubah urutan dan ikon', () => {
  const polished = [
    "Assalamu'alaikum warahmatullahi wabarakatuh.",
    '',
    'Yth. Bapak/Ibu Ahmad Fauzi,',
    '',
    'Semoga Bapak/Ibu senantiasa sehat dan berada dalam lindungan Allah SWT.',
    '',
    ' Status keberangkatan: *H-14*',
    ' Sisa tagihan: *Rp 12.500.000*',
    ' Opsi pembayaran: Dapat dilunasi atau dicicil kapan saja, dengan minimal *Rp 5.000.000/pax*',
    ' Invoice: https://invoice.example.com/ABC123',
    '',
    'Apabila sudah melakukan pembayaran, mohon abaikan pesan ini.',
    '',
    'Terima kasih atas perhatian Bapak/Ibu.',
    '',
    'Salam hangat,',
    'Rahmah Travel',
  ].join('\n');

  const result = canonicalizeFuPelunasanText(
    polished,
    fuPelunasanFormatOptions(ROW),
  );

  assert.ok(result.startsWith("Assalamu'alaikum Warahmatullahi Wabarakatuh 😊\n\n"));
  assert.ok(result.includes('\n\n📌 Sisa tagihan: *Rp 12.500.000*\n📅 Status keberangkatan: H-14\n💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.\n🔗 Invoice: https://invoice.example.com/ABC123\n\n'));
  assert.ok(result.includes('Terima kasih atas perhatian Bapak/Ibu. 🙏'));
  assert.ok(result.endsWith('\n\nSalam hangat,\nRahmah Travel'));
  assert.ok(!result.includes('🗓️'));
  assert.ok(!result.includes('\\n'));
});

test('formatter kanonis mengenali label tebal tanpa ikon', () => {
  const source = [
    'Yth. Bapak/Ibu Ahmad Fauzi,',
    '',
    'Pembuka.',
    '',
    '*Sisa Tagihan:* Rp 12.500.000',
    '*Status Keberangkatan:* H-14',
    '*Pilihan Pembayaran:* Dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax',
    '*Tautan Invoice:* https://invoice.example.com/ABC123',
    '',
    'Penutup.',
  ].join('\n');

  const result = canonicalizeFuPelunasanText(
    source,
    fuPelunasanFormatOptions(ROW),
  );

  assert.ok(result.includes('\n\n📌 Sisa tagihan: *Rp 12.500.000*\n📅 Status keberangkatan: H-14\n💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.\n🔗 Invoice: https://invoice.example.com/ABC123\n\n'));
});

test('formatter kanonis membersihkan daftar rincian dan tanda tangan dari paragraf', () => {
  const invoice = 'https://invoice.example.com/ABC123';
  const source = [
    "Assalamu'alaikum Warahmatullahi Wabarakatuh 😊",
    '',
    'Yth. Bapak/Ibu Ahmad Fauzi,',
    '',
    `Semoga sehat. Rincian sebagai berikut: • *Kode Order:* 4837 • *Sisa Tagihan:* Rp 12.500.000 • *Status Keberangkatan:* H-14 • *Ketentuan`,
    '',
    '📌 Sisa tagihan: *Rp 12.500.000*',
    '📅 Status keberangkatan: H-14',
    '💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.',
    `🔗 Invoice: ${invoice}`,
    '',
    `Rincian lengkap dapat diakses melalui tautan invoice berikut: ${invoice} Jika Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini. *Rahmah Travel*`,
    '',
    'Terima kasih atas perhatian Bapak/Ibu. 🙏',
    '',
    'Salam hangat,',
    'Rahmah Travel',
  ].join('\n');

  const result = canonicalizeFuPelunasanText(
    source,
    fuPelunasanFormatOptions(ROW),
  );

  assert.ok(!result.includes('Kode Order'));
  assert.ok(!result.includes('Ketentuan'));
  assert.ok(!result.includes('*Rahmah Travel*'));
  assert.equal(result.split(invoice).length - 1, 1);
  assert.ok(result.includes('\n\nJika Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini.\n\n'));
  assert.ok(result.includes('\n\n📌 Sisa tagihan: *Rp 12.500.000*\n📅 Status keberangkatan: H-14\n💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.\n'));
});

test('formatter kanonis membuang rincian pembayaran ganda dari penutup', () => {
  const source = [
    'Yth. Bapak/Ibu Ahmad Fauzi,',
    '',
    'Pembuka.',
    '',
    '📌 Sisa tagihan: *Rp 12.500.000*',
    '',
    '• *Informasi Pembayaran:* Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax. Apabila Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini.',
    '',
    'Terima kasih atas perhatian Bapak/Ibu. 🙏',
    '',
    'Salam hangat,',
    'Rahmah Travel',
  ].join('\n');

  const result = canonicalizeFuPelunasanText(
    source,
    fuPelunasanFormatOptions(ROW),
  );

  assert.ok(!result.includes('Informasi Pembayaran'));
  assert.ok(result.includes('\n\nApabila Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini.\n\n'));
});

test('formatter kanonis membuang kalimat pengantar tautan tanpa URL', () => {
  const invoice = 'https://invoice.example.com/ABC123';
  const source = [
    'Yth. Bapak/Ibu Ahmad Fauzi,',
    '',
    'Pembuka.',
    '',
    `🔗 Invoice: ${invoice}`,
    '',
    'Bapak/Ibu dapat melihat rincian invoice resmi melalui tautan berikut:',
    invoice,
    'Apabila Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini.',
    '',
    'Terima kasih atas perhatian Bapak/Ibu. 🙏',
    '',
    'Salam hangat,',
    'Rahmah Travel',
  ].join('\n');

  const result = canonicalizeFuPelunasanText(
    source,
    fuPelunasanFormatOptions(ROW),
  );

  assert.ok(!result.includes('tautan berikut:'));
  assert.ok(result.includes('\n\nApabila Bapak/Ibu sudah melakukan pembayaran, mohon abaikan pesan ini.\n\n'));
  assert.equal(result.split(invoice).length - 1, 1);
});

test('formatter kanonis memecah rincian yang tergabung dalam satu baris', () => {
  const source = [
    'Yth. Bapak/Ibu Ahmad Fauzi,',
    '',
    'Pembuka.',
    '',
    'Sisa tagihan: *Rp 12.500.000* | Status keberangkatan: H-14 | Invoice: https://invoice.example.com/ABC123',
    '',
    'Penutup.',
  ].join('\n');

  const result = canonicalizeFuPelunasanText(
    source,
    fuPelunasanFormatOptions(ROW),
  );

  assert.ok(result.includes('\n\n📌 Sisa tagihan: *Rp 12.500.000*\n📅 Status keberangkatan: H-14\n💳 Pembayaran dapat dilunasi atau dicicil kapan saja, dengan minimal Rp 5.000.000/pax.\n🔗 Invoice: https://invoice.example.com/ABC123\n\n'));
  assert.ok(!result.includes(' | '));
});

test('deep link WhatsApp memakai nomor 62 dan mempertahankan baris kosong', () => {
  const link = buildWhatsAppDeepLink({ phone: ROW.phone, text: EXPECTED });
  assert.ok(link.startsWith('https://wa.me/6281234567890?text='));
  assert.ok(link.includes('%0A%0A'));
  assert.ok(!link.includes('\\n'));
  assert.equal(
    decodeURIComponent(new URL(link).searchParams.get('text')),
    EXPECTED,
  );

  const withoutPhone = buildWhatsAppDeepLink({ phone: '', text: EXPECTED });
  assert.ok(withoutPhone.startsWith('https://wa.me/?text='));
});

test('payload WhatsApp mengirim teks final tanpa mengubah newline', () => {
  const payload = buildWhatsAppTextPayload({
    phone: ROW.phone,
    text: EXPECTED,
  });
  assert.equal(payload.to, '6281234567890');
  assert.equal(payload.type, 'text');
  assert.equal(payload.text.body, EXPECTED);
  assert.ok(payload.text.body.includes('\n\n'));
});
