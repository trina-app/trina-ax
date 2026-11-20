# Message search at least as good as Slack's: from:, in:, phrases, word forms, best match, near matches

- Date: 2026-11-19
- Status: accepted
- Supersedes: the "Rejected: Slack's from:/in:/date filters" line of [⌘K에서 대화방 메시지 찾기](../DECISIONS.md#k에서-대화방-메시지-찾기--room-11-and-group-chat-messages-in-the-search-palette-featsearch-room-messages-2026-11-08-product-owner) (from: and in: only; the rest of it stays)
- Branch: feat/message-search-slack-level (the owner, QA TC-5365: "messages are hard to find with search")

넣을 곳: trina-ax `server/src/rooms/search.ts`, `shared/src/search-text.ts`, `shared/src/api/rooms.ts`,
`web/src/components/SearchDialog.tsx`, 이유: room message search and its palette are core chat.

- **Ask:** message search at least as good as Slack's; Slack and Claude Code are the floor.
- **Audit** on a seeded copy of the QA team (about 1,400 messages: Korean, English and mixed, names, links, files,
  thread replies, DMs, an edited message, messages 540 days old, a guest in one group chat): 20 of 34 cases as expected
  before. Missing: a particle ("회의를" found nothing, "견적서는" missed "견적서를"), English forms ("deploys",
  "deploying", "meetings"), "quoted phrases" (the quotes were characters), from:, in:, typing mistakes ("recieve"),
  best match first. Already right: part of a Korean word ("인화" finds "인화원", the trigram index of migration 267),
  case, thread replies, DMs, links, edits, old messages, file names, who sees what (guests included), the jump to the
  message in its room, marked. After: 34 of 34.
- **Rule: the text** (`parseSearch`, the same in the server and the app): `from:` a person (`me`, a username, `@name`,
  `"Full Name"`, Korean initials as names elsewhere), `in:` a room or a 1:1 chat (`#room`, `@person`, `"Room name"`,
  the everyone room's words), `"a phrase"` (as typed, its words together in that order), and the words. A word is
  matched by its part without a Korean particle when two syllables stay ("회의를" → "회의", "인화원에서" → "인화원";
  "사과" stays) or without an English ending when four letters stay ("deploys", "deployed", "deploying" → "deploy";
  "meetings" → "meeting"; "process", "during" stay). It is a part of a word, so every form is found. A lone quote is a
  character, as before.
- **Rule: filters never widen what a person sees.** `in:` picks among the rooms they are in now (`myRooms`); a room they
  are not in reads exactly as a name that does not exist (`filters.missing`, nothing found). `from:` names only people the
  searcher may see (`reachFilter`: a guest only the people of their places, a member no guest outside theirs; an
  account no longer in use only while it is in one of their rooms), anyone else reads as a name nobody has; it only
  narrows the authors inside the same query (SEE_MEMBER_SQL, then canSee, then messagesOut). Guests: their one chat only, as
  before. Files sent in rooms take the same filters and word forms. The answer says how the filters were read
  (`filters`): the section reads "Messages · from QA Member Two · in #QA-Search Marketing", and a filter that names
  nobody says so. With a filter in the text the palette searches only the rooms' messages and files.
- **Rule: order.** `sort=relevant` (what the app asks; Slack's "Most relevant"): the newest 300 matches the person sees
  (`RELEVANT_POOL`: bounded, never a whole history sorted), ranked by the whole text in order (4), each word as a whole
  word (2; a Korean particle after it counts as its end), as typed (1), a short message (up to 0.5) and recency (up to 1,
  halved in a month), so "내일 회의 10시로" from April comes before "회의실 예약" from yesterday; past the 300 the pages
  go on newest first. A best-match cursor carries its pool's newest message and its time, so a message sent between
  pages changes no later page; it is refused on `sort=recent`. `sort=recent`, the API's default for older apps: newest first as before. One small "Best match ⌄ /
  Newest" menu above the results, outside the list (the list holds only options: axe).
- **Rule: near matches** when nothing matched as typed (first page only): candidates from the same trigram index by its
  own rank (any of the words' three-letter pieces, at most 1,000, who sees them decided in the query), then each word in
  the text as typed or with 1 typing mistake (4–7 letters or syllables) or 2 (8 or more), as a word or the start of one.
  Only words of letters and digits ("q4-plan", "^abc": as typed only). Shown as "Close matches", one page, no order menu.
- **No migration.** The trigram index of migration 267 serves all of it. On 100,000 messages (13 MB of text; the index
  36.5 MB, unchanged) each search took about 20 ms on the build Mac (`tests/unit/b-rooms-search-slack.test.ts` prints
  the times); a near match over common pieces is the slowest, 100–160 ms, and runs only when nothing matched as typed.
- **Left out:** stemming beyond these endings (Korean verb endings such as "보냈어요" for "보내"), near matches for Korean
  by jamo (whole syllables only), `during:`/`before:`/`has:` filters, suggestions of names while typing a filter (the
  footer's hint names the filters).
- **Tests:** `tests/unit/b-rooms-search-slack.test.ts` (word forms, phrases, filters, visibility with filters, order and
  its pages, near matches, 100,000 messages), `tests/unit/b-rooms-search.test.ts` ("견적서가" now finds "견적서를"),
  `web/test/e2e/search-message-filters.spec.ts`.
- **Version impact:** server and web together; the API's default order is unchanged, so an older app gets what it got.
