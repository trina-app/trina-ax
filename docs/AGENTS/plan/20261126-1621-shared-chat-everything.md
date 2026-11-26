# Shared chats: everything a private chat does, behind the one notice or the read card

- Date (UTC): 2026-11-26 16:21
- Branch: `feat/shared-chat-everything`
- Status: in progress
- Where: server (chat tools, turn, prompt, routes), docs. Why: the owner (11-26, "다 되는거 아니야?"): in a shared chat
  the asker's AI does everything it does in a private chat; where other people would see something they cannot open,
  the one-time notice or the read card asks the asker first. No blanket offs.
- Version impact: minor (shared chats gain tools that were off there; nothing is removed)

## Goal

After #647 (own connections, browser, team-file attachments) and #652 (browser file upload), the remaining blanket
offs in shared chats go. Each lifted tool runs for the asker's own request with the asker's own access, exactly as in
their own chat, with one of three existing guards: the tool's own card (changes), the shared chat's read card (a place
some people here cannot open), or the once-per-place notice (the asker's own connected services).

## Scope

In (numbers as in the owner's brief):
1. set_title in shared chats.
2. move_skill (list, move, rename, copy) behind its own card.
3. Google Drive tools and save_connector_file `drive:`: the once-per-place notice; what comes back joins the answer's
   read record as the asker's own (or the team Drive share's people).
4. Slack reading: the same notice; the Slack place joins the read record.
5. connect_service: offered (the sign-in is on the asker's own card).
6. shared_with_me, looking_at, my_folders, and reads of files shared with the asker one by one (grantReads): offered;
   what they show goes through the read card (a file or place someone here cannot open).
7. rooms, room_read, room_file, save_room_file: offered; what a call found joins the read card first when someone here
   is not in that room.
8. delete_files: the normal card for any file the asker may delete (as in their own chat).
9. change_project_members, change_folder_access, skill_files: offered with their normal card (Always still skips it).
10. An upload attached before the chat was shared: a reference behind the read card (project chat) or a copy kept with
    the chat (chat shared with people), as a team file of the sender's own folder is today.
11. The situation block, the model-pick hint and the person's "earlier yes" approvals (card-approvals) in shared chats.
Kept (owner decisions): other chats' memories, guest-only limits, the personal-skill copy check, scheduled-run place
skipping, the dev environment's own-folder/login limit.

Out: nothing else.

## Steps

1. rooms/ai-tools.ts: the tools above join SHARED_TOOLS; SHARED_UNDER_ALWAYS goes.
2. The *Off()/refusal functions lose their shared and "others wrote here" lines (delete_files, project members, folder
   access, shared_with_me, looking_at, my_folders); results that list places go through TurnExec.confirmSharedRead with
   the places they name.
3. chat/tools.ts: room tools in shared chats, gated by the read card on what each call found (a project chat's own
   room keeps its no-card scoped tools); Slack provider in shared chats with the notice; Drive tools behind the notice.
4. tools/drive.ts: a shared chat's turn is its turn (turnChat), the source exported for the notice.
5. chat/browser-notice.ts: the kept notice for Drive and Slack beside the browser's (same table, Settings lists them).
6. turn.ts: grantReads, situation and approvals in shared chats; sharedSources counts a file opened through a grant.
7. routes/chats.ts: an upload of this chat becomes a team reference of its file in a shared chat.
8. prompt.ts: the "not available here" list keeps only what is still true (guests).
9. Docs, changes/, ASKS.md, decision file. Tests.

## Decisions

docs/decisions/20261126-shared-chat-everything.md (replaces the shared-chat exclusions in SHARED_TOOLS's comment,
20261123-ask-registry-findings.md decisions 1 and 2 "only under Always", and the rooms/Drive/connect lines of
20261118-shared-chat-connections.md).

## Risks

- Another member's message must never drive the asker's tools: each turn is its sender's; changes keep their cards.
- A place some people here cannot open must never reach the chat without the asker's yes: every lifted read goes
  through confirmSharedRead or confirmSharedConnection.
- Overlap with #652 (prompt.ts, tools.ts, turn.ts, docs pages): small hunks, rebased onto dev.

## Tests

Per item: the asker can; a turn by another member uses only their own access; the read card or notice shows when
someone here cannot open what comes back. Bun 1.3.12 unit tests of the areas, typecheck, check:prepush, tests/security.

## Result

(filled in at the end)
