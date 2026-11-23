import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_DIRNAME = 'rahmah-travel-console';
const tmpRoot = path.join(os.tmpdir(), RUNTIME_DIRNAME);

let resolvedTmpRoot = null;

export function isVercelRuntime() {
  return process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
}

export function isReadOnlyFsError(error) {
  const code = String(error?.code || '');
  return ['EROFS', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(code);
}

export function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  } catch (error) {
    if (!isReadOnlyFsError(error)) throw error;
    return null;
  }
}

export function getRuntimeTempDir() {
  if (resolvedTmpRoot) return resolvedTmpRoot;
  ensureDirectory(tmpRoot);
  resolvedTmpRoot = tmpRoot;
  return resolvedTmpRoot;
}

export function resolveWritablePath(preferredPath, fallbackName) {
  const preferred = path.resolve(preferredPath);
  const preferredDir = path.dirname(preferred);
  if (ensureDirectory(preferredDir)) return preferred;
  const tempDir = getRuntimeTempDir();
  ensureDirectory(tempDir);
  return path.join(tempDir, fallbackName);
}

export function canUseFilesystemPersistence() {
  if (isVercelRuntime()) return false;
  return true;
}
