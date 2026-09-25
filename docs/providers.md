# LLM providers

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

Pick the model that reviews your code (your subscription, an API key or a local model), and measure it before trusting it.

`revu init` does it for you and stores it in `.revu.local.yaml`. It is **a single line**:

```yaml
provider: claude
```

| I want to use… | `provider:` | Notes |
|---|---|---|
| **My Claude subscription** | `claude` or `claude:<model>` | Uses your Claude Code CLI login, no API key. `claude:sonnet`, `claude:opus`, `claude:haiku` or a model ID pins the model; without it the summary shows which one was used |
| **Ollama** (local, free) | `ollama:qwen2.5-coder:14b` | `ollama pull qwen2.5-coder:14b` first. Uses Ollama's native API with a 16k window; see "Choosing a local model" below |
| **LM Studio** (local, free) | `lmstudio:<model>` | Turn on the local server in LM Studio |
| **Anthropic API** | `anthropic:claude-sonnet-5` | Environment variable `ANTHROPIC_API_KEY` |
| **OpenAI API** | `openai:gpt-4.1` | Variable `OPENAI_API_KEY` |
| **OpenRouter** | `openrouter:<model>` | Variable `OPENROUTER_API_KEY` |
| **Codex / Gemini CLI** | `codex` / `gemini` | Untested presets; adjust if needed |
| **Any other program** | `command:my-program --flag` | revu sends the prompt on stdin and reads the answer |

> **Never write an API key in a yaml.** It lives in an environment variable
> (`export OPENAI_API_KEY=...` in your `~/.zshrc`); revu only reads the variable.

**Fine tuning** (custom URL, timeout, etc.): use the long form.

```yaml
provider:
  type: openai                 # openai | anthropic | command
  base_url: http://my-server:8000/v1
  model: my-model
  timeout_s: 900
  api_key_env: MY_VARIABLE
  effort: low                  # Anthropic API only: low | medium | high | xhigh | max (fewer hidden reasoning tokens)
```

## Choosing a local model (Ollama)

Three things decide whether a local model works well with `revu`, in this order:

1. **The context window.** `revu` sends about 5,000 tokens for a median commit and up to ~13,000 per call. Ollama's default
   window is only **4k tokens on machines with less than 24 GB**, and a longer prompt is cut *silently at the front*, which
   drops revu's instructions and your rules. That is why `provider: ollama:<model>` uses Ollama's native API and asks for
   `num_ctx: 16384` on every request, refuses an answer whose prompt filled the window, and splits big diffs into smaller
   calls that fit. Change it with the long form (`provider: {type: ollama, model: ..., num_ctx: 12288}`). A larger window
   costs memory: roughly 0.2 MB per token for a 14B model (about +3 GB at 16k). `OLLAMA_FLASH_ATTENTION=1` together with
   `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves it (check that your Ollama version supports them).
2. **Whether it fits in memory** with room for that window and for the rest of your system.
3. **Whether it answers with valid JSON and few false positives.** revu asks Ollama for JSON output, but small models still
   invent more problems than large ones (revu drops findings that point outside the diff).

| Memory | Model | Size | Notes |
|---|---|---|---|
| 16-18 GB (M3 Pro 18 GB) | `qwen2.5-coder:14b` | ~9 GB | **Measured, and not good enough as the only reviewer** (see below) |
| 16-18 GB, if you can spare the memory | `gpt-oss:20b` (`think: low`) | ~14 GB | Apache 2.0, MoE with ~3.6B active parameters, reasoning + structured outputs. **Not measured yet.** On Apple Silicon it needs the GPU wired-memory limit raised and leaves ~3 GB for macOS and the window |
| 24-32 GB | `qwen3-coder:30b` | ~19 GB | MoE (3.3B active), 256K context; ranked first for quality per GB in the 2026 rankings consulted. **Not measured** |
| 24 GB+ | `devstral:24b` | ~14 GB | Built for agentic coding. **Not measured** |

**What was measured** (one run per model at temperature 0, `qwen2.5-coder:14b` on an Apple M3 Pro with 18 GB, compared with
`claude -p` using exactly the same revu configuration; a small benchmark, so read it as a warning sign, not a verdict):

| | `claude` | `qwen2.5-coder:14b` |
|---|---|---|
| 7 planted bugs (missing `await`, off-by-one, SQL injection, `Math.random` token, `reduce` without initial value, `splice(-1)`, unhandled async callback) | **7 / 7** | **2 / 7** (missed the token, `reduce`, `splice`, the off-by-one and the async callback) |
| False alarms on 2 clean files | 0 | 0 |
| 6 real commits (1.9k-4.5k tokens each): findings that match the other model | 8 findings | 0 of claude's 8 found; 5 of its own, mostly generic ("no tests", "async calls lack error handling") |
| Time per commit | ~21 s | ~60 s (up to 86 s) |
| Memory | - | 10 GB loaded on the GPU (16k window), leaving the machine under memory pressure |

A reviewer that misses five of seven obvious bugs gives false confidence, which is worse than no review. Use this model only
as a complement, or try a stronger one. Whatever you pick, run `revu --no-cache` on some past commits and compare before
trusting it.

For a rough speed ceiling, generation on Apple Silicon is limited by memory bandwidth: a 9 GB dense model on a chip with
~150 GB/s cannot exceed roughly 15-16 tokens per second, so a 700-token answer takes about a minute with the prompt
processing on top; MoE models are several times faster.

## Measure a model yourself: `revu bench`

Do not trust rankings (or this README): measure the model on the machine you will use it on.

```sh
revu bench                                  # the provider configured in this project
revu bench --provider ollama:gpt-oss:20b    # any provider, without touching your config
revu bench --runs 3                         # the same model can vary between runs
revu bench --commits 3                      # also: speed and number of findings on the last 3 commits of THIS repo
```

It reviews a fixed, synthetic set of files with **7 planted bugs** (missing `await`, off-by-one, SQL injection, `Math.random` for a
session token, `reduce` without initial value, `splice(-1)`, unhandled async callback) and **2 clean files**. Your own files
are never used or sent (except with `--commits`, which says so). It prints which bugs were found, how many false alarms the
clean files produced, time, model, tokens and cost, and a one-line verdict:

```
  ✔ A1 missing await on res.json()                       critical: Missing await on res.json()
  ✖ B2 Math.random for a session token                   NOT FOUND
Result: 5 of 7 planted bugs found · 0 false alarms in the clean files · 1 other extra finding
Cost:   claude-sonnet-5 · 3.3k in / 3.2k out · ≈$0.045 · 28.2s · 1 call
Verdict: Mixed: it misses obvious bugs. Use it as a complement, not as the only reviewer.
```

Reference results on the same suite (one run each, so a yardstick and not a ranking): `claude-sonnet-5` 7/7 in ~27 s;
`qwen2.5-coder:14b` on an Apple M3 Pro 18 GB 2/7 in ~54-70 s. A time above 2 minutes means the model is too slow for a hook on every
commit: run `revu --base main` instead. For options that need the long provider form (`think: low`, `num_ctx`), put them in
`.revu.local.yaml` and run `revu bench` without `--provider`. It is a small suite: a good score does not prove a model is good,
but a bad one is a reliable warning.

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
