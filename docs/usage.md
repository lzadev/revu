# Daily use

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>

What you see on every commit, how to read a finding, and every command.

## The normal way: you do nothing special

```sh
git add .
git commit -m "feat: add orders screen"
```

The hook fires by itself and shows the review like this (tool messages carry the `revu ›` prefix):

```
revu › Reviewing 1 file(s) with claude…

━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1 file(s) · +1 −1 · claude · 6.7s
Replaces an await with .Result inside an async handler…

━━ FINDINGS (1) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 1  🟠 MAJOR  Replace .Result with await
             api/Endpoints/ChatEndpoints.cs:21

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟠  MAJOR   1/1  bug · api: async/await end to end
Replace .Result with await
📄 api/Endpoints/ChatEndpoints.cs:21

📍 Code
   20 │
 ▶ 21 │   var result = svc.ChatAsync(req.Message, req.History, ct).Result;
   22 │   return Results.Ok(result);

❌ What's wrong
   .Result blocks a thread while the call runs; under load it exhausts the thread pool…

✅ How to fix it
   - var result = svc.ChatAsync(req.Message, req.History, ct).Result;
   + var result = await svc.ChatAsync(req.Message, req.History, ct);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 COMMIT BLOCKED · 1 blocking issue(s)

  What to do:
    1. Fix the issues marked 🔴 / 🟠 above
    2. Stage your changes:  git add <files>
    3. Commit again (do not use --no-verify)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## How to read a finding

Every finding has **always the same parts, with the same icon**, so you know what you are reading:

| Part | What it is |
|---|---|
| A `━━━` rule line | A new finding starts |
| 🔴 🟠 🟡 ⚪ + label | Severity: **critical** and **major** block the commit; minor and nit only warn |
| Title (bold) | One-line summary of the problem |
| 📄 | File and line where it is |
| 📍 **Code** | The code, with `▶` on the affected line |
| ❌ **What's wrong** | The explanation of the problem and its impact |
| ✅ **How to fix it** | The fix: `-` lines (remove) and `+` lines (add) |
| Final box | Verdict: ✅ allowed · 🚫 blocked, with what to do |

In interactive mode (a terminal) you see the same thing in colour and, under each finding, this menu:

```
◆  What do you want to do?
│  ● Apply suggested fix (writes the change and stages it)
│  ○ Skip (I'll handle it)
│  ○ Ignore (false positive · don't flag it again)
│  ○ Explain more
│  ○ Copy prompt for my AI agent
│  ○ Stop review
```

**↑/↓** to move and **Enter** to choose:

| Option | Effect |
|---|---|
| **Apply suggested fix** | Modifies the file and stages it for this same commit |
| **Skip** | You carry on; you will fix it yourself (if it is blocking, the commit is cancelled at the end) |
| **Ignore** | Marks it as a false positive and **never flags it again** (stored in `.revu/ignored.json`; commit it and the whole team stops seeing it) |
| **Explain more** | Asks the LLM for a deeper explanation with an example |
| **Copy prompt for my AI agent** | Copies a ready-made prompt to paste into Claude Code / Cursor / Copilot |
| **Stop review** | Leaves the rest unresolved |

At the end: no serious problems left → the commit goes through. Serious problems left → it asks:
**Cancel commit and fix** (recommended) or **Commit anyway**.

## All commands

| Command | What it does |
|---|---|
| `revu` | Reviews what is staged (same as the hook), without committing. Use it to try things |
| `revu --all` | Reviews all your changes against HEAD (staged and unstaged) |
| `revu --base main` | Reviews your whole branch against `main`, like a PR |
| `revu init` | Sets the project up (safe to repeat) |
| `revu fix` | Applies the ready-made fixes of the last review, no menus (see [Agents & CI](agents-and-ci.md)) |
| `revu fix --dry-run` | Shows what `revu fix` would change, without writing |
| `revu fix --id 1,3` | Applies only those findings (the numbers in the report); `--all` includes non-blocking ones |
| `revu bench` | Scores the configured LLM on 7 planted bugs + 2 clean files (synthetic, your files are not used); `--runs N`, `--commits N`, `--provider <spec>` |
| `revu egress` | Shows what has been sent to an LLM from this repo (paths and sizes, never content) |
| `revu trust` | Approves the LLM provider a repo asks for (if it runs commands or uses a custom URL) |
| `revu rules` | Shows which rules it uses and which files they come from |
| `revu doctor` | Diagnoses the configuration and tests the LLM |
| `revu --show-prompt` | Prints what would be sent to the LLM, without calling it |
| `revu --json` | JSON output (for CI) |
| `revu --plain` | No menus, just the report |
| `revu --no-cache` | Forces a fresh review even if the diff is identical |
| `revu uninstall` | Removes the git hook from the project |
| `revu --help` | Help |

## Skipping the review (emergencies)

```sh
git commit --no-verify -m "hotfix"     # standard git
REVU_SKIP=1 git commit -m "hotfix"
```

---

<sub>[Documentation index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Usage](usage.md) · [Agents & CI](agents-and-ci.md) · [Cost](cost.md) · [FAQ](faq.md) · [Architecture](architecture.md)</sub>
