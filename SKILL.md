---
name: improve-system
description: >-
  Makes Claude Code improve itself from your own history. Reads the Claude Code
  sessions of the last days saved on your computer (~/.claude/projects), reports
  what Claude keeps getting wrong, the instructions you repeat, the skills to
  create and the tasks to automate, checks whether the previous fixes worked,
  then writes the rule, hook, skill or automation you pick. Manual only: run
  /improve-system [days] [auto].
argument-hint: "[days, default 7] [auto]"
disable-model-invocation: true
---

# improve-system

Every Claude Code session is saved as one `.jsonl` file in `~/.claude/projects/<folder>/`. That history
shows what Claude got wrong, what the user had to say twice and the work they redo. This skill turns it
into fixes, then measures on the next run whether those fixes worked.

Arguments: `$ARGUMENTS`.
- A whole number from 1 to 90 is the number of days to read (default 7; anything else: say so and use 7).
- The word `auto` turns on **auto mode**, used by the weekly scheduled run (`scripts/install-macos.sh`).
  No one is there to answer: do steps 1 and 2, save the report (step 4), and stop. Ask nothing, build
  nothing, write nothing outside `~/.claude/improve-system/reports/`, add nothing to `changes.md`,
  and leave the digest in place (the scheduler deletes it). Start the saved report with the line
  `Mode: auto (nothing was built)`.

Without `auto`, if the latest report starts with that line and is less than 3 days old, do not
regenerate it: show its top 3, ask which one to build and go to step 3. Regenerate only if the user asks.

Answer in the language the user writes in.

State kept between runs, in `~/.claude/improve-system/`:
- `reports/YYYY-MM-DD.md`: one file per report.
- `changes.md`: one line per change built.

## 1. Gather

1. Run the digest, with the absolute path of this skill folder (the scheduled run only allows that
   exact command). It only reads, masks secrets and writes one private Markdown file:
   ```bash
   node <absolute path of this skill folder>/scripts/digest.mjs --days <N>
   ```
   It prints the digest path and the command to delete it. Read the digest in full.
2. Read what already exists, so you never propose something already there and you spot rules Claude
   still breaks: the last report and `changes.md` (paths in the digest header), `~/.claude/CLAUDE.md`,
   the names and descriptions of `~/.claude/skills/*`, and the instruction files the digest lists for the
   folders that come up.

What the digest contains: per-folder totals, tool errors, messages repeated across sessions, then every
message the user typed, session by session, in local time. `⚠️` marks a message that looks like a
correction, `⏹` marks the user stopping Claude.

How far to trust it:
- `⚠️` comes from a word list. Read the messages around it before calling it a correction. A `⏹`
  followed by a new instruction is a strong sign Claude went the wrong way.
- Close-wording groups are candidates: check the original messages and drop groups whose intent differs.
- Active time is an estimate from short gaps between events, not measured working time.
- Instruction files are found on disk; that does not prove Claude Code loaded them.
- If the digest says sessions were left out (`truncated`), say so in the report or rerun with fewer days.

Do not open raw `.jsonl` files to read them: they hold whole conversations. To check one precise point,
`grep` the file path shown under the session.

## 2. Report

Write it in chat. Every point cites the history: date, folder and the user's own words. No generic tip
the history does not show. A point needs **2 different sessions or more**; anything seen once goes in
"Weak signals".

0. **Follow-up** (only if `changes.md` exists). For each change listed, count the same problem in the
   new period and compare with the period before it:
   - give raw counts with their base (sessions and messages in each period), and a rate when it helps,
     such as corrections per 10 sessions;
   - count only clear instances of the same problem;
   - verdict, one of: "resolved" (no recurrence over at least 2 sessions where it could have happened),
     "decreasing", "no effect", "not enough data" (too few sessions to judge);
   - a rule in an instruction file that had no effect becomes a hook, not the same rule written again.
     If that rule lives in an `AGENTS.md` with no `CLAUDE.md`, first offer to create a `CLAUDE.md` that
     imports `@AGENTS.md`.
1. **What Claude gets wrong**: mistakes that come back (`⚠️`, `⏹`, the same request redone, the same
   tool failing). Count, number of sessions, 2 quotes, the fix.
2. **What you repeat**: instructions given in many sessions (a style, a tool, a check). Start from
   "Messages repeated across sessions".
3. **Skills to create**: multi-step workflows done again and again. Name, what it does in 3 lines,
   source sessions. Never one that already exists.
4. **Tasks to automate**: same kind of request in the same folder every day or week. Dates, folders,
   rough time today, the automation. Time saved is a hypothesis: never multiply a whole session's
   active time by a repeat count.
5. **Weak signals**: one line each.

Pick the form of each fix:

| The problem | The fix |
|---|---|
| A short preference or convention | A rule in an instruction file |
| A procedure of several steps | A skill |
| Something that must always happen, or a rule Claude already breaks | A hook |
| A task that needs no conversation | A script or a scheduled task |

Tag each recommendation with **impact** (high / medium / low: how often, and how costly in
corrections, errors or interruptions) and **confidence** (high / low: how solid the evidence is).
End with the top 3 changes and ask which one to build (in auto mode, list them without asking).

## 3. Build what the user picks

Show exactly what will be written, and write only after the user says yes.

- **A rule.** Pick the file:
  - for every project: `~/.claude/CLAUDE.md`;
  - for one project, from the instruction files the digest lists:
    - only `CLAUDE.md` → there;
    - only `AGENTS.md` → there (other agents such as Codex read it too);
    - both, `CLAUDE.md` imports `@AGENTS.md` → shared rules in `AGENTS.md`, Claude-only rules in `CLAUDE.md`;
    - both, no import → `CLAUDE.md`, and offer to add `@AGENTS.md` at its top for one source of truth;
    - none → ask whether other agents are used (then `AGENTS.md`), else `CLAUDE.md`.

  Never delete or weaken other rules. If a close rule already exists, show the rewrite of that one rule
  instead of adding a second. Keep the file short: long instruction files are followed less.
- **A hook.** In `~/.claude/settings.json` or the project's `.claude/settings.json`:
  1. copy the file to `settings.json.bak` first;
  2. merge the hook into the existing JSON, never replace the file;
  3. check the result parses: `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`;
     if it fails, restore the backup;
  4. run the hook's script once by hand on a real case from the history.
- **A skill.** Write `~/.claude/skills/<name>/SKILL.md`: frontmatter `name` and a `description` that
  says what it does and when to use it, then the steps taken from the sessions. Test it on a real
  message from the history: check the description matches it and walk through the steps. Tell the
  user to type `/<name>`.
- **An automation.** Write the script or scheduled task, run it once, show the result.

## 4. Save and clean up

- Save the report to `~/.claude/improve-system/reports/<date>.md` (create folders if needed).
- For each change built, append to `~/.claude/improve-system/changes.md`:
  `<date> · <rule|hook|skill|automation> · <file> · <the problem, in the user's words>`.
- Delete the digest with the command the script printed (not in auto mode).

Never edit or delete a session file. The history goes nowhere else: the digest is read by the model
like any prompt, with secrets masked.

## Notes

- Sessions of `/improve-system` itself are left out (`--include-self` keeps them). Messages copied
  into a resumed session are counted once. Sub-agent transcripts are skipped.
- The digest keeps only what the user typed, not Claude's answers, so it stays small.
- Under Codex, this skill still reads the Claude Code history in `~/.claude/projects`.
