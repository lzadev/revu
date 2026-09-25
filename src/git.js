import { execFileSync } from 'node:child_process';

function run(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (allowFail) return null;
    throw new Error((e.stderr || e.message).toString().trim());
  }
}

export const repoRoot = cwd => run(['rev-parse', '--show-toplevel'], { cwd }).trim();
export const branchName = cwd => (run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFail: true }) || '').trim();
export const gitPath = (cwd, p) => run(['rev-parse', '--git-path', p], { cwd }).trim();
export const hasHead = cwd => run(['rev-parse', '--verify', 'HEAD'], { cwd, allowFail: true }) !== null;

// mode: 'staged' (default, for commits) | 'all' (working tree vs HEAD) | { base } (branch vs base, like a PR)
export function getDiff(cwd, mode, contextLines) {
  const base = ['diff', '--no-color', '--no-ext-diff', `-U${contextLines}`, '-M', '--diff-filter=ACMRD'];
  if (mode === 'staged') return run([...base, '--cached'], { cwd });
  if (mode === 'all') return run([...base, hasHead(cwd) ? 'HEAD' : '--cached'], { cwd });
  const ref = String(mode.base);
  // never let a value become a git OPTION (e.g. --output=/some/file)
  if (ref.startsWith('-') || !/^[A-Za-z0-9._\/@~^{}:-]+$/.test(ref)) throw new Error(`Invalid --base ref: ${JSON.stringify(ref)}`);
  return run([...base, `${ref}...HEAD`, '--'], { cwd });
}

export const hasUnstagedChanges = (cwd, file) =>
  run(['diff', '--quiet', '--', file], { cwd, allowFail: true }) === null;
export const stageFile = (cwd, file) => run(['add', '--', file], { cwd });

// Tracked AGENTS.md / CLAUDE.md files that live in sub-folders (monorepos)
export const nestedGuidelineFiles = cwd =>
  (run(['ls-files', '-co', '--exclude-standard', '--', '*/AGENTS.md', '*/CLAUDE.md'], { cwd, allowFail: true }) || '').split('\n').filter(Boolean);

export const gitCommonDir = cwd => run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).trim();
