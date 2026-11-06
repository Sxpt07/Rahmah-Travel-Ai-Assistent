import axios from 'axios';
import * as cheerio from 'cheerio';

const DEFAULT_MAX_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 20000;

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'footer',
  '[aria-hidden="true"]',
  '.cookie-banner',
  '.cookie-consent',
  '#cookie-banner',
];

function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function cleanText(value = '') {
  return normalizeWhitespace(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...context truncated at ${maxChars} characters]`;
}

/**
 * Scrape a public travel-agency page and turn it into clean, AI-readable context.
 *
 * @param {string} url - Absolute http(s) URL to index.
 * @param {{ maxChars?: number, timeoutMs?: number }} [options]
 * @returns {Promise<string>} Structured plain-text context.
 */
export async function scrapeWebContext(url, options = {}) {
  const maxChars = Number(options.maxChars || process.env.SCRAPER_MAX_CHARS || DEFAULT_MAX_CHARS);
  const timeoutMs = Number(options.timeoutMs || process.env.SCRAPER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL. Please provide a full URL, e.g. https://example.com/paket-umrah');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  let response;
  try {
    response = await axios.get(parsed.toString(), {
      timeout: timeoutMs,
      maxRedirects: 5,
      maxContentLength: 10 * 1024 * 1024,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 UmrahAssistantBot/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
  } catch (error) {
    const status = error.response?.status;
    const reason = status
      ? `The website returned HTTP ${status}.`
      : error.code === 'ECONNABORTED'
        ? `The website took longer than ${timeoutMs}ms to respond.`
        : 'The website could not be reached.';
    throw new Error(`Failed to fetch website: ${reason}`);
  }

  const contentType = String(response.headers?.['content-type'] || '');
  if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
    throw new Error(`Unsupported content type "${contentType}". Only HTML pages can be indexed.`);
  }

  const html = typeof response.data === 'string' ? response.data : String(response.data || '');
  if (!html.trim()) {
    throw new Error('The website returned an empty response.');
  }

  const $ = cheerio.load(html);

  NOISE_SELECTORS.forEach((selector) => $(selector).remove());

  const title = cleanText($('title').first().text()) || cleanText($('h1').first().text());
  const metaDescription = cleanText(
    $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '',
  );
  const canonical = cleanText($('link[rel="canonical"]').attr('href') || '');

  const seen = new Set();
  const unique = (text) => {
    const value = cleanText(text);
    if (!value || value.length < 2) return '';
    const key = value.toLowerCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return value;
  };

  const lines = [];
  lines.push('# WEBSITE CONTEXT');
  lines.push(`Source URL: ${parsed.toString()}`);
  if (canonical && canonical !== parsed.toString()) lines.push(`Canonical URL: ${canonical}`);
  if (title) lines.push(`Page title: ${title}`);
  if (metaDescription) lines.push(`Meta description: ${metaDescription}`);
  lines.push(`Scraped at: ${new Date().toISOString()}`);

  // ---------- Headings ----------
  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = Number(el.tagName.slice(1));
    const text = unique($(el).text());
    if (text && text.length <= 300) headings.push({ level, text });
  });

  if (headings.length) {
    lines.push('\n## HEADINGS');
    for (const heading of headings) {
      lines.push(`${'#'.repeat(Math.min(heading.level + 2, 6))} ${heading.text}`);
    }
  }

  // ---------- Paragraphs & list items ----------
  const passages = [];
  $('p, li, blockquote, dt, dd').each((_, el) => {
    // Avoid duplicating text that belongs to a nested block already captured.
    if ($(el).find('p, li, blockquote').length > 0) return;
    const text = unique($(el).text());
    if (text && text.length >= 3) passages.push(text);
  });

  if (passages.length) {
    lines.push('\n## CONTENT');
    passages.forEach((text) => lines.push(`- ${text}`));
  }

  // ---------- Tables (package lists, prices, facilities, schedules) ----------
  const tables = [];
  $('table').each((tableIndex, table) => {
    const rows = [];
    $(table)
      .find('tr')
      .each((_, tr) => {
        const cells = $(tr)
          .find('th, td')
          .map((__, cell) => cleanText($(cell).text()))
          .get()
          .filter(Boolean);

        if (!cells.length) return;
        const row = cells.join(' | ');
        if (row.length >= 2) rows.push(row);
      });

    if (rows.length < 2) return;

    const caption =
      cleanText($(table).find('caption').first().text()) ||
      cleanText($(table).prevAll('h1, h2, h3, h4, h5, h6').first().text()) ||
      `Table ${tableIndex + 1}`;

    tables.push({ caption, rows });
  });

  if (tables.length) {
    lines.push('\n## TABLES / PACKAGE DATA');
    tables.forEach((table) => {
      lines.push(`### ${table.caption}`);
      table.rows.forEach((row) => lines.push(`- ${row}`));
    });
  }

  // ---------- FAQ / accordion answers ----------
  const faqAnswers = [];
  $('[class*="faq" i], [id*="faq" i], [class*="accordion" i], details').each((_, el) => {
    const text = unique($(el).text());
    if (text && text.length >= 10 && text.length <= 1500) faqAnswers.push(text);
  });

  if (faqAnswers.length) {
    lines.push('\n## FAQ / ADDITIONAL DETAILS');
    faqAnswers.forEach((text) => lines.push(`- ${text}`));
  }

  const context = lines.join('\n').trim();

  if (context.length < 80) {
    throw new Error('Not enough readable text found on the page. The site may rely on JavaScript rendering.');
  }

  return truncate(context, maxChars);
}

export default scrapeWebContext;
