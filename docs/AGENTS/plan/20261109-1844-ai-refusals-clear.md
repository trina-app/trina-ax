# The AI's refusals say why, who and what next (part A)

- Date (UTC): 2026-11-09 18:44
- Branch: `fix/ai-refusals-clear`
- Status: done
- Where: trina-ax core (`server/src/policy/refusal.ts` new; `chat/turn.ts`, `chat/prompt.ts`, `chat/schedules.ts`,
  `tools/file-moves.ts`, `tools/higgsfield.ts`, `team-files/service.ts`, a few connection, schedule and web texts).
  Why: chat, permissions and files are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Texts the AI reads, one tool that now makes a missing folder, a card line; no API, setting or
  data change.

## Goal

The owner: "왜케 제약이 많아?? 안되는게 왜케 많은거야? 이유도 모르고?" Most limits are real, but the AI is not told why,
who could change it or where the person can do it instead, and some texts are wrong: a scheduled run reports "the user
did not allow this" for a card nobody saw, a card that timed out reads like a no, a shared chat says the person "chose
not to share" when the check failed. After this the AI can tell the person what did not happen, why, and one next step,
and it no longer blames the person for something they never decided.

## Scope

In:
- One helper for refusal texts the AI reads (`refusal({ done, why, next, names })`): what did not happen; one reason
  (no permission and who can grant it, nobody could be asked, the person said no, the card timed out, other people
  would have to agree, a server limit with its number, not available in this kind of chat); one next step with the
  screen's name in the person's language; the folders, groups, projects and connections involved. Rooms and shared
  chats keep "counts, never who cannot read what"; "not found or no access" stays the same for both (only a neutral
  next step is added).
- How a server card ended (yes, no, timed out, nobody to ask, the answer stopped) reaches the refusal texts:
  `askPerson` in the turn, `TurnPerson.confirmWhy` for tools.
- Bug 1: scheduled runs and timed-out cards no longer read as "the user did not allow": the wider-audience card, the
  skill-write card (text only), the room-change card, move_files / copy_files (`!person || person.unattended`, as
  save_url), generate_video.
- Bug 8: a shared chat's read refusal says the real reason (no, no answer, a scheduled run, a check that failed).
- Bug 10: the room, shared chat, confidential chat and scheduled run instructions say what is not available there and
  where to do it; "Rooms cannot be read in this chat" gets its reason and a next step.
- B9 / bug 5: move_files and copy_files make a missing target folder (same audience card; the card says the folder is
  new, in all five languages). The prompt no longer tells the AI to write a README.md to make a folder.
- Bug 4: the prompt says the AI cannot delete files and the person can use the Files screen's trash.
- Wording: read-only names who can grant write (B2); the per-answer write limit gives the number and "continue in the
  next message" (B7); admin-only folder moves name the admins (B14); connection, schedule, web and video refusals that
  only need words (E, F, G, H2).

Out:
- Skills: `skills/guard.ts`, `skills/move.ts`, `skills/text.ts`, move_skill, the `SKILL_FILES_REFUSAL` call sites
  (another PR, `fix/ai-skill-move-like-page`, changes them now); skills bugs 2, 3, 6, 7, 9.
- New cards (skill folders, a delete tool), schedule pre-approval, connections in rooms, post_to_room: later PRs.

## Steps

1. `server/src/policy/refusal.ts`: the helper, card endings, screen names in five languages, admin and granter names.
2. `chat/turn.ts`: `askPerson` (waitForPerson keeps its answer), card endings into the wider-audience, skill-write,
   room-change and shared-read refusals; `roomRefsBlock` with a reason.
3. `chat/tools.ts` `turnPerson`: `confirmWhy`. `tools/file-moves.ts`, `tools/higgsfield.ts`: the helper.
4. `team-files/service.ts`: `audienceChange` for a folder that is not there yet, `ensureFolder`; file-moves makes it
   after the card. `shared/src/tools.ts` descriptions.
5. `chat/prompt.ts` and `chat/schedules.ts`: mode limits, no README, no delete.
6. Read-only, write limit, admin-only folders, E/F/G/H2 texts.
7. Tests, DECISIONS, CHANGELOG.

## Risks

- No migration. Permissions: nothing new is allowed except creating the target folder of a move or copy, which goes
  through the same write check as `write` (a missing folder is made the way a new file's folders are) and the same
  audience card.
- Names in refusals: admins and the folder's project people are named only where the person may already see the
  place; "not found or no access" names nothing about the path; rooms and shared chats name no one who cannot read.
- Card texts in five languages (move/copy into a new folder). Phone and desktop show the same card.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`; unit tests for the helper, the
text of every bug-1 site, move_files into a new folder (the card says new, no README), a shared chat's timeout reason;
the chat, room, file, schedule and connection suites, the security permission matrix and the whole `tests/unit`
compared with dev; web unit tests in Docker; e2e specs for the cards whose text changes.

## Result

Built as planned (DECISIONS "Refusals say why, who and what next" and "move_files and copy_files make the target
folder"). Differences and additions:

- `waitForPerson` stays the primitive; `askPerson` reads why a card got no answer from a per-request record, so its
  other callers and test stand-ins are unchanged.
- The neutral next step for "not found or no access" lives in the instructions, not in the tool text, which stays byte
  for byte the same for a missing and a hidden path.
- Read-only notes are added in the chat turn only (after a policy "Access denied: read-only" text), so the remote
  connector and the security tests see the same tool text as before.
- Independent review: a read-only note named a hidden project's creator (a hidden project answers "read-only folder"
  like a missing one); now the creator is named only when the person may read that exact project folder. A new folder
  where nothing went in is taken away again; a failed shared-chat check no longer says a yes was needed.
- Audit summaries say `nobody to ask (scheduled run)` / `no answer in time` where that happened (cards of rooms,
  shared chats, the wider audience, skills, connections).
- Also removed a leftover merge marker in DECISIONS.md (from merge 8c1df78a).

PR: see the PR link commit.
