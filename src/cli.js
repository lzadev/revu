import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { applySuggestion } from './apply.js';
import { describeProvider, loadConfig, scopedGuidelines, userConfigPath } from './config.js';
import { autoProviderSpec } from './detect.js';
import { parseDiff } from './diff.js';
import { branchName, getDiff, gitPath, nestedGuidelineFiles, repoRoot } from './git.js';
import { helpText } from './help.js';
import { makeT } from './i18n.js';
import { init, uninstallHook } from './init.js';
import { isSafeRelPath } from './fsafe.js';
import { renderCommits, renderSuite, runCommits, runSuite } from './bench.js';
import { agentPrompt, explainPrompt, systemPrompt } from './prompt.js';
import { loadNeverSend } from './exclude.js';
import { complete, expandProvider, extractJson, PROVIDER_SPECS } from './providers.js';
import { ruleStats } from './secrets.js';
import { runReview } from './review.js';
import { describeProviderFull, isTrusted, trust } from './trust.js';
import { appendEgress, readEgress, addIgnored, cacheGet, cacheKey, cachePut, diffHash, loadIgnored, readLast, writeLast } from './store.js';
import { contentWidth, fixLine, fixVerdict, mdLines, plainHeading, renderCard, renderIndex, renderSummary, renderWalkthrough, verdictBlock, wrap } from './ui.js';

const stringify = e => (e && e.message) || String(e);
const brand = sub => pc.bgMagenta(pc.black(' revu ')) + (sub ? pc.dim(`  ${sub}`) : '');

function copyToClipboard(text) {
  const cmds = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip']] : [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  for (const [c, ...args] of cmds) { try { execFileSync(c, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return true; } catch {} }
  return false;
}

// Who is running us? Agents/CI can't answer menus, so they get the plain report instead.
const truthy = v => v && !/^(0|false|no)$/i.test(v);
function detectUnattended(cfg) {
  if (cfg.interactive === false) return 'config (interactive: false)';
  if (truthy(process.env.REVU_PLAIN) || truthy(process.env.REVU_NONINTERACTIVE)) return 'REVU_PLAIN';
  if (truthy(process.env.CI)) return 'CI';
  if (truthy(process.env.CLAUDECODE)) return 'Claude Code';
  return null;
}

// A menu nobody answers must not hang a commit forever (unknown agents driving a real terminal).
async function askIdle(promptFn, options, idleS, idle) {
  if (!idleS) return promptFn(options);
  const ac = new AbortController();
  const timer = setTimeout(() => { idle.hit = true; ac.abort(); }, idleS * 1000);
  try { return await promptFn({ ...options, signal: ac.signal }); } finally { clearTimeout(timer); }
}

function getRoot(t) {
  try { return repoRoot(process.cwd()); } catch { console.error(t('noRepo')); return null; }
}

// No provider configured? Pick whatever works on this machine so revu "just runs".
async function ensureProvider(cfg, t, note) {
  if (!cfg.provider) {
    const spec = await autoProviderSpec();
    if (!spec) throw new Error(t('noProvider'));
    cfg.provider = expandProvider(spec);
    note(t('autoProvider', { spec }));
    return;
  }
  // A provider defined by the REPO that can run a command / pick a URL must be approved by the user first.
  if (cfg._providerNeedsTrust && !isTrusted(cfg._root, cfg.provider)) throw new Error(t('untrustedProvider', { what: describeProviderFull(cfg.provider) }));
}

