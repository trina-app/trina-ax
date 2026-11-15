# Stored connection keys never reach the files the AI saves, nor the live answer in an encoded form

- Date (UTC): 2026-11-15 12:58
- Branch: `fix/files-hide-keys`
- Status: in progress
- Where: server/src/integrations/connections (redactor), server/src/mcp/protocol.ts and server/src/chat/tools.ts (the
  turn's tool calls). Why: what the AI saves is server work (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no new feature or API change

## Goal

QA TC-3041: a member gives the AI their connection key and asks for documents. The answer and the steps say
[hidden key], but every file the AI made holds the key itself: Word, PDF, Hangul and Markdown files, a filled Hangul
form, an artifact, and so the search's text cache and the owner's export. QA TC-2981 (the rest): while a turn waits on a
card, the base64 form of the key shows in the live answer and the messages API, until the whole answer is checked at
the end.

## Scope

In:
- One place for every tool call of a chat turn (mcp/protocol.ts, before any check, card or write): the tools that save
  what the AI gives them get it through the turn's redactor (redact.ts, the one the answer and steps use):
  make_file (content, output), write (content, path), edit and edit_files (new text), edit_hwp (replacements, cell and
  row values, output), artifact (content, title, key, edit text), rename_file / move_files / copy_files (new names and
  folders), save_url / save_room_file (save path), generate_video (description and path), promo_video and intro_deck
  (their slot text).
- What the person already has is not changed: text a tool only finds by (edit's old text, edit_hwp's find and label
  cells, an artifact edit's old text) is left, a replacement keeps a key the replaced text already holds, and write
  keeps a key the file it overwrites already holds. Paths a tool only reads (make_file's source and template) are left.
- The AI is told after the call that the key was saved as [hidden key], so what it says is true (edit_hwp's result
  already shows the hidden value).
- The live answer: the end of the text that could be part of an encoded form of a key (base64, %, JSON or HTML escapes)
  waits for the next piece, as the plain key already does.
- Already covered, checked: remember, schedule_create, post_to_room, answer shares, chat titles.

Out:
- Files the AI saved before this fix, and files the person uploaded, are not rewritten.
- box_shell (developer environment commands) runs the command as given; its shown command is already hidden.
- A file made from an existing team file (make_file `source`) is a copy of that file.

## Steps

1. Plan (this commit).
2. hide-args.ts and the hook in mcp/protocol.ts / chat/tools.ts; redact.ts formCarryLength.
3. Unit tests that fail without the fix (tests/unit/c-integrations-secret-files.test.ts).
4. Hands-on on a local server with fake data: open the files, screenshots at 1440 and 390.

## Risks

No migration, no UI text. Plain-words check: the only mark is the existing "[hidden key]". The live answer holds back
the last word or code-like run (at most a few hundred characters) a moment longer for people with a stored key.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit a-*, b-*, c-*, i-*, mcp-*, sec-*.

## Result

Filled in at the end.
