# Cost and tokens

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

What one review costs, measured, and how to spend less.

`revu` makes **one LLM call per batch of ~48,000 characters of diff** (about 12,000 tokens) and nothing else: no calls
for the local checks, none for `revu fix`, `revu rules`, `revu doctor` (except its one-line ping) or a cached repeat of the
same diff. Each call sends a fixed part (system prompt ~830 tokens + your rules, ~160 for the default template) plus the
diff with `context_lines` (default 8) lines of context around every change, and gets back a small JSON (~600-750 tokens
in the real runs measured).

**Measured on the last 59 commits of a real project** (a monorepo with web, mobile and API; token counts are estimates at
~4 characters per token, so treat them as +/- 30%):

| Per commit | Input tokens | LLM calls |
|---|---|---|
| Median | ~5,000 | 1 |
| Average | ~14,900 | 1.8 |
| p90 | ~42,000 | 3-4 |
| Largest (a whole new mobile app) | ~136,000 | 12, one after another |

47 of 59 commits fit in a single call. The average is far above the median because a few big feature commits dominate.

**What one call really costs, measured** with Claude Sonnet 5 through `claude -p` on 7 reviews (small commits): about **6,500
tokens in and 2,000 tokens out per call**. The output is about three times the visible answer (~700 tokens) because the model
reasons before answering and that hidden reasoning is billed as output. The summary line of every review now shows it:
`claude · claude-sonnet-5 · 2.2k in / 1.0k out · ≈$0.019 · 9.1s` (`≈` = list-price equivalent, for a subscription that is not
billed per token).

**Estimated API cost per commit**, using the measured ~2,000 output tokens per call for every model (only Sonnet 5 was
measured; a model that reasons less will cost less) and the per-million prices of the 2026-06-24 snapshot of Anthropic's
price list (check the current ones):

| Model | Input / Output | Median commit | Average commit | p90 | Largest | 15 commits/day, 22 days |
|---|---|---|---|---|---|---|
| Haiku 4.5 | $1 / $5 | $0.02 | $0.03 | $0.08 | $0.26 | ~$11 / month |
| Sonnet 5 | $2 / $10 | $0.03 | $0.07 | $0.15 | $0.51 | ~$22 / month |
| Opus 5.5 | $4 / $20 | $0.06 | $0.13 | $0.31 | $1.02 | ~$44 / month |
| Fable 5.1 | $10 / $50 | $0.15 | $0.33 | $0.77 | $2.56 | ~$109 / month |

Local models (Ollama, LM Studio) cost nothing per token, and `provider: claude` (your Claude Code subscription) is not billed per
token but counts against your plan's usage limits.

**Which Claude model is `provider: claude` using?** The one your Claude Code has as its default (`model` in
`~/.claude/settings.json`, or `/model`), because revu does not pass `--model`. It is always shown in the summary line and in
`revu doctor`. To pin one, use `provider: claude:sonnet`, `claude:opus`, `claude:haiku` or a full model ID
(`claude:claude-sonnet-5`).

**Why the `claude` preset is slim.** A trivial `claude -p` call carries Claude Code's own context: **~37,000 input tokens**
on a machine with many MCP servers and skills (the same call costs ~$0.15 cold). The preset therefore switches off skills
(`--disable-slash-commands`), MCP servers (`--strict-mcp-config`) and the default system prompt (revu sends its own), which
brings the overhead down to ~500 tokens with the same review quality on the benchmark (7 of 7 planted bugs). Switching MCP off
is also a security measure: `--tools ""` only disables the built-in tools, so without it an injected diff could try to use
your MCP tools (browser, design tools…).

**How to spend less** (all of these exist today):

- **`context_lines: 3`** in `.revu.yaml`: about 15% fewer input tokens (14.9k -> 12.7k on average) with the same findings for most
  changes.
- **A cheaper model** for routine commits: the spread between Haiku/Sonnet and Fable is 5-10x. Code review of a diff does not
  need the biggest model; try Sonnet 5 first.
- **`effort`** for the Anthropic API provider (`provider: {type: anthropic, model: claude-sonnet-5, effort: low}`):
  fewer hidden reasoning tokens. Only sent when you set it, because older models reject the parameter. With `provider: claude` the model's own defaults apply (pick a lighter one with `claude:haiku`).
- **`ignore_paths`** for generated or vendored files, and `never_send` for what must not leave.
- **A local model** (`provider: ollama:...`) when tokens matter more than speed.
- **Review the branch once instead of every commit:** `revu --base main` (or in CI) looks at the net diff, which is usually
  smaller than the sum of the intermediate commits. `REVU_SKIP=1 git commit` skips one commit.
- **Repeats are free:** the result is cached per diff, so re-running on unchanged staged changes costs nothing.

**Things that multiply the cost:** an AI agent that fixes and retries reviews the new diff each time (2-3 attempts = 2-3x;
`revu fix` itself is free); a huge commit makes many sequential calls, so it also takes minutes, which can exceed an agent's
per-command time limit; an invalid JSON answer is retried once. Prompt caching would not help much: the repeatable part of
the prompt is only ~1,000 tokens, below the minimum cacheable size of most models, and calls are minutes apart.

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
