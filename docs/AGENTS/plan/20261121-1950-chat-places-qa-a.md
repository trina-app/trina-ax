# Chat places QA-A fixes (TC-6935..6944)

- Date (UTC): 2026-11-21 19:50
- Branch: `fix/chat-places-qa-a`
- Status: done
- Where: server (file tools, work folder, cards, refusals, guest error), shared (step lines, error words), web (chat
  file link, Word preview, error words). Why: the findings are in the AI's core file tools and their words
  (docs/REPOSITORY-RULES.md)
- Version impact: patch: fixes of words, step lines and two viewer states; no new feature, no migration

## Goal

Fix the overnight QA-A findings on chat places (sheet rows TC-6935..6944), so a person never meets a dead-end viewer,
a wrong reason, shell variables or jargon in what the AI says.

## Scope

In:
1. TC-6935 (P2): `/c/<chat>?file=<id>` opens the viewer only once the chat opened and the file is mine to open. A chat
   that does not open keeps its own notice (an open viewer of that chat closes); a file that does not open gets one
   plain line ("can't be found, or you don't have access") and no viewer, no Download. The 404 stays generic.
2. TC-6936 (P2): one reason for every spelling of the work folder (`$TRINA_WORK/…`, `${TRINA_WORK}/…`, the absolute
   path, `chat:work/…`) and every tool. The file tools turn the first three into `chat:work/…` at the door. The turn
   tells why there is no folder: none ran yet, the people changed (an earlier key folder of the chat is there; an
   absolute path into it is refused with that reason), commands off, no work folder in this chat, a sub-agent. No more
   "dev environment is off, or this is a sub-agent" as a list of guesses.
3. TC-6937 (P3): step lines say "Work folder › frame1.png" for `$TRINA_WORK` too; a box_shell line drops the leading
   `cd "$TRINA_WORK" &&` and says the folder in words (also for lines saved before, at render).
4. TC-6938 (P3): write/edit of the work folder steer to a box_shell command or copy_files, and say not to save an extra
   copy; box_shell and write texts say the same. The API engine's "One step didn't work" line leaves out a refused save
   that a later step made or handed over by another route (same file name).
5. TC-6939 (P3): the shared read card for copy_files into `chat:work/` or `chat:files/` names the files (up to three, else
   "N files") and says everyone in the chat sees that place.
6. TC-6940 (P3): the server's texts fill Korean particle marks the way the web app does (`koParticle`): "내 개인 폴더를".
   The AI chat is 채팅 in Korean (the card, its footer); 대화 is the room list. The chat-file chip said "이 대화": now
   "이 채팅".
7. TC-6941 (P3): refusals the AI passes on are plain: "this deck has 3 slides", "This chat has no files of its own",
   "save it in My files"; no "main assistant", `<attachments>`, `users/<your id>/`.
8. TC-6942 (P3): a Word file with no page size or margins (pandoc's default, what make_file writes) gets Word's default
   page (Letter, 1 inch margins) in the preview, in Files and in a chat alike. #265's fit-to-width stays its own.
9. TC-6943 (P3): reading slides as pictures says "View slides 3–5 · launch.pptx", with a slide icon.
10. TC-6944 (P3): a guest whose team's AI is not for guests reads "AI isn't available for guests in this team."
    (`guest_no_ai`), not "Let your admin know".

Out: a default page in the .docx make_file writes (the preview fix covers both places); renaming every Korean 채팅.

## Steps

1. Plan (this file).
2. Server and shared fixes 2, 4, 5, 6, 7, 10 with unit tests.
3. Shared step lines 3, 9 with tests.
4. Web 1, 8, 10 with tests; i18n en first, then the other five.
5. Typecheck, check:prepush, area tests, web unit tests (Bun 1.3.12); visual check on a private QA copy.
6. Independent review, one PR into dev (not enqueued).

## Decisions

None new. Follows docs/decisions/20261121-chat-places-as-paths.md (one `shownPlace` for every spelling, the people-change
words) and "Plain words in errors, cards and steps" (docs/DECISIONS.md).

## Risks

- Tool texts change (box_shell, write): the engine prompt pins are updated.
- `tr()` now changes Korean particle marks after a filled value: only where the value's reading is known, as in the web.
- No migration.

## Tests

- `tests/unit/chat-places-qa-a.test.ts` (step lines, work words, card text, particles, refusals, slides, guest words)
- `tests/unit/api-engine-honest.test.ts` (a refused save superseded by a command or copy_files)
- `tests/unit/places-parse.test.ts`, `places-produce.test.ts` (the work refusal by reason)
- `web/test/unit/chat-places-qa-a.test.ts` (link steps, default Word page, guest error words)

## Result

All ten findings fixed as in Scope, plus the review's points: absolute work-folder paths of list/glob/grep are
recorded in a shared chat like the other spellings, the copy card says it reads that place (its yes covers the place
for the answer), "the people changed" is said only when the folder is new or was made after the change (conditional
line), project chats check where commands run first, room_file decks say slides, the shell-variable match stops at
the name's end, the "didn't work" exemption covers only refused work-folder saves made later by name, and the link
effect runs once per link. Visual check on a private QA-Acme copy (port 19851) at 1440/390, light and dark; the Word
page also checked merged with #265 (call `defaultDocxPages` before `docxPageWidth` when the two meet).
