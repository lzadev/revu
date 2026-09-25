import pc from 'picocolors';
import { redactLine, visible } from './guard.js';

const cols = () => Math.min(process.stdout.columns || 100, 100);
export const contentWidth = () => cols() - 6; // leave room for clack's "│  " gutter

export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    out.push(line);
  }
  return out;
}

// **bold** and `code` inline styling. Stateful across wrapped lines so spans that
// straddle a line break stay styled; state resets on blank lines.
export function mdLines(lines) {
  let code = false, bold = false;
  return lines.map(line => {
    if (!line.trim()) { code = bold = false; return line; }
    let out = '', buf = '';
    const flush = () => { if (buf) out += code ? pc.cyan(buf) : bold ? pc.bold(buf) : buf; buf = ''; };
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '`') { flush(); code = !code; }
      else if (line[i] === '*' && line[i + 1] === '*' && !code) { flush(); bold = !bold; i++; }
      else buf += line[i];
    }
    flush();
    return out;
  });
}
export const md = s => mdLines([s])[0];

const SEV = {
  critical: { icon: '🔴', badge: s => pc.bgRed(pc.white(pc.bold(` ${s} `))), color: pc.red },
  major: { icon: '🟠', badge: s => pc.bgYellow(pc.black(pc.bold(` ${s} `))), color: pc.yellow },
  minor: { icon: '🟡', badge: s => pc.bgBlue(pc.white(pc.bold(` ${s} `))), color: pc.blue },
  nit: { icon: '⚪', badge: s => pc.bgWhite(pc.black(` ${s} `)), color: pc.gray },
};
export const sevColor = s => SEV[s]?.color || pc.white;

export const rule = (ch = '━', w = contentWidth()) => ch.repeat(Math.max(10, Math.min(w, 80)));
const ind = (lines, n = 3) => lines.map(l => ' '.repeat(n) + l);
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const where = f => `${f.file}:${f.line}${f.end_line > f.line ? '-' + f.end_line : ''}`;

// Section headers are fixed labels with an icon, so you can always tell WHAT you are reading:
// 📍 the code · ❌ what is wrong · ✅ how to fix it
const label = (icon, text, color) => color(pc.bold(`${icon} ${text}`));

export function renderCard(f, idx, total, t) {
  const w = contentWidth() - 3;
  const sev = SEV[f.severity] || SEV.minor;
  const out = [
    sev.color(rule()),
    `${sev.icon} ${sev.badge(t('sev')[f.severity] || f.severity.toUpperCase())}  ${pc.dim(`${idx}/${total}`)}  ${pc.dim([f.category, f.rule && short(f.rule, 48)].filter(Boolean).join(' · '))}`,
    pc.bold(sev.color(f.title)),
    `📄 ${pc.cyan(where(f))}`,
    '',
    label('📍', t('lblCode'), pc.cyan),
  ];

  const pad = String(Math.max(...f.frame.map(l => l.no))).length;
  const code = f.frame.map(l => {
    const gutter = `${String(l.no).padStart(pad)} │`;
    const text = l.text.length > w - pad - 5 ? l.text.slice(0, w - pad - 6) + '…' : l.text;
    return l.hit ? `${sev.color('▶')} ${sev.color(gutter)} ${pc.bold(text)}` : `  ${pc.dim(gutter)} ${pc.dim(text)}`;
  });
  out.push(...ind(code, 1));

  if (f.explanation) out.push('', label('❌', t('lblWrong'), pc.red), ...ind(mdLines(wrap(f.explanation, w))));

  out.push('', label('✅', t('lblFix'), pc.green));
  if (f.suggestion_code) {
    const a = f.original, b = f.suggestion_code.split('\n');
    const shown = l => redactLine(visible(l));
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre].trimEnd() === b[pre].trimEnd()) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf].trimEnd() === b[b.length - 1 - suf].trimEnd()) suf++;
    const diff = [
      ...a.slice(0, pre).map(l => pc.dim(`  ${shown(l)}`)),
      ...a.slice(pre, a.length - suf).map(l => pc.red(`- ${shown(l)}`)),
      ...b.slice(pre, b.length - suf).map(l => pc.green(`+ ${shown(l)}`)),
      ...a.slice(a.length - suf).map(l => pc.dim(`  ${shown(l)}`)),
    ];
    out.push(...ind(diff));
    if (f.risk?.length) out.push('', ...ind([pc.yellow(pc.bold(`⚠ ${t('riskWarn', { list: f.risk.map(r => t('risk')[r] || r).join(', ') })}`))]));
  } else out.push(...ind([pc.dim(t('noCodeFix'))]));
  return out.join('\n');
}

