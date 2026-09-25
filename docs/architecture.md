# Architecture

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

How the pieces fit together.

## Layout

```
revu/
├─ bin/revu.js         command entry point (checks the Node version first)
├─ src/
│  ├─ cli.js           commands and interactive menu
│  ├─ review.js        orchestrates the review and validates findings
│  ├─ prompt.js        the prompt sent to the LLM
│  ├─ providers.js     Ollama/OpenAI · Anthropic · CLI command · shorthands (`ollama:model`) · egress gate
│  ├─ detect.js        auto-detection of available LLMs
│  ├─ config.js        loads config and discovers rules (AGENTS.md, .revu/rules/…)
│  ├─ diff.js          parses git diff with real line numbers
│  ├─ ui.js            cards, colours, summary
│  ├─ apply.js         applies fixes to files
│  ├─ init.js          `revu init` + hook installation
│  ├─ help.js          `revu --help`
│  ├─ store.js         ignored findings, cache, last review, egress log
│  ├─ secrets.js       secret-detection engine (gitleaks rules + revu's own)
│  ├─ re2.js           Go RE2 → JavaScript regex translator (same behaviour on every Node)
│  ├─ exclude.js       files that are never sent (.revuignore, .cursorignore…)
│  ├─ guard.js         guardrails: secrets, hidden Unicode, risky suggestions, safe text
│  ├─ trust.js         approval of providers requested by a repo
│  ├─ fsafe.js         reads/paths confined to the repo
│  ├─ i18n.js          all interface text (English)
│  └─ data/            gitleaks rule set (MIT) converted to JSON
├─ templates/revu.yaml rules template copied by `revu init`
├─ scripts/            importer for the gitleaks rules
└─ test/               tests (`npm test`)
```

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
