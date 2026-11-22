# A shared chat's copied files: every path to the original means the chat's copy

- Date (UTC): 2026-11-22 05:03
- Branch: `fix/shared-chat-copy-paths`
- Status: in progress
- Where: server/src/chat, server/src/mcp, web/src/components/chat. Why: a gap left by #320 (QA TC-v1b-*, QA-D flow 4,
  TC-v1d-02)
- Version impact: patch (a fix of shared-chat file edits and the share dialog's default, no new feature)

## Goal

박준호 makes a quote PDF in his own chat (saved in users/junho/…), shares the chat with 김민지 "with files": the chat gets a
copy (`origin: 'shared-copy'`, `from` = the original path). Today the answer's text still names users/junho/…. When
김민지 asks her AI to change the quote, the AI follows that path, cannot open it and makes a separate new file
(`_할인적용.pdf`) instead of a new version of the chat's copy. It is flaky: it depends on whether the model reads the
`<chat_files>` note ("a link above to a file of the same name opens this copy") and switches to chat_file.

Root cause (checked):
1. #320 never rewrites links: the stored text keeps the original path; the web maps it to the copy only for the
   creator (`from` is stripped for everyone else, `copyForViewer`) and for others through the side panel's
   file-access fallback (copyOf).
2. Tools: the resolver (files/places.ts) maps a team path to a chat file never (plan 20261121-0615 rule 7). A path
   in users/junho/ is a team path for 김민지's turn: read and edit are denied, so the AI makes a new file.
3. Context: the transcript (chat/shared.ts labelledTranscript) gives the answer text with the original path and a
   note by name only (prompt-only).

## Scope

In:
1. `sharedCopyMap(ctx, chatId, viewer)` (chat/chat-files-share.ts): the chat's copies by the path they were copied from
   (newest copy of each path), leaving out a copy on an answer hidden from the viewer (same rule as copyOf).
2. Tools, deterministic: a new TurnToolSet hook `mapPaths(name, args, agent)` that mcp/protocol.ts callTool runs first
   on every tool call of a chat turn. In a chat shared with people (not a project chat), for the main AI only, each
   path argument (rooms/ai-tools.ts namedPaths keys, top level and arrays, edit_pdf's nested files) that names a
   copied original (trimmed, NFC, no leading "/" or "./") becomes the copy's chat place path
   `chat:files/<id>/<name>`. Everything after that (read, edit, write, edit_office, edit_pdf, the version rules,
   cards) is the existing chat-file path: an edit by anyone is a new version of the copy (putVersion), and the original
   is never opened. For everyone in the chat, the creator too (one file, not two, as the web already does for them).
   A sub-agent keeps its paths (it has no chat places; the creator's sub-agent still reads its own file).
3. Context, deterministic: the transcript of a shared chat replaces, in each answer's text that the runner sees, every
   occurrence of a copied original path (as written, and URL-encoded) with the copy's chat place path. The
   `<chat_files>` note names that path too. Never more of the original than the text already showed.
4. Share dialog (TC-v1d-02): "Share the files too" is ticked by default when every listed file is safe (no file marked
   private and no warnPicks in the check); unticked by default (the #320 rule) otherwise. A person's own tick or untick
   wins until the picks change. #322's one box and one button stay.

Out: rewriting the stored answer text; a web map of paths for people other than the creator (their links already
open the copy through the file-access lookup); room messages.

## Steps

1. sharedCopyMap + tests.
2. mapPaths hook (chat/tools.ts, turns.ts, mcp/protocol.ts) + tests: private PDF, share with files, another member's
   AI edits by the original path → a version of the copy; the original's bytes and file events unchanged.
3. Transcript rewrite + tests.
4. Share dialog default + web tests (safe → ticked; private or warnPicks → unticked).
5. typecheck, check:prepush, area tests (Bun 1.3.12); a real UI run of S-002 three times on a new QA copy.

## Decisions

- Rule 7 of plan 20261121-0615 ("the resolver never maps a team path to chat:files/") is narrowed: the mapping is not
  in the resolver but in one pre-call step, only for paths recorded as copied into this chat (`from` of a
  'shared-copy' attachment), only in a chat shared with people, only for the main AI. Every other team path keeps its
  team handling ("not found" for what the person cannot open).

## Result

(filled in at the end)
