import fs from 'node:fs';
import path from 'node:path';
import { isSafeRelPath, realInside } from './fsafe.js';
import { hasUnstagedChanges, stageFile } from './git.js';

const MAX_SHIFT = 60; // the original block must still be near where the review saw it

// Apply a finding's suggested replacement. `f` may come from a saved file, so nothing in it is trusted:
// path must stay inside the repo and must not be a symlink; the original block must still be in the file;
// suggestions flagged as risky are refused unless the caller has asked a human (allowRisky).
export function applySuggestion(root, f, { stage, t, allowRisky = false }) {
  if (typeof f?.suggestion_code !== 'string' || !f.suggestion_code) return { ok: false, reason: '—' };
  if (f.risk?.length && !allowRisky) return { ok: false, reason: t('riskRefused', { list: f.risk.map(r => t('risk')?.[r] || r).join(', ') }) };
  if (!isSafeRelPath(f.file) || !Array.isArray(f.original) || !f.original.length || f.original.length > 41 || !Number.isInteger(f.line)) return { ok: false, reason: t('unsafePath') };

  const abs = path.join(root, f.file);
  let st;
  try { st = fs.lstatSync(abs); } catch { return { ok: false, reason: t('changed') }; }
  if (st.isSymbolicLink() || !st.isFile() || !realInside(root, abs)) return { ok: false, reason: t('unsafePath') };
  if (stage && hasUnstagedChanges(root, f.file)) return { ok: false, reason: t('unstaged') };

  const content = fs.readFileSync(abs, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const n = f.original.length;

  let best = -1;
  for (let i = 0; i + n <= lines.length; i++) {
    let same = true;
    for (let j = 0; j < n && same; j++) same = lines[i + j].trimEnd() === String(f.original[j]).trimEnd();
    if (same && (best === -1 || Math.abs(i - (f.line - 1)) < Math.abs(best - (f.line - 1)))) best = i;
  }
  if (best === -1 || Math.abs(best - (f.line - 1)) > MAX_SHIFT) return { ok: false, reason: t('changed') };

  lines.splice(best, n, ...f.suggestion_code.split('\n'));
  fs.writeFileSync(abs, lines.join(eol));
  if (stage) stageFile(root, f.file);
  return { ok: true };
}
