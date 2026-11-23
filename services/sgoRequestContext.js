import { AsyncLocalStorage } from 'node:async_hooks';

const sgoRequestStore = new AsyncLocalStorage();

export function runWithSgoCookie(cookieHeader, callback) {
  return sgoRequestStore.run(
    { cookieHeader: String(cookieHeader || '').trim() },
    callback,
  );
}

export function getRequestSgoCookieHeader() {
  return sgoRequestStore.getStore()?.cookieHeader || '';
}
