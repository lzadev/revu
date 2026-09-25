import fs from 'node:fs';
import path from 'node:path';

// Resolve symlinks and only accept paths that really live inside `root` (no ../, no absolute paths, no symlink escapes).
export function realInside(root, p) {
  try {
    const rr = fs.realpathSync(root), rp = fs.realpathSync(p);
    return rp === rr || rp.startsWith(rr + path.sep) ? rp : null;
  } catch { return null; }
}

export function readInside(root, p, max = 20000) {
  const rp = realInside(root, p);
  if (!rp) return null;
  try { return fs.statSync(rp).isFile() ? fs.readFileSync(rp, 'utf8').slice(0, max) : null; } catch { return null; }
}

// A repo-relative path from untrusted data: no absolute, no "..", no NUL / control chars.
export const isSafeRelPath = p =>
  typeof p === 'string' && p.length > 0 && p.length < 1024 && !path.isAbsolute(p) && !/[\u0000-\u001f\u007f]/.test(p) &&
  !p.split(/[\\/]/).includes('..');
