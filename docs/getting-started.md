# Getting started

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

Install revu, turn it on in a project and understand what happens on every commit.

## How it works

`revu` is a terminal program, but **you almost never type it**. You install it once and it runs by itself:

```
you type:      git commit -m "my change"
                     │
                     ▼
         git runs the pre-commit "hook"  ◄── installed by `revu init`, once
                     │
                     ▼
   revu takes what is staged (git diff --cached)
                     │
                     ├─ reads YOUR RULES   → AGENTS.md, .revu.yaml, .revu/rules/…
                     ├─ sends it to YOUR LLM → Ollama / Claude / OpenAI…
                     └─ receives the problems it found
                     │
                     ▼
   shows them one by one and you decide what to do
                     │
                     ▼
   any serious problem left unresolved?
        YES → the commit is cancelled     NO → the commit goes through
```

The three pieces:

| Piece | What it is | Where it lives |
|---|---|---|
| **The `revu` program** | The tool (this repository) | Installed once on your computer |
| **The rules** | What the code of THIS project must satisfy | In each project; committed to git |
| **`.revu.local.yaml`** | Which LLM YOU use | In each project; NOT committed |

Every project has its own rules, and every person can use a different LLM.

## Install

You need **Node 20 or newer** and **git** (`node -v` to check). On an older Node, `revu` says so clearly instead of
failing with a strange error, and as a git hook it does not block your commits (it sends nothing anywhere).
If you switch Node versions (nvm, etc.) **you do not need to run `revu init` again**: the hook uses the `node` on your
PATH when the one it was installed with no longer exists, and if there is none it says `NOT reviewed` loudly.

```sh
git clone https://github.com/lzadev/revu.git && cd revu
npm install
npm link             # creates the global `revu` command
revu --version
```

If you get `command not found`: `npm prefix -g` shows npm's global folder; add that path + `/bin` to your PATH.
To uninstall: `npm unlink -g revu`.

## Enable it in a project

```sh
cd your-project
revu init
```

It asks 2–3 questions (↑/↓ and Enter): **which LLM you use** (it detects what you have) and **profile** (`Chill`: only what matters · `Assertive`: everything, including minor things). It creates:

| File | What for | Committed? |
|---|---|---|
| `.revu.yaml` | Team rules and settings | **Yes** |
| `.revu.local.yaml` | Your LLM (`provider: claude`, for example) | No (added to `.gitignore`) |
| `.git/hooks/pre-commit` | Makes revu run on every commit | No (it is local) |

Then:

```sh
revu doctor      # is everything fine? makes a test call to your LLM
revu rules       # which rules is it reading? (very useful, see [Configuration](configuration.md))
```

**Without questions** (for scripts, or to onboard teammates quickly):

```sh
revu init --yes --provider ollama:qwen2.5-coder:14b
```

> If you never configure an LLM, revu tries to **auto-detect** one on the fly (Claude CLI, Ollama, LM Studio, API
> key variables) and tells you which one it used.

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