async function review(values) {
  if (process.env.REVU_SKIP) return 0;
  const root = getRoot(makeT());
  if (!root) return 1;

  const cfg = loadConfig(root);
  const t = makeT();
  wireEgressLog(cfg, root);
  const mode = values.base ? { base: values.base } : values.all ? 'all' : 'staged';
  const showPrompt = !!values['show-prompt'];
  const unattendedBy = detectUnattended(cfg);
  const interactive = !values.plain && !values.json && !showPrompt && !unattendedBy && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const idle = { hit: false };
  const idleS = Number(cfg.prompt_timeout_s ?? 90);

  const emit = interactive ? m => p.log.message(m) : m => console.log(m);
  const tag = pc.dim(`${t('toolPrefix')} ›`);
  const info = interactive ? m => p.log.info(m) : m => console.log(`${tag} ${pc.dim(m)}`);
  const warn = interactive ? m => p.log.warn(m) : m => console.log(`${tag} ${pc.yellow('⚠ ' + m)}`);
  const heading = interactive ? (m, body) => p.note(body, m) : (m, body) => console.log(`${plainHeading(m)}\n${body}\n`);

  if (interactive) p.intro(brand(branchName(root)));

  const diffText = getDiff(root, mode, cfg.context_lines);
  const files = parseDiff(diffText);
  if (!files.length) {
    const msg = mode === 'staged' ? t('nothingStaged') : t('nothingToReview');
    values.json ? console.log(JSON.stringify({ findings: [] })) : (interactive ? p.outro(msg) : console.log(msg));
    return 0;
  }

  const scoped = scopedGuidelines(root, files.map(f => f.path), cfg.guidelines_files);
  if (!cfg._sources.some(s => s.ok) && !scoped.length) info(t('noConfigHint'));

  if (showPrompt) {
    const r = await runReview({ cfg, files, root, branch: branchName(root), scoped, dryRun: true });
    if (r.stats?.withheld?.length) console.log(pc.yellow(t('withheldNote', { n: r.stats.withheld.length, files: r.stats.withheld.join(', ') })) + '\n');
    if (r.stats?.redactions) console.log(pc.yellow(t('redactedNote', { n: r.stats.redactions })) + '\n');
    r.prompts.forEach((pr, i) => {
      console.log(pc.bold(pc.magenta(t('promptHeader', { i: i + 1, of: r.prompts.length }))));
      console.log(pc.dim('─── system ───') + '\n' + pr.system + '\n' + pc.dim('─── user ───') + '\n' + pr.user + '\n');
    });
    return 0;
  }

  // Provider failures never lock you out of committing unless you set fail_open: false
  const failure = e => {
    if (e?.code === 'SECRET_EGRESS') { // fail CLOSED: never let fail_open turn a blocked leak into a silent pass
      if (values.json) console.log(JSON.stringify({ error: stringify(e) })); else { warn(stringify(e)); info(t('egressHint')); }
      if (interactive) p.outro('');
      return 1;
    }
    if (values.json) console.log(JSON.stringify({ error: stringify(e) }));
    else { warn(t('providerError', { msg: stringify(e) })); info(t('doctorHint')); }
    if (cfg.fail_open) info(t('failOpen'));
    if (interactive) p.outro('');
    return cfg.fail_open ? 0 : 1;
  };

  try { await ensureProvider(cfg, t, info); } catch (e) { return failure(e); }
  const provider = describeProvider(cfg.provider);

  // ── run (or reuse) the review ────────────────────────────────────────────
  const cacheDir = path.resolve(root, gitPath(root, 'revu-cache'));
  const key = cacheKey(systemPrompt(cfg), diffText, cfg._guidelinesText, JSON.stringify(cfg.path_instructions), JSON.stringify(scoped), JSON.stringify(cfg.provider), cfg.profile, cfg.max_findings);
  let result = values['no-cache'] ? null : cacheGet(cacheDir, key);
  let seconds = null;
  const spin = interactive ? p.spinner() : null;
  if (result) {
    const ignored = loadIgnored(root);
    result.findings = result.findings.filter(f => !ignored[f.fingerprint]);
    info(t('cached'));
  } else {
    const started = Date.now();
    const msg = t('reviewing', { n: files.length, provider });
    spin ? spin.start(msg) : console.error(`${tag} ${pc.dim(msg)}`);
    try {
      result = await runReview({
        cfg, files, root, scoped, branch: branchName(root),
        onProgress: ({ batch, of }) => of > 1 && spin?.message(t('reviewingBatch', { i: batch, of, provider })),
      });
    } catch (e) {
      spin?.stop(pc.red('✖'));
      return failure(e);
    }
    seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.llmError) {
      // The LLM failed, but the LOCAL checks (secrets, sensitive files, hidden Unicode) already ran. They are reported and
      // block regardless of fail_open; fail_open only decides what to do when there is nothing else to say.
      const e = result.llmError; delete result.llmError;
      const blockingLocal = result.findings.some(f => f.local && cfg.block_on.includes(f.severity));
      spin?.stop(pc.yellow('⚠'));
      if (!blockingLocal || e.code === 'SECRET_EGRESS') return failure(e);
      warn(t('providerError', { msg: stringify(e) }));
    } else {
      spin?.stop(pc.green('✔') + pc.dim(` ${seconds}s`));
      cachePut(cacheDir, key, result);
    }
  }

  writeLast(path.resolve(root, gitPath(root, 'revu-last.json')), { version: 1, at: new Date().toISOString(), mode, diffHash: diffHash(diffText), findings: result.findings });

  if (values.json) { console.log(JSON.stringify({ notice: t('untrustedNotice'), ...result }, null, 2)); return result.findings.some(f => cfg.block_on.includes(f.severity)) ? 1 : 0; }

  const { findings, stats } = result;
  if (!stats.files) { interactive ? p.outro(t('nothingToReview')) : console.log(t('nothingToReview')); return 0; }

  heading(t('summary'), renderSummary(result, { provider, seconds }, t));
  const wt = renderWalkthrough(result);
  if (wt) heading(t('walkthrough'), wt);
  if (stats.dropped) info(t('dropped', { n: stats.dropped }));
  if (stats.withheld?.length) info(t('withheldNote', { n: stats.withheld.length, files: stats.withheld.join(', ') }));
  if (stats.redactions) info(t('redactedNote', { n: stats.redactions }));
  if (cfg.secret_policy === 'off') warn(t('secretOff'));
  const truncBlock = cfg.on_truncate === 'block' && stats.truncated?.length > 0;
  if (stats.truncated?.length) warn(t('truncatedWarn', { files: stats.truncated.join(', ') }));
  if (stats.ignored) info(t('ignoredNote', { n: stats.ignored }));

  if (!findings.length) {
    if (truncBlock) { const b = verdictBlock('blocked', 1, t); interactive ? (p.log.message(b), p.outro('')) : console.log('\n' + b); return 1; }
    interactive ? p.outro(pc.green('✔ ') + t('clean')) : console.log('\n' + verdictBlock('ok', stats.truncated?.length || 0, t));
    return 0;
  }

  heading(t('lblFindings', { n: findings.length }), renderIndex(findings, t));

  // ── walk through findings ────────────────────────────────────────────────
  const tally = { fixed: 0, skipped: 0, ignored: 0 };
  const unresolved = [];
  const stage = mode === 'staged';
  let stopped = false;

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    emit(renderCard(f, i + 1, findings.length, t) + (interactive ? '' : '\n'));
    if (!interactive || stopped) { unresolved.push(f); continue; }

    let resolved = false;
    while (true) {
      const options = [];
      if (f.suggestion_code) options.push({ value: 'apply', label: t('apply'), hint: stage ? t('applyHint') : '' });
      options.push(
        { value: 'skip', label: t('skip'), hint: t('skipHint') },
        { value: 'ignore', label: t('ignore'), hint: t('ignoreHint') },
        { value: 'explain', label: t('explain') },
        { value: 'prompt', label: t('prompt') },
        { value: 'stop', label: t('stop') },
      );
      const action = await askIdle(p.select, { message: t('qAction'), options }, idleS, idle);
      if (idle.hit) { stopped = true; break; }
      if (p.isCancel(action) || action === 'stop') { stopped = true; break; }

      if (action === 'apply') {
        let allowRisky = false;
        if (f.risk?.length) {
          const ok = await p.confirm({ message: t('riskConfirm', { list: f.risk.map(r => t('risk')[r] || r).join(', ') }), initialValue: false });
          if (p.isCancel(ok) || !ok) continue;
          allowRisky = true;
        }
        const r = applySuggestion(root, f, { stage, t, allowRisky });
        if (r.ok) { p.log.success(t('appliedOk', { file: f.file })); tally.fixed++; resolved = true; break; }
        p.log.warn(t('applyFail', { reason: r.reason }));
      } else if (action === 'skip') { tally.skipped++; break; }
      else if (action === 'ignore') { addIgnored(root, f); tally.ignored++; resolved = true; break; }
      else if (action === 'explain') {
        const s2 = p.spinner(); s2.start(t('thinking'));
        try {
          const text = await complete(cfg, explainPrompt(cfg, f));
          s2.stop(pc.green('✔'));
          p.log.message(mdLines(wrap(text.trim(), contentWidth())).join('\n'));
        } catch (e) { s2.stop(pc.red('✖')); p.log.warn(stringify(e)); }
      } else if (action === 'prompt') {
        const text = agentPrompt(f);
        if (copyToClipboard(text)) p.log.success(t('copied')); else p.log.message(`${t('printedPrompt')}\n\n${text}`);
      }
    }
    if (!resolved) unresolved.push(f);
  }

  // ── verdict ──────────────────────────────────────────────────────────────
  const blockers = unresolved.filter(f => cfg.block_on.includes(f.severity));
  if (truncBlock) blockers.push({ severity: 'major' });
  if (!interactive || idle.hit) {
    if (idle.hit) warn(t('idleTimeout', { n: idleS }));
    const block = verdictBlock(blockers.length ? 'blocked' : 'ok', blockers.length || stats.truncated?.length || 0, t, blockers.filter(f => f.suggestion_code).length);
    interactive ? p.log.message(block) : console.log('\n' + block);
    if (interactive) p.outro('');
    return blockers.length ? 1 : 0;
  }

  info(t('tally', tally));
  if (tally.fixed && stage) info(t('fixesStaged'));
  if (!blockers.length) { p.log.message(verdictBlock('ok', stats.truncated?.length || 0, t)); p.outro(''); return 0; }

  p.log.warn(t('blockers', { n: blockers.length }));
  const go = await askIdle(p.select, {
    message: t('qCommit'),
    options: [
      { value: 'cancel', label: t('cancel'), hint: t('cancelHint') },
      { value: 'commit', label: t('commitAnyway') },
    ],
  }, idleS, idle);
  if (idle.hit) warn(t('idleTimeout', { n: idleS }));
  if (go === 'commit') { p.log.message(verdictBlock('warn', blockers.length, t)); p.outro(''); return 0; }
  p.log.message(verdictBlock('blocked', blockers.length, t, blockers.filter(f => f.suggestion_code).length));
  p.outro('');
  return 1;
}

