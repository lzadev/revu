# AI agents, VS Code and CI

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

What happens when someone other than a person at a terminal commits, the `revu fix` loop, and how to make the review mandatory for a team.

## Commits made by an AI agent or a GUI

When whoever commits is not a person in a terminal (Claude Code, Codex, Cursor, Copilot's agent, VS Code,
GitHub Desktop, CI…), **it cannot answer menus**. revu detects that and switches mode:

| Who commits | What happens |
|---|---|
| **A person in a terminal** | Interactive menu (apply, skip, ignore…) |
| **An agent without a terminal** (most of them: they run `git commit` through a pipe) | Prints the **full report** and **blocks** the commit if there are serious problems |
| **An agent in a real terminal** (e.g. VS Code / Cursor's integrated terminal) | If it is detected as an agent/CI: same as above. If not: the menu waits **90 s** and, unanswered, is treated as unattended → report + commit blocked |
| **VS Code / GitHub Desktop commit button** | No menus: the report appears in Git's output panel and the commit is blocked if there are serious problems |

When it blocks, the report ends with an instruction written for the agent:

```
🚫 COMMIT BLOCKED · 2 blocking issue(s)
  What to do: 1. Fix the issues marked 🔴 / 🟠 above … 3. Commit again (do not use --no-verify)
```

Every finding carries file:line, an explanation and the fix code, so an agent can read it, fix it, `git add` and
commit again. In practice it is a reviewer giving feedback to the agent.

### The agent loop: `revu fix`

When a commit is blocked from VS Code or from an agent there is **no "Apply suggested fix" menu**.
That is what `revu fix` is for: it applies the ready-made fixes of the last review, without asking anything.

```
git commit  →  🚫 blocked (revu stores the review inside .git)
revu fix    →  ✅ applies the fixes that come with code and stages them
               ❌ lists in full the ones that need a manual fix
(fix by hand whatever is left)  +  git add
git commit  →  ✅ allowed
```

What `revu fix` does, exactly:

- **By default it only touches blocking findings** (critical and major) that come with fix code.
  `--all` also includes the non-blocking ones; `--id 1,3` lets you pick (numbers from the report).
- **It writes the change and runs `git add`** on the file, so it goes into the same commit.
- **Findings without a code fix** are left alone: they are printed in full (code, what is wrong) so you or the agent
  can fix them by hand. It ends with a verdict: `✅ FIXES APPLIED` or `🚫 N BLOCKING ISSUE(S) STILL NEED A MANUAL FIX`.
  The exit code is `1` if any blocking finding remains.
- **It refuses to apply if your code changed since the review** (it compares the diff). Without that protection it
  could apply an old fix on different code. If that happens, run `revu` again, or `--force` if you know what you are doing.
- **It refuses if the file has unstaged changes**, so it does not sneak changes you did not want into the commit.
- **`--dry-run`** shows you the diff of what it would apply, without writing. **`--json`** gives machine output
  (`applied`, `manual`, `failed`, `remaining_blocking`).

**Recommendation:** paste this into your `AGENTS.md` (or `CLAUDE.md`) so the agent follows the loop on its own:

```markdown
## Code review (revu)
Every `git commit` goes through an automatic review. If the commit is blocked:
1. Run `revu fix` (it applies the ready-made fixes and stages them).
2. Fix by hand the problems `revu fix` lists as "need a manual fix", then `git add`.
3. Commit again. Never use `--no-verify` or `REVU_SKIP`, and never run `revu trust`.
```

**How an agent is detected:** the `CLAUDECODE` variable (set by Claude Code), `CI`, or your own
`REVU_PLAIN=1` / `REVU_NONINTERACTIVE=1`. For other agents working in a real terminal you can force it:

```yaml
# .revu.yaml
interactive: false        # never show menus in this project (always the plain report)
prompt_timeout_s: 90      # seconds without an answer before a menu is cancelled (0 = wait forever)
```

**Limitations you should know about**

- **Tested with:** commits without a terminal (pipes), with a simulated real terminal, and with `CLAUDECODE=1`.
  **Verified in VS Code** (Source Control commit button: report in Git's output and commit blocked).
  **Not tested** with Cursor, Copilot's agent or GitHub Desktop: for them the behaviour is inferred from how they run
  `git` (with or without a terminal), not from running them.
- **The VS Code commit button has no menu**: apply fixes with `revu fix` in the terminal (or by hand).
  One-key "Apply suggested fix" only exists in the terminal menu.
- **An agent can skip it** with `git commit --no-verify` or `REVU_SKIP=1`. A local hook cannot prevent that.
  To make it mandatory, run `revu --base origin/main --json` in your CI (see [Teams and monorepos](#teams-and-monorepos)).
- **The review adds time to the commit** (about 10 s with Claude; more with local models). If your agent has a
  per-command time limit shorter than your LLM, the commit may be cut off: use a faster model or raise the limit.
- **Every commit attempt reviews again** what changed; an agent that fixes and retries spends one LLM call per
  attempt. Keep `block_on: [critical, major]` so it does not chase minor details.

## Teams and monorepos

**Onboarding a team** (once):

1. One person runs `revu init`, tunes `.revu.yaml` (and/or `AGENTS.md`, `.revu/rules/`) and **commits those files**.
2. Every teammate runs `git pull`, installs revu ([Getting started](getting-started.md)) and runs `revu init` in the project: they choose **their**
   LLM and get **their** hook. The rules already come from the repo.

**To make it mandatory** (a local hook can be skipped with `--no-verify`): run this in your CI

```sh
revu --base origin/main --json     # exits with code 1 if there are serious problems
```

**Monorepos**: use one `AGENTS.md` per folder (style D) or `.revu/rules/` with `paths:` (style C).

**Husky**: `revu init` detects it, touches nothing and shows you the line to add to `.husky/pre-commit`.

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
