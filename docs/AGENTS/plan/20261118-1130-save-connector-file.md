# Save the original of a Gmail attachment or a Google Drive file (save_connector_file)

- Date (UTC): 2026-11-18
- Branch: `fix/audit2-conv-connectors`
- Status: done
- Where: server (tools, Google Drive and Google apps integrations, connection media). Why: AI tools and connections
  are Team AX core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new AI tool

## Goal

Limits audit 2, N17 + N18 (QA TC-4927): a Gmail attachment reached the AI only as text (Word, Excel and Hangul files
had no way to be kept except retyping their text; only PDFs and pictures could be saved with save_url), and a Google
Drive file could not be copied into the team folder at all. Claude Code would just copy the file. The AI should save
the original bytes through the normal save path.

## Scope

In: one tool `save_connector_file` (`mcp-file:<id>` handles and `drive:<file id>`), every Gmail attachment kept as a
handle, Drive downloads of the original (Google formats exported as Office files), the save rules of save_url and
save_room_file, the room card's words, step label, tool lists, tests, a decision file and a changes note.
Out: OCR, Drive `offset` paging, raising any size cap, Drive in shared chats (still not offered there).

## Steps

1. `connections/media.ts`: a kept item may carry the file's name.
2. `google-apps/attachments.ts`: keep every attachment (not only PDFs and pictures), name the handle and the tool.
3. `google-drive/read.ts`: `fetchDrive` shared by drive_read and `driveOriginal` (exports .docx/.xlsx/.pptx).
4. `tools/drive.ts`: `withDrive` (source, lock, fence, read record) used by drive_* and the save.
5. `tools/save-connector-file.ts` + registration in `tools/index.ts`; SHARED_TOOLS (handles only); turn.ts room card.
6. Tests: `tests/unit/save-connector-file.test.ts`; tool lists in c-tools, i-wiring, b-browser, step-labels-tools.

## Decisions

docs/decisions/20261118-save-connector-file.md
