# The AI's file actions that touch skill folders: one card per call, bound to what it shows

- Date (UTC): 2026-11-09 20:12
- Branch: `feat/ai-skill-folder-actions`
- Status: done
- Where: trina-ax core (`server/src/skills/folder-actions.ts` new, `server/src/chat/skill-files.ts` new,
  `server/src/skills/guard.ts`, `server/src/skills/changes.ts`, `server/src/skills/text.ts`,
  `server/src/team-files/service.ts`, `server/src/chat/tools.ts`, `server/src/chat/turn.ts`,
  `server/src/chat/subagents.ts`, `server/src/tools/make-file.ts`, `server/src/devenv/srt/`, `shared/src/tools.ts`,
  `shared/src/step-labels.ts`). Why: skills, permissions and the dev environment are core features of every team
  server (see docs/REPOSITORY-RULES.md)
- Version impact: patch. One new AI tool behind a server card, stricter checks elsewhere; no HTTP API change, no
  migration.

## Goal

The refusal audit (2026-11-10, rows A6 and A7, bug 3) found that every AI move, copy or rename into or out of a skill
folder is refused with the same text, even for an admin who only renames a project folder that holds skills
("projects/견적 → projects/2026 견적"), or who asks to take a PDF that landed in `skills/` by mistake back out. People
do all of this on the Files screen. The security review of the first draft narrowed what the AI may do ("B1") and found
gaps in what exists today. This builds the narrowed B1 and closes those gaps.

## Scope

In: a new tool `skill_files` (move, copy or rename one item), the main AI in the person's own chat only, one server
card per call, its yes bound to a token over every file's path and hash, the target, and the readers and editors. The
token is checked again inside the file service right before the rename or copy. Exactly three kinds:

- **N**: a group or project folder (`groups/<g>`, `projects/<p>`) holding skills renamed in place, when nothing changes
  for anyone (the same skills, readers and editors before and after). A plain card. Admin-only rules for managed
  folders stay. Also a skill's own folder renamed in its skills folder, with its `name:` line on the same card (else the
  skill stops loading).
- **O**: files, skills or rules leaving a skill root by move, copy (files) or rename (the skills folder itself, or a
  group or project folder moved out of its place). The card names the skills and how many people lose them (names only
  for the owner, admins and a project's creator, as `move_skill`), and who gains or loses the files. Recorded as
  `skills.change`.
- **I**: a SKILL.md folder of text files going into a skill root. The card shows the full text of every file, readers
  and editors gained, the same name elsewhere (counted per person, named only where the asker can read it), and the
  exact target, which must not exist. The bytes placed are the bytes the card showed, as new files (a process that
  held the old file open cannot change it afterwards). Cut after the review (product owner): no picture, media or any
  other file that is not text goes in, on its own or in the folder; the refusal tells the user to upload it on the
  Files screen. A single `.md` (a team rule), any other single file, instruction file names and text above the card's
  limit are refused too.

Everything else is refused up front with a reason and the Files screen as the next step: moves within or between skill
folders (`move_skill` for a whole skill to another level), deletes, folders that would switch project or group skills
on, `groups/` or `projects/` themselves, the person's own skills folder (`move_skill`). Rooms, shared chats, chats
others wrote in, scheduled runs, template runs, confidential chats, drafts and sub-agents get the refusal before any
card; a chat that read a room is refused "I".

Also, existing gaps:

- Approvals for skill saves (`skillApprovals`) are one-shot: used up by the check itself, dropped after every call
  that failed, and the "already confirmed" shortcut goes. `make_file` approves the path it really saves (`x.md` with
  docx saves `x.md.docx`).
- The file service's skill guard stays closed by default: `move()` and `copy()` refuse skill roots (copy now also as
  the source) for any AI turn without a one-call grant for that exact operation; a grant needs `onExists: 'fail'`.
