# Improve System: Claude Code that improves itself

Every conversation you have with Claude Code is saved on your computer, in `~/.claude/projects/`. This skill reads that history and tells you what Claude gets wrong, what you keep repeating, which skills to create and which tasks you redo every day. Then it writes the rule, hook, skill or automation you pick. On the next run, it checks whether those changes actually worked.

## In 3 steps

1. **Add the skill to Claude**, for all your projects:

   ```bash
   npx skills add Melvynx/shared-skills --skill improve-system -g -a claude-code
   ```

2. **Run it** in Claude Code:

   ```text
   /improve-system
   ```

   The skill never starts on its own: only when you type the command. Add a number to read more days: `/improve-system 14` (7 by default, 90 max).

3. **Pick what it builds**: a rule, a hook, a new skill or an automation.

## What the skill does

- `scripts/digest.mjs` reads your sessions from the last days and turns them into one short file: your messages, detected corrections and interruptions, repeated messages (close wordings included), errors by tool, an estimate of active time, and the instruction files found on disk (`CLAUDE.md`, `AGENTS.md`). Dates are in local time.
- Messages copied into a resumed session are counted once. Malformed JSONL lines and invalid timestamps are counted.
- The digest is written to a private temp folder (permissions 700/600), never to a predictable shared path.
- Claude turns it into a report: follow-up on previous changes, what Claude gets wrong, what you repeat, skills to create, tasks to automate, with dates and folders.
- It writes what you pick, always after your approval, in the right file: `AGENTS.md` or `CLAUDE.md` depending on your project. Before touching a `settings.json`, it makes a `.bak` copy and checks the JSON stays valid.
- It keeps its reports and a change log in `~/.claude/improve-system/` to measure their effect next time.

## Weekly automatic report (macOS)

Recommended: one automatic report per week, and you build the changes you like yourself.

```bash
bash ~/.claude/skills/improve-system/scripts/install-macos.sh --run-now
```

By default, Mondays at 9:00 over the last 7 days (`--weekday 0-6`, `--hour`, `--minute`, `--days` to change it). `--run-now` starts a test run right away.

- The job runs `claude -p "/improve-system 7 auto"`. In `auto` mode, the skill writes the report to `~/.claude/improve-system/reports/` and stops: it asks nothing and builds nothing.
- Its permissions are limited to what it needs: run `digest.mjs`, read, and write in the reports folder. It cannot change your `CLAUDE.md`, `settings.json` or skills.
- The digest is created in a temp folder deleted at the end of the run, even on failure.
- A macOS notification arrives when the report is ready. Then type `/improve-system`: it picks up the report if it is less than 3 days old instead of reading everything again, and asks what to build.
- If the Mac is asleep at the scheduled time, the job runs on wake; if it is off, that week is skipped.
- Logs: `~/.claude/improve-system/logs/` (12 weeks kept).
- Uninstall: `bash ~/.claude/skills/improve-system/scripts/install-macos.sh --uninstall`.

If the skill is installed somewhere other than `~/.claude/skills/`, run the script from its real folder: it derives the path of `digest.mjs` from there. Run the install again if you move the skill or change your Node or Claude Code installation.

## Privacy

Secrets (API keys, tokens, passwords, private keys) are masked before the digest is written. Only you can read the digest; Claude deletes it at the end with the command the script prints (if a run is interrupted, the temp folder stays: delete it by hand). The model reads it like any message, and it is sent nowhere else. No session file is ever modified.

## Tests

Node.js 18+:

```bash
node --test test/digest.test.mjs
node --check scripts/digest.mjs
```

Script options: `--days 7`, `--out <file>`, `--root <folder>`, `--state <folder>`, `--max-chars 180000`, `--include-self`. Both `--days 14` and `--days=14` work; unknown options are rejected.

## Metric limits

"Active time" is an estimate from gaps between close events; it is not measured working time. Instruction files are detected on disk, with no guarantee Claude Code loaded them. Masking covers common secret formats but does not guarantee full anonymization: review the digest before sharing it.
