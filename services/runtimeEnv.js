import fs from 'node:fs';
import path from 'node:path';

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

export function resolveWritablePath(preferredPath, fallbackName) {
  return path.resolve(preferredPath || fallbackName);
}
