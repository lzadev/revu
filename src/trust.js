// Trust store for provider settings that come from a repository.
// A repo is untrusted input: it must not be able to choose a command to run or a URL that receives your code and API key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storeFile = () => path.join(os.homedir(), '.config', 'revu', 'trusted.json');
const canon = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const providerFingerprint = p => crypto.createHash('sha256').update(canon(p)).digest('hex').slice(0, 32);
const realRoot = root => { try { return fs.realpathSync(root); } catch { return root; } };
const load = () => { try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { return {}; } };

export const isTrusted = (root, provider) => (load()[realRoot(root)] || []).includes(providerFingerprint(provider));

export function trust(root, provider) {
  const db = load(), key = realRoot(root);
  db[key] = [...new Set([...(db[key] || []), providerFingerprint(provider)])];
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(storeFile(), JSON.stringify(db, null, 2), { mode: 0o600 });
}

export function describeProviderFull(p) {
  if (!p) return '';
  if (p.type === 'command') return `command: ${p.command}`;
  return `${p.type}  url: ${p.base_url || '(default)'}  model: ${p.model || '?'}${p.api_key_env ? `  sends the value of $${p.api_key_env}` : ''}`;
}
