import { SEVERITIES } from './config.js';
import { renderFileForPrompt } from './diff.js';
import { matchesAny } from './glob.js';
import { loadNeverSend } from './exclude.js';
import { assessSuggestion, clean, isSensitiveFile, redactLine, scanAdded, visible } from './guard.js';
import { makeT } from './i18n.js';
import { complete, extractJson } from './providers.js';
import { systemPrompt, userPrompt } from './prompt.js';
import { redactText } from './secrets.js';
import { fingerprint, loadIgnored } from './store.js';

const rank = s => SEVERITIES.indexOf(s);
const MAX_RAW_FINDINGS = 100;

function batchFiles(files, maxChars, redact) {
  const batches = [], truncated = [];
  let cur = [], size = 0;
  for (const f of files) {
    const r = renderFileForPrompt(f, maxChars, redact);
    if (r.truncated) truncated.push(f.path);
    if (cur.length && size + r.text.length > maxChars) { batches.push(cur); cur = []; size = 0; }
    cur.push({ file: f, text: r.text }); size += r.text.length;
  }
  if (cur.length) batches.push(cur);
  return { batches, truncated };
}

async function askModel(cfg, prompt) {
  const raw = await complete(cfg, prompt);
  try { return extractJson(raw); }
  catch {
    const retry = await complete(cfg, { system: prompt.system, user: prompt.user + '\n\nIMPORTANT: your previous reply was not valid JSON. Reply with ONLY the JSON object.' });
    return extractJson(retry);
  }
}

