# ⌘K search follow-ups: a common word in chat search, tests, keys, team file names by every word

- Date (UTC): 2026-11-11 02:35
- Branch: `fix/search-followups`
- Status: in progress
- Where: trina-ax core (`server/src/routes/chats.ts`, `server/src/team-files/find.ts`, `server/src/rooms/search.ts`,
  `web/src/components/SearchDialog.tsx`). Why: the follow-ups of the independent review of #349 (⌘K rooms and people,
  room files, every word); search is core.
- Version impact: patch. Faster and more consistent search; no new endpoint, field or migration.

## Goal

The review of #349 found no must-fix and six smaller points. This branch does them.

## Scope

In:
1. **Chat search with a common word** (`routes/chats.ts`). #349 reads the messages holding any word in one pass, but it
   evaluates each word's `LIKE` twice per row, joins `messages` for every row and builds an object per row: on a word
   in most messages (one letter, "요"; the palette searches from the first letter) it is slower than dev (2,000 chats ×
   100 messages: dev 0.5–1.1 s, #349 1.5–3.2 s, and SQLite blocks the server meanwhile). Now: each word's `LIKE` once
   (an inner select giving w0…wN, the filter outside), only the chat id and the flags read (arrays, not objects), no
   join. The messages and roles (which answers hold a word) are read only for the chats that reach `found()` (shared
   chats, chats with several authors), from `messages` by its chat index. Variants (GROUP BY, MATERIALIZED, a pass per
   word) are timed before choosing; the numbers go in DECISIONS. A timing test with a common word, as the room searches
   have.
2. **Tests of the hidden-answer check through words** (`tests/unit/b-shared-chat-audience.test.ts`): my own chat with
   several authors that is no longer shared (visible() → found()); one word only in the title and the other only in a
   hidden answer; the plain chat list (no projectId) and the trash.
3. **The palette's keys** (`SearchDialog.tsx`): the stale-result key folds only A–Z, as the server's `LIKE` does
   ("Été" and "été" are different searches); the team files' key follows what `findFiles` matches (below).
4. **Team file names by every word** (`team-files/find.ts`): every word in the name, in any order, as room files; the
   access checks stay as they are. The composer's team-file picker uses the same function, so it matches the same
   way. The changes/ note says so.
5. **Room files without the full `messagesOut`** (`rooms/search.ts`): `hiddenAmong` and the files of the messages
   (`fileOut`) give what the hit needs; only if it stays simple and every access test stays green.
6. **A hand-made cursor at a file they cannot see** (`tests/unit/b-rooms-file-search.test.ts`), as message search has.

Out: anything else.

## Steps

1. This plan (first commit).
2. Time the variants for 1; build the chosen one with its timing test.
3. 4, 5; then 3 in the web; tests 2 and 6.
4. DECISIONS (the ⌘K section), `changes/search-followups.md`.

## Risks

- Chat search decides who finds a shared chat's hidden answer: `found()` keeps deciding, the pre-pass only narrows. Tests
  in 2 cover the paths that reach `found()`.
- Reading `messages` directly for the chats that reach `found()`: the same text as `messages_fts` (finished messages,
  `status <> 'streaming'`, the index's own rule).
- `findFiles` is also the composer's picker: a looser match lists more names there (the same order and cap).
- No migration.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run check:i18n`; `tests/unit/b-api.test.ts`,
`tests/unit/b-shared-chat-audience.test.ts`, `tests/unit/b-shared-chats.test.ts`, `tests/unit/b-rooms-file-search.test.ts`,
`tests/unit/b-rooms-search.test.ts`, the team file find tests, `web/test/unit/search-palette.test.tsx`; the search e2e
specs.

## Result

(filled in at the end)
