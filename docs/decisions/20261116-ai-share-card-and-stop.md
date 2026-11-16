# One card for a share, and the owner can always stop sharing

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (narrows two points of "A member shares their own files" in the archive: the AI's share result was
  links written as prose, and a member could not take people off their own file while the team's switch was off)
- Branch: feat/ai-share-card-and-stop (the owner's AI sharing plan of 2026-11-16; QA "Manual AI tests" MAN-011, MAN-012,
  MAN-017; QA group "B. One card + stop sharing")

- **Ask:** Hands-on tests failed on sharing: "stop sharing this" got "I can't take that access away", and a share came
  back as a long answer with links and folder paths. The owner's rule: you decide who sees what you made, and you can
  change your mind any time.

- **Rule 1, the owner can always stop.** Whoever owns a file may take people and groups off their own share
  (`FileShares.change` with nothing to add), also while **Members can share files they own** is off and after they lost
  edit access to the file. Adding stays as it was: edit access now, and for a member the switch on. A call that adds and
  removes at once is an add. `GET /api/files/shares` says `canStop`; the Share dialog keeps ✕ for it. Team owner and
  admins: any team file, as before. Why: with the switch off the person who shared a file was the one person who
  could not end it, and "an owner who lost edit access" still has grants that come back when the access does.

- **Rule 2, `stop_sharing` is a tool of its own.** Not a `remove` list on `share_with_person`: each tool then has one
  verb and the same two fields, the model has no mode to get wrong, and a mistaken call can only take access away. It
  matches people only among those already on the files (it never lists teammates). With `people` left out it takes
  everyone off. Off wherever `share_with_person` is off, and in every scheduled run (nobody watches its Undo). Main AI
  only. Audited as `file.unshare` with via `ai`.

- **Rule 3, a stop needs no card when the person named it.** It only narrows and its result has Undo, so it runs at
  once when the asker's own message of this turn (quoted lines left out, no "don't") names every file, and every
  person when people were given. Otherwise the asker gets one card. In a chat other people write in, or one that read
  a room, each file must be one the asker named or attached in their own message (the share tool's rule, without "the
  AI made it in this answer"). In any chat that holds other people's words (`othersWordsIn`: those chats, and one marked
  `chats.others_words` after reading content someone else wrote) the message must name the file and every person:
  "everyone on it" is not a name there, so a stop with nobody named asks. The naming check is the share tool's
  explicit-ask check (`namedInFull`, the file named or attached, quoted lines left out); no second mark. A share keeps its card as decided in
  [No card right after an explicit ask](20261116-no-card-after-explicit-ask.md) and "Always allow".

- **Rule 4, one card, made from the server's record.** The tool's step keeps what was done (`Step.shared`,
  `shared/src/api/share-card.ts`): the files by link id with their names and their places in words
  (`chat/place-words.ts`, never a path), whose they are when not the asker's, who was added or taken off, the level
  (view), who got a notice, after a stop who can still open a file and through what (the folder's rules, a group still
  on it, the whole team: `FileShares.stillOpens`), a refusal's reason, and the next step as data. The confirmation card
  carries the same rows (`AskUserRequest.share`), so the card that asked turns into the card that says what was done,
  in the same place and box. Nothing on either card comes from the AI's words or a file's content. One button:
  **Manage access** after a share (the file's Share dialog), **Undo** after a stop (the same people added again through
  `PUT /api/files/shares` as the viewer, with that endpoint's own rules). The app reads what is true now for the button
  as the viewer (`POST /api/files/shares/cards`, by link id; anything the folder rules do not let them read is `gone`).
  Several files are one card. A refusal or a partial result is the same card; its button comes from a registry
  (`registerShareNext`) so another change can add "Ask Mina" without touching the card.

- **Rule 5, the record is the asker's alone.** In a chat other people see, `ChatStore.viewSteps` leaves `Step.shared`
  out for everyone but the person whose turn it was (they see the step's verb, as before). The card is drawn from the
  step, so it is in no room post, export, search index or "Often asked" (those copy an answer's text).

- **Rule 6, the AI says one sentence.** The tools return no links any more; their result and the prompt tell the AI
  that the card shows the files, places and people, and to answer in one short sentence.

- **Rule 7, the person taken off is told on the link page, not by a notice.** `file_share_stops` (migration 358) keeps
  who took whom off while they stay off. The link page then says "<name> stopped sharing this file" in place of "You
  need access" (still nothing about the file; asking again stays). No Activity notice and no push: a stop is not news
  the owner wants sent. Shared with me drops the file as before.

- **Left out:** folder sharing, edit rights, the "who can open this" tool and the next-step buttons' actions, a stop of
  a share made through a folder rule or a group's membership (the card only says it is still open that way).

- **Tests:** `tests/unit/c-file-share-stop.test.ts` (owner stop with the switch off and without edit access, adding
  still refused, who may not, the link page line, `stillOpens`, the cards endpoint),
  `tests/unit/b-stop-sharing.test.ts` (the tool: explicit ask, the card, refusals as records, a shared chat's viewer,
  another member's message, where it is off), `tests/unit/b-share-with-person.test.ts` (the record, no links, the other
  viewer), `web/test/unit/share-card.test.tsx`, `web/test/e2e/share-card.spec.ts`.

- **Version impact:** minor (a new tool and step field; migration 358 is additive, reader 1).
