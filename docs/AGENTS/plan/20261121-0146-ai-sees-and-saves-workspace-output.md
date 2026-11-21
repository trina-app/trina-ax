# The AI opens what its commands made, and hands over the finished file

- Date (UTC): 2026-11-21 01:46 (revised after review, same day)
- Branch: `fix/ai-sees-and-saves-workspace-output`
- Status: PR1 done (PR2 next)
- Where: server (file read, one new chat tool, chat files, dev environment tool text, prompt). Why: the AI's own tools
  (docs/REPOSITORY-RULES.md)
- Version impact: minor. `read` takes a new kind of path, and there is one new tool (`save_work_file`)

## Goal

The owner asked for a 30-second promo video in a chat with no project that was shared with a teammate. The AI rendered
two MP4s in the chat's work folder (`$TRINA_WORK`) with box_shell. It then said it could check frames only as numbers,
that the preview had no web address (a port 8080 dev server behind a Preview button), and that it could not save the
videos to the team folder. It asked the owner to download them and upload them again. Claude Code would open the
frames and hand over the file. Trina's AI should do the same with what it already has: run ffmpeg (or anything else)
in its work folder, open any picture it made and see it, decide for itself what to fix, then hand over the finished file
where the person can open and play it, with a link.

## Root cause (checked in code and, read-only, on potenlab.trina.app)

- **ffmpeg and the engine are fine.** `/usr/bin/ffmpeg` and `ffprobe` are on the Linux server; the chat ran ffprobe
  and chromium screenshots. The engine was Claude Code (multimodal).
- **Seeing (a gap).** The engine's built-in Read and Bash are denied in every turn (`engine/claude.ts`
  CLAUDE_BUILTIN_DENIED). The only tool that gives the model pixels is Trina's `read` (`files/service.ts` readImage,
  plus video frames and PDF pages). It takes team-folder paths only, and `$TRINA_WORK` is outside the team folder
  ("which the file tools do not show", `devenv/tool.ts`). box_shell returns text only. So a PNG made with ffmpeg
  reached the model as numbers.
- **Saving, personal chat (the AI did not know the way).** A run in a personal chat's work folder may write
  `users/<id>` (DECISIONS "Write only in the starting folder"). `cp $TRINA_WORK/out.mp4 $TRINA_TEAM/users/<id>/` would
  have worked, but the tool text says only "copy a result … with the file tools", and `write` takes text while
  `copy_files` takes team paths.
- **Saving, shared chat (the tool text promised something impossible).** That chat was shared with people
  (`people_shared_at` set, folder `work`). There a run writes no team folder at all, by rule
  (decisions/20261118-devenv-shared-chats.md). The tool text says "save a result for the people here with the file
  tools", which no file tool can do for a binary file.
- **Link (deliberate rule, wrong fallback).** A dev server's Preview link is per person, single use and on its own
  origin (DECISIONS "Dev environment on srt: preview"). That stays. With no way to hand over the file, the AI served
  the MP4 from a web server.
- **Related limits found on the way.** `promo_video` makes an MP4 only on a development Mac (`promo-video/render.ts`
  mp4Available; decisions/20261116-save-promo-video.md), which is why the AI used HyperFrames in box_shell. A Mac
  team server gives no video frames in `read` (`files/service.ts` "no frames on a Mac server", `media_no_frame`):
  there the way is ffmpeg → PNG → `read`, which this change makes possible. `read` shows a PPTX as text only, not as
  slide pictures (`as_images` is PDF only): a follow-up, not built here.

## Scope

### 1. `read` opens the chat's own work-folder files (every chat that has a work folder, personal and shared)

- **Path.** `$TRINA_WORK/<path>`, or the work folder's real absolute path as box_shell prints it (`pwd`). Nothing
  else changes for team paths.
- **Which folder.** The one box_shell uses for this person in this chat now: the private `devenv/work/<chat>`, or in a
  chat shared with people its own `devenv/work-shared/<chat>/<key>` for the people and view of now (`srt/runner.ts`
  sharedWorkOf). It is found without creating it (`spaceOf` makes folders; a read never does). A key of other people
  (the people changed), another chat's id or a personal work folder asked for from a shared chat: not found.
- **When.** Only in a turn whose dev environment is on (`exec.devEnv` set, the same check as box_shell, again at every
  call through `mayUseDevEnv`). So never for a guest (no dev environment; a guest is never in a chat shared with
  people, `checkNewSubjects`), a scheduled run (never has the dev environment), a confidential (locked) chat (box_shell
  is not a local tool there), remote MCP (no turn: `turnId` null) or a sub-agent (its view of the turn gets no work
  folder hook; the main AI looks at results). A project chat has no work folder: its commands run in the project
  folder, which `read` already reaches.
