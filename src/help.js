import pc from 'picocolors';

const H = {
  en: {
    tagline: 'AI code review on every commit — your rules, any LLM.',
    how: 'How it works',
    howBody: [
      'You run `git commit` as usual. A git hook (installed by `revu init`) runs revu,',
      'which sends your staged changes + your rules to the LLM you chose, shows the',
      'problems it found, and only lets the commit through if nothing serious is left.',
    ],
    start: 'Get started',
    startBody: ['cd your-project', 'revu init          # pick your LLM, create .revu.yaml, install the hook', 'git commit         # that\'s it — review runs automatically'],
    cmds: 'Commands',
    cmdList: [
      ['revu', 'review what is staged (what the hook does) — use it to try things'],
      ['revu --all', 'review all your changes vs HEAD'],
      ['revu --base main', 'review this whole branch vs main (like a PR)'],
      ['revu init', 'set up the current repo'],
      ['revu fix', 'apply the ready-made fixes of the last review (no menus: for agents / VS Code)'],
      ['revu bench', 'score the configured LLM on planted bugs (7 bugs + 2 clean files); --runs N, --commits N, --provider <spec>'],
      ['revu egress', 'show what has been sent to an LLM from this repo (paths and sizes, never content)'],
      ['revu trust', 'approve the LLM provider a repository asks for (commands / custom URLs)'],
      ['revu rules', 'show which rules are being used, and from which files'],
      ['revu doctor', 'check config and test the LLM connection'],
      ['revu uninstall', 'remove the git hook'],
    ],
    opts: 'Options',
    optList: [
      ['--plain', 'no menus, just print the report (automatic without a terminal)'],
      ['--json', 'machine-readable output, for CI'],
      ['fix --dry-run', 'show what `revu fix` would change, without writing'],
      ['fix --id 1,3', 'apply only these findings (numbers from the report) · --all includes non-blocking'],
      ['--show-prompt', 'print exactly what would be sent to the LLM, without calling it'],
      ['--no-cache', 'ignore the cached result for an unchanged diff'],
      ['REVU_SKIP=1', 'skip once (or: git commit --no-verify)'],
    ],
    initFlags: 'Non-interactive init (scripts / team onboarding)',
    initFlagsBody: 'revu init --yes --provider ollama:qwen2.5-coder:14b',
    prov: 'LLM values for `provider:`',
    docs: 'Docs: README.md',
  },
};

export function helpText(specs) {
  const h = H.en;
  const row = ([a, b]) => `  ${pc.cyan(a.padEnd(18))}${b}`;
  return [
    `${pc.bold(pc.magenta('revu'))} — ${h.tagline}`, '',
    pc.bold(h.how), ...h.howBody.map(l => '  ' + l), '',
    pc.bold(h.start), ...h.startBody.map(l => '  ' + pc.dim('$ ') + l), '',
    pc.bold(h.cmds), ...h.cmdList.map(row), '',
    pc.bold(h.opts), ...h.optList.map(row), '',
    pc.bold(h.initFlags), '  ' + pc.dim('$ ') + h.initFlagsBody, '',
    pc.bold(h.prov), '  ' + specs, '', pc.dim(h.docs), '',
  ].join('\n');
}
