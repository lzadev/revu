# FAQ and known limits

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

Answers to the common questions, how revu avoids noise, and what it cannot do.

**Is my code sent to any server?**
Only to **the LLM you configured**. With Ollama / LM Studio nothing leaves your computer. With `claude` or an API, the
diff goes to that provider (just as if you pasted it into its chat). Files containing secrets are never sent (see [SECURITY.md](../SECURITY.md)).

**How long does it take?**
With Claude, about 10 seconds for a small change. With a local model, from 20 s to several minutes depending on your
hardware. Repeating on the same diff is instant (cache).

**It flags things that are not true.**
Use **Ignore** and, if it keeps happening, sharpen the rule. revu already discards on its own anything that points to
lines or files that do not exist in the diff.

**What if there is no internet or Ollama is off?**
With `fail_open: true` (default) it warns and **lets the commit through**. Set `false` to block. The local checks
(secrets, sensitive files, hidden Unicode) block regardless.

**Does it work if an AI agent commits, or from VS Code / GitHub Desktop?**
Yes, without menus: it prints the report and blocks only if there are serious problems. Details and limits in
[Agents & CI](agents-and-ci.md).

**Does it work if my code, comments and rules are written in Spanish (or another language)?**
Yes. The LLM reads code, comments, identifiers and rules in any language (checked with Claude on Spanish code and Spanish
rules: it found the bug and enforced the Spanish rules as blocking). Accents, the letter n-tilde and non-ASCII file names go through
intact. The review comments themselves are always in English. One detail for the secret scanner: provider tokens
(`sk_live_…`, `ghp_…`, `AKIA…`) are detected by format in any language, and generic `name = value` secrets are detected
with English names plus the common Spanish ones (the Spanish words for password, key, credential and secret, such as
`clave`, `llave`, `credencial`, `secreto`). Names in other languages (`senha`, `mot de passe`…) are not covered yet: for
those, use `never_send` or add a rule. Write `MUST:` (not a translation of it) in front of rules that must block.

**"Couldn't run the review".**
Run `revu doctor`. Typical causes: Ollama is off (`ollama serve`), model not downloaded, API key variable not set, or
a mistyped `provider:`.

**Is it reading my AGENTS.md?**
Run `revu rules`: it lists every rule file it found. If it is not there, check that it is in the repo root (or inside a
sub-folder, for per-folder rules).

**"file has unstaged changes" when applying a fix.**
So that changes you did not want do not sneak into the commit, fixes are only applied to files that are fully staged.
`git add` the file (or `git stash` the rest) and try again.

## How revu avoids noise and hallucinations

- **It verifies every finding against the diff**: if the model cites a line or file that does not exist, it is dropped.
- It only comments on **lines added** in this commit, not old code.
- The `chill` profile hides minor details.
- The result is **cached** per diff in `.git/revu-cache` (never committed).
- Applying a fix looks the code up **by content**, not just by line number, and refuses if the file changed.

## Known limits

- The `codex` and `gemini` presets are untested; if they fail, use `command:...` with your own command.
- Small local models (<14B) give more false positives.
- The LLM reviews the diff (with some context), not the whole repository: it does not detect problems that depend on
  files that did not change.
- Every rules file is truncated to 20,000 characters.
- Generic secret detection knows English and Spanish variable names; other languages need your own rules or `never_send`.

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
