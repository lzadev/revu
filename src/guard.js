// Guardrails: everything that comes from the repo or from the LLM is untrusted input.
import { matchesAny } from './glob.js';
import { isAllowedLine, redactText, scanText } from './secrets.js';

// ── Terminal-safe text ─────────────────────────────────────────────────────────────
// Strips ANSI/OSC sequences (cursor moves, clipboard writes via OSC 52, fake "commit allowed" banners…)
// and every other control character except \n and \t.
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
export const clean = (s, max = 4000) => String(s ?? '').replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(CONTROL, '').slice(0, max);

// Invisible / direction-changing characters are made VISIBLE in code frames instead of hidden.
const TROJAN = /[‪-‮⁦-⁩]/;          // bidi overrides: "Trojan Source"
const INVISIBLE = /[​⁠᠎]/;               // zero-width chars hidden inside identifiers
export const visible = s => String(s).replace(/[‪-‮⁦-⁩​-‏⁠᠎﻿]/g, c => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);

// ── Secrets (engine: secrets.js) ─────────────────────────────────────────────────────
export const findSecrets = scanText;
export const redactLine = s => redactText(s).text;

// ── Sensitive files: never sent to an LLM, always reported ─────────────────────────
export const SENSITIVE_FILES = [
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore',
  '**/id_rsa', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/.netrc', '**/.aws/credentials',
  '**/service-account*.json', '**/credentials.json',
];
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i;
export const isSensitiveFile = (p, allow = []) => matchesAny(p, SENSITIVE_FILES) && !TEMPLATE_SUFFIX.test(p) && !matchesAny(p, allow);

// ── Files an LLM suggestion may never auto-edit (they can run code or weaken this very tool) ─────
export const PROTECTED_FIX_PATHS = [
  '.github/**', '**/.github/**', '.gitlab-ci.yml', '**/.gitlab-ci.yml', '.circleci/**', '.husky/**', '**/.husky/**', '.git*', '**/.gitmodules',
  '.revu.yaml', '.revu.local.yaml', '.revu/**', '**/package.json', '**/Dockerfile*', '**/docker-compose*.{yml,yaml}',
  '**/Makefile', '**/*.sh', '**/*.ps1', '**/*.bat', '**/.env*', '**/*.lock', '**/package-lock.json', '**/.npmrc',
];

// ── Scan the ADDED lines of a file for things a human must look at, independent of any LLM ─────────
// Secrets are matched over runs of consecutive added lines (so multi-line secrets such as private keys are seen whole).
// `allowed` = the line carries an allow marker or the file is in `allowPaths`: not reported, but still never sent to an LLM.
export function scanAdded(file, { allowPaths = [] } = {}) {
  const out = [], pathAllowed = matchesAny(file.path, allowPaths);
  for (const h of file.hunks) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const text = run.map(l => l.text).join('\n');
      const starts = []; let off = 0;
      for (const l of run) { starts.push(off); off += l.text.length + 1; }
      const perLine = new Map(); // one report per line: the most specific / severe rule wins
      for (const s of scanText(text, { path: file.path })) {
        let i = starts.length - 1;
        while (i > 0 && starts[i] > s.start) i--;
        const cur = perLine.get(i);
        if (!cur || (s.sev === 'critical' && cur.sev !== 'critical')) perLine.set(i, s);
      }
      for (const [i, s] of perLine) out.push({ line: run[i].newNo, id: 'secret', kind: s.kind, sev: s.sev, allowed: pathAllowed || isAllowedLine(run[i].text) });
      run = [];
    };
    for (const l of h.lines) {
      if (l.type !== 'add') { flush(); continue; }
      run.push(l);
      if (TROJAN.test(l.text)) out.push({ line: l.newNo, id: 'bidi', sev: 'critical' });
      else if (INVISIBLE.test(l.text)) out.push({ line: l.newNo, id: 'invisible', sev: 'major' });
    }
    flush();
  }
  return out;
}

// ── Is an LLM-suggested replacement safe to apply without a human reading it? ──────────────────
const HOST = /https?:\/\/[^\s"'`)<>]+/gi;
const EXEC = /\b(?:eval|exec|execSync|execFile|spawn|spawnSync|fork|system|popen|subprocess|child_process|os\.system|__import__|importScripts|Runtime\.getRuntime)\b|new\s+Function\s*\(|\bFunction\s*\(/g;
const SHELL = /\b(?:curl|wget|nc|ncat|bash\s+-c|sh\s+-c|powershell|Invoke-Expression|iex|rm\s+-rf|chmod\s+[0-7]{3,4}|base64\s+-d|certutil|mshta)\b/g;
const BLOB = /[A-Za-z0-9+/=_-]{80,}/g;
const IMPORT = /\b(?:require\s*\(|import\s*\(|import\s+[^;\n]*\bfrom\b|^\s*import\s+["'])/gm;

const uniq = (re, s) => new Set(s.match(re) || []);
const added = (re, before, after) => [...uniq(re, after)].some(x => !uniq(re, before).has(x));

// returns risk ids; empty array = nothing suspicious
export function assessSuggestion(original, code, { file = '', protectedPaths = PROTECTED_FIX_PATHS } = {}) {
  const before = original.join('\n'), risks = [];
  if (matchesAny(file, protectedPaths)) risks.push('protected');
  if (code.split('\n').length > 40 || code.length > 4000) risks.push('large');
  if (added(HOST, before, code)) risks.push('url');
  if (added(EXEC, before, code)) risks.push('exec');
  if (added(SHELL, before, code)) risks.push('shell');
  if (added(BLOB, before, code)) risks.push('blob');
  if (added(IMPORT, before, code)) risks.push('import');
  if (TROJAN.test(code) || INVISIBLE.test(code)) risks.push('unicode');
  if (findSecrets(code).length) risks.push('secret');
  return risks;
}
