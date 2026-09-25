// Secret detection engine. Same model as gitleaks (MIT): keyword prefilter → regex → secret group → entropy → allowlists,
// running the gitleaks default rule set (src/data/gitleaks-rules.json, see THIRD_PARTY.md) plus a few revu rules.
import fs from 'node:fs';
import { translate } from './re2.js';

const DATA = JSON.parse(fs.readFileSync(new URL('./data/gitleaks-rules.json', import.meta.url), 'utf8'));

export const ALLOW_MARKS = ['revu-allow-secret', 'gitleaks:allow'];
export const isAllowedLine = line => ALLOW_MARKS.some(m => String(line).includes(m));

const POSIX = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', xdigit: '0-9A-Fa-f', space: '\\s', punct: '!-\\/:-@\\[-`{-~' };

const withPosix = src => src.replace(/\[:(\w+):\]/g, (m, n) => POSIX[n] ?? m);

// Go RE2 → JavaScript. Exact translation (re2.js) that behaves the same on every Node version; if a pattern uses something
// it can't translate we fall back to an approximation and say so (`exact: false`). Approximations are fine for DETECTION
// (more permissive) but an inexact ALLOWLIST regex is dropped, because it could hide a real secret.
function convert(src) {
  const t = translate(withPosix(src));
  if (t !== null) { try { return { re: new RegExp(t, 'gd'), exact: true }; } catch {} }
  return legacyConvert(src);
}

function legacyConvert(src) {
  let flags = 'gd', s = src, exact = true;
  const lead = /^\(\?([imsU]+)\)/.exec(s);
  if (lead) {
    s = s.slice(lead[0].length);
    for (const f of lead[1]) { if ('ims'.includes(f)) flags += f; else exact = false; }
  }
  if (/\(\?[imsU]+\)/.test(s)) { s = s.replace(/\(\?[imsU]+\)/g, ''); exact = false; }
  s = withPosix(s.replace(/\\z/g, '$(?![\\s\\S])').replace(/\\A/g, '^').replace(/\(\?P</g, '(?<'));
  try { return { re: new RegExp(s, flags), exact }; } catch {}
  try { return { re: new RegExp(s.replace(/\(\?[a-zA-Z]*(?:-[a-zA-Z]*)?:/g, '(?:'), flags), exact: false }; }
  catch { return null; }
}
export const _convert = convert, _legacyConvert = legacyConvert; // exposed for tests

const shannon = s => { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; return -Object.values(f).reduce((h, n) => h + (n / s.length) * Math.log2(n / s.length), 0); };

// Random secrets don't contain long runs like "nopqrstuvwxyz", "0123456789" or "zyxwvu": those are alphabets / examples.
function hasLongRun(s, len = 6) {
  let up = 1, down = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    up = d === 1 ? up + 1 : 1; down = d === -1 ? down + 1 : 1;
    if (up >= len || down >= len) return true;
  }
  return false;
}

// Share of the value that is made of stopwords. A phrase ("session_active_12345") is mostly words; a random key that happens
// to contain one short word ("…MULE00…") is not.
function stopwordCoverage(lowerSecret, stops) {
  const covered = new Array(lowerSecret.length).fill(false);
  for (const w of stops) { if (!w) continue; for (let i = lowerSecret.indexOf(w); i !== -1; i = lowerSecret.indexOf(w, i + 1)) for (let k = i; k < i + w.length; k++) covered[k] = true; }
  return covered.filter(Boolean).length / lowerSecret.length;
}
const STOPWORD_VETO = 0.35;

// A value made only of letters is normally an identifier (gitleaks allows it). But a random letters-only key has about half
// its letters uppercase and high entropy, unlike camelCase words ("getAuthorizationToken" is ~10% uppercase).
function randomLetters(v) {
  if (!/^[A-Za-z]{20,}$/.test(v) || hasLongRun(v)) return false;
  const upper = (v.match(/[A-Z]/g) || []).length / v.length;
  return upper >= 0.3 && upper <= 0.7 && shannon(v) >= 3.8;
}

// Values that are obviously templates: ${VAR}, <token>, xxxx, changeme, placeholder, CHANGE-THIS-PASSWORD …
// (The last words are Spanish template words — detection data for code written in Spanish; the tool itself is English.)
const PLACEHOLDER_START = /^["']?(?:\$|<|%|\{|x{3,}|\*{3,}|pass|secret|change|placeholder|example|dummy|sample|test|fake|your|redacted|todo|fixme|username|user|admin|root|database|cambi|contrase|tu[-_]|ejemplo|pon[-_]|reemplaz|nombre|usuario|prueba|falso)/i;
const SHOUTED_WORDS = /^["']?[A-Z]+(?:[-_ ][A-Z]+)+["']?$/; // CHANGE-THIS-PASSWORD
// kebab/snake-case words with an optional short number: valid-token-123, reset_password_link_2 (identifiers, not keys)
const WORD_PHRASE = /^["']?[a-z]{2,12}(?:[-_][a-z]{2,12}){1,4}(?:[-_]?\d{1,4})?["']?$/;
const isPlaceholder = v => PLACEHOLDER_START.test(v) || SHOUTED_WORDS.test(v) || WORD_PHRASE.test(v);

const MAX_PER_RULE = 2000;
const MAJOR = new Set(['generic-api-key', 'jwt', 'jwt-base64', 'curl-auth-header', 'curl-auth-user', 'hashicorp-tf-password']);
// Rules that match a NAME=value shape (not a provider's token format) get the extra "does it look random?" checks.
const FUZZY = new Set(['generic-api-key', 'hashicorp-tf-password', 'curl-auth-header', 'curl-auth-user']);

// ── revu's own rules (JavaScript syntax, exact) ────────────────────────────────────
const OWN = [
  { id: 'private-key', description: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/gd, keywords: ['private key'], sev: 'critical', whole: true },
  { id: 'password-in-url', description: 'password in URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{4,})@([^\s/:?#]+)/gid, keywords: ['://'], entropy: 3.0, sev: 'major', fuzzy: true,
    skip: m => /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i.test(m[2]) },
  // Detection data for code written in Spanish: same shape as gitleaks' generic-api-key, with Spanish variable names
  // (password / key / credential / secret). Provider-specific tokens are detected by format whatever the language.
  { id: 'generic-secret-es', description: 'hardcoded secret (Spanish name)', sev: 'major', fuzzy: true, entropy: 3.5,
    keywords: ['contrase', 'clave', 'llave', 'credencial', 'secreto'],
    re: /[\p{L}\p{N}_.-]{0,50}?(?:contrase.a|clave|llave|credencial(?:es)?|secreto)(?:[\p{L}\p{N}_ \t.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[`'"\s=]{0,5}([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?:[`'"\s;]|\\[nr]|$)/giud,
    skip: m => /^[a-zA-Z_.-]+$/.test(m[1]) && !randomLetters(m[1]) }, // plain words are not secrets (gitleaks' allowlist), random letter soup is
  { id: 'npm-auth-token', description: 'npm auth token', re: /_authToken\s*=\s*([^\s$]{10,})/gd, keywords: ['_authtoken'], entropy: 3.0, sev: 'critical', fuzzy: true },
];

