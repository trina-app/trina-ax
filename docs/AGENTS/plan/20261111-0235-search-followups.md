# ⌘K search follow-ups: a common word in chat search, tests, keys, team file names by every word

- Date (UTC): 2026-11-11 02:35
- Branch: `fix/search-followups`
- Status: done
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
   word, EXISTS per chat) are timed before choosing; the numbers go in DECISIONS (Result: the EXISTS pass per word won).
   A timing test with a common word, as the room searches have.
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

1. **Chat search.** Timed first (DECISIONS: "Chat search with a common word"). The suggested pass over `messages_fts`
   with each `LIKE` once (an inner select) was faster than #349 but still 1.3–2.3 s on a common word, and a `GROUP BY` of
   it no faster: a pass over `messages_fts` reads the whole team's messages and hands every matching row to JS. Built
   instead: a pass per word (longest first, each over the chats that held the words before) over the chats the list may
   show, `EXISTS` on `messages` by the chat's index, stopping at a chat's first message with the word: 19–35 ms for a
   common word on 2,000 chats × 100 messages, a word in no message 1.3–1.6 s (before #349 0.5–4.7 s and 1.7–3.3 s). The
   messages and roles are read only for a chat that reaches `found()`, from that chat's messages, each word's `LIKE`
   once. Timing test in `b-api.test.ts`.
2. Tests added in `b-shared-chat-audience.test.ts` (one test: title word + hidden word on the project page and in the
   plain list, the trash, and the chat once no longer shared, through `found()`).
3. The palette's keys: A–Z only for the server's `LIKE` sources; the team file names by their words with every letter
   folded, since `findFiles` now matches every word (4), so "q4  budget" and "q4 budget" are one search there too.
4. `findFiles` matches every word; its access checks are unchanged. The #349 changes/ line now names team files and the
   picker (it is unreleased, so it was corrected rather than repeated).
5. Done: `hiddenAmong` (exported) per room, `fileOut` and `refsOf` (exported) instead of `messagesOut`; every access
   test stays green, and a page is 0.5–11 ms where it was 19–198 ms.
6. Done: hand-made cursors at, above and below an unseen file.
