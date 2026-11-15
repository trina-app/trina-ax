# Stored connection keys never reach saved memories or scheduled tasks

- Date (UTC): 2026-11-15 08:24
- Branch: `fix/memory-hides-keys`
- Status: in progress
- Where: server/src/chat (remember tool), server/src/tools/schedules.ts. Why: the AI's saved text is server work
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no new feature or API change

## Goal

A member asks the AI to remember a connection key. The step already reads "Remembered: My key is [hidden key]", but the
saved memory holds the raw key: Settings › Memory shows it and the owner's export (memories.csv) has it (QA tracking
TC-2981). Saved AI text gets the same key hiding as the answer, the steps and the chat title.

## Scope

In:
- remember: the text goes through the turn's redactor (redact.ts, the one the answer, steps and titles use) before the
  card asks and before it is saved.
- schedule_create: the title and prompt the AI writes go through the same redactor before the card shows them and
  before they are saved (a run uses the stored connection, never a key in the prompt).
- Once at start-up: memories the AI made earlier (created_turn_id set) that hold one of the person's stored keys get
  [hidden key] in its place (a settings key marks it done).
- Checked, no change: file-list lines (a nightly team reader, not a chat turn; a line shows only to people who can open
  the file itself), skill suggestions (the person sends them from an answer that is already hidden, or from their own
  file, and edits them first), "often asked" lines (already masked), room posts and answer shares (already hidden),
  chat titles (already hidden).

Out: the person's own typed messages and memories they type in Settings › Memory stay as typed (by design).

## Steps

1. Plan (this commit).
2. remember and schedule_create redact; a start-up clean-up of AI-made memories.
3. Unit tests that fail without the fix (tests/unit/c-integrations-secret-echo.test.ts).
4. Screenshots of Settings › Memory at 1440 and 390, before and after, on a local server with fake data.

## Risks

No migration. A memory or scheduled prompt that quoted a key now says [hidden key]; the key is still in the connection.
Plain-words check: no new UI text; the hidden mark is the existing "[hidden key]".

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit c-integrations-*, b-chat*, b-api.

## Result

(at the end)
