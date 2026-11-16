# Share, room-post and attach gates count file and web content written by others

- Date (UTC): 2026-11-16 12:04
- Branch: `batch/prompts-1116` (PR #1109; QA rows in the PR)
- Status: done
- Where: trina-ax core (`server/src/chat/`, `server/src/integrations/connections/tools.ts`, one migration). Why: the
  cards and "Always allow" are core.
- Version impact: patch. One additive column.

## Goal

The batch brings "Always allow" to the share card and the room post card with files (#1095), no card after an explicit
ask (#1097), a team file attached to a connected service's send (#1103) and the recipient's AI reading a file shared
with them (#1080). Together they need one more rule: what counts as "other people's words" for these gates. Until now
it was other people's messages (a shared chat, a room read, a quote). Content the AI reads (a teammate's team file, a
file shared with the person, a web page, a connected service's answer) was not counted.

## Scope

In:

- One mark per chat (`chats.others_words`, migration 412): set when content someone other than the chat's person wrote
  comes in. Kept until the chat's session starts anew, as the other marks.
- share_with_person, post_to_room (the place, and the linked files of the files card), a team file attached to a
  connection's send, change_project_members: in a chat with the mark (or one that read rooms), the person's "Always
  allow" counts only for what their own message of this turn names. Otherwise the card shows, without "Always allow".
- A file read through a share grant counts as a room read for the rest of the chat (`chats.rooms_seen`), so every gate
  of a room read applies; a scheduled run does not read through a grant.
- The clean cases stay card-free: an explicit ask, a chat that read only the person's own files, a target and file the
  person named.

Out: file and folder names shown by a listing; the content of a file the AI makes in the answer; the room card after
a room read (the person's "Always allow" for it stays as the owner decided on 2026-11-13).

## Steps

1. Tests that show the gap (tests/unit/b-others-words-gates.test.ts). 2. The mark and the gates. 3. Tests for the
clean cases, the scheduled run, the attach path. 4. Decision notes, changes fragment. 5. Checks, independent review.

## Result

See docs/decisions/20261116-always-allow-more-cards.md "Content written by others".
