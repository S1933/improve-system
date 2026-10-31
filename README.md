# improve-system

A Claude Code skill that reads your own session history and turns it into fixes: rules, hooks, skills and automations. On the next run it measures whether the previous fixes actually worked.

Every Claude Code conversation is saved on disk in `~/.claude/projects/<folder>/*.jsonl`. That history already contains the answer to "why do I keep correcting the same thing?" — `improve-system` mines it, reports it with evidence, and writes the change you pick.

Manual only: it never starts on its own.

## Install

Requires Node.js 18+ and Claude Code (or Codex — see [Compatibility](#compatibility)).

```bash
npx skills add S1933/improve-system --skill improve-system -g -a claude-code
```

Then, in Claude Code:

```text
/improve-system          # last 7 days
/improve-system 14       # last 14 days (1–90)
/improve-system 7 auto   # scheduled mode: report only, build nothing
```

## How it works

```text
~/.claude/projects/**/*.jsonl
        │
        ▼  scripts/digest.mjs  (read-only, masks secrets)
   digest.md  →  report in chat  →  you pick a fix  →  it writes the fix
                                        │
                                        ▼
                    ~/.claude/improve-system/changes.md
                                        │
                                        ▼  next run: did it work?
```

1. **Digest** — `scripts/digest.mjs` walks the last N days of sessions and produces one short Markdown file: your messages verbatim, detected corrections (`⚠️`), interruptions (`⏹`), close-wordings repeated across sessions, tool errors, permission denials, an active-time estimate, and the instruction files found on disk (`CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`).
2. **Report** — the model turns the digest into a report where every point cites a date, a folder and your own words. Anything seen in fewer than two sessions goes to "Weak signals".
3. **Build** — you choose one recommendation; it shows the exact content, then writes it to the right file.
4. **Follow-up** — the next run compares the same problem before/after the change and gives a verdict: `resolved`, `decreasing`, `no effect`, `not enough data`.

### The report

- **Follow-up** — raw counts with their base (sessions and messages in each period), plus rates such as corrections per 10 sessions. A rule that had no effect becomes a hook, never the same rule written twice.
- **What Claude gets wrong** — recurring mistakes: count, number of sessions, two quotes, the fix.
- **What you repeat** — instructions given across many sessions.
- **Skills to create** — multi-step workflows you redo, with source sessions.
- **Tasks to automate** — same request, same folder, every day or week.
- **Weak signals** — one line each.
- **Top 3 changes**, each tagged with impact (high/medium/low) and confidence (high/low).

### The fix it writes

| Problem | Fix |
|---|---|
| Short preference or convention | A rule in an instruction file |
| Multi-step procedure | A skill |
| Something that must always happen, or a rule Claude keeps breaking | A hook |
| A task that needs no conversation | A script or a scheduled task |

Rules land in `~/.claude/CLAUDE.md` (all projects) or in the project's `CLAUDE.md` / `AGENTS.md`, following whatever the project already uses — including `@AGENTS.md` imports. Hooks are merged into `settings.json` after copying it to `settings.json.bak`, with a JSON validity check and an automatic restore on failure. Nothing is written without showing you the content first.

## Weekly automatic report (macOS)

One report per week, built by you later. Nothing is modified during the scheduled run.

```bash
bash ~/.claude/skills/improve-system/scripts/install-macos.sh --run-now
```

Default: Mondays at 09:00 over the last 7 days. `--weekday 0-7`, `--hour`, `--minute`, `--days`, `--dry-run`, `--uninstall`.

- Runs `claude -p "/improve-system 7 auto"` under launchd (`com.improve-system.weekly`).
- `auto` mode only writes the report: no questions, no changes, nothing appended to `changes.md`.
- Tool permissions limited to running `digest.mjs`, reading, and writing inside `~/.claude/improve-system/reports/` — it cannot touch `CLAUDE.md`, `settings.json` or skills.
- The digest goes to a per-run temp directory deleted on exit, even on failure.
- macOS notification when the report is ready. Type `/improve-system` within 3 days and it reuses that report instead of re-reading everything.
- Asleep at the scheduled time → runs on wake. Machine off → that week is skipped.
- Logs in `~/.claude/improve-system/logs/`, kept 12 weeks.
- If the skill lives outside `~/.claude/skills/`, run the script from its real folder: it derives `digest.mjs` from there. Re-run it after moving the skill or changing your Node / Claude Code install.

## Privacy

- Read-only on session files: they are never edited, moved or deleted.
- Secrets are masked to `[SECRET]` before anything is written — private keys, provider API keys (OpenAI/Anthropic, Stripe, GitHub, GitLab, Hugging Face, Slack, Google), JWTs, bearer tokens, credentials embedded in database URLs, and `*_key` / `*token*` / `*password*` assignments. Long high-entropy blobs are caught too.
- The digest is written with mode `600` into a fresh `700` directory under `$TMPDIR` (or `--out`), never at a predictable shared path.
- It is deleted after reading; the script prints the exact command (an interrupted run leaves the temp folder behind — delete it by hand).
- Masking covers common formats, not every possible secret: read the digest before sharing it.

The digest is read by the model like any prompt — it is sent nowhere else.

## CLI reference

```bash
node scripts/digest.mjs [--days 7] [--out <file>] [--root <dir>] [--state <dir>]
                        [--max-chars 180000] [--include-self]
```

| Option | Default | Meaning |
|---|---|---|
| `--days N` | `7` | Window, 1–90 |
| `--out FILE` | private temp dir | Where to write the digest |
| `--root DIR` | `~/.claude/projects` | Session history root |
| `--state DIR` | `~/.claude/improve-system` | Reports and change log location |
| `--max-chars N` | `180000` | Digest budget; long messages are shortened, then the oldest sessions dropped |
| `--include-self` | off | Keep sessions that ran `/improve-system` itself |

Both `--days 14` and `--days=14` work. Unknown options are rejected. Exit codes: `0` success, `1` no history / write failure, `2` invalid arguments.

## Repo layout

```text
SKILL.md                  the skill itself: procedure, rules, state files
README.md
scripts/digest.mjs        history → masked Markdown digest (stdlib only)
scripts/install-macos.sh  weekly launchd job (--dry-run, --uninstall)
test/digest.test.mjs      14 tests, node:test
agents/openai.yaml        Codex interface metadata
assets/codex-icon.svg
```

## Tests

```bash
node --test test/digest.test.mjs
node --check scripts/digest.mjs
```

Covered: close-wording grouping, secret masking (messages and titles), resumed-session duplicates, malformed JSONL, date windowing, correction/interruption/error/denial counting, self-session skipping (including plugin prefixes), instruction-file detection with `@AGENTS.md` import, budget truncation, private output directory, argument parsing.

## Compatibility

- **Claude Code** — primary target; reads `~/.claude/projects`, writes `~/.claude/...`.
- **Codex** — `agents/openai.yaml` exposes `$improve-system`; the skill still reads the Claude Code history and writes to `~/.claude/`.
- **Linux / Windows** — the digest is cross-platform; the scheduler script is macOS-only (launchd).

## Limits

- **Active time is an estimate**, from gaps under 15 minutes between events — not measured working time. Time saved by an automation is a hypothesis, never session length multiplied by repeat count.
- **Instruction files are detected on disk**; that does not prove Claude Code loaded them.
- `⚠️` corrections come from an English/French word list — hints to check against the surrounding messages, not verdicts.
- Close formulations use Jaccard similarity at 0.76: candidates, verified by reading the originals.
- Sub-agent transcripts are skipped; one level of `projects/<folder>/*.jsonl` only.
- If the digest reports `truncated`, rerun with fewer days.
