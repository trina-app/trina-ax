# Scenario QA fixes: honest chat-file edits, Restore for every file, PDF versions, CJK fonts, readable steps

- Date (UTC): 2026-11-21 23:39
- Branch: `fix/scenario-qa-file-versions`
- Status: done
- Where: server (tools, chat, devenv), shared (step labels, API), web (file panel, steps). Why: five findings of the
  multi-person scenario QA on dev 3d747563a (QA sheet TC-7039, 7040, 7043, 7044, 7048).
- Version impact: patch (fixes of shipped features; one optional response field added, older clients ignore it)

## Goal

People in a shared chat can trust what the AI says about a chat file and can undo any version, whatever the file type.

## Findings and root causes

1. **TC-7039 (P1)**: a "failed" PPTX edit left a slide "임시" as version 2 of a shared deck; the AI then said both "want
   to go back?" and "it is already the original". Root cause, read from the code: edit_office itself is atomic (the
   worker's result is checked part by part and read back by a fresh worker before `ChatPlaces.version` → `putVersion`;
   every refusal happens before it). The stray version was a *separate, successful* edit_office call the AI made "as a
   test" (add_slide "임시") to see whether add_slide takes speaker notes. So the real gaps are: (a) nothing tells the AI
   that every call saves a version everyone opens, and the description does not say what it cannot change (speaker
   notes), so it probed; (b) a refusal does not say what state the file is in, and a read of a chat file does not say
   which version it is or who saved it, so the AI could not tell "original" from "my test"; (c) people could not
   restore a PPTX version (TC-7040), so the AI's offer to go back had no way to happen.
2. **TC-7040 (P2)**: the panel's Restore follows `canEdit`, which is "may edit as text" (text names, 10 MB). Restore of
   any version is a `putVersion` of that version's own bytes and needs neither.
3. **TC-7044 (P2)**: edit_pdf does not take a chat file at all (`placeRefusal` refuses `file_path` chat:files/…, and
   the tool reads only team paths), so the AI remade the PDF as "(2)".
4. **TC-7043 (P2)**: in the box, fontconfig's default sans-serif is DejaVu (no Hangul), so ffmpeg drawtext without a
   font file draws boxes; the AI then said it checked the frames and the text was clear.
5. **TC-7048 (P3)**: a box_shell line keeps a guessed path with a file id (`Work folder › .. › files › <uuid> › …`), a
   step's tooltip and error detail show `chat:files/<uuid>/…`, and answers name tools (`edit_office`) and raw paths.

## Scope