let COMPILED = null, STATS = null;
function compile() {
  if (COMPILED) return COMPILED;
  const rules = [];
  const stats = { total: DATA.rules.length + OWN.length, compiled: 0, failed: [], inexact: 0, allowDropped: 0 };
  const allowOf = list => (list || []).map(a => {
    const re = [];
    for (const src of a.regexes || []) { const c = convert(src); if (c?.exact) re.push(c.re); else stats.allowDropped++; }
    return { re, stop: (a.stopwords || []).map(w => w.toLowerCase()), target: a.regexTarget || 'secret', and: String(a.condition || '').toUpperCase() === 'AND' };
  });
  for (const r of DATA.rules) {
    const c = convert(r.regex);
    if (!c) { stats.failed.push(r.id); continue; }
    if (!c.exact) stats.inexact++;
    const pathRe = r.path ? convert(r.path)?.re : null; // e.g. hashicorp-tf-password only applies to .tf / .hcl files
    rules.push({ id: r.id, description: r.description, re: c.re, pathRe, keywords: r.keywords || [], entropy: r.entropy, secretGroup: r.secretGroup, allow: allowOf(r.allowlists), sev: MAJOR.has(r.id) ? 'major' : 'critical', fuzzy: FUZZY.has(r.id) });
  }
  for (const o of OWN) rules.push({ ...o, allow: [], secretGroup: o.whole ? 0 : 1 });
  stats.compiled = rules.length;
  COMPILED = { rules, global: allowOf([{ regexes: DATA.global.regexes, stopwords: DATA.global.stopwords }])[0] };
  STATS = stats;
  return COMPILED;
}
export const ruleStats = () => (compile(), { ...STATS });

const lineAround = (text, i) => text.slice(text.lastIndexOf('\n', i - 1) + 1, (text.indexOf('\n', i) + 1 || text.length + 1) - 1);

