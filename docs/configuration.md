# Configuration and rules

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

Tell revu what matters in your project: where rules live, severities and every `.revu.yaml` setting.

## Where to put your rules

Rules are written in **plain language**. There is no syntax to learn. You can use **whichever style you prefer, or
combine them**; revu merges everything:

### Style A — Do nothing: use the `AGENTS.md` you already have

revu **automatically** reads these, if they exist in the project root:

`AGENTS.md` · `CLAUDE.md` · `.cursorrules` · `.github/copilot-instructions.md` · `CONTRIBUTING.md`

If your team already documented its conventions there for its AI agents, it just works.

### Style B — A single file: `.revu.yaml`

```yaml
guidelines: |
  - MUST: never commit secrets or tokens.
  - MUST: every async call handles its error.
  - React components in PascalCase; hooks prefixed with `use`.

path_instructions:            # rules only for some paths
  - path: "supabase/**"
    instructions: "Every new table must have RLS enabled."
```

### Style C — One file per topic: `.revu/rules/*.md`

Great for teams: each rule or topic in its own file, reviewed like code.

File `.revu/rules/sql.md` (the `---` block must be at the very start of the file):

```markdown
---
paths: ["backend/**", "supabase/**"]
---
- Every SQL query must be parameterized.
- No SELECT * in production.
```
`paths:` is optional: without that block, the rule applies to the whole project.

### Style D — Per-folder rules (monorepos)

An `AGENTS.md` or `CLAUDE.md` **inside a sub-folder** applies **only to the files of that folder**:

```
my-repo/
├─ AGENTS.md              ← rules for everything
├─ frontend/AGENTS.md     ← only for files inside frontend/
└─ backend/AGENTS.md      ← only for files inside backend/
```

### See what it is reading: `revu rules`

```
Rules this project is reviewed against  /path/to/my-app

  ✔ AGENTS.md  412 chars
  ✔ guidelines (.revu.yaml)  230 chars
  ✔ .revu/rules/sql.md  180 chars  → applies to: backend/**

Folder-scoped (apply only inside their folder)
  ✔ frontend/AGENTS.md  → applies to: frontend/**

Also looked for (not found): CLAUDE.md, .cursorrules, CONTRIBUTING.md

Blocks the commit on: critical, major
```

Want to see the exact text the LLM will receive, with your rules and the diff? `revu --show-prompt`
(it does not call the LLM, it only prints it).

### Tips for writing good rules

- Be **specific**: "don't use `any`" works better than "write good TypeScript".
- Write **`MUST:`** in front of whatever should **block** the commit. Everything else is reported but does not stop it.
- If you get false positives, they are almost always fixed by **sharpening a rule**, not by changing model.

### Severities

| Severity | Means | Blocks? (default) |
|---|---|---|
| `critical` | a bug or security hole that would break production | yes |
| `major` | a probable bug or a violated `MUST` rule | yes |
| `minor` | maintainability, conventions | no |
| `nit` | taste/style (only with the assertive profile) | no |

Change it with `block_on: [critical, major, minor]` in `.revu.yaml`.

### Other `.revu.yaml` settings

```yaml
profile: chill                # chill | assertive
block_on: [critical, major]
fail_open: true               # if the LLM does not answer, let the commit through? (secret checks always block)
interactive: auto             # auto | false (false = never menus, always the plain report)
prompt_timeout_s: 90          # a menu left unanswered this long cancels the commit
ignore_paths: ["src/generated/**"]     # added to the built-in ignores (lockfiles, dist, images…)
guidelines_files: [docs/STYLE.md]      # replaces the automatic list of rule files
guidelines_files: []                   # turns auto-discovery off
```

## Configuration precedence

(last wins): built-in defaults → `~/.config/revu/config.yaml`
(yours, for all your projects) → `.revu.yaml` (team) → `.revu.local.yaml` (yours, this project).

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