In:
1. P1, tool texts and results (server/src/tools/edit-office.ts, files/place-output.ts, chat/chat-file-tool.ts):
   - edit_office description: every call without output saves a version that people see, so never call it to try
     something out; it cannot change speaker notes, charts, tables in a deck, comments or other parts not listed: say so
     without calling it.
   - Every refusal of an in-place chat-file edit (edit_office, edit_pdf) ends with the real state: "Nothing was saved
     by this call: '<name>' is still version N." plus, when this answer already saved version N of it, "(version N is
     your own save earlier in this answer; say so)". One wrapper, so no refusal path is missed.
   - A read of a chat file that has more than one version says which one it is and who saved the newest ("version 2
     of 2, the newest, saved by Trina for QA Owner"), so a later "is it the original?" is answered from the record.
   - The success text of a chat-file version says how people undo it (Versions › Restore on the file).
2. P2 Restore (server/src/chat/chat-file-edit.ts, shared/src/api/chats.ts, web FilePanel): `ChatFileVersions.canRestore`
   (optional: older servers → use canEdit). Same rules as canEdit except the text-name and 10 MB edit limits: a chat
   shared with people, not in the trash, not a project chat, safe operations off, the head not held by the safety check.
   The restore route checks canRestore's rule, not the edit rule. Size: `ChatFiles.restore` already allows a version up
   to its own size (max(50 MB, min(size, 1 GB))), so a person restores an AI's 300 MB version; a test pins it. The web
   shows Restore on every row and on the opened old version when canRestore. Opening an old version already uses the
   same viewer for every type (the chat file URL with `version`); checked visually for PPTX, DOCX and PDF.
3. P2 PDF versions (server/src/tools/pdf-tools.ts, chat/tools.ts, chat/turn.ts, chat/prompt.ts): edit_pdf with
   `file_path` chat:files/<id>/<name> (or by name) and no output saves a new version through `ChatPlaces.head` /
   `ChatPlaces.version`, the same gates as edit_office (#252: a chat shared with people or personal, not project, not
   a k answer, the person continuing the chat, rechecked at the insert; read first, by the head's hash). With output it
   makes a new file from the chat file (read through readPlaceFile). insert_pdf and stamp_image files stay team paths.
   `placeRefusal` lets edit_pdf's file_path through; the pre-card version check covers edit_pdf like edit_office; the
   wider-audience check treats a chat target with a file id as a version (not a new attach). Texts: PDF_TOOLS_RULE,
   the shared chat line, CHAT_FILE_DESCRIPTION and PLACE_WORDS.inPlace name edit_pdf.
4. P2 fonts (server/src/devenv/srt/config.ts + runner.ts, devenv/tool.ts, chat/prompt.ts):
   - (a) Linux box runs get `FONTCONFIG_FILE` pointing to a server-written fonts.conf in `<base>/devenv/bin/fonts/`
     (read-only in a run, like the git wrapper) that prefers Noto Sans/Serif/Sans Mono CJK KR for sans-serif, serif,
     monospace and Sans (before the system rules, then includes /etc/fonts/fonts.conf), and `MATPLOTLIBRC` pointing to a
     matplotlibrc there with Noto Sans CJK KR first. Only the box: the server's own PDF printing keeps its fonts.
     fonts-noto-cjk is already in packages.json (group fonts, image and default installs): no package change. The box
     text says the default fonts have Korean, Japanese and Chinese.
   - (b) One general line in the prompt: when you check your own output (a picture, a page, a video frame), say what is
     actually visible, including broken, box-shaped or missing letters; never say it looks right unless you saw it.
5. P3 readable steps and answers (shared/src/step-labels.ts, web Steps.tsx, chat/prompt.ts):
   - A chat place anywhere in a step line or its detail reads in words ("This chat › 견적서.pdf"); a file id (UUID) is
     never shown in a worded path; a chat place's tooltip shows no raw path.
   - Prompt: refer to files by their name (a link for team files as today), never by a chat:files/ or work path or an id,
     and never say "as you can see above" about a picture only you looked at.

Out: speaker notes in edit_office (a new edit kind, its own plan); an AI tool to restore a version (people restore; the
AI tells them where); stamp_pdf / merge / split on chat files in place; the "One step didn't work" line
(server/src/engine/api-honest.ts, another agent); the sharing findings (another agent).

## Steps

1. This plan (first commit), independent plan review, apply.
2. P1 + P3 texts and wrapper, tests (tests/unit/places-ai-versions.test.ts, step-labels tests).
3. P2 Restore server + web, tests (b-chat-file-edit, web unit).
4. P2 edit_pdf versions, tests (places-ai-versions).
5. P2 fonts: config + runner, tests (srt config unit), box text.
6. Checks with Bun 1.3.12: typecheck, check:prepush, area tests, web unit, full tests/unit + tests/security once.
7. Visual check on a new private QA copy (colima Docker srt; real engine under $1.5).
8. Independent code review, apply; one PR into dev (not queued); QA rows updated.

## Decisions

None new; follows docs/decisions/20261121-ai-edits-chat-files.md and the one-version-per-answer rule (owner
2026-11-21).

## Risks

- Restore on binary files: the bytes are the chain's own (no new content), same audit and rate limit as today.
- edit_pdf in place: the same gates as edit_office, rechecked at the insert; a project chat stays read-only.
- Fonts: only the box's environment changes; a person's own fontconfig or matplotlibrc in the folder still wins
  (matplotlib reads ./matplotlibrc first). A server without fonts-noto-cjk falls back to the system's rules.
- No migration. Five app languages: no new web strings (Restore exists); the step words exist in all languages.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit (places-ai-versions, b-chat-file-edit, step labels, srt
config, prompt), web unit, full tests/unit and tests/security once; visual check at 1440 and 390.

## Result

Built as planned, plus what the plan review and the coordinator's later QA rows added:
- putVersion keeps a version's bytes once its row is in (prune and audit failures are logged, not thrown).
- A refused edit_office / edit_pdf on a chat file gets one line with the file's real state, added at the call site in
  chat/tools.ts (every refusal path), and never "nothing was saved" when the head moved during the call.
- A produce tool's output that names an existing chat file by its own path (chat:files/<id>/<name>, same name) saves a
  new version (files/place-output.ts versionProduced, edit_office's rules) instead of a "(2)" copy (TC-7267, 7283,
  7243); prompt and make_file text say to remake a chat file that way. edit_pdf output naming the same file is in place.
- Restore when the newest version is held by the safety check stays off (unchanged rule).
- Prompt: look before describing how something made looks; check the result for what the person asked to leave out
  (TC-7263, 7276); artifacts changed by their key (TC-7247); a picture request makes a PNG (TC-7235); the API engine's
  deferred-tool list says the names are not for answers.
- Not folded (other roots): TC-7234 (an edit after the file was moved to a project or room) and TC-7241 (a person's
  upload with a taken name: "Save as a new version / Keep both" needs a UI decision).
- Visual check on a private QA copy (Linux container, srt, OpenRouter sonnet-4.5, about 1.04 USD): a PDF date change made
  version 2 with Restore at 1440 and 390; speaker notes got no test slide and no version; drawtext without a font file
  rendered Hangul (fc-match sans-serif = Noto Sans CJK KR inside srt); steps read "This chat › …". Sonnet still named
  edit_office in one answer despite the rules (model behaviour).
