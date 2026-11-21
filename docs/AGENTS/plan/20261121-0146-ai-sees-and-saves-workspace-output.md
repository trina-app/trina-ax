# The AI opens what its commands made: read and copy_files take the chat's work folder

- Date (UTC): 2026-11-21 01:46
- Branch: `fix/ai-sees-and-saves-workspace-output`
- Status: draft (waiting for plan review)
- Where: server (file tools, dev environment tool text, prompt). Why: the AI's own tools (docs/REPOSITORY-RULES.md)
- Version impact: minor. `read` and `copy_files` take a new kind of path, which the AI can now use

## Goal

The owner asked for a 30-second promo video in a chat with no project that was shared with a teammate. The AI rendered
two MP4s in the chat's work folder (`$TRINA_WORK`) with box_shell. It then said it could check frames only as numbers,
that the preview had no web address (a port 8080 dev server behind a Preview button), and that it could not save the
videos to the team folder. It asked the owner to download them and upload them again. Claude Code would open the
frames and save the file. Trina's AI should do the same with the tools it already has: run ffmpeg (or anything else)
in its work folder, open any picture it made and see it, decide for itself what to fix, then put the finished file
in the team folder with the person's own rights and link it.

## Root cause (checked in code and, read-only, on potenlab.trina.app)

- **ffmpeg and the engine are fine.** `/usr/bin/ffmpeg` and `ffprobe` are on the server, and the chat ran ffprobe and
  chromium screenshots. The engine is Claude Code (multimodal).
- **Seeing (a gap).** The engine's built-in Read and Bash are denied in every turn (`engine/claude.ts`
  CLAUDE_BUILTIN_DENIED). The only tool that gives the model pixels is Trina's `read` (`files/service.ts` readImage, with
  video frames and PDF pages). It takes only team-folder paths, and `$TRINA_WORK` is outside the team folder
  ("which the file tools do not show", `devenv/tool.ts`). box_shell returns text only. So a PNG made with ffmpeg
  reached the model only as numbers.
- **Saving (a deliberate rule plus a gap).** A run writes only its starting folder and `users/<id>`, and in a chat shared
  with people no team folder at all (DECISIONS "Write only in the starting folder", decisions/20261118-devenv-shared-chats.md).
  That chat was shared with people. The rule stays. The gap: the tool text says "save a result with the file tools",
  but `write` takes text and `copy_files` takes only team paths, so a binary file had no way out.
- **Link (deliberate rule, wrong fallback).** A dev server's Preview link is per person and single-use, on its own
  origin (DECISIONS "Dev environment on srt: preview"). That stays. Because the file could not be saved, the AI
  served the MP4 from a web server instead.

## Scope

In:
1. **`read` takes a work-folder path.** The path is the absolute one the AI sees in box_shell (`$TRINA_WORK/...` or
   the real absolute path of the work folder). The file goes through the very same read path as a team file
   (readImage / media / PDF / text), so pictures, video frames, PDF pages and text all work. The work folder is the
   one box_shell uses for this person in this chat right now (`srt/runner.ts` spaceOf): the private one, or a shared
   chat's own folder for its people now. The turn gives it to the file tools as a per-turn hook (ToolCtx), checked
   again on every open. Refused: links anywhere on the path, hard-linked files (`openToRead`'s single-link rule), `..`,
   and any path outside that folder. In a shared chat, the read first records what a run there may read
   (noteSharedReads, as a command does) and adds the chat as the read's source.
2. **`copy_files` takes a work-folder file as a source.** It copies the bytes into `to_folder` with the person's own
   write rights (placeProduced: write access, conflict copy, versions, events, turn write budget, the quarantine hash
   check). The wider-audience card asks when more people can read the target than the file's source: the chat in a
   shared chat, the person in a private chat (the same as copying from their own folder today). Run isolation is
   unchanged; this is the explicit save step. Never into skills/ or as an instruction file.
3. **Tool text.** box_shell's text says how it really works: open a picture, video or PDF from the work folder with
   `read`, and save a finished file into the team folder with `copy_files`. A Preview dev server is for a web app,
   not for showing a finished file.
4. **One prompt line** when the work folder is offered: "Look at what you make before you report. Save the finished file
   in the team folder and link it." No step-by-step recipe, nothing video-specific.
5. Check that an MP4 (H.264) saved in the team folder plays in the file viewer (Chrome, desktop app). Fix it if it
   does not.

Out: a public link for dev servers; other tools (stamp_pdf, unzip_file …) on work-folder paths (copy first); project
chats (their commands already run in the project folder, which `read` reaches).

## Steps

1. Plan (this file), first commit. Plan review.
2. Tests: `tests/unit/work-folder-read-copy.test.ts`. read: a PNG comes back as an image and an MP4 as frames; links,
   a link on the path, hard links, `..` and paths outside are refused; a shared chat reads only its own folder, and a
   different set of people gets nothing. copy_files: from the work folder to the own folder with no card, to a wider
   folder in a shared chat with the card, skills/ refused, conflict copy. Not offered without the dev environment or in
   a project chat.
3. Code: a work-folder resolver (`devenv/work-files.ts`), the ToolCtx hook set by the turn (`chat/turn.ts`), `read`
   and `copy_files` (`files/service.ts`, `tools/file-moves.ts`), the shared-chat read card and the step labels for the
   new path form, the box_shell text, the prompt line.
4. Decision `docs/decisions/20261121-ai-sees-and-saves-workspace-output.md`, `changes/ai-sees-and-saves-workspace-output.md`.
5. QA on a new private copy of the QA team with a real engine. Before and after: "make a short clip". The AI makes it,
   opens its own frames, fixes something it sees, saves it to the team folder and links it. Screenshots, QA sheet rows
   TC-6160..6162.

## Decisions

`docs/decisions/20261121-ai-sees-and-saves-workspace-output.md`: the work folder stays isolated from the team folder.
`read` and `copy_files` are the explicit way out, with the person's rights and the wider-audience card.

## Risks

- No migration.
- Security: the work folder is written by sandboxed commands. Links, hard links and paths outside are refused, every
  open is checked again (the same identity checks as a shared-folder read), and a shared chat reads only its own folder.
- Read-scope bookkeeping for a work path is kept apart from team paths (no read-before-write hash for a team path).
- The shared-chat read card must not treat a work path as a team path.

## Tests

`bun run typecheck`, `bun run check:prepush`, the new unit test, `tests/unit/dev-env*.test.ts`, the read, copy and
shared-card tests.

## Result

(at the end)
