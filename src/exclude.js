// Files the user never wants an LLM to see (like Copilot content exclusion / .cursorignore).
// Reads .revuignore plus the ignore files other AI tools already use, so you don't repeat yourself.
import { readInside } from './fsafe.js';
import path from 'node:path';

export const EXCLUDE_FILES = ['.revuignore', '.cursorignore', '.aiexclude', '.copilotignore'];

// gitignore-style line (simplified: no negation) → globs understood by glob.js
export function lineToGlobs(raw) {
  let p = String(raw).trim();
  if (!p || p.startsWith('#') || p.startsWith('!')) return [];
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  let anchored = p.startsWith('/');
  if (anchored) p = p.slice(1); else if (p.includes('/') && !p.startsWith('**/')) anchored = true;
  const base = anchored || p.startsWith('**/') ? p : `**/${p}`;
  return dirOnly ? [`${base}/**`] : [base, `${base}/**`];
}

export function loadNeverSend(root, extra = []) {
  const globs = [], sources = [];
  for (const g of extra) globs.push(...lineToGlobs(g));
  if (extra.length) sources.push({ file: 'never_send (.revu.yaml)', count: extra.length });
  for (const f of EXCLUDE_FILES) {
    const text = readInside(root, path.join(root, f), 100000);
    if (text == null) continue;
    const gs = text.split(/\r?\n/).flatMap(lineToGlobs);
    globs.push(...gs);
    sources.push({ file: f, count: gs.length });
  }
  return { globs, sources };
}
