# Typing mistakes in searches of several words, on every search surface

- Date (UTC): 2026-11-21 10:10
- Branch: `fix/search-multiword-typo`
- Status: in progress
- Where: trina-ax `shared/src/search-near.ts` (new), `server/src/rooms/search*.ts`, `server/src/rooms/reader.ts`,
  `server/src/team-files/find.ts`, `web/src/components/SearchDialog.tsx`. Why: the matching and ranking of searches
  (see docs/REPOSITORY-RULES.md); the tokenizer and the index are left alone.
- Version impact: patch (a search finds more of what was meant; no API, schema or migration change that an older app
  would notice: one optional field).

## Goal

A search of several words with one misspelled word still finds what was meant: "quarterly reprot budget" finds
"Quarterly report budget", "견적서 sincre" and "견젹서 sincere" find "견적서 Sincere". Today only room messages forgive a
typing mistake, and only for words of four letters or more (none for Korean words under four syllables); team files,
files sent in rooms, room and people names in ⌘K and the AI's room search find nothing when one word is misspelled.

## Scope

In:
- One matcher (`shared/src/search-near.ts`): each word of the text matches a word of the item as the whole word, the
  start of a word, inside a word, or near (typing mistakes: none under 4 letters, 1 for 4–7, 2 from 8; Hangul by its
  letters (jamo): 1 from 3 syllables, 2 from 6). A one-letter word matches only as a whole word or a word's start in
  the near pass. Score: exact (whole) < prefix < inside < near, so the results rank exact > prefix > fuzzy.
- Room messages (⌘K, Search screen): near pass uses the matcher (Korean too), ranks by it; candidates for Hangul words
  from two-syllable pieces as well as the trigram pieces.
- Team file and folder names (⌘K / file picker): a near pass over the names already listed when no name holds every
  word, ranked by the matcher, then newest.
- Files sent in rooms (⌘K): the same near pass over a bounded set of the newest names the person sees.
- ⌘K rooms and people: a name that matches no word as typed may match near (after every exact one).
- The AI's room search tool (`rooms` with a query): when nothing matches as typed, near matches of the same rooms and
  filters, said as such in the result.
Out: AI chat records (their LIKE over every message has no index to draw near candidates from), the AI's file
grep/glob tools (an AI asks for exact text), the tokenizer and stemming (`searchStem`, particles: branch
fix/ko-search-forms), the index (no migration).

## Steps

1. `shared/src/search-near.ts`: `nearWordBudget`, `wordGrade`, `gradeText` (sum of per-word grades or null), Hangul
   jamo edit distance; exported from `shared/src/index.ts`.
2. Room messages: move the near pass to `server/src/rooms/search-near.ts` (also used by the AI tool), rank by grade.
3. Team files, room files, ⌘K names, AI room search as above.
4. Tests: `tests/unit/search-near.test.ts` (first, middle, last word, English and Korean, ranking, short words),
   additions to the room message, room file, team file and AI room search tests; the 100,000-message timing.
5. Decision file, changes note.

## Decisions

`docs/decisions/20261121-search-near-every-word.md`: changes the "near matches" rule of
[20261119-message-search-slack-level](../../decisions/20261119-message-search-slack-level.md) (Korean by jamo, ranking,
more surfaces).

## Risks

Visibility: every near pass reads only candidates the person already sees (the same SQL and checks as the exact pass);
it widens which words match, never which items. Speed: near passes run only when nothing matched as typed, over bounded
candidate sets. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/search-near.test.ts`, the search unit tests
(`b-rooms-search*.test.ts`, `b-rooms-file-search.test.ts`, `search-text.test.ts`, `find-files-cap.test.ts`,
`a-guests-room-search.test.ts`, web `search-palette`), and the search access security tests.

## Result

