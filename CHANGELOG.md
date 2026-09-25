# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/)
(while below 1.0, minor versions may include breaking changes).

## [Unreleased]

## [0.3.0] - 2026-09-25

First public release.

### Added

- Pre-commit review of the staged diff with a git hook, an interactive menu (apply, skip, ignore, explain, copy an agent
  prompt) and a plain report when nobody can answer menus (agents, CI, GUIs).
- Rules from your project: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`,
  `.revu/rules/*.md`, `.revu.yaml`, per-folder rules for monorepos.
- Providers: Claude CLI (`claude`, `claude:<model>`), Ollama (native API), LM Studio, Anthropic API, OpenAI-compatible APIs and
  any command. Every review reports the model, tokens and cost.
- `revu fix` to apply ready-made fixes non-interactively, `revu bench` to score a model on planted bugs, `revu rules`,
  `revu doctor`, `revu egress`, `revu trust`.
- Secret protection: 225 detection rules, multi-line keys, the `withhold` / `redact` policies, an egress gate on every
  provider call, sensitive-file and exclusion lists (`.revuignore`, `.cursorignore`, `.aiexclude`, `.copilotignore`).
- Adaptive batching for local models' context windows and truncation detection for Ollama.

### Security

- 16 flaws found in a security review and fixed, each with a regression test (see [SECURITY.md](SECURITY.md)): repository
  config could not run commands or redirect API keys, LLM suggestions are gated, terminal output is sanitized, paths are
  confined to the repository, and more.
- The `claude` preset disables built-in tools, MCP servers and skills.

[Unreleased]: https://github.com/lzadev/revu/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lzadev/revu/releases/tag/v0.3.0