// Local audit of what leaves the machine: paths, sizes and counters. Never content.
function wireEgressLog(cfg, root) {
  const file = path.resolve(root, gitPath(root, 'revu-egress.log'));
  cfg._egressLog = file;
  cfg._onEgress = prompt => {
    const meta = cfg._egressMeta || {}; cfg._egressMeta = null;
    appendEgress(file, { provider: describeProvider(cfg.provider), type: cfg.provider?.type, chars: prompt.system.length + prompt.user.length, filesSent: meta.files || [], withheld: meta.withheld || [], redactions: meta.redactions || 0, policy: cfg.secret_policy });
  };
}

// `revu fix` — apply the ready-made fixes of the last review without any menu (for agents, VS Code, CI).
async function fixCmd(values) {
  const root = getRoot(makeT());
  if (!root) return 1;
  const cfg = loadConfig(root);
  const t = makeT();
  const tag = pc.dim(`${t('toolPrefix')} ›`);
  const say = m => console.log(`${tag} ${m}`);
  const lastFile = path.resolve(root, gitPath(root, 'revu-last.json'));

  const saved = readLast(lastFile);
  if (!saved) { console.error(t('fixNoReview')); return 1; }
  if (!values.force && diffHash(getDiff(root, saved.mode, cfg.context_lines)) !== saved.diffHash) { say(pc.yellow('⚠ ' + t('fixStale'))); return 1; }

  const total = saved.findings.length;
  const all = saved.findings.map((f, i) => ({ ...f, n: i + 1 }));
  const pending = all.filter(f => !f.resolved);
  let selected;
  if (values.id) {
    const ids = String(values.id).split(',').map(x => parseInt(x, 10));
    if (ids.some(n => !(n >= 1 && n <= total))) { console.error(t('fixBadId', { id: values.id, max: total })); return 1; }
    selected = pending.filter(f => ids.includes(f.n));
  } else selected = values.all ? pending : pending.filter(f => cfg.block_on.includes(f.severity));
  if (!selected.length) { say(t('fixNothing')); return 0; }

  const dry = !!values['dry-run'];
  const stage = saved.mode === 'staged';
  const applied = [], manual = [], failed = [];
  say(t('fixHeader', { n: selected.length }));
  for (const f of selected) {
    if (!f.suggestion_code) { manual.push(f); continue; }
    if (!isSafeRelPath(f.file)) { failed.push({ f, reason: t('unsafePath') }); continue; }
    if (dry) { f.risk?.length ? failed.push({ f, reason: t('riskRefused', { list: f.risk.map(r => t('risk')[r] || r).join(', ') }) }) : applied.push(f); continue; }
    const r = applySuggestion(root, f, { stage, t });
    r.ok ? applied.push(f) : failed.push({ f, reason: r.reason });
  }

  const appliedSet = new Set(applied.map(f => f.n));
  const remaining = pending.filter(f => cfg.block_on.includes(f.severity) && !appliedSet.has(f.n)).length;

  if (values.json) {
    const slim = f => ({ n: f.n, severity: f.severity, file: f.file, line: f.line, title: f.title, explanation: f.explanation });
    console.log(JSON.stringify({ notice: t('untrustedNotice'), dry_run: dry, applied: applied.map(slim), manual: manual.map(slim), failed: failed.map(x => ({ ...slim(x.f), reason: x.reason })), remaining_blocking: remaining }, null, 2));
  } else {
    const section = (title, body) => console.log(`${plainHeading(title)}\n${body}\n`);
    if (applied.length) {
      if (dry) section(`${t('fixDry')} (${applied.length})`, applied.map(f => renderCard(f, f.n, total, t)).join('\n\n'));
      else section(`${t('fixApplied')} (${applied.length})`, applied.map(f => fixLine(f, stage ? t('fixStagedNote') : t('fixWrittenNote'), t)).join('\n'));
    }
    if (failed.length) section(`${t('fixFailed')} (${failed.length})`, failed.map(x => fixLine(x.f, x.reason, t)).join('\n'));
    if (manual.length) section(`${t('fixManual')} (${manual.length})`, manual.map(f => renderCard(f, f.n, total, t)).join('\n\n'));
    if (!applied.length && !dry) say(pc.yellow(t('fixNoneApplied')));
    if (!dry) console.log('\n' + fixVerdict(remaining, applied.length, t));
  }

  if (!dry) {
    saved.findings.forEach((f, i) => { if (appliedSet.has(i + 1)) f.resolved = true; });
    writeLast(lastFile, { ...saved, diffHash: diffHash(getDiff(root, saved.mode, cfg.context_lines)) });
  }
  return dry ? 0 : remaining ? 1 : 0;
}

