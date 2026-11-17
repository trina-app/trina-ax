# A plainer "save where more people can see" card

- Date (UTC): 2026-11-17 17:32
- Branch: `fix/save-card-plain`
- Status: in progress
- Where: component B chat (`server/src/chat/turn.ts` askWidening and confirmRoomChange, `server/src/chat/i18n.ts`,
  `server/src/chat/share-words.ts`). Why: the card and its words are built there; the web card already formats a
  detail marked `markdown` (PR #1235).
- Version impact: patch (the same card with fewer words; no new setting, table or screen)

## Goal

QA TC-4815: the AI's wider-audience save card (PR #1232's words) leads with a long paragraph ("Messages from your
conversations (other people's words) came in here, so changes are asked first. This came from … Save it to … (11
people, 8 of them can't see where it came from)?"), repeats the place in an "Action / File" list, counts characters and
shows raw `**`. Give it the treatment PR #1235 gave the send-to-room card.

## Scope

In:
- One plain question with the place and counts ("Save to Sales › Notes › x.md (4 people)? 1 of them can't see the chat
  it came from."), the source with its count on a short second line.
- The "other people's words" reason moves to the small note under the buttons; dropped when every room read is the side
  chat's own room (grant-reads.ts roomsReadOnly, the #1235 server logic).
- The preview of a written file formatted with the shared Markdown renderer (ConfirmDetail.markdown), plain where the
  text has `](`, an autolink, a web address or a long random-looking part, and always plain for an instruction file. No
  character count. The Action row and the File row that repeats the question's place are dropped.

Out: when the card shows, its buttons, Always allow, approvals and grants; the skill save card (its own component and
path: chat/turn.ts confirmSkillWrite with a SkillWritePreview).

## Steps

1. Shared helper for "safe to format" (share-words.ts), used by post-to-room.ts and the save card.
2. i18n in six languages; askWidening's question, note and details; askAlways keeps a card's own note beside the Always
   allow note.
3. Unit tests (wording, same-room rule, preview), decision file, changes fragment, screenshots before/after.
