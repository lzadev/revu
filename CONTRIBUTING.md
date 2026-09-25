# Contributing to revu

Thank you for wanting to help. revu is a small, security-conscious project and every kind of contribution is welcome:
bug reports, documentation, tests, rules, new providers and ideas.

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [How the code is organised](#how-the-code-is-organised)
- [Making a change](#making-a-change)
- [Tests](#tests)
- [Security-sensitive changes](#security-sensitive-changes)
- [Common tasks](#common-tasks)
- [Style](#style)
- [Commit messages and pull requests](#commit-messages-and-pull-requests)

## Ways to contribute

- **Report a bug** with the [bug template](https://github.com/lzadev/revu/issues/new?template=bug_report.yml). Include `revu --version`,
  `node -v`, your OS and (with secrets removed) the output of `revu doctor`.
- **Try it somewhere we have not**: Windows, Cursor, Copilot's agent, GitHub Desktop and other local models are listed as
  untested in the README. A report of what worked or failed is very valuable.
- **Run `revu bench`** with a model you use and share the result in an issue: it helps everyone choose a model.
- **Improve the docs**, fix a typo, add an example.
- **Fix a bug or build a feature.** For anything bigger than a small fix, open an issue first so we can agree on the approach.
- **Report a vulnerability** privately: see [SECURITY.md](SECURITY.md). Please do not open a public issue for it.

## Development setup

You need Node.js 20 or newer and git.

```sh
git clone https://github.com/lzadev/revu.git
cd revu
npm install
npm test          # about a minute; no LLM, network or API key is needed
```

Use your working copy as the global command with `npm link`, then `revu --help`. The tests never call a real LLM: they use a
fake OpenAI-compatible server, fake CLIs and a fake Ollama (see `test/helpers.js`).

## How the code is organised

See [docs/architecture.md](docs/architecture.md). In short: `src/cli.js` has the commands, `src/review.js` orchestrates a
review, `src/providers.js` talks to LLMs (and holds the egress gate), `src/secrets.js` is the secret detector,
`src/guard.js` holds the safety checks, and `src/config.js` loads settings and rules.

## Making a change

1. Fork the repository and create a branch: `git checkout -b fix/short-description`.
2. Make the change **together with a test** (see below).
3. Run `npm test`.
4. Update the docs if behaviour changed, and add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request using the template.

## Tests

`npm test` runs everything with Node's built-in test runner (`node --test`). There is no framework to install.

- `test/core.test.js`: unit tests for parsing, config, globs.
- `test/security.test.js`: the security and behaviour suite. Every test named `SEC-nn` encodes an attack or a guarantee.
- `test/helpers.js`: throw-away repositories (with an isolated `HOME`), a fake LLM server and a CLI runner.

**A bug fix needs a test that fails before the fix and passes after it.** Write the test first, watch it fail, then fix.
If a test uses random data, make sure it cannot fail by chance: use fixed vectors, or assert a statistical rate with an
explicit tolerance (see `SEC-45`).

## Security-sensitive changes

revu reads code it does not control and an LLM's answer can end up in files, so some areas deserve extra care: **providers,
secret detection, config loading, anything that writes files, and anything that decides what is sent to an LLM.**
For those changes:

- State the threat you considered in the pull request (the template asks for it).
- Never let a repository choose a command to run or a URL to send data to without the user's approval (`revu trust`).
- Keep the egress gate (`complete()` in `src/providers.js`) as the single path to any provider.
- Do not weaken a `SEC-*` test to make a change pass. If a guarantee has to change, say so in the pull request.
- **Never put real secrets in code, tests or docs.** Test tokens are generated at runtime with random bytes or clearly fake.

## Common tasks

**Add a secret-detection rule.** Provider-token rules come from gitleaks: regenerate them with
`python3 scripts/import-gitleaks.py` (see the script header). revu's own rules live in `OWN` in `src/secrets.js`. Add a
detection test *and* a false-positive test (`SEC-42` and `SEC-46` show the pattern), and check it against a real repository:
0 detections is the goal.

**Add an LLM provider.** Write the handler in `src/providers.js` (return the text, and call `record({model, input, output})`),
add it to `complete()` and, if it deserves a short form, to `expandProvider()`. Decide whether a repository may select it
without approval (fixed hosts and commands are safe; anything configurable needs `revu trust`). Add tests with a fake
server (see `SEC-47` for Ollama).

**Add or change interface text.** All messages live in `src/i18n.js`. revu speaks English only.

**Change the review prompt.** `src/prompt.js`. The prompt is part of the cache key, so results are invalidated automatically.
Keep the injection defences (`SEC-13`).

## Style

- Node.js 20+, ES modules, no build step, no TypeScript, **no new runtime dependencies** unless there is a strong reason
  (there are three today: `@clack/prompts`, `picocolors`, `yaml`).
- Everything is in English: code, comments, messages, docs, tests.
- Comments explain *why*, not *what*. Match the density and naming of the surrounding code.
- Keep functions small and files focused. Prefer clear code to clever code.

## Commit messages and pull requests

We follow [Conventional Commits](https://www.conventionalcommits.org/): `fix: ...`, `feat: ...`, `docs: ...`, `test: ...`,
`refactor: ...`, `chore: ...`. Keep the subject under 72 characters and say why in the body when it is not obvious.
Small, focused pull requests are reviewed faster than big ones.

By contributing you agree that your contribution is released under the [MIT License](LICENSE) and that you will follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
