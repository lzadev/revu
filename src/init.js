import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import YAML from 'yaml';
import { detectProviders } from './detect.js';
import { gitCommonDir, gitPath, repoRoot } from './git.js';
import { trust } from './trust.js';
import { makeT } from './i18n.js';
import { expandProvider, PROVIDER_SPECS } from './providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', 'bin', 'revu.js');
const START = '# >>> revu >>>', END = '# <<< revu <<<';
export const shq = x => `'${String(x).replace(/'/g, `'\\''`)}'`; // POSIX single-quote escaping: paths can't inject shell code
const within = (dir, base) => dir === base || dir.startsWith(base + path.sep);

export function installHook(root) {
  const dir = path.resolve(root, gitPath(root, 'hooks'));
  if (dir.includes(`${path.sep}.husky`)) return { ok: false, husky: true };
  // a global / shared core.hooksPath would put our hook in EVERY repository that uses it
  const realRoot = fs.realpathSync(root);
  if (!within(dir, realRoot) && !within(dir, path.resolve(gitCommonDir(root)))) return { ok: false, outside: true, dir };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pre-commit');
  // The hook must survive a Node upgrade / nvm switch: try the Node it was installed with, then whatever `node` is on PATH.
  // If neither exists it says so and lets the commit continue (nothing is sent anywhere when revu cannot run).
  const block = [START,
    '# Re-attach the terminal so revu can be interactive',
    'if (: </dev/tty) 2>/dev/null; then exec </dev/tty; fi',
    `REVU_NODE=${shq(process.execPath)}`,
    `REVU_BIN=${shq(BIN)}`,
    '[ -x "$REVU_NODE" ] || REVU_NODE=$(command -v node)',
    'if [ -z "$REVU_NODE" ] || [ ! -f "$REVU_BIN" ]; then',
    '  echo "revu: cannot run (node or revu not found) — this commit was NOT reviewed. Run \'revu init\' again." >&2',
    'else',
    '  "$REVU_NODE" "$REVU_BIN" hook || exit 1',
    'fi',
    END].join('\n');
  let body;
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    body = cur.includes(START) ? cur.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block) : cur.replace(/\s*$/, '\n\n') + block + '\n';
  } else body = `#!/bin/sh\n${block}\n`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return { ok: true, file };
}

export function uninstallHook(root) {
  const file = path.join(path.resolve(root, gitPath(root, 'hooks')), 'pre-commit');
  if (!fs.existsSync(file)) return false;
  const cur = fs.readFileSync(file, 'utf8');
  if (!cur.includes(START)) return false;
  const next = cur.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), '\n');
  if (next.trim() === '#!/bin/sh' || !next.trim()) fs.rmSync(file); else fs.writeFileSync(file, next);
  return true;
}

function ensureGitignore(root, line) {
  const f = path.join(root, '.gitignore');
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.split('\n').includes(line)) fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
}

export async function init(opts = {}) {
  const t = makeT();
  const interactive = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!interactive && !opts.provider) { console.error(t('needFlags')); return 1; }
  const quit = () => { p.cancel(t('cancelled')); return 1; };
  const ask = async q => { const a = await p.select(q); return p.isCancel(a) ? null : a; };

  let root;
  try { root = repoRoot(process.cwd()); } catch { console.error(t('noRepo')); return 1; }
  if (interactive) p.intro(pc.bgMagenta(pc.black(' revu ')) + pc.dim(`  ${t('initTitle')}`));

  // 1) which LLM
  let spec = opts.provider;
  if (!spec) {
    const s = p.spinner(); s.start(t('lookingLlms'));
    const found = await detectProviders();
    s.stop(found.length ? t('foundN', { n: found.length }) : t('noneFound'));
    const options = found.map(f => ({ value: f.id, label: f.label, hint: f.hint }));
    options.push({ value: 'manual', label: t('manual'), hint: t('manualHint') });
    const choice = await ask({ message: t('qLlm'), options });
    if (!choice) return quit();
    if (choice === 'manual') spec = 'ollama:qwen2.5-coder:14b';
    else {
      const f = found.find(x => x.id === choice);
      if (f.spec) spec = f.spec;
      else if (f.models?.length) {
        const m = await ask({ message: t('qModel'), options: f.models.map(v => ({ value: v, label: v })) });
        if (!m) return quit();
        spec = f.prefix + m;
      } else spec = `${f.id}:`;
    }
  }
  try { expandProvider(spec); } catch (e) { console.error(e.message); return 1; }

  // 2) team rules file (only if missing)
  const teamFile = path.join(root, '.revu.yaml');
  if (!fs.existsSync(teamFile)) {
    let profile = opts.profile;
    if (!profile && interactive) { profile = await ask({ message: t('qProfile'), options: [{ value: 'chill', label: t('chill'), hint: t('chillHint') }, { value: 'assertive', label: t('assertive'), hint: t('assertiveHint') }] }); if (!profile) return quit(); }
    const tpl = fs.readFileSync(path.join(HERE, '..', 'templates', 'revu.yaml'), 'utf8').replace('__PROFILE__', profile || 'chill');
    fs.writeFileSync(teamFile, tpl);
    log(interactive, 'success', t('createdYaml', { f: pc.cyan('.revu.yaml') }));
  } else log(interactive, 'info', t('keptYaml', { f: pc.cyan('.revu.yaml') }));

  // 3) personal LLM choice (gitignored)
  fs.writeFileSync(path.join(root, '.revu.local.yaml'),
    `# Personal (not committed): which LLM YOU use. Team rules live in .revu.yaml\n# Options: ${PROVIDER_SPECS}\n${YAML.stringify({ provider: spec })}`);
  ensureGitignore(root, '.revu.local.yaml');
  // Presets are safe. A custom `command:` is only auto-approved when a person is answering at a terminal;
  // a scripted/agent `init --yes --provider command:…` must not be able to approve arbitrary commands (use `revu trust`).
  if (interactive || !/^\s*command\s*:/.test(spec)) trust(root, expandProvider(spec));
  log(interactive, 'success', t('savedLocal', { f: pc.cyan('.revu.local.yaml') }) + pc.dim(`  provider: ${spec}`));

  // 4) git hook
  const hook = installHook(root);
  if (hook.husky) log(interactive, 'warn', `${t('husky', { f: pc.cyan('.husky/pre-commit') })}\n  ${shq(process.execPath)} ${shq(BIN)} hook`);
  else if (hook.outside) log(interactive, 'warn', `${t('hookOutside', { dir: hook.dir })}\n  ${shq(process.execPath)} ${shq(BIN)} hook`);
  else log(interactive, 'success', t('hookInstalled', { f: pc.dim(path.relative(root, hook.file)) }));

  interactive ? p.outro(t('initDone')) : console.log(t('initDone'));
  return 0;
}

const log = (interactive, level, msg) => (interactive ? p.log[level](msg) : console.log(msg));
