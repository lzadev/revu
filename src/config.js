import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { PROTECTED_FIX_PATHS } from './guard.js';
import { readInside } from './fsafe.js';
import { expandProvider } from './providers.js';

export const SEVERITIES = ['critical', 'major', 'minor', 'nit'];

// Rule files picked up automatically from the repo root (if they exist).
export const AUTO_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', 'CONTRIBUTING.md'];
// In sub-folders only these are auto-scoped to their folder (monorepos): frontend/AGENTS.md → files under frontend/
export const SCOPED_NAMES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_FILE_CHARS = 20000;

export const DEFAULTS = {
  profile: 'chill', // chill: only what matters · assertive: thorough, includes nits
  provider: null, // null → auto-detect (claude CLI, Ollama, LM Studio, API keys)
  block_on: ['critical', 'major'],
  fail_open: true, // if the LLM is unreachable, let the commit through
  interactive: 'auto', // 'auto' = menus when a human is at a terminal · false = never show menus
  prompt_timeout_s: 90, // a menu nobody answers for this long cancels the commit (0 = wait forever)
  max_findings: 15,
  context_lines: 8,
  max_chars_per_request: 48000,
  ignore_paths: [
    '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.lock',
    '**/dist/**', '**/build/**', '**/coverage/**', '**/*.min.*', '**/*.map', '**/*.snap',
    '**/*.{png,jpg,jpeg,gif,svg,ico,webp,pdf,woff,woff2}',
  ],
  guidelines: '',
  guidelines_files: AUTO_FILES, // set your own list to replace it, or [] to turn auto-discovery off
  path_instructions: [],
  // What happens when a secret is found in the diff:
  //   withhold (default): the file is NOT sent to any LLM at all · redact: secrets are replaced by a placeholder and the rest is sent · off: no protection
  secret_policy: 'withhold',
  never_send: [], // extra globs that must never reach an LLM (.revuignore / .cursorignore / .aiexclude / .copilotignore are read too)
  allow_secrets_in: [], // globs where secret-looking values are expected (test fixtures): not reported, but still never sent
  allow_sensitive_files: [], // globs of files like .env that you accept to commit
  fix_protected_paths: PROTECTED_FIX_PATHS, // `revu fix` never auto-edits these
  on_truncate: 'warn', // a file too big to review fully: warn | block
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}

// A provider that a REPO defines is only auto-trusted when it is a fixed preset (claude, ollama:model, openai:model…).
// Anything that can pick a command or a URL (object form, `command:`) needs the user's explicit approval (`revu trust`).
function readLayer(file, { repoRoot } = {}) {
  const text = repoRoot ? readInside(repoRoot, file, 200000) : (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  if (text == null) return { y: {}, unsafe: false };
  let y;
  try { y = YAML.parse(text) || {}; }
  catch (e) { throw new Error(`Invalid YAML in ${file}: ${e.message}`); }
  if (!isObj(y)) y = {};
  let unsafe = false;
  if (y.provider !== undefined) {
    const raw = y.provider;
    unsafe = !!repoRoot && (typeof raw !== 'string' || /^\s*command\s*:/.test(raw));
    try { y.provider = expandProvider(raw); } catch (e) { throw new Error(`${file}: ${e.message}`); }
  }
  return { y, unsafe };
}

export const userConfigPath = () => path.join(os.homedir(), '.config', 'revu', 'config.yaml');

// .revu/rules/*.md — one file per topic. Optional frontmatter `paths:` scopes it to globs.
function parseRuleFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try { meta = YAML.parse(m[1]) || {}; } catch {}
  return { meta, body: m[2] };
}

// Precedence (low → high): defaults < ~/.config/revu/config.yaml < .revu.yaml (team) < .revu.local.yaml (personal)
export function loadConfig(root) {
  const layers = [
    readLayer(userConfigPath()),
    readLayer(path.join(root, '.revu.yaml'), { repoRoot: root }),
    readLayer(path.join(root, '.revu.local.yaml'), { repoRoot: root }),
  ];
  const ys = layers.map(l => l.y);
  let cfg = ys.reduce(merge, DEFAULTS);
  cfg._providerNeedsTrust = layers.some(l => l.unsafe);
  cfg._root = root;
  cfg.block_on = (cfg.block_on || []).map(s => String(s).toLowerCase());
  cfg.path_instructions = [...(cfg.path_instructions || [])];

  const sources = []; // for `revu rules`: where every rule comes from
  const parts = [];

  if (String(cfg.guidelines || '').trim()) {
    parts.push(String(cfg.guidelines).trim());
    sources.push({ ok: true, label: 'guidelines (.revu.yaml)', chars: cfg.guidelines.length });
  }

  const auto = cfg.guidelines_files === AUTO_FILES;
  for (const rel of cfg.guidelines_files || []) {
    const abs = path.resolve(root, String(rel));
    const text = readInside(root, abs, MAX_FILE_CHARS); // refuses ../, absolute paths and symlinks that leave the repo
    if (text != null) {
      parts.push(`# ${rel}\n${text}`);
      sources.push({ ok: true, label: rel, chars: text.length, auto });
    } else sources.push({ ok: false, label: rel, auto, blocked: fs.existsSync(abs) });
  }

  const rulesDir = path.join(root, '.revu', 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const rel of fs.readdirSync(rulesDir, { recursive: true }).map(String).filter(f => /\.(md|mdc|txt)$/i.test(f)).sort()) {
      const raw = readInside(root, path.join(rulesDir, rel), MAX_FILE_CHARS);
      if (raw == null) continue;
      const { meta, body } = parseRuleFile(raw);
      const label = `.revu/rules/${rel}`;
      const globs = [].concat(meta.paths || meta.globs || []).flatMap(g => String(g).split(',')).map(g => g.trim()).filter(Boolean);
      if (globs.length) {
        for (const g of globs) cfg.path_instructions.push({ path: g, instructions: body, _source: label });
        sources.push({ ok: true, label, chars: body.length, scope: globs.join(', ') });
      } else {
        parts.push(`# ${label}\n${body}`);
        sources.push({ ok: true, label, chars: body.length });
      }
    }
  }

  for (const pi of cfg.path_instructions.filter(x => !x._source)) {
    sources.push({ ok: true, label: 'path_instructions (.revu.yaml)', chars: String(pi.instructions || '').length, scope: pi.path });
  }

  cfg._guidelinesText = parts.filter(Boolean).join('\n\n').trim();
  cfg._sources = sources;
  cfg._hasTeamConfig = fs.existsSync(path.join(root, '.revu.yaml'));
  return cfg;
}

// AGENTS.md / CLAUDE.md inside sub-folders apply only to files under that folder.
export function scopedGuidelines(root, filePaths, skip = []) {
  const seen = new Map();
  for (const fp of filePaths) {
    let dir = path.posix.dirname(fp);
    while (dir && dir !== '.') {
      for (const name of SCOPED_NAMES) {
        const rel = `${dir}/${name}`;
        if (seen.has(rel) || skip.includes(rel)) continue;
        seen.set(rel, readInside(root, path.join(root, rel), MAX_FILE_CHARS));
      }
      dir = path.posix.dirname(dir);
    }
  }
  return [...seen].filter(([, text]) => text).map(([rel, text]) => ({ path: `${path.posix.dirname(rel)}/**`, instructions: text, _source: rel }));
}

export const describeProvider = p =>
  !p ? 'auto' : p.type === 'command' ? p.command.split(/\s+/)[0] : `${p.model || 'model'}`;
