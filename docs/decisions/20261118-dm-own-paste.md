# Your own paste is yours to send

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/dm-own-paste-blocked (the owner, 2026-11-18)

- **Ask:** In a new private AI chat the owner pasted an email they had received and wrote "send this to <teammate> as a
  DM". Trina looked the name up in the rooms list, found the 1:1 chat, and post_to_room refused with
  `answer_share_hidden` ("earlier room answers some people cannot see"). Nothing in the message came from a room.
- **Why it happened:** the `rooms` tool marked the chat `rooms_seen = 1` before it listed the rooms. A list shows room
  names only and adds nothing to the read scope, so the provenance check (chat/answer-share.ts `useOf`) took the chat as
  having read room messages it cannot name (`roomsUnseen`). For such a chat a recipient with an old answer hidden from
  them in ANY room (`room_hidden_answers`, docs/DECISIONS.md "지난 대화") is never sent anything, confirmed or not. The
  teammate had such a row, so every post to them from that chat was refused, and the refusal's "write the message
  without that content" could not work: the check goes by what the chat read, not by the text.
- **Rule 1 (names are not messages):** the `rooms` tool and a "#room" pick in the person's message mark the chat
  `rooms_seen = 2` (chat/read-rooms.ts `ROOM_NAMES_ONLY`) when no room message came in; a search that shows messages
  marks it 1, before the result reaches the AI. Every gate of a read room still applies (the value is true: cards,
  delete_files, remember, the outside mark). Only the provenance checks of a post, a share and a chat's audience
  (`roomMessagesSeen`) do not count names as unnamed room messages. Rooms whose messages were read are in the read scope
  as before.
- **Rule 2 (own paste):** with own_words, a text that is one stretch of one of the person's own messages on the
  answer's branch (author is the person, not auto_sent; "> " quote lines and "#room" titles left out; whitespace
  collapsed, NFC) goes as their own words: the branch's reads are not counted for it (chat/own-paste.ts). What goes is
  that stretch of the person's message itself, never the AI's copy, so spacing or an invisible character the AI put in
  carries nothing. Linked team files in it are still checked (who can open them), and the card is shown as before.
  A word changed or added, two messages stitched, a quote line or an AI answer is not their own and gets the full check.
  Found in the leak review and part of the rule: lines split on "\n" only (a "\r" inside a quoted room message keeps
  the rest of it in the quote); the stretch starts and ends at a word's edge ("approve" out of "do not approve" is
  not theirs); a stretch that shares 8 words in a row with an earlier AI answer on the branch, compared by words so Markdown cannot hide it (or a shorter one
  wholly inside one) is not their own, since the person may have copied what the AI showed them and cannot see what
  is hidden from the recipient; a message the server wrote for the person (onboarding, skill drafts, by its client
  id) is not theirs.
- **Rule 3 (next step):** the `answer_share_hidden` refusal tells the AI the step that works: send the part of the
  person's own message with own_words exactly as written; otherwise say why it was not sent and where it can go.
- **Not changed:** content the AI brought in from a room (room_read, a search, a side chat, a quote) is never sent past
  a member with hidden answers; a confirm still cannot carry it. Rule 2 is for own_words only: the share button (an AI answer) never counts as own words.
- **Left out:** the AI choosing which stretch of the person's text to send is a channel of a few bits at most. A person who pastes room content they can see into their own message chose to send it, as they could in the
  room's composer. Group chat names (names only) can now reach someone without a "conversation" source line; a name
  is not a message. Name matching across scripts ("테스트" for "test") is not added: the AI asked or guessed; a
  transliteration hint in findPeople is possible later.
- **Tests:** tests/unit/b-dm-own-paste.test.ts.
- **Version impact:** server only; no migration (rooms_seen is an integer with no check).
