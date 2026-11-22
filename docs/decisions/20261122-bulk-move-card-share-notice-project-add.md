# Many moves where others look ask once; a Send with copies grants no source file

- Date: 2026-11-22
- Status: accepted
- Supersedes: for a Send that carries copies only, the "or used a file as a source" part of
  [A post to a room and the view it gives are one card](20261117-post-to-room-one-card.md)
- Branch: fix/bulk-move-card-share-notice-project-add (claude-code scenario rerun, QA TC-r2u-25, TC-r2u-29, TC-r2u-03)

Where: the AI's file tools (`server/src/tools/file-moves.ts`), post_to_room (`server/src/chat/post-to-room.ts`,
`server/src/chat/share-next-steps.ts`) and project joins (`server/src/chat/project-joins.ts`).

- **Ask (TC-r2u-25, S-122):** asked to sort a shared folder (18 people see it) into date folders, the AI renamed and
  moved all 15 files with no card. move_files asked only when someone's access changed; renames never asked.
- **Rule:** past 3 items in one answer, moved or renamed where someone other than the person can read them, the server
  asks once on its own card that lists them (old name → new name, or the names and the target folder). A yes covers
  the rest of that answer. The person's own "Always allow" for moves (kind `move_files`) goes without the card (Rule A,
  [20261116-always-allow-final-rule-a.md](20261116-always-allow-final-rule-a.md) stays final). Not asked: a call with
  nobody to ask (a scheduled task the person set up, a call outside a chat), a call the room card already asked for
  (a chat that read rooms), copies (the originals stay). When the move's own "who can see it" card shows, it carries
  the same line and stands for this card.
- **Ask (TC-r2u-29):** after a quote was posted, the room got "박준호 shared 명함.jpg"; after a chart, "김민지 shared
  index.html". The posted file went as a copy (no share, no share notice); Send also gave view access to the copy's
  sources (what the chat that made it read), which the card never named.
- **Rule:** a Send that carries copies grants view only on linked files that do not go as copies, never on source
  files. The card keeps its "N people can't see some sources" line for them, and the "Let them view" button after the
  post offers them, by name, as before. A Send with no copies is unchanged.
- **Ask (TC-r2u-03):** people added to a project got no notice; only the members who were there already heard "X
  joined".
- **Rule:** the person who starts to see a project because someone else changed it (members, a group, a rule) gets a
  `project.joined` notice of their own, "<actor> added you to '<project>'", on the same audit row; not for their own
  change, a change nobody made, or a new or re-enabled account. Shown always, never pushed, like `project.joined`.
- **Why:** one card for many changes is the owner's lean-card rule (one card per action, Always allow final); a share
  the person never saw named on the card is the kind of surprise the share notices exist to prevent.
- **Tests:** `tests/unit/c-file-moves.test.ts` (many moves and renames), `tests/unit/b-post-to-room.test.ts` (a Send
  with copies shares no source file), `tests/unit/b-project-members-only.test.ts` and
  `web/test/unit/inbox-notice-rows.test.tsx` (the added-you notice).
- **Version impact:** patch (one card in one case, one notice more, a narrower grant; no new setting, table or route).