// `revu trust` — explicitly approve a provider that this repository's config asks for.
async function trustCmd() {
  const root = getRoot(makeT());
  if (!root) return 1;
  const cfg = loadConfig(root);
  const t = makeT();
  if (!cfg.provider || !cfg._providerNeedsTrust) { console.log(t('trustNothing')); return 0; }
  console.log(`${pc.bold(t('trustHeader'))}\n\n  ${pc.cyan(describeProviderFull(cfg.provider))}\n`);
  if (isTrusted(root, cfg.provider)) { console.log(pc.green(t('trustDone'))); return 0; }
  // never approvable by an agent / CI / pipe: a person must answer at a real terminal
  if (detectUnattended(cfg) || !process.stdin.isTTY || !process.stdout.isTTY) { console.error(pc.red(t('trustUnattended'))); return 1; }
  const ok = await p.confirm({ message: t('trustAsk'), initialValue: false });
  if (p.isCancel(ok) || !ok) return 1;
  trust(root, cfg.provider);
  console.log(pc.green(t('trustDone')));
  return 0;
}

// `revu egress` — what has actually been sent to an LLM from this repo (paths/sizes only)
function egressCmd() {
  const root = getRoot(makeT());
  if (!root) return 1;
  const cfg = loadConfig(root);
  const t = makeT();
  const rows = readEgress(path.resolve(root, gitPath(root, 'revu-egress.log')), 20);
  console.log(pc.bold(t('egressTitle')) + '\n');
  if (!rows.length) { console.log(t('egressNone')); return 0; }
  for (const r of rows) {
    console.log(`${pc.dim(r.at.replace('T', ' ').slice(0, 19))}  ${pc.cyan(String(r.provider))}  ${r.chars} chars  sent: ${(r.filesSent || []).join(', ') || '—'}`);
    const extra = [r.withheld?.length ? `withheld: ${r.withheld.join(', ')}` : '', r.redactions ? `${r.redactions} redacted` : ''].filter(Boolean).join(' · ');
    if (extra) console.log(`${' '.repeat(21)}${pc.yellow(extra)}`);
  }
  return 0;
}