function allowed(a, { secret, match, line }) {
  const target = { secret, match, line }[a.target] ?? secret;
  const checks = [];
  if (a.re.length) checks.push(a.re.some(re => { re.lastIndex = 0; return re.test(target) && !(re.source === '^[a-zA-Z_.-]+$' && randomLetters(secret)); }));
  if (a.stop.length) {
    // gitleaks vetoes a value that merely CONTAINS a stopword; on random keys that is a false negative (~1-2% contain some
    // English word). Here the words must cover a good part of the value (or be an alphabet-like sequence such as a-z).
    const low = secret.toLowerCase();
    checks.push(stopwordCoverage(low, a.stop) >= STOPWORD_VETO);
  }
  return checks.length > 0 && (a.and ? checks.every(Boolean) : checks.some(Boolean));
}

// File a piece of text belongs to: explicit `path`, or the nearest preceding "### FILE: <path> (" header of a rendered prompt.
// Unknown → null, and then path-restricted rules DO apply (broad = safe).
function pathResolver(text, path) {
  if (path) return () => path;
  const marks = [...text.matchAll(/^### FILE: (.+?) \((?:added|modified|renamed|deleted|copied)/gm)].map(m => [m.index, m[1]]);
  if (!marks.length) return () => null;
  return i => { let p = null; for (const [at, name] of marks) { if (at > i) break; p = name; } return p; };
}

const stripFlags = re => new RegExp(re.source, re.flags.replace(/[gd]/g, ''));

// → [{ruleId, kind, sev, start, end}]  (start/end = the SECRET's range, so it can be redacted precisely)
export function scanText(text, { path } = {}) {
  const { rules, global } = compile();
  const lower = text.toLowerCase(), pathAt = pathResolver(text, path), out = [];
  for (const r of rules) {
    if (r.keywords.length && !r.keywords.some(k => lower.includes(k))) continue;
    const pathRe = r.pathRe ? stripFlags(r.pathRe) : null;
    r.re.lastIndex = 0;
    let m, n = 0;
    while ((m = r.re.exec(text))) {
      // A flood of matches must never leave a tail unscanned: past the cap, treat the rest of the text as secret.
      if (++n > MAX_PER_RULE) { out.push({ ruleId: r.id, kind: r.id, sev: r.sev, start: m.index, end: text.length }); break; }
      if (m[0] === '') { r.re.lastIndex++; continue; }
      const gi = r.secretGroup != null && m[r.secretGroup] != null ? r.secretGroup : (m.length > 1 && m[1] != null ? 1 : 0);
      const secret = m[gi];
      if (!secret) continue;
      if (pathRe) { const p = pathAt(m.index); if (p && !pathRe.test(p)) continue; }
      if (r.skip?.(m)) continue;
      // hex strings top out at 4 bits/char, so random ones often fall under gitleaks' 3.5: use a floor that fits their alphabet
      // gitleaks' thresholds (3-3.5 bits/char) suit long keys; a random 16-char key averages only ~3.7 and often dips under 3.5.
      // So the floor scales with length: never above 80% of log2(length).
      let minEntropy = r.entropy ? Math.min(r.entropy, 0.8 * Math.log2(Math.max(2, Math.min(secret.length, 62)))) : 0;
      if (/^[0-9a-fA-F]{20,}$/.test(secret)) minEntropy = Math.min(minEntropy || 3.0, 3.0);
      if (minEntropy && shannon(secret) < minEntropy) continue;
      if (r.fuzzy && (isPlaceholder(secret) || hasLongRun(secret))) continue;
      const ctx = { secret, match: m[0], line: lineAround(text, m.index) };
      if (r.allow.some(a => allowed(a, ctx)) || allowed(global, ctx)) continue;
      const [start, end] = m.indices[gi];
      out.push({ ruleId: r.id, kind: r.id, sev: r.sev, start, end });
    }
  }
  return out;
}

const mergeRanges = hits => {
  const rs = hits.map(h => ({ start: h.start, end: h.end, id: h.ruleId })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rs) { const last = out.at(-1); if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else out.push({ ...r }); }
  return out;
};

// Replace every detected secret (multi-line ones included) with a placeholder. Returns { text, count }.
export function redactText(text, opts) {
  const ranges = mergeRanges(scanText(text, opts));
  let out = text;
  for (const r of [...ranges].reverse()) out = out.slice(0, r.start) + `[REDACTED:${r.id}]` + out.slice(r.end);
  return { text: out, count: ranges.length };
}
