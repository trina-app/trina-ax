# The AI saves new content in My files unless a place is named; the wider-audience card in plain words

- Date (UTC): 2026-11-17 15:34
- Branch: `fix/ai-save-my-files-default`
- Status: done
- Where: core server (server/src/chat). Why: the AI's instructions, the save card and the save results are chat core
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch (AI instructions, card wording, a line in save results; no data change)

## Goal

QA TC-4792 (Manual AI tests, MAN-026 and MAN-027). In a 3-person room's side chat the AI saved a summary to
Company-wide › Meeting notes (10 people). The card said "Trina read content fewer people can see (messages of the
conversation leads) and now wants to save to Company-wide > …, which 10 people can see. Save it?", and the answer then
said "everyone in the room can open it". Retest 2 (#1162 follow-up, 863ea4ba0) fixed the group-chat fallback only.

For people: new summaries, notes and documents land in My files unless they name a place; the card says in plain words
where the content came from and how many people can see each side; the answer says who can open the file only from the
real folder.

## Scope

In:
- Instructions: new content goes to users/<id>/ (My files) unless the person or the task names a place (a skill's steps,
  the chat's project, the side chat's room save place, a scheduled task's folder). Company-wide is not picked because
  the content looks like it belongs there (its purpose line, the templates line).
- The wider-audience card (widenConfirm, skillWiden): "This came from <source> (3 people). Save it to <place> (10
  people, 7 of them can't see where it came from)?" in all six languages. Same facts plus who at the place cannot see
  the source (review of #1232: an overlap must not read as safe); same buttons, same rules for when it asks.
- A file made from an existing file stays next to it (FL-15), and no "where?" question (review of #1232).
- A line at the end of each new file's save result: who can open it now, from its folder (only the user / the whole
  team / a count; in a side chat how many of the room's people and how many outside). The who-can-open rule allows it.
  Same gates as who_can_open (confidential, scheduled, Slack, template runs; guests; sub-agents); in a shared chat no
  counts beyond "only the user" / "the whole team".

Out:
- The room save places decided in 20261116-flow-regressions-0512-save-place.md and 20261117-room-notes-not-company-wide.md
  (team room → group folder, Everyone room → Company-wide, group chat → smallest group folder or own folder + share):
  kept as they are; they are the "task names it" case.
- The "Send to room?" card and post_to_room (another branch).

## Steps

1. prompt.ts: saveNewPlaceRule in the turn's base lines (not for a guest); the shared/ purpose line and the templates line.
2. i18n.ts: widenConfirm, skillWiden reworded; widenFrom / widenFromYou for the per-source count.
3. turn.ts widenSources: the card's sources with their counts (read-scope.ts sourceViewerCount).
4. save-audience.ts + turn.ts audienceNote + tools.ts: the audience line after a save (main AI, not a guest).
5. Tests: tests/unit/b-ai-save-place.test.ts; update plural-counts, b-skill-save-one-card, c-reader-counters.
6. ai-scenarios: a case for "save the room's summary" with no place named → My files.

## Decisions

docs/decisions/20261117-ai-save-my-files-default.md

## Result

See the PR.
