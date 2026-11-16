# Sharing through the AI: a refusal names the next step, a card names no path

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (it extends "Refusals say why, who and what next" and "Plain words in errors, cards and steps" in the
  archive to the share and post tools)
- Branch: feat/ai-share-words (the owner's "AI sharing" plan of 2026-11-16, part 1; QA "Manual AI tests" MAN-013, MAN-015)

Plan: `docs/AGENTS/plan/20261116-1500-ai-share-words.md`.

- **Ask:** a teammate's hands-on tests of sharing through the AI failed on words, not on rules. Asked to put a file in a
  room, the AI pasted the file's text (nothing told it that a link in `text` sends the file). Asked to "reply to that
  thread", it picked one. Cards and questions showed folder paths. A refusal ended with "can't": "Folders can't be
  shared", "only its owner can share it".
- **Rule 1, a refusal names the next step.** Every refusal the AI gets from `share_with_person` and `post_to_room` says
  why in plain words and ends with `Next step:`, the sentence to pass on and the offer to make
  (`server/src/chat/share-words.ts` `SHARE_NO`, `POST_NO`). The instructions say the same in one line
  (`REFUSAL_NEXT_RULE`). What is refused does not change.
  - Someone else's file: "it is Mina's file, so only Mina can add people"; the offer is a short message to Mina with the
    file's link. The owner's name goes to the AI only in the person's own chat (the Share dialog shows it to anyone who
    can open the file); a shared chat gets "someone else's file".
  - The team's switch for members is off: who can turn it on (the team owner or an admin, Admin, team settings), or that
    the person can do it themselves when they are one.
  - A folder: "I can't share the whole folder yet, but I can share the N files in it", with the files right in the
    folder that the person can share now (each checked by the Share dialog's own check, `FileShares.view`; at most 10
    listed, subfolders and hidden files left out). For a team folder it also says the truth the old text hid: the team
    owner or an admin shares a team folder with Share on the folder in Files. In a shared chat nothing of the folder is
    listed.
  - Nobody by that name (a guest, a person outside the team and a group the person is not in still read the same, on
    purpose): who files can be shared with, and what works for a guest (posting the file to a chat they are in).
  - A room that is not found: the AI calls `rooms` and offers the two or three closest. The room list is not put into
    the refusal itself: room names are other people's words, and they enter a chat only through the room tools, which
    mark the chat as having read rooms.
  - The person already has access: the share's result says so (`already_had_access`) and the AI says it; not a refusal.
  - A service that is not connected (Gmail) in an own chat: say so, show the connect card or the screen, offer a draft.
- **Rule 2, a file goes to a room as a file.** `post_to_room`'s description and the instructions say: link the file in
  `text` with one short line, never paste its content, no `own_words` (the card then offers "Send with the files").
- **Rule 3, "that thread" is asked about.** With no thread named or quoted, the AI reads the room and asks, offering two
  or three by who wrote it and its first words. Never the newest by guess. In a room's side chat the quoted message's
  thread stays the target, as before.
- **Rule 4, several files of one name.** The one made, read or attached in this chat, or the only one the person may
  share, is used without asking, and the AI says which. Otherwise it asks; each choice has the name, the place in words
  and, for a shared file, who shared it and when.
- **Rule 5, no path on a card.** The link rule covered "your answer"; `CARD_WORDS_RULE` extends it to a card's question
  and options. The server also does it: an `ask_user` option whose label is a team path (or holds one in backticks) is
  shown in place words (`placeWords`); the value the AI gets back is unchanged. Two options never read the same: a label
  that words would make equal to another keeps what the AI wrote. The file lists on the share card and the post card
  ("Attached with Send with the files") are the place in words ending in the file's name ("My folder › Work ›
  Quote.pdf"), so two files of one name read differently; the post card listed team paths before, the share card bare
  names.
- **Card text.** The thread quote in the post card's title loses its Markdown marks. The share card says "They can only
  view it" for one file and "them" for several, in six languages (two texts, picked by the count: Korean, Indonesian,
  Japanese and Chinese do not change with the number).
- **Comments under an answer.** In a shared chat the AI is told that comments exist, that it cannot read them, and that
  "Send to Trina" in the thread brings them to it. It still does not read threads
  (`20261116-chat-answer-threads.md`).
- **Left out:** buttons under a refusal (Ask Mina, Share N files), stop sharing, "who can open this", folder sharing:
  other parts of the plan. The step line of an `ask_user` answer still shows the value the AI gave.
- **Tests:** `tests/unit/b-ai-share-words.test.ts` (each rule, where it is in the instructions, each refusal, place
  words, the cards through the scripted engine), and the changed lines of `b-share-with-person.test.ts` and
  `b-post-to-room.test.ts`. Real AI on a private copy of the QA team: MAN-013, MAN-015, same-name files, a folder,
  someone else's file (results in the plan).
- **Version impact:** patch (wording; no tool, schema or permission change).
