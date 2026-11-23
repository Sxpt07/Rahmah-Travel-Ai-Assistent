import { createRequire } from 'node:module';

let DatabaseSyncImpl = null;
let loadError = null;

try {
  const require = createRequire(import.meta.url);
  const sqlite = require('node:sqlite');
  DatabaseSyncImpl = sqlite.DatabaseSync || null;
} catch (error) {
  loadError = error;
}

function createStubDatabase() {
  const tables = new Map();
  const meta = new Map();
  const stmt = {
    all() { return []; },
    get() { return undefined; },
    run() { return { changes: 0, lastInsertRowid: 0 }; },
  };
  return {
    exec() {},
    prepare() { return stmt; },
    close() {},
    __stub: true,
  };
}

export function getDatabaseSyncClass() {
  if (!DatabaseSyncImpl) {
    const message = loadError?.message || 'node:sqlite is unavailable in this runtime';
    const err = new Error(
      `SQLite runtime tidak tersedia: ${message}. Gunakan Node.js 22+ atau environment yang mendukung node:sqlite.`,
    );
    err.code = 'SQLITE_RUNTIME_UNAVAILABLE';
    throw err;
  }
  return DatabaseSyncImpl;
}

export function createDatabaseSync(path) {
  if (!DatabaseSyncImpl) {
    return createStubDatabase();
  }
  try {
    const Ctor = getDatabaseSyncClass();
    return new Ctor(path);
  } catch (error) {
    if (path === ':memory:') {
      return createStubDatabase();
    }
    throw error;
  }
}

export function isSqliteStub(db) {
  return Boolean(db && db.__stub);
}