// `revu bench` — how good is the configured LLM at THIS job, on a fixed suite of planted bugs (synthetic: your files are not used).
async function benchCmd(values) {
  let root = null;
  try { root = repoRoot(process.cwd()); } catch { /* bench also works outside a repository */ }
  const cfg = loadConfig(root || process.cwd());
  const t = makeT();
  const spec = values.provider;
  try {
    if (spec) { cfg.provider = expandProvider(spec); cfg._providerNeedsTrust = false; } // typed by you on the command line
    else await ensureProvider(cfg, t, m => values.json || console.error(pc.dim(`${t('toolPrefix')} › ${m}`)));
  } catch (e) { console.error(pc.red(stringify(e))); return 1; }
  const label = spec || describeProvider(cfg.provider);
  const runs = Math.max(1, Math.min(10, parseInt(values.runs, 10) || 1));
  if (!values.json) console.error(pc.dim(`${t('toolPrefix')} › running the suite ${runs} time(s) with ${label}; the first call can be slow while a local model loads…`));

  const results = [];
  for (let i = 0; i < runs; i++) { const r = await runSuite(cfg); results.push(r); if (r.error) break; }
  const last = results.at(-1);
  let rows = null;
  if (values.commits && root && !last.error) {
    if (!values.json) console.error(pc.yellow(`${t('toolPrefix')} › --commits sends the diffs of your last ${values.commits} commits to ${label} (secret protection applies).`));
    rows = await runCommits(cfg, root, Math.max(1, Math.min(20, parseInt(values.commits, 10) || 3)));
  }
  if (values.json) {
    console.log(JSON.stringify({ suite_version: 1, provider: label, runs: results.map(r => r.error ? { error: r.error } : { found: r.found, total: r.total, falseAlarms: r.falseAlarms, extras: r.extras.length, seconds: r.seconds, meta: r.meta }), ...(last.error ? { error: last.error } : { found: last.found, total: last.total, falseAlarms: last.falseAlarms }), commits: rows }, null, 2));
    return last.error ? 1 : 0;
  }
  console.log(renderSuite(last, label));
  if (runs > 1 && !last.error) console.log(`\n${runs} runs: ${results.map(r => `${r.found}/${r.total}`).join(', ')} planted bugs found (the same model can vary from run to run)`);
  if (rows) console.log(renderCommits(rows));
  return last.error ? 1 : 0;
}

