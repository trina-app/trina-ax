# delete_files follow-ups: nothing stranded in the trash storage, the right audit outcome

- Date (UTC): 2026-11-09 22:28
- Branch: `fix/ai-delete-followups`
- Status: in progress
- Where: trina-ax core (`server/src/team-files/service.ts`, `server/src/chat/delete-files.ts`). Why: the trash and the
  AI's tools are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Bug fixes of #277; nothing visible changes when nothing fails.

## Goal

The security review of #277 (delete_files) found no MUST. Its SHOULD: a double fault in `TeamFiles.remove` can strand
an item. A writer outside the process changes a folder while it moves to the trash, something takes its old place so
it cannot go back, and then the `trash_items` insert fails: the folder sits in `.system/trash/<month>/<uuid>` with no
row, nobody can restore it, and the AI says "Nothing was moved".

## Scope

In:
- When an item cannot go back after its rows failed, it is never left without a row if one can be written: the same
  writes are tried once more, then the trash row alone. Logged at error level with the storage path either way. The
  call reports it as moved (in the trash, or out of place with an admin to recover it), never as "nothing moved".
- The rollback puts an item back only where nothing took its place, in both branches (a file an outside writer made at
  the old path in that instant is never overwritten).
- A delete_files call where every item failed is audited `failed`, not `changed`.

Out (the review's optional nits, left with the reason in DECISIONS):
- The card's purge date counts from when the card opens and `purge_at` from the move: it never promises more time
  than the trash gives.
- `aiTrashed()` keeps reading the AI's trash rows still in the trash: SQL cannot fold letter case and Unicode form the
  way the volume does, so narrowing it there would let a variant spelling count as new.

## Steps

1. `remove()`: put back with `putBack` in both branches; when it fails, rescue the row (full writes, then the row
   alone), error log with the storage path; if no row can be written, throw `TrashStranded` with the path.
2. `trashAiPlan` and the tool: report kept and stranded items as moved; audit `failed` when nothing moved and nothing
   changed.
3. Tests with an injected insert failure; DECISIONS and CHANGELOG.

## Risks

The Files screen's delete shares `remove()`: the same rescue applies there (before, the item was stranded too). No
migration, no API change.

## Tests

`tests/unit/ai-delete-files.test.ts`, the file and trash suites, the security permission matrix, `bun run typecheck`,
`check:i18n`, `check:docs`.

## Result

Filled in at the end.
