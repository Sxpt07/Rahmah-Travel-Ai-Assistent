export const SGO_DEVICE_COOKIE_NAME = 'rahmah_sgo_device';
export const SGO_DEVICE_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeCookieHeader(value = '') {
  const raw = String(value || '')
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/\s*\r?\n\s*/g, '; ')
    .trim();

  if (!raw) return '';
  if (/(?:^|;\s*)sgo_admin_session\s*=/i.test(raw)) return raw;
  if (/^[A-Za-z0-9_-]{1,40}=/.test(raw)) return raw;
  return `sgo_admin_session=${raw}`;
}

export function toSgoSessionCookieHeader(value = '') {
  const normalized = normalizeCookieHeader(value);
  if (!normalized) return '';

  const match = normalized.match(/(?:^|;\s*)sgo_admin_session=([^;\s]+)/i);
  if (!match) return '';

  const token = String(match[1] || '').trim();
  return token ? `sgo_admin_session=${token}` : '';
}

export function readCookieValue(cookieHeader = '', name = '') {
  const wanted = String(name || '').trim();
  if (!wanted) return '';

  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== wanted) continue;

    const rawValue = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return '';
}

export function readSgoDeviceCookie(req) {
  const raw = readCookieValue(
    req?.headers?.cookie || '',
    SGO_DEVICE_COOKIE_NAME,
  );
  return toSgoSessionCookieHeader(raw);
}

export function sgoDeviceCookieOptions({ secure = false } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(secure),
    path: '/',
    maxAge: SGO_DEVICE_COOKIE_MAX_AGE_MS,
  };
}
