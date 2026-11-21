# A typing mistake in one word of a search no longer makes it miss: every word near on its own, exact before near

- Date: 2026-11-21
- Status: accepted
- Supersedes: the "near matches" rule of [message search at least as good as Slack's](20261119-message-search-slack-level.md)
  (Korean words, the order, the other search boxes; the rest of it stays)
- Branch: fix/search-multiword-typo (follow-up of 2026-11-20: typing mistakes in searches of several words)

넣을 곳: trina-ax `shared/src/search-near.ts` (new), `server/src/rooms/search-near.ts` (new), `server/src/rooms/search.ts`,
`server/src/rooms/reader.ts`, `server/src/team-files/find.ts`, `web/src/components/SearchDialog.tsx`, 이유: the
matching and the order of the search boxes and the AI's room search; the words of a text (`searchWords`,
`parseSearch`, `searchStem`) and the indexes are unchanged.

- **Ask:** "quarterly reprot budget" should find "Quarterly report budget", "견적서 sincre" should find "견적서 Sincere".
  Before, only room messages forgave a typing mistake (words of 4 letters or more; a Korean word only from 4 syllables,
  by whole syllables); team files, folders, files sent in rooms, rooms and people in ⌘K and the AI's room search found
  nothing when one of several words was misspelled.
- **Rule: each word on its own** (`nearMatcher`): every word of the text must match a word of the item as the whole
  word (grade 0; a Korean particle after it counts as its end), its start (1), inside a word (2), or near: one typing
  mistake (3: a letter more, less, changed, or two neighbours swapped), two (4), a half more when it is in the start of
  a longer word ("reprot" in "reports"). The item's score is the sum; lower first, so exact before prefix before near,
  the newest first among the same.
- **Rule: how many mistakes.** None for a word with anything but letters and digits ("q4-plan": as typed only) or under
  4 letters; 1 from 4; 2 from 8. A Korean word by its letters (jamo: "견젹서" is one from "견적서"): none under 3
  syllables, 1 from 3, 2 from 6. A one-letter word only as a whole word or a word's start, never inside one. A quoted
  phrase as typed only.
- **Rule: when.** Only when nothing matched as typed (as before for messages): room messages and room files on the
  first page only (no cursor), team files and folders when no name holds every word, ⌘K rooms and people when no name
  matches, the AI's `rooms` search when nothing matched in the same rooms, windows and filters (its answer says
  "close spellings, the closest first: check they are what was meant"; text only, not file names; not with `files`).
  Team file names that do match as typed are now ordered the same way (whole words first), then newest.
- **Rule: who sees what is unchanged.** Every near pass reads only what the exact pass would: room messages from the same
  trigram index with who sees them decided in the query (SEE_MEMBER_SQL) and canSee after, room files by the same query
  without the words (the newest 5,000 the person sees), team files from the same listing and visiblePath, the AI's
  search the same rooms and windows. It widens which words match, never which items.
- **Speed.** Candidates are bounded: messages 2,000 by the index's rank plus, for a Korean word with a possible mistake,
  the newest 2,000 holding two of its syllables (side by side, or with one between: a read of the index's text, as a
  search of a two-letter word is); room files 5,000 names; team files the names already listed (at most 20,000 kept).
  The matcher remembers each word of a text it has looked at, so a team's repeated words cost once; it scored 30,000
  names and messages in about 1.2 s on a heavily loaded build Mac (`tests/unit/search-near.test.ts` prints the time;
  `b-rooms-search-slack.test.ts` the 100,000-message times).
- **Left out:** AI chat records (their search has no index to draw near candidates from), the AI's file grep and glob
  (an AI asks for exact text), two-syllable Korean words (too many real words are one letter apart: 연수/연구), a
  "Close matches" label on file rows (names are short and shown whole).
- **Tests:** `tests/unit/search-near.test.ts`, `tests/unit/b-rooms-search-slack.test.ts` (near matches, 100,000
  messages), `tests/unit/b-rooms-file-search.test.ts`, `tests/unit/find-files-cap.test.ts`, `tests/unit/b-chat-rooms.test.ts`
  (the AI's search).
- **Version impact:** patch: a search finds what was meant; no API field, schema or migration.
