import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { parseDiff } from './diff.js';
import { getDiff } from './git.js';
import { BENCH_GUIDELINES, BENCH_VERSION, FILES, PLANTED, REFERENCE } from './bench-suite.js';
import { runReview } from './review.js';
import { usageLine } from './ui.js';

const covers = (f, b) => f.file === b.file && f.line - 1 <= b.line && (f.end_line || f.line) + 1 >= b.line;
const CLEAN = Object.keys(FILES).filter(f => f.includes('clean'));

function makeSuiteDiff() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-bench-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'bench@revu'); git('config', 'user.name', 'revu bench');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init', '--no-verify');
  for (const [f, c] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git('add', '.');
  return { dir, files: parseDiff(getDiff(dir, 'staged', 8)) };
}

// One run of the suite against cfg.provider. Never reads or sends the user's own files.
export async function runSuite(cfg) {
  const { dir, files } = makeSuiteDiff();
  try {
    const benchCfg = { ...DEFAULTS, provider: cfg.provider, secret_policy: cfg.secret_policy, profile: 'chill', guidelines: BENCH_GUIDELINES, _guidelinesText: BENCH_GUIDELINES, path_instructions: [], _sources: [], _root: dir };
    const t0 = Date.now();
    const res = await runReview({ cfg: benchCfg, files, root: dir, branch: 'main' });
    const seconds = (Date.now() - t0) / 1000;
    if (res.llmError) return { error: String(res.llmError.message), seconds };
    const bugs = PLANTED.map(b => ({ id: b.id, file: b.file, line: b.line, match: res.findings.find(f => covers(f, b)) || null }));
    const extras = res.findings.filter(f => !PLANTED.some(b => covers(f, b)));
    const falseAlarms = extras.filter(f => CLEAN.includes(f.file));
    return { seconds, meta: res.meta, bugs, found: bugs.filter(b => b.match).length, total: bugs.length, extras, falseAlarms: falseAlarms.length, findings: res.findings.length, dropped: res.stats.dropped };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Latency / findings on the last N commits of the CURRENT repository (no ground truth: it measures speed and volume).
export async function runCommits(cfg, root, n) {
  const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const shas = git('log', '--no-merges', '-n', String(n), '--format=%H\t%s').trim().split('\n').filter(Boolean).map(l => l.split('\t'));
  const rows = [];
  for (const [sha, subject] of shas) {
    const files = parseDiff(git('show', '--format=', `-U${cfg.context_lines}`, '-M', '--diff-filter=ACMRD', sha));
    const t0 = Date.now();
    const res = await runReview({ cfg: { ...cfg }, files, root, branch: '' });
    rows.push({ sha: sha.slice(0, 7), subject: subject.slice(0, 50), files: files.length, seconds: (Date.now() - t0) / 1000, error: res.llmError ? String(res.llmError.message) : null, findings: res.findings.length, meta: res.meta });
  }
  return rows;
}

const verdict = r => {
  const share = r.found / r.total;
  const slow = r.seconds > 120 ? ' It is also slow (' + r.seconds.toFixed(0) + ' s): too slow for a hook on every commit; run `revu --base main` instead.' : '';
  if (share >= 6 / 7 && r.falseAlarms === 0) return `Good: it finds nearly everything the reference does and raises no false alarms.${slow}`;
  if (share >= 4 / 7) return `Mixed: it misses obvious bugs. Use it as a complement, not as the only reviewer.${slow}`;
  return `Weak: it misses most planted bugs, so a clean review would give false confidence. Not recommended as the only reviewer.${slow}`;
};

export function renderSuite(r, spec) {
  if (r.error) return `revu bench · ${spec}\n\nThe benchmark could not run: ${r.error}`;
  const out = [`revu bench · ${spec} · suite v${BENCH_VERSION} (${r.total} planted bugs, ${CLEAN.length} clean files)`, ''];
  for (const b of r.bugs) out.push(`  ${b.match ? '✔' : '✖'} ${b.id.padEnd(52)} ${b.match ? `${b.match.severity}: ${b.match.title.slice(0, 50)}` : 'NOT FOUND'}`);
  for (const f of r.extras) out.push(`  ${CLEAN.includes(f.file) ? '⚠' : '·'} ${(CLEAN.includes(f.file) ? 'false alarm' : 'extra finding').padEnd(52)} ${f.file}:${f.line} ${f.title.slice(0, 40)}`);
  const usage = usageLine(r.meta, r.seconds.toFixed(1));
  out.push('', `Result: ${r.found} of ${r.total} planted bugs found · ${r.falseAlarms} false alarm${r.falseAlarms === 1 ? '' : 's'} in the clean files · ${r.extras.length - r.falseAlarms} other extra finding${r.extras.length - r.falseAlarms === 1 ? '' : 's'}`);
  out.push(`Cost:   ${usage || `${r.seconds.toFixed(1)} s`}${r.meta?.calls ? ` · ${r.meta.calls} call${r.meta.calls === 1 ? '' : 's'}` : ''}`);
  out.push(`Verdict: ${verdict(r)}`);
  out.push('', 'Reference results on this same suite (one run each, so a yardstick and not a ranking):');
  for (const x of REFERENCE) out.push(`  ${x.model.padEnd(50)} ${x.found}/${x.total}  ${x.note}`);
  return out.join('\n');
}

export function renderCommits(rows) {
  const out = ['', 'Last commits of this repository (speed and volume; there is no ground truth here):'];
  for (const r of rows) out.push(`  ${r.sha}  ${String(r.files).padStart(2)} files  ${r.seconds.toFixed(0).padStart(4)} s  ${r.error ? 'ERROR ' + r.error.slice(0, 60) : `${r.findings} findings  ${usageLine(r.meta, null)}`}   ${r.subject}`);
  const ok = rows.filter(r => !r.error);
  if (ok.length) out.push(`  average ${(ok.reduce((n, r) => n + r.seconds, 0) / ok.length).toFixed(0)} s per commit over ${ok.length}`);
  return out.join('\n');
}
