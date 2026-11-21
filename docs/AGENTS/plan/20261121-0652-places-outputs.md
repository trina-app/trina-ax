# Chat places, phase 3: produce tools write to chat:files/, and a document's references resolve through its place

- Date (UTC): 2026-11-21 06:52
- Branch: `feat/places-outputs` (on `feat/places-resolver-read` 4ed781728, P1's interface; rebased onto P1's final head)
- Status: in progress
- Where: server (make_file and the produce tools that place through `placeProduced`, the turn's cards, the API
  engine's link guard, the shared-chat prompt), web (answer links). Why: the AI's core file tools are core
  (docs/REPOSITORY-RULES.md)
- Version impact: **minor**. The produce tools take a new kind of `output` and `source`; nothing existing narrows; no
  migration

Parent plan: [20261121-0615-chat-places-as-paths.md](20261121-0615-chat-places-as-paths.md) (P3, with "After the
independent review" fix 4 `copyImages`). Owner decisions kept: a project chat keeps the project folder as its only save
place (`chat:files/` is read-only there); `room:files/` waits.

## Goal

In a chat shared with people the AI can make a file for the people there and hand it over in the answer with the tool
it already knows: `make_file {…, output: "chat:files/proposal.pptx"}` (and edit_office, the PDF tools, stamp_pdf,
comment_docx, resize_images, make_zip). A document made from a file in the chat's work folder (`source:
chat:work/proposal.html`) takes its pictures from that same place, never from the team folder.

## Scope

In:
- **Output.** `output: chat:files/<name>` on every produce tool that places through `placeProduced`. One helper,
  `authorizeOutput` (server/src/files/place-output.ts), stands where each tool authorized its team output; the chat
  branch of `placeProduced` attaches the file to the answer through #200's entry (`ChatFiles.createFromAi`, then
  `attachToAnswer`): `CHAT_FILE_AI_MAX` (1 GB), the turn's write limits (bytes, files), `assertStorageRoomForAI`, the
  quarantine hash, a taken name gets "name (2).ext" (no overwrite before P4's versions).
- **Who may.** The resolver decides (`mayAttachChatFile`): a people-shared chat's main AI only. A project chat is
  refused with the project-folder sentence; a personal, locked or scheduled chat, a guest, a sub-agent and remote MCP are
  refused in plain words. An answer with a k group carries no file (checked before the work and again right before the
  attach). `chat:work/` outputs are refused until P2's in-sandbox writer (a TODO hook, tested).
- **Gates.** `sharedSources` takes a `chat:` value through the resolver (its readers: the chat) instead of reading it
  as a team path; the wider-audience check for a `chat:` target becomes the shared read card over the files whose bytes
  go in (embedded pictures, a template): a source some people here cannot open asks first, exactly as a read would.
- **Sources and references.** make_file's `source` and `template` may be `chat:work/…` or `chat:files/…` (read through
  the work folder's safe open and `ChatFiles.open`). `copyImages` resolves every picture through the source's own
  place: relative to a `chat:work/` source only inside the work folder, relative to a `chat:files/` source only among
  the chat's files, a `chat:` reference through the resolver; the team-root fallback stays for team sources only. An
  HTML page in a chat place is printed with its pictures, stylesheets and fonts from that place.
- **Links.** A chat file's link is `/c/<chat>?file=<id>`. Tools return it; the API engine's `LinkGuard` takes `/c/` in
  `ROUTE` and keys on `file=`. The web shows `/c/<chat>?file=<id>` and `[x](chat:files/<id>/…)` as a file chip that opens
  the chat file's viewer, and the chat page opens that viewer for `?file=`.
- **H1.** One prompt line in a chat shared with people: files made for the people here go to `chat:files/`; a team
  folder only when the user names one. Decision amendment of 20261117-ai-save-my-files-default.md.

Out: `chat:work/` writes (P2), a new version of an existing chat file (P4), `room:files/` (P6), reading `chat:` inputs in
edit_office / the PDF tools (they keep team inputs; P1/P4), split_pdf's and resize_images' `output_folder` to
`chat:files/` (refused in plain words).

## Steps

1. Tests first: tests/unit/places-produce.test.ts (each gate, copyImages, project/k refusals, limits, link guard), web
   unit test for the chip.
2. server/src/files/place-output.ts: `authorizeOutput`, `attachProduced`, `readPlaceFile`, `placeLink`.
3. `placeProduced` chat branch; make_file (all branches); the other produce tools' output check; result texts.
4. chat/place-ctx.ts (the turn's ResolveCtx and attach), ToolCtx.places in chat/tools.ts toolContext.
5. turn.ts: `sharedSources` and `confirmWidening` for `chat:` values.
6. api-links.ts, web Markdown/markdown.ts, ChatPage `?file=`.
7. Prompt line, decision amendment, changes/ file.

## Decisions

Amends [20261117-ai-save-my-files-default.md](../../decisions/20261117-ai-save-my-files-default.md) for chats shared
with people (new file docs/decisions/20261121-shared-chat-output-to-chat-files.md).

## Risks

- Security: a chat output must never be wider than its sources: every source goes through the shared read card's
  rules; a `chat:work/` document can never pull a team file (no team fallback). Opus security review on the PR.
- The attach moves the produced temp file into the chat store: a failure after the move leaves no team file.
- P1 and P4 touch the same turn.ts lines; rebase onto P1's final head and keep one resolver call per site.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/places-produce.test.ts, the make_file, work-file-attach,
shared save card and link guard tests, tests/security, web unit tests. QA on a private QA copy with a real engine.

## Result

(filled in at the end)