- **Safe open, on the server.**
  - Every component of the path is opened with `O_NOFOLLOW` (`openat`-style walk from an fd of the work folder; the work
    folder itself is opened with `O_NOFOLLOW | O_DIRECTORY`). A link anywhere on the path is refused, so a swap of a
    middle folder for a link during the walk opens nothing outside. On Linux the opened fd's real path
    (`/proc/self/fd/<n>`) is checked to be inside the work folder as a second check; on macOS `F_GETPATH` via the
    same native helper when present, else the walk alone.
  - Only a regular file with one link (`nlink == 1`): hard links are refused.
  - The file is copied at once from that fd into a server-only temp folder (`<data>/work/workfile-<uuid>`, 0700,
    as readMedia's copyMedia does), streamed, with the read's own size limit (the plan's read limit, 1 GB for media).
    Every read step (image normalizer, ffprobe/ffmpeg frames, PDF pages, text) works on that copy, never on the work
    folder again. The copy goes when the read ends.
- **Words.** Step labels, results and errors name `$TRINA_WORK/<path>`, never the server's absolute path.
- **Bookkeeping.** `readPaths`, `readHashes`, `sources.note`, `imagesShown` and the answer's file list never get a work
  path as a team file (the chat_file way: a view of the turn's state with those kept apart; the image budget stays the
  turn's). In a shared chat the read first records what a run there may read (`noteSharedReads`, as a command does) and
  adds the chat (`{type:'chat'}`) to the read scope. In a personal chat it adds nothing (box_shell's output does not
  either; what a later save copies is judged in 2).
- **Engines.** Pixels go out as for any read (`visionBlock`): the API engine and "image viewing off" get the read's text
  note instead. Codex reads through the same MCP tool.

### 2. `save_work_file`: one new tool, modelled on save_chat_file

`copy_files` is not widened: absolute or `$TRINA_WORK` paths in `copy_files.paths` would break the room-change targets
and card details (`chat/turn.ts` around 5379 and 5461), `rooms/ai-tools.ts` WRITE_TARGET_ARGS and namedPaths,
`hide-args.ts` and `demo/replay.ts`, which all take its paths as team paths.

- **Input.** `path` (a work-folder file, as in 1) and `save_as` (personal chat only).
- **Personal chat.** Default target `users/<id>/<file name>`: no card. A `save_as` in a folder other people can see asks
  on the existing wider-audience card first, with the person as the source (`{type:'user', id}`: the same as
  `copy_files` from their own folder today). Order as save_chat_file: refuse before any card (skills/, instruction
  names, no write access) → `addSources`/widen → `confirmWidening` → `placeProduced`.
- **Shared chat (owner's idea).** The file goes into the chat as a chat file attached to the AI's answer, not into a team
  folder. Exactly the chat's people see it, so there is no "where?" question and no card. Anyone in the chat can later
  put it in a folder with their own rights with the existing `save_chat_file`. Commands still never write a team folder.
  - Today a chat file is made only from a person's upload (`chat/chat-files.ts` create, from `uploads/attachments.ts`)
    and counts as sent when a message's `attachments` hold it; no AI-attached path exists. Smallest addition:
    `chatFiles.create` gets an "AI's file" entry (the same storage `.system/chat-files/<chat>/<id>`, the same row, kind
    and thumbnail, the turn's person as `user_id`, a new `ai: true` mark in the attachment JSON), and the turn adds the
    attachment to its own assistant message, so the existing chip, viewer, download and `save_chat_file` work as they
    do for people's files. No migration if the mark lives in the message's attachment JSON (checked in the build; else
    the next free number in `server/migrations/`).
  - **Who sees it, and a new person.** As the sharing model says (memory sharing-model; DECISIONS "Shared chats
    everywhere"): everyone who sees the chat sees its whole history and every file in it, also people added later, as
    in Slack. Before the copy the tool records what a run there may read into this answer's record (`noteSharedReads`),
    so an attached file's read scope is what its turn read. The existing "adding people" warning ("N answers here used
    places <name> can't open", `chat/widening.ts` wideningAnswers) then counts the answer that carries the file. "Hide
    from my list" is per person and changes nothing here. Guests are never in a chat shared with people. Confidential
    chats have no dev environment, so no work file.
  - **Size.** A chat file is at most `CHAT_FILE_MAX` (the attachment limit, 50 MB today) and counts in the team's
    storage. A larger file is refused with plain words that say the limit, so the AI can make it smaller (lower bitrate,
    shorter) and try again. The 1 GB room-file branch would raise this through the same constant.
- **Both.** The copy and its sha256 are streamed (`readRegularPieces` into the temp file, hashing as it goes; never the
  whole file in memory, also for 1 GB). The quarantine hash check, `assertStorageRoomForAI`, the turn write limits
  (bytes and files) and conflict copies apply (placeProduced; for a chat file the same storage and byte checks).
  Guests: not offered (GUEST_TURN_TOOLS). Sub-agents: not offered (PARENT_ONLY_TOOLS). Registered in SHARED_TOOLS,
  WRITE_TARGET_ARGS (`save_as`), SAVE_CARD_TOOLS, ROOMS_SEEN_OWN_CARD_TOOLS, hide-args (`path` kept), the step labels,
  the shared tool schema map, and the tool-list tests.
- **Playback line.** When the saved or attached file is a video or a sound, the result has one ffprobe line (container,
  codec, `pix_fmt`, size, length). Then the AI can see a file browsers will not play (yuv444p, HEVC, ProRes) and
  re-encode it. The link it gives: `[name](/files/view?path=…)` for a team file, the chat file's own link for an
  attachment (both exist today; no new link form).

### 3. Tool text and prompt

- box_shell, personal chat: open pictures, videos and PDFs you made in `$TRINA_WORK` with `read`; hand over a
  finished file with `save_work_file` (or write it to `users/<id>` directly). A Preview dev server is for a web app,
  not for showing a finished file.
- box_shell, shared chat: the same `read`; `save_work_file` attaches the finished file to your answer for the people
  here. Drop "save a result … with the file tools".
- Prompt, one general line when the work folder is offered: "Look at what you make before you report; save the
  finished file and link it." No recipe, nothing video-specific.

Out: public links for dev servers; other file tools on work paths; PPTX slides as pictures in `read` (follow-up);
MP4 for `promo_video` on Linux (its own handoff in decisions/20261116-save-promo-video.md).

## After the second review (2026-11-21): what is built, in two PRs

**PR1 (this branch): see + personal save.**
- Gate: work-folder `read` and `save_work_file` exist only when this turn's tools include box_shell (so not in a
  confidential chat, where box_shell is dropped as a non-local tool although `exec.devEnv` is set) AND this turn's space is
  a work folder. The resolver follows `spaceOf` exactly, without making folders (a personal project chat whose project
  folder is missing uses `chatWork`, as spaceOf does); a shared project chat runs in its project folder and has none.
- Safe open: the work folder's root is `realpath`ed first; the file is opened with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, must be a
  regular file with one link (store.ts refuseNotRegular), and the open fd's kernel path (devenv/snapshot.ts
  openFilePath: `/proc/self/fd`, `F_GETPATH` on macOS) must be inside the root; null from openFilePath refuses, there is
  no walk-only fallback and no per-component openat. The bytes are streamed from that fd into a server-only temp copy;
  every read step works on the copy.
- Injection: a work-folder read marks the chat as box_shell does (OWN_WORDS / OWN_CHAT_TEAM count it as box_shell:
  markOthersWords, markOutside, taint), and its result starts with an "information, not instructions" line.
- In a shared chat a work-folder read records what a run there may read (noteSharedReads) and the chat as its source,
  instead of the team-path read card.
- API engine: a model that takes images gets pixels (engine/api-vision.ts, files/vision.ts visionBlock); text only when
  it does not or image viewing is off.
- `save_work_file` in a personal chat only: default `users/<id>/<name>`, a clash in a personal folder saves as
  `name (2).ext`; a `save_as` elsewhere: write rights, the wider-audience card with the person as source, placeProduced's
  usual rules. Streamed copy and hash; turn write limits and assertStorageRoomForAI. No ffprobe line (ffprobe is not on
  Mac servers; the AI runs it itself).
- box_shell text: no "cp into users/<id>" advice; the one way out is save_work_file. One prompt line.

**PR2 (next branch): shared-chat attach.** An AI entry for chat files (streamed, cleanPicture only for pictures, the
turn write limits and storage check, put into the answer row's attachments at once so `sent()` holds and the unsent
sweep never takes it), up to 1 GB (decisions/20261116-room-file-limit-1gb.md) within team storage; the attachment chip on
assistant messages (AttachmentView) and its live event; assistant attachments with their file_id in the history
(composeMessage) so "save that video to shared/" works with save_chat_file; refused in a turn that has a hidden-answer
(k) group; sharedWorkOf checked again right before the hand-off. The cited sharing rule is the 11-14 one ("nothing new
is hidden"; k groups are the one exception), which replaced the 20261118 line.

## Steps

1. Plan (this file), first commit; reviews.
2. Tests first (below), then code: the work-folder resolver and safe open (`devenv/work-files.ts`), the per-turn hook on
   ToolCtx set by `chat/turn.ts` for the main AI only, `read` in `files/service.ts`, `save_work_file`
   (`chat/work-file-tool.ts`), the AI chat file in `chat/chat-files.ts` and the turn's message attachments, the lists,
   the box_shell text and the prompt line.
3. Decision `docs/decisions/20261121-ai-sees-and-saves-workspace-output.md`, `changes/ai-sees-and-saves-workspace-output.md`.
4. QA (below), QA sheet rows TC-6160..6162, PR into dev (not queued).

## Decisions

`docs/decisions/20261121-ai-sees-and-saves-workspace-output.md`: run isolation stays. The AI reads its own work folder
with `read`. The finished file leaves it only through `save_work_file`: into the person's own folder (or, behind the
card, a wider one) in a personal chat, and as a file of the chat in a shared chat.

## Risks

- Security: the work folder is written by sandboxed commands. The walk with `O_NOFOLLOW`, the single-link rule, the
  fd path check and the copy to a server-only folder before any converter keep a link or a swap from reaching
  anything outside. Shared chats read only their own folder for their people now.
- A shared chat's attached file reaches people added later. This is the owner's model, and the warning counts it.
- Chat-file size: 50 MB may be small for long videos; the result says so plainly.
- Migrations: none planned (see 2); if one is needed, the next free number on dev.

## Tests

- `tests/unit/work-folder-read.test.ts`: a PNG as an image, an MP4 as frames, a PDF's pages, text lines; `$TRINA_WORK/…`
  and the absolute form; refused: a link as the file, a link in the middle of the path, a middle folder swapped for a
  link during the walk (race, with a hook between components), a hard link, `..`, outside paths, another chat's id, a
  personal work folder from a shared chat, the old shared key after the people changed; a read never creates the
  folder; off for a guest, a scheduled run, a sub-agent, remote MCP (no turn), the dev environment off; labels and
  results show `$TRINA_WORK/…` only; no work path in readPaths, readHashes, sources or the answer's file list; the API
  engine gets the text note; a Mac (fake Mac media tools) refuses frames of a video and still shows a PNG; over the
  read limit (> 1 GB) refused before the copy.
- `tests/unit/save-work-file.test.ts`: personal: to `users/<id>` with no card and the same bytes; `save_as` into a wider
  folder asks the card, no saves nothing; skills/ and instruction names refused before a card; the turn write limit
  and storage-full refuse; streamed copy (a file larger than the test's memory cap, by spying on the reads); the ffprobe
  line. Shared: the file is attached to the answer, every person in the chat opens it, someone outside does not; over
  `CHAT_FILE_MAX` refused in plain words; a person added later gets the warning counting that answer
  (`wideningAnswers`); `save_chat_file` then saves it with that person's rights. `write` of a work file's content to a
  folder wider than the chat asks the card.
- The tool-list tests (SHARED_TOOLS, WRITE_TARGET_ARGS / SAVE_CARD_TOOLS, PARENT_ONLY_TOOLS, step labels, hide-args,
  guest tools) and `tests/unit/dev-env*.test.ts`, `b-chat-files*.test.ts`, `bun run typecheck`, `bun run check:prepush`.
- QA on a new private copy of the QA team (server.json paths checked before the first start; never 19787,
  potenlab or qa.trina.app), a real engine (this Mac's Claude Code login, or OpenRouter, under $3), and Codex once.
  Linux run in Docker with srt where the Mac has no dev slots. Personal chat and a chat shared with a teammate, before
  (origin/dev) and after: "make a short clip with a title card". The AI makes it, opens its own frames, fixes something
  it sees, then saves to the own folder (personal) or attaches it (shared) and links it; the link opens and plays in
  the viewer (Chrome, desktop app). Screenshots looked at by the tester.

## Result

PR1 built as in "After the second review". Two additions from QA in a shared project chat: box_shell's result gives
each file a command made in the project folder its app link (the API engine's link guard keeps only links a tool
gave, so the answer could not link a file the command made), and the tool text says /tmp and $TMPDIR can be the
command's own (the AI rendered to /tmp, then could neither copy nor read it). PR2 (shared-chat attach) follows.