// `revu rules` — answers "what is it actually reading?"
function rulesCmd() {
  const root = getRoot(makeT());
  if (!root) return 1;
  const cfg = loadConfig(root);
  const t = makeT();
  const found = cfg._sources.filter(s => s.ok);
  const missing = cfg._sources.filter(s => !s.ok);
  const nested = nestedGuidelineFiles(root).filter(rel => !(cfg.guidelines_files || []).includes(rel));

  console.log(`${pc.bold(t('rulesTitle'))}  ${pc.dim(root)}\n`);
  if (!found.length && !nested.length) console.log(pc.yellow(t('rulesNone')));
  const size = s => pc.dim(`${s.chars} ${t('chars')}`);
  for (const s of found) console.log(`  ${pc.green('✔')} ${s.label}  ${size(s)}${s.scope ? pc.dim(`  → ${t('appliesTo')}: `) + pc.cyan(s.scope) : ''}`);
  for (const s of missing.filter(x => !x.auto || x.blocked)) console.log(`  ${pc.red('✖')} ${s.label}  ${pc.dim(s.blocked ? t('outsideRepo') : t('docMissing'))}`);
  if (nested.length) {
    console.log(`\n${pc.bold(t('rulesNested'))}`);
    for (const rel of nested) console.log(`  ${pc.green('✔')} ${rel}  ${pc.dim(`→ ${t('appliesTo')}: `)}${pc.cyan(path.posix.dirname(rel) + '/**')}`);
  }
  const nv = loadNeverSend(root, cfg.never_send);
  if (nv.sources.length) { console.log(`\n${pc.bold(t('rulesNeverSend'))}`); for (const x of nv.sources) console.log(`  ${pc.green('✔')} ${x.file}  ${pc.dim(x.count + ' patterns')}`); }
  const auto = missing.filter(x => x.auto && !x.blocked).map(x => x.label);
  if (auto.length) console.log(`\n${pc.dim(t('rulesAlso', { list: auto.join(', ') }))}`);
  console.log(`\n${t('rulesBlock', { list: pc.bold(cfg.block_on.join(', ')) })}`);
  console.log(pc.dim(t('rulesTip')));
  return 0;
}

