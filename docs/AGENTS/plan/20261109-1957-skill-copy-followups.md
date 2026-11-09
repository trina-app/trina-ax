# Skill move and copy: the code review's follow-ups

- Date (UTC): 2026-11-09 19:57
- Branch: `fix/skill-copy-followups`
- Status: done
- Where: trina-ax core (`server/src/skills/move.ts`, `server/src/skills/text.ts`, `server/src/chat/tools.ts`,
  `tests/unit/move-skill.test.ts`). Why: skills and permissions are core features of every team server (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. Stricter checks and clearer words on the move / copy card; no API, no migration.

## Goal

The code review of #269 (the AI moves and copies a skill behind the server card) found no MUST, and these:

- A skill file hard-linked elsewhere is read by the move / copy walk; a copy makes it an ordinary file at a level more
  people read. Every other walker skips hard links.
- A renamed copy can land broken: the copy's name pattern accepts `a--b`, which the skill parser rejects, and the name
  line rewrite turns a valid folded header (`name: >-` on its own line) into an invalid one.
- A folder of the same name in other letter case at the target counts as "not there".
- "64 KB" on the card where the text is cut at 64K characters.
- A renamed copy's card lists the original paths, not where the files land.

## Scope

In:

- A hard link in the skill folder refuses the move or copy (like a symbolic link).
- A renamed copy: the name must pass the skill parser's own name rule, and the SKILL.md as it would be is parsed
  (`checkSkill`) and must load with the new name, else refused with what to do.
- A case-only clash at the target is "already has a skill of that name".
- The cut note says characters; the card's file list shows the target paths.
- Tests: a hard link, `a--b`, a folded name header, a case-only clash, a file added between a copy's card and the yes.

Out: `copy_files`'s reason when a skill folder is the source: `fix/ai-refusals-clear` edits `tools/file-moves.ts` and
has not landed on dev yet, so it stays for that branch or later.

## Steps

1. `move.ts`: `nlink > 1` in `skillFiles`; `COPY_NAME` from the parser's pattern; `checkSkill` after `withName`; a
   case-only target clash is `moveTaken`.
2. `text.ts`: the cut note in characters, a refusal for a copy that would not load.
3. `tools.ts`: target paths in the file list.
4. Tests in `move-skill.test.ts`.

## Risks

A hard link that worked before now refuses: the person moves the file out of the skill folder or replaces it with a
copy first (the refusal says so). No migration, no API change; five languages for the new text.

## Tests

`bun run typecheck`, `check:i18n`; `move-skill`, `project-skills`, `c-file-moves`, the security permission matrix and
the whole `tests/unit` compared with dev.

## Result

Built as planned. The name line rewrite now also takes a name written as a block (`name: >-` and its indented lines),
so such a skill copies under a new name instead of being refused; `checkSkill` still guards every renamed copy. The
card's file list shows where each file lands for moves too, and says "복사할 파일" for a copy. `copy_files`'s reason
for a skill folder as the source is left out: `fix/ai-refusals-clear` had not landed on dev.

Checks: typecheck, `check:i18n`, `check:docs` clean; `move-skill` 25 pass, `project-skills` and `c-file-moves` pass,
the e2e `project-skills` spec passes; the permission matrix's 3 failures and the whole `tests/unit`'s 53 failures are
the same as on dev. PR: https://github.com/trina-app/trina-ax/pull/272.
