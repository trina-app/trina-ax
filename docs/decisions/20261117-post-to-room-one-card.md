# A post to a room and the view it gives are one card

- Date: 2026-11-17
- Status: accepted
- Supersedes: for post_to_room only, the "Let them view after a post" button of
  [Who can open this, and one tap](20261116-ai-share-who-can-open.md) when the post's own card is shown
- Branch: fix/post-to-room-one-card (the owner; real-AI flow FL-08 step 1, 2026-11-17)

Where: component B chat tools (`server/src/chat/post-to-room.ts`, `server/src/chat/share-next-steps.ts`) and the
offers store (`server/src/files/share-fixes.ts`), because the card and the offer both live there.

- **Ask:** in default mode (Always allow off) one post of a file to a team room showed two confirmations for one
  action: the room card ("라마바카페 건(3명)에 보낼까요?") and then a "Let them view" button for the same file and the same
  two people. The owner's top complaint is the number of cards. One card should say what will happen.
- **Rule:** when the post links a file (or used a file as a source) that the person may share and that some people in
  the room cannot open, the option whose yes gives them access says so on itself: "Send (2 people can then open
  Quote.pdf)" (`postRoomOptView`, `postRoomOptViewMore` for several files). Only the options that grant carry it, never
  a sentence above them: [파일도 함께 보내기] sends copies, so it grants only files that do not go as copies and usually
  says nothing; "Always allow" answers as [파일도 함께 보내기] when that is offered, else as [보내기], and carries that
  choice's words. [보내기] posts and then gives exactly those people view access to exactly those files. The card's
  "N people can't open" line no longer counts the people the yes lets in (a guest, never given a file, still counts), and
  its "With the files:" line compares only what each choice leaves unseen, so it no longer contradicts the options
  (coordinator review of the first build: "3 people there will be able to open X" above "With the files, everyone there
  can see it" did not say which button granted).
- **What the card shows comes from the server:** the count, the file name and the room are worked out from the room's
  members, the file's access and the person's right to share it (`ShareFixes.viewPlan`, the same rules as the button),
  never from the AI's text. The card goes to the asker alone (in a shared chat too) and names nobody; the step that shows
  the result ("2 people can now view Quote.pdf") is the asker's only, as before.
- **The yes is the widening's confirmation:** the view is given only when this card was shown and answered with
  [보내기] or [파일도 함께 보내기] (or "Always allow" pressed on it). The explicit-ask skip and the "allowed earlier in this
  chat" repeat never apply to a post that would give a view: such a post always shows its card.
- **Always allow stays final (Rule A, #1143):** with "Always allow" on, the post goes without a card as before and
  nothing is shared by itself; the "Let them view" button stays under the answer. A new 1:1 chat (made only on the yes)
  also keeps the button, since nobody can be counted before it exists.
- **Order and failures:** the post goes first, then the grant (granting first would change the room check's key and
  make the post ask again).
  - The post fails or is refused (someone joined while the card waited, the person lost access, the sending limit):
    nothing is posted and nothing is shared.
  - The post went and the grant fails (the person may no longer share it, the team turned off members' sharing while
    the card waited), reaches nobody, or stops part-way through several files: the post stays, the AI is told that some
    or all of them cannot open it yet, and the button comes back under the answer for whoever still cannot open it. The
    offer the card made is deleted.
  - The grant runs as the tap does (`ShareFixes.run`): checked again now, only people still in the room who still
    cannot open the file, never a guest or someone who joined since, audited `file.share` with `via: 'ai'`.
- **Why:** the precedent is #1168, which made stamp_pdf's room card and its "more people can see" card one card. Here
  the second confirmation came after the action instead of before it, so the merge moves it into the one card and runs
  it on that card's yes.
- **Left out:** the provenance line ("N people can't see some of the sources") is unchanged, since a source can be a
  conversation or a service that no grant covers. "Ask <owner>" (someone else's file) stays a button after the post: it
  asks the owner, it does not widen anything by itself.
- **Tests:** `tests/unit/c-who-can-open.test.ts` (one card, one yes, both effects; no; Always allow; a grant that fails
  after the post; someone who joins while the card waits; the button's own rules), `tests/unit/b-post-to-room.test.ts`
  (the card's words).
- **Version impact:** patch (one card fewer; no new screen, setting or table).
