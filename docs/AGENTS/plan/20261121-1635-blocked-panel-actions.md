# Blocked file panel: no file actions, no path (follow-up to #207)

- Date (UTC): 2026-11-21
- Branch: `fix/blocked-panel-actions`
- Status: in progress
- Where: `web/src/components/FilePanel.tsx`, `web/test/e2e/share-chat-files.spec.ts`, a `changes/` note.
- Version impact: **patch**: a UI fix, no API or data change.

## Goal

QA on qa.trina.app (2026-11-21): in a chat shared with people, a member opens a file link that only the chat's
creator can add ("Only QA Admin can add this file to the chat" with [Ask to add it]). The panel header still showed
"Show in Files", a dead end that hints at a place they cannot open.

When the panel's file does not open for me (the server's `not_found`, which it answers alike for "gone" and "not
yours": the "ask to add" state and the generic "can't be found, or you don't have access" line), the header keeps only
the file's name and Close:

- no "Show in Files" (icon and the phone's ⋯ item), no Share, no Expand, no ⋯ menu at all;
- download, Ask Trina, add to chat, Save PDF and Edit were already hidden for that state; they stay hidden;
- the title's tooltip shows the name only (it showed the full path) and the title is not draggable into a chat.

## Scope

In: `FilePanel.tsx` header, the blocked-panel e2e at 1440 and 390, before/after screenshots from the local mock.
Out: other error kinds (too large, busy, network): the file is there and the actions can work.

## Steps

1. Plan and `changes/` note (first commit).
2. `FilePanel.tsx`: one `noAccess` flag gates "open in Files", Share, Expand and the title's path and drag.
3. Extend `share-chat-files.spec.ts` (blocked panel: no Show in Files, download, Ask Trina, ⋯, path in the title).
4. typecheck, check:prepush, that e2e; PR to `dev`, not queued.