// Turn a raw finding (from the LLM = untrusted, or from our local checks) into a verified one,
// or null if it points at code that isn't in the diff. Every string is sanitized and length-capped.
function verify(raw, fileMap, cfg) {
  if (!raw || typeof raw !== 'object') return null;
  const file = fileMap.get(String(raw.file || '').replace(/^\.?\//, ''));
  if (!file) return null;
  const known = new Map(); // newNo → {type,text}
  for (const h of file.hunks) for (const l of h.lines) if (l.type !== 'del') known.set(l.newNo, l);

  let line = parseInt(raw.line, 10);
  if (!Number.isFinite(line)) return null;
  if (known.get(line)?.type !== 'add') {
    const near = [1, -1, 2, -2].map(d => line + d).find(n => known.get(n)?.type === 'add');
    if (!near) return null; // model hallucinated the location → drop
    line = near;
  }
  let end = Math.max(line, parseInt(raw.end_line, 10) || line);
  if (end - line > 40) end = line;
  for (let n = line; n <= end; n++) if (!known.has(n)) { end = n - 1; break; }

  const original = [];
  for (let n = line; n <= end; n++) original.push(known.get(n).text);
  // frames are DISPLAY only: control chars stripped, invisible chars made visible, secrets never shown
  const show = s => { const c = visible(clean(s, 400)); return cfg.secret_policy !== 'off' ? redactLine(c) : c; };
  const frame = [];
  for (let n = line - 3; n <= end + 3; n++) if (known.has(n)) frame.push({ no: n, text: show(known.get(n).text), hit: n >= line && n <= end });

  let code = typeof raw.suggestion_code === 'string' ? raw.suggestion_code.replace(/^```\w*\n?|\n?```$/g, '').replace(/\n$/, '') : null;
  if (code !== null && (code.length > 20000 || code.includes('[REDACTED:'))) code = null; // never apply a placeholder / an absurd blob
  if (code !== null && code.split('\n').map(s => s.trimEnd()).join('\n') === original.map(s => s.trimEnd()).join('\n')) code = null;

  const category = clean(raw.category, 30).toLowerCase();
  const f = {
    severity: SEVERITIES.includes(String(raw.severity).toLowerCase()) ? String(raw.severity).toLowerCase() : 'minor',
    category: /^[a-z-]{2,30}$/.test(category) ? category : 'other',
    file: file.path, line, end_line: end,
    title: clean(raw.title || 'Issue', 120).trim() || 'Issue',
    explanation: clean(raw.explanation, 2000).trim(),
    suggestion_code: code || null,
    rule: raw.rule ? clean(raw.rule, 120) : null,
    original, frame, local: !!raw._local,
  };
  f.risk = f.suggestion_code ? assessSuggestion(original, f.suggestion_code, { file: f.file, protectedPaths: cfg.fix_protected_paths }) : [];
  f.fingerprint = fingerprint(f, original[0] || '');
  return f;
}

// Checks that run locally, with no LLM: they cannot be prompt-injected, so they always run.
function localFindings(files, cfg, t) {
  const out = [];
  for (const f of files) {
    const firstAdded = f.hunks.flatMap(h => h.lines).find(l => l.type === 'add');
    if (isSensitiveFile(f.path, cfg.allow_sensitive_files) && firstAdded) {
      out.push({ _local: true, severity: 'critical', category: 'security', file: f.path, line: firstAdded.newNo, title: t('sensFileTitle', { file: f.path }), explanation: t('sensFileExplain'), rule: 'revu:sensitive-file' });
      continue;
    }
    for (const s of scanAdded(f, { allowPaths: cfg.allow_secrets_in })) {
      if (s.id === 'secret' && (cfg.secret_policy === 'off' || s.allowed)) continue; // allowed values are not reported, but are still redacted / never sent
      const text = { secret: [t('secretTitle', { kind: s.kind }), t('secretExplain', { kind: s.kind }), 'revu:secret-scan'], bidi: [t('bidiTitle'), t('bidiExplain'), 'revu:hidden-unicode'], invisible: [t('invisTitle'), t('invisExplain'), 'revu:hidden-unicode'] }[s.id];
      out.push({ _local: true, severity: s.sev, category: 'security', file: f.path, line: s.line, title: text[0], explanation: text[1], rule: text[2] });
    }
  }
  return out;
}

export async function runReview({ cfg, files, root, branch, scoped = [], dryRun = false, onProgress = () => {} }) {
  const t = makeT();
  cfg._llmMeta = null; // filled by the provider as the calls are made
  const policy = cfg.secret_policy || 'withhold';
  const reviewable = files.filter(f => !f.binary && f.status !== 'deleted' && f.hunks.length && !matchesAny(f.path, cfg.ignore_paths));
  const stats = {
    files: reviewable.length, skipped: files.length - reviewable.length,
    additions: reviewable.reduce((n, f) => n + f.additions, 0), deletions: reviewable.reduce((n, f) => n + f.deletions, 0),
    dropped: 0, ignored: 0, truncated: [], withheld: [], secretFiles: [], excluded: [], redactions: 0,
  };
  if (!reviewable.length) return { summary: '', walkthrough: [], findings: [], stats };

  const fileMap = new Map(reviewable.map(f => [f.path, f]));
  const ignoredSet = loadIgnored(root);

  // ① what must NEVER reach an LLM: user exclusions, sensitive files, and (policy "withhold") any file holding a secret
  const neverSend = loadNeverSend(root, cfg.never_send);
  const excluded = reviewable.filter(f => matchesAny(f.path, neverSend.globs));
  const sensitive = reviewable.filter(f => isSensitiveFile(f.path, cfg.allow_sensitive_files));
  const local = localFindings(reviewable, cfg, t).map(r => verify(r, fileMap, cfg)).filter(Boolean);
  const activeLocal = local.filter(f => !ignoredSet[f.fingerprint]);
  const secretFiles = policy === 'withhold' ? new Set(activeLocal.filter(f => f.rule === 'revu:secret-scan').map(f => f.file)) : new Set();
  const withhold = new Set([...excluded, ...sensitive].map(f => f.path).concat([...secretFiles]));
  stats.withheld = [...withhold];
  stats.secretFiles = [...secretFiles];
  stats.excluded = excluded.map(f => f.path);
  const toSend = reviewable.filter(f => !withhold.has(f.path));
  const sendMap = new Map(toSend.map(f => [f.path, f]));

  // ② what is sent gets every detectable secret replaced by a placeholder (multi-line ones included)
  // A local model has a fixed context window (provider.num_ctx): leave room for the instructions, your rules and the answer,
  // and give the rest to the diff (~3 characters per token). Bigger diffs become more, smaller calls instead of a cut prompt.
  let maxChars = cfg.max_chars_per_request;
  if (cfg.provider?.type === 'ollama') {
    const fixed = Math.ceil((systemPrompt(cfg).length + (cfg._guidelinesText || '').length + JSON.stringify(cfg.path_instructions || []).length + 800) / 3);
    maxChars = Math.max(6000, Math.min(maxChars, ((cfg.provider.num_ctx || 16384) - fixed - 3000) * 3));
  }
  const { batches, truncated } = batchFiles(toSend, maxChars, s => s);
  stats.truncated = truncated;
  const system = systemPrompt(cfg);
  const summaries = [], walkthrough = [], raws = [], prompts = [];
  let llmError = null; // local checks must still be reported when the LLM fails

  for (let i = 0; i < batches.length; i++) {
    onProgress({ batch: i + 1, of: batches.length });
    const b = batches[i];
    let diffText = b.map(x => x.text).join('\n\n');
    if (policy !== 'off') { const r = redactText(diffText); diffText = r.text; stats.redactions += r.count; }
    const prompt = { system, user: userPrompt(cfg, { files: b.map(x => x.file), diffText, branch, scoped }) };
    if (dryRun) { prompts.push(prompt); continue; }
    cfg._egressMeta = { files: b.map(x => x.file.path), redactions: stats.redactions, withheld: stats.withheld }; // for the local audit log
    let json;
    try { json = await askModel(cfg, prompt); } catch (e) { llmError = e; break; }
    if (json && typeof json === 'object') {
      if (json.summary) summaries.push(clean(json.summary, 1500));
      for (const w of Array.isArray(json.walkthrough) ? json.walkthrough.slice(0, 200) : []) {
        if (w && sendMap.has(String(w.file))) walkthrough.push({ file: String(w.file), change: clean(w.change, 300) });
      }
      raws.push(...(Array.isArray(json.findings) ? json.findings.slice(0, MAX_RAW_FINDINGS) : []));
    }
  }
  if (dryRun) return { prompts, stats };

  const seen = new Set();
  let findings = [];
  const localLines = new Set(local.map(f => `${f.file}:${f.line}`));
  // the LLM only saw files in sendMap: findings about anything else are invented
  const modelFindings = raws.map(r => { const v = verify(r, sendMap, cfg); if (!v) stats.dropped++; return v; }).filter(Boolean);

  for (const f of [...local, ...modelFindings]) {
    if (!f.local && localLines.has(`${f.file}:${f.line}`)) continue; // our local finding on that line already says it
    const key = `${f.file}:${f.line}:${f.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ignoredSet[f.fingerprint]) { stats.ignored++; continue; }
    if (cfg.profile !== 'assertive' && f.severity === 'nit') continue;
    findings.push(f);
  }
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
  findings = findings.slice(0, cfg.max_findings);

  return { summary: summaries.join(' '), walkthrough, findings, stats, llmError, meta: cfg._llmMeta };
}
