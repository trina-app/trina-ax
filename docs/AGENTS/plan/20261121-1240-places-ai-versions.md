# The AI changes a chat file by saving a new version of it (P4-AI)

- Date (UTC): 2026-11-21 12:40
- Branch: `feat/places-ai-versions` (off `batch/20261121-places` 4bf6f1a9e, PR #230; rebased on `dev` once #230 is in)
- Status: done
- Where: server (chat places, the file tools' chat branch, edit_office), shared (tool descriptions). Why: the AI's core
  file tools are core (docs/REPOSITORY-RULES.md)
- Version impact: **minor**. write, edit, edit_files and edit_office take an existing chat file; nothing that worked
  before is narrowed; no migration (432 from #217 already holds `root_id`, `replaces`, `version`, `origin`)
- Parent plan: [20261121-0615-chat-places-as-paths.md](20261121-0615-chat-places-as-paths.md) P4 and "After the
  independent review" fix 2. #217 built the store (`ChatFiles.putVersion`, `find`, `visibleTo`, `versions`,
  `openVersion`, `kCarried`); this is the AI's side of it.

## Goal

"첨부한 견적서의 날짜를 12월 1일로 고쳐 줘" in a chat shared with people: today the AI says a chat file is not changed
in place and makes a copy somewhere else. After this, it changes the attached file itself: a new version, the earlier
one kept, and everyone in the chat opens the new one from the same chip.

## Scope

In:
- `write` and `edit` (and so `edit_files`, which runs each file as an edit) on `chat:files/<id>/<name>` or
  `chat:files/<name>` of an existing chat file: a new version through `ChatFiles.putVersion` with `origin: 'ai'` and the
  turn's write limits; `edit_office` with no `output` on a chat file: the same, its source read through the resolver.
- Who (files/places.ts `mayWriteChatVersion`, checked before any card and again at the save):
  - the main AI of a chat shared with people, or of a personal chat that holds that chat file (a chat made private
    again), and only while the asker may continue the chat (`chatFor(…, 'continue')`);
  - refused in an answer with a k group (putVersion does not check it: the caller does), in a project chat (chat files
    are read-only there: owner decision 2026-11-21), for a sub-agent, a guest, a scheduled run, a locked chat and remote
    MCP (no chat place there at all).
- Read-before-write as for team files: the head's sha256 the read recorded under `chat:files/<root id>/<name>`. A head
  someone saved after the read: `write` saves a version beside it (putVersion `expectHead`, the result says so),
  `edit` applies to the newest text when it still applies once, else asks for a new read.
- Any id of a chain (an older answer's file_id) resolves to its head (`ChatFiles.find`). A chain only hidden answers
  carry, or a k-carried one, is "not found" / refused as for a read.
- `read` of a chat file takes `versions: true` (the list: number, when, who, Trina for whom, size, newest) and
  `version: n` (that version's content).
- Live update seam: a new module `chat/chat-file-version-hook.ts` with `onChatFileVersion(chatId, fileId)`, which the
  AI's saves call, and `listenChatFileVersions(fn)`, which S2's `tellChat` (feat/chat-file-edit-versions, not pushed
  yet) registers with. No change to chat-files.ts or to S2's files.
- Tool descriptions: write, edit and edit_office say that a chat file's save is a new version and the old one stays.
- #216's blanket refusal stays for everything else: `chat:work/` (copy_files → writeIntoWork), reserved prefixes,
  `chat:files/` itself, a name that is no chat file, and every other produce tool in place (edit_pdf replace,
  comment_docx, resize_images replace, edit_hwp): they say to copy the file into a team folder first.

Out (later): make_file / edit_pdf / comment_docx / resize_images writing a version of a chat file; `write` of a new
`chat:files/<name>` text file (make_file output does that today).

## Steps

1. This plan.
2. Tests (`tests/unit/places-ai-versions.test.ts`): k refusal, project refusal, sub-agent refusal, a version made
   (erin opens the new bytes, the root's id still opens it, the old version is in the list), an old id resolves to the
   head, a hidden root stays hidden, the turn's write limits, the storage check, `versions` / `version: n`, edit_files.
   The P1 refusal tests in places-read.test.ts change to the new rule.
3. Code: places.ts words and `mayWriteChatVersion`; ChatPlaces `version` / `head` (chat/place-ctx.ts); ChatPlaceHooks
   `write` / `edit` (chat/chat-file-tool.ts → chat/chat-file-write.ts); FileService.callPlace; chat/tools.ts
   beforeFileTool, beforeBatch and `placeRefusal`; turn.ts `confirmChatTarget` for a version (no card in a personal
   chat, the shared read card in a people chat); edit_office in place.
4. typecheck, check:prepush, area tests on Bun 1.3.12; QA on a private QA copy with a real engine (OpenRouter, < $1).

## Decisions

None new: the parent plan's fix 2 and the owner's 2026-11-21 answer (project chats keep the project folder) decide it.

## Risks

- A write path for the AI into a place every member of the chat sees: the k rule, the continue check and the read
  card are the guards; tests pin each.
- S2 builds on the same store; the hook module is the only shared seam, so the two branches do not conflict.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit places-*.test.ts, b-chat-file*.test.ts, office edit tests.

## Result

- Built as planned: `write`, `edit`, `edit_files` and `edit_office` (no output) on an existing chat file save a new
  version (chat/chat-file-write.ts, chat/place-ctx.ts `head` / `version`, files/places.ts `mayWriteChatVersion`);
  `read` takes `versions: true` and `version: n` on a chat file; a read with `chat_file` counts as read too.
- Added on the way: edit_office is offered in chats shared with people, for the chat's own files only (it was not
  offered there at all: decision 20261121-office-edit-in-place "left for later"); a team Office file is refused there
  in plain words. Decision: docs/decisions/20261121-ai-edits-chat-files.md.
- S2 security review (race): `PutVersionOptions.recheck`, called synchronously right before the insert; the AI's save
  passes its gate (the turn's rule plus the chat as the database has it then: continued by the person, not a project
  chat). A failed recheck removes the written bytes. Tests flip the gate between the write and the insert.
- The live-update seam is `chat/chat-file-version-hook.ts`; S2's `tellChat` registers with `listenChatFileVersions`.
- QA on a private copy with a real engine (OpenRouter): "첨부한 견적서의 날짜를 12월 1일로 고쳐 줘" on an attached .docx
  in a shared chat gave version 2 (견적일 2026년 12월 1일), the other member downloaded the new file and saw the chip's
  "Updated" by the AI. Seen with gemini-2.5-flash: it changed the quote on a plain "here is the quote" message
  (version 2, the original kept); the model's doing, not a server check.
