# The send-to-room card: one line, who can't open the file, Send and Don't send

- Date: 2026-11-17
- Status: accepted
- Supersedes: for post_to_room's card only, the options of [A post to a room and the view it gives are one
  card](20261117-post-to-room-one-card.md) ("Send (2 people can then open Quote.pdf)" next to [파일도 함께 보내기], and
  "the card names nobody"); the room post card's "Always send with the files" wording of [Always allow on the share, web
  address and room-post-with-files cards](20261116-always-allow-more-cards.md) (the kind `post_files` and what it does
  stay)
- Branch: fix/send-to-room-card (QA TC-4791; manual AI tests MAN-013, 014, 015, 033)

- **Ask:** when the AI in a side chat posts to a room, the card read "Send this to General (3 people)? 2 people can't
  open 1 linked file. With the files, everyone there can see it…", the message had a size ("87 characters"), four radio
  choices (Send / Send with the files / Always send with the files / Don't send), "Messages from your conversations
  (other people's words) came in here…" even when the only conversation read was the one posted to, and the preview
  showed raw `**`. Office workers had to work out which choice let whom open what.
- **Rule (the card's words):**
  - One line: "Send to General (3 people)?" (the thread and new 1:1 chat lines alike).
  - When Send lets people open a file they cannot open now: "Maria and Tom can't open the file yet; sending shares it
    with them" (`postRoomShareWith`). People still left out after Send (a guest, never given a file; someone else's
    file that does not go as a copy): "Gus can't open the linked file" (`postRoomFilesWho`). Up to three names, then
    "Maria, Tom, and 3 others" (`peopleWords`). The names come from the server's records of the room, the files and
    their access (the same rows and `ShareFixes.viewPlan` as before), never from the AI. The card goes to the asker alone
    (also in a shared chat), who can see the room's people anyway; the AI's result still names nobody.
  - The provenance line ("N people there can't see some of the sources") and "Everyone in this conversation will see
    it, including people who join later" stay where they apply: they say something the person could not know.
  - The message is formatted with the chat's Markdown renderer (`ConfirmDetail.markdown`), with no size. A text with a
    web address or a long random-looking part stays as written, its marks highlighted: a formatted link shows its words
    and hides where it goes. The note is formatted the same way.
- **Rule (the choices):** Send and Don't send. Send is the choice that leaves the fewest people out: with the linked
  files as copies when they can go (the old [파일도 함께 보내기]), plus the view the card grants for the person's own
  files that do not go as copies (own words, a file too big to copy). Its yes is bound to the key of what the card
  showed for that choice, checked again on the yes, exactly as before (a change while it waited asks again). The old
  link-only Send is gone from this card; the step's "Let them view" / "Ask <owner>" buttons after a post stay.
- **"Always allow": kept.** The owner's rule is that every card offers it on its first showing and that it is final
  (docs/DECISIONS.md "Always allow on every card", [Rule A](20261116-always-allow-final-rule-a.md)). Every other server
  card shows it the same way: the quiet middle button between the main one and the "no", with its note under them
  (`withAlways`). This card now does too, labelled "Always allow" like the others (not "Always send with the files").
  It answers as Send this time; the kinds `post_to_room` and `post_files` stay apart, so a choice on one never makes the
  other send more than the person picked. Where the choice does not count (a shared chat without the asker's own ask) it
  is not offered, as before.
- **The reason line moves; the protection does not.** "Messages from your conversations (other people's words) came
  in here, so changes are asked first" (and the shared-file and other-people's-words variants) moves from above the
  question to the small line under the buttons (the card's `note`, with what Always allow covers). The card still shows
  in every case it showed before: the explicit-ask skip, the per-chat approval and Always allow are unchanged.
- **No reason line when every room read is the one posted to** (`grant-reads.ts roomsReadOnly`, server logic): the
  chat's read scope names no other room, no other chat or Slack source, nothing read through a share grant; its side
  chat's room, if any, is that room; a quoted message counts only in that room's side chat. Not in a shared chat or a
  chat others write in. False on any doubt. The provenance line is not changed by this: it counts people who truly
  cannot see a source (someone who joined after the messages read), which is still worth saying.
- **Why:** the owner's rule for cards is fewer and plainer (lean UI = remove, not add), and FL-14/FL-27 counted this
  card as heavy. One question, one fact about the file in plain words, and the two buttons every other card has.
- **Left out:** the save card and its logic (another branch); when the card shows at all.
- **Tests:** `tests/unit/b-post-to-room.test.ts` ("the card's words (QA TC-4791)": same-room sources, another room or a
  quote keeps the line, names), `tests/unit/c-who-can-open.test.ts` (Send's yes grants and names who),
  `web/test/unit/ask-card-details.test.tsx` (the formatted message), `web/test/e2e/post-to-room-card.spec.ts`.
- **Version impact:** patch (the same card with fewer words and choices).