// One line per finding, shown before the details: see everything at a glance.
export function renderIndex(findings, t) {
  const w = contentWidth();
  const labelW = Math.max(...findings.map(f => (t('sev')[f.severity] || f.severity).length));
  return findings.map((f, i) => {
    const sev = SEV[f.severity] || SEV.minor;
    const head = `${String(i + 1).padStart(2)}  ${sev.icon} ${sev.color(pc.bold((t('sev')[f.severity] || f.severity.toUpperCase()).padEnd(labelW)))}`;
    return `${head}  ${short(f.title, Math.max(20, w - labelW - 8))}\n${' '.repeat(6 + labelW)}${pc.dim(short(where(f), w - labelW - 8))}`;
  }).join('\n');
}

// The final answer, impossible to miss: is the commit blocked or allowed, and what to do.
export function verdictBlock(kind, n, t, fixable = 0) {
  const w = rule();
  if (kind === 'ok' && n > 0) return [pc.yellow(w), pc.yellow(pc.bold(t('verdictPartial', { n }))), pc.yellow(w)].join('\n'); // allowed, but not everything was reviewed
  if (kind === 'ok') return [pc.green(w), pc.green(pc.bold(t('verdictOk'))), pc.green(w)].join('\n');
  if (kind === 'warn') return [pc.yellow(w), pc.yellow(pc.bold(t('verdictForced', { n }))), pc.yellow(w)].join('\n');
  return [
    pc.red(w),
    pc.red(pc.bold(t('verdictBlocked', { n }))),
    '',
    ...ind([t('todoTitle'), `  1. ${fixable ? t('todo1Fix', { n: fixable }) : t('todo1')}`, `  2. ${t('todo2')}`, `  3. ${t('todo3')}`], 2),
    '',
    ...ind([pc.dim(`ℹ️  ${t('untrustedNotice')}`)], 2),
    pc.red(w),
  ].join('\n');
}

// Section heading for the plain (non-interactive) report
export const plainHeading = title => `\n${pc.bold(pc.magenta(`━━ ${title.toUpperCase()} `))}${pc.magenta('━'.repeat(Math.max(4, Math.min(contentWidth(), 80) - title.length - 4)))}`;

const kfmt = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// "claude-sonnet-5 · 5.2k in / 0.7k out · ≈$0.031 · 21.1s": which model answered, how much it read/wrote and what it cost
// (≈ = list-price equivalent, e.g. a subscription that is not billed per token).
export function usageLine(meta, seconds) {
  const m = meta || {};
  const parts = [m.models?.length ? m.models.join(' + ') : null];
  if (m.input || m.output) parts.push(`${kfmt(m.input || 0)} in / ${kfmt(m.output || 0)} out`);
  if (m.cost) parts.push(`${m.costBasis === 'list' ? '≈' : ''}$${m.cost.toFixed(3)}`);
  if (seconds) parts.push(`${seconds}s`);
  return parts.filter(Boolean).join(' · ');
}

export function renderSummary(result, meta, t) {
  const w = contentWidth();
  const { stats } = result;
  const usage = usageLine(result.meta, meta.seconds);
  const lines = [
    pc.dim(`${stats.files} ${t('files')} · `) + pc.green(`+${stats.additions}`) + pc.dim(' ') + pc.red(`−${stats.deletions}`) +
      pc.dim(` · ${meta.provider}${usage ? ` · ${usage}` : meta.seconds ? ` · ${meta.seconds}s` : ''}`),
  ];
  if (result.summary) lines.push('', ...mdLines(wrap(result.summary, w)));
  return lines.join('\n');
}

export function renderWalkthrough(result) {
  const w = contentWidth();
  const rows = result.walkthrough;
  if (!rows.length) return '';
  const fw = Math.min(38, Math.max(...rows.map(r => r.file.length)));
  return rows.map(r => {
    const name = r.file.length > fw ? '…' + r.file.slice(-(fw - 1)) : r.file.padEnd(fw);
    const change = mdLines(wrap(r.change, w - fw - 3));
    return [pc.cyan(name) + '  ' + (change[0] || ''), ...change.slice(1).map(c => ' '.repeat(fw + 2) + c)].join('\n');
  }).join('\n');
}

// Result of `revu fix`
export function fixVerdict(remaining, applied, t) {
  const w = rule();
  if (!remaining) return [pc.green(w), pc.green(pc.bold(t('fixDone', { n: applied }))), '', ...ind([t('fixDoneNext')], 2), pc.green(w)].join('\n');
  return [pc.red(w), pc.red(pc.bold(t('fixRemain', { n: remaining }))), '', ...ind([t('fixRemainNext')], 2), pc.red(w)].join('\n');
}
export const fixLine = (f, note, t) => {
  const sev = SEV[f.severity] || SEV.minor;
  return `${sev.icon} ${sev.color(pc.bold(t('sev')[f.severity] || f.severity))}  ${f.title}\n      ${pc.cyan(where(f))}${note ? pc.dim('  → ' + note) : ''}`;
};
