import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { realInside } from './fsafe.js';

// Team-shared list of dismissed findings (commit it so false positives stay dismissed for everyone).
const ignoredFile = root => path.join(root, '.revu', 'ignored.json');

export function loadIgnored(root) {
  try { return JSON.parse(fs.readFileSync(ignoredFile(root), 'utf8')); } catch { return {}; }
}
export function addIgnored(root, f) {
  const all = loadIgnored(root);
  all[f.fingerprint] = { file: f.file, title: f.title, at: new Date().toISOString().slice(0, 10) };
  const dir = path.dirname(ignoredFile(root));
  fs.mkdirSync(dir, { recursive: true });
  // never write through a symlinked .revu/ (or ignored.json) that leaves the repository
  if (!realInside(root, dir) || (fs.existsSync(ignoredFile(root)) && (fs.lstatSync(ignoredFile(root)).isSymbolicLink() || !realInside(root, ignoredFile(root))))) throw new Error('.revu/ignored.json is not inside the repository');
  fs.writeFileSync(ignoredFile(root), JSON.stringify(all, null, 2) + '\n');
}

export const fingerprint = (f, lineText) =>
  crypto.createHash('sha1').update([f.file, f.rule || '', f.title.toLowerCase(), lineText.trim()].join('\n')).digest('hex').slice(0, 12);

// Result cache lives inside .git (never committed): re-running on an unchanged diff is free.
export const cacheKey = (...parts) => crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex');
export function cacheGet(dir, key) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, key + '.json'), 'utf8')); } catch { return null; }
}
export function cachePut(dir, key, value) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(value)); } catch {}
}

// The last review is kept inside .git so `revu fix` can apply its ready-made fixes later.
export const diffHash = text => crypto.createHash('sha1').update(text).digest('hex');
export function readLast(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
export function writeLast(file, data) { try { fs.writeFileSync(file, JSON.stringify(data)); } catch {} }

// Local audit log of what was sent to an LLM: paths, sizes and counters only. Never content, never secrets.
export function appendEgress(file, entry) {
  try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}
export function readEgress(file, n = 20) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).map(l => JSON.parse(l)); } catch { return []; }
}