async function doctor() {
  const root = getRoot(makeT());
  if (!root) return 1;
  const cfg = loadConfig(root);
  const t = makeT();
  const state = f => (fs.existsSync(f) ? pc.green(t('docFound')) : pc.dim(t('docMissing')));
  console.log(pc.bold(t('docFiles')));
  for (const f of [path.join(root, '.revu.yaml'), path.join(root, '.revu.local.yaml'), userConfigPath()]) console.log(`  ${f}  ${state(f)}`);

  try { await ensureProvider(cfg, t, m => console.log('  ' + pc.yellow(m))); } catch (e) { console.log(pc.red('✖ ' + stringify(e))); return 1; }
  console.log(`  ${t('docLlm')}: ${pc.cyan(JSON.stringify(cfg.provider))}`);
  const cmd = cfg.provider.type === 'command' ? cfg.provider.command : '';
  if (cmd && !/^claude\b.*--tools\s+(""|'')/.test(cmd) && !/^codex\b.*--sandbox\s+read-only/.test(cmd)) console.log(`  ${pc.yellow('⚠ ' + t('docAgentic'))}`);
  console.log(`  profile: ${cfg.profile} · block_on: ${cfg.block_on.join(', ')}`);
  console.log(`  ${t('docRules', { n: cfg._sources.filter(s => s.ok).length })}`);
  const rs = ruleStats();
  console.log(`  ${cfg.secret_policy === 'off' ? pc.red('⚠ ' + t('secretOff')) : t('docSecrets', { policy: pc.green(cfg.secret_policy), rules: rs.compiled, approx: rs.inexact })}${rs.failed.length ? pc.red('  (rules failed to compile: ' + rs.failed.join(', ') + ')') : ''}`);
  const hook = path.join(path.resolve(root, gitPath(root, 'hooks')), 'pre-commit');
  console.log(`  ${fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes('>>> revu') ? pc.green(t('docHookOk')) : pc.yellow(t('docHookNo'))}\n`);

  const s = p.spinner(); s.start(t('docTesting'));
  const t0 = Date.now();
  try {
    extractJson(await complete(cfg, { system: 'Reply with ONLY this JSON: {"ok": true}', user: 'ping' }));
    const used = cfg._llmMeta?.models?.length ? `  (model: ${cfg._llmMeta.models.join(' + ')})` : '';
    s.stop(pc.green('✔ ' + t('docOk', { s: ((Date.now() - t0) / 1000).toFixed(1) })) + pc.dim(used));
    return 0;
  } catch (e) { s.stop(pc.red('✖ ' + stringify(e))); return 1; }
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      all: { type: 'boolean' }, base: { type: 'string' }, plain: { type: 'boolean' }, json: { type: 'boolean' },
      'no-cache': { type: 'boolean' }, 'show-prompt': { type: 'boolean' },
      id: { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, runs: { type: 'string' }, commits: { type: 'string' },
      provider: { type: 'string' }, profile: { type: 'string' }, yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  const cmd = positionals[0] || 'review';
  if (values.help || cmd === 'help') { console.log(helpText(PROVIDER_SPECS)); return 0; }
  if (values.version) { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return 0; }
  switch (cmd) {
    case 'init': return init({ provider: values.provider, profile: values.profile, yes: values.yes });
    case 'doctor': return doctor();
    case 'rules': return rulesCmd();
    case 'fix': return fixCmd(values);
    case 'trust': return trustCmd();
    case 'egress': return egressCmd();
    case 'bench': return benchCmd(values);
    case 'uninstall': { const t = makeT(); const r = getRoot(t); if (!r) return 1; console.log(uninstallHook(r) ? t('hookRemoved') : t('noHook')); return 0; }
    case 'review': case 'hook': return review(values);
    default: console.error(`Unknown command "${cmd}"\n`); console.log(helpText(PROVIDER_SPECS)); return 1;
  }
}

main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(pc.red(stringify(e))); process.exit(1); });