- A move of a folder holding skills records each skill that stops (or starts) applying as `skills.change`, with
  notices, for the Files screen too (today only a project's switch-on is recorded, without notices).
- Dev-environment runs: the project's and the person's skills folders are on the run's no-write list (an absent one is
  made as a mount point for the run and removed after, like srt's own names).
- The file tools' skill refusal says what to use for each case instead of one text about moving skills.

Out (cut by the review): producers (save_url, generate_video, room files) writing into skill folders, team rules made
by file actions, AI moves that switch project or group skills on or off other than through `move_skill`, deletes in
skill folders.

## Steps

1. `skills/guard.ts`: one-shot approvals; the per-call grant (`allowSkillAction` / `takeSkillAction`); the refusal text.
2. `skills/folder-actions.ts`: classify (N, R, O, I or refused with a reason), plan (files and hashes, readers and
   editors before and after with the folder rules, the skills affected, the same name elsewhere), token, run.
3. `team-files/service.ts`: `checkMove` (the move's own checks without moving), the grant in `move()` / `copy()`,
   fresh files for "I", `placeSkillTree`, the per-skill records of a folder move (`skills/changes.ts`).
4. `chat/skill-files.ts` and `chat/tools.ts`: the tool, its up-front refusals, the card, the result (counts, names by
   `seesWho`); `PARENT_ONLY_TOOLS`; `shared/src/tools.ts` input; step labels.
5. `chat/turn.ts` and `tools/make-file.ts`: the final `make_file` path; approvals dropped after each call.
6. `devenv/srt/access.ts` and `runner.ts`: skill roots on the no-write list, mount points for absent ones.
7. Texts in five languages, DECISIONS, PERMISSIONS, CHANGELOG, tests.

## Risks

- Prompt injection: planted text could ask the AI to move skills out (fewer people get them) or bring a planted skill
  in. The card is the server's, says who gains and loses, shows every word the AI would follow, and its yes is bound to
  exactly that; checked again inside the service right before the rename. Nothing else covers it (no room grant, no
  earlier answer).
- A card that does not match what runs: the token covers the files, the target, the readers and the editors; a file
  added or changed between the card and the yes refuses the call.
- A file kept open by a dev-environment job: "I" places new files with the shown bytes; skill roots are read-only in
  runs.
- Names: only to who may see them in the app; tool results carry counts otherwise.
- Coordination: `fix/ai-refusals-clear` (file-moves.ts, service.ts wording, refusal helper), `feat/ai-delete-files`
  (`TeamFiles.remove`), `feat/fewer-cards-after-room-read` and `feat/room-read-connection-cards` (turn.ts),
  `fix/skill-copy-followups` (move.ts walker): this branch keeps to its own call sites and adds its own walker.
- No migration (highest on dev: 701). Five languages for every card text.

## Tests

`bun run build:native`, `typecheck`, `check:i18n`, `check:docs`, `docs:api`; a new `tests/unit/skill-files.test.ts`
with an attack test for each MUST (a leftover approval after a failed call, a team-to-team move that widens, a name
clash, a team rule by a file action, a project folder moved out with its skills and the off-audit, each mode refusal, a
sub-agent, a card that does not match what runs, a file added between the card and the yes); the dev-environment
run's no-write list; the `make_file` docx path; the skills, file and chat suites, the security permission matrix, the
whole `tests/unit` compared with dev, and the web unit tests in Docker.

## Result

Built as planned, with what an independent security review (two passes, before the PR) added:

- The card shows every word: a text or a file name with a character a person cannot see there (zero-width,
  direction, tag characters) is refused.
- The card's bytes go into place in the move's own step, inside the database transaction with both renames, instead
  of a swap after the move that could fail open; a renamed skill folder gets its new SKILL.md the same way (the old
  text kept as a version), so it never stops halfway. Folders, empty ones too, and a script's execute bit are kept.
- The same-name counts look only at skills and projects the asker reads (a count must not tell a name); Slack threads'
  chats are refused (an answer may go to a channel); a skills folder moved out of the skill roots records each skill.
- Cut after the review, by the product owner: no picture, media or any other file that is not text goes into a skill
  folder through the AI (its content could not be shown on the card); the refusal tells the user, in their language,
  to upload it on the Files screen. A thumbnail on the card could bring pictures back later, as its own change.

Differs from the plan: the new tool is `skill_files` (one item per call); the old file tools keep refusing and say
what to use. `fix/ai-refusals-clear` had not landed, so the refusals use their own why / next-step texts in that shape.
New audit actions `skills.files` and `skills.files_refused` have words on the Admin audit screen (five languages).

Checks: see the PR, https://github.com/trina-app/trina-ax/pull/276.
