# QA-B findings: chat file versions, the edit panel, Share with files, Make it a project

- Date (UTC): 2026-11-21 19:39
- Branch: `fix/qa-b-chat-files-share-project`
- Status: done
- Where: web (file panel, Share dialog, Make it a project dialog, rooms store), server (chat file versions, make-project,
  chat audience, turn). Why: fixes of QA rows TC-6945..6962 on code already in dev (see docs/REPOSITORY-RULES.md)
- Version impact: patch: wording, layout and small behaviour fixes of shipped features; no new feature, no migration

## Goal

Tonight's QA-B pass found rough edges in the features merged on 11-21 (chat file versions, the S2 edit panel, Share
with files, Make it a project). Fix each one small and in the style of the code around it.

## Scope

In (one line each; QA row):

- TC-6945 Share dialog at 390: the files step's two buttons stack full width; Copy link stays off the phone footer
  while that step shows (it comes back on the saved toast).
- TC-6946 "Moving files…" stuck after Make it a project: the POST answer (made with filesMoving before the moves ran)
  can arrive after the room.updated that says the moves settled, and overwrote it. The store keeps the room's own
  word heard while the POST is on its way.
- TC-6948 Versions list: no fixed 256 px box; a taller list (most of the panel) with a fade at its bottom edge while
  more rows are below.
- TC-6949 Restore at the cap: the server says which versions the save pruned (`ChatFileSaved.pruned`); the toast says
  "Version 9 was removed to keep 20 versions" instead of "Nothing was deleted".
- TC-6950 The gap in version numbers after the cap: one quiet line under the list.
- TC-6951 Share → everyone removed: one line "Only you will see this chat and its files…", no "Everyone here sees…"
  note, no Copy link, and no Copy link on the saved toast of a chat that became private.
- TC-6846: already fixed by PR #265 (open): skipped.
- TC-6952 "Updated by Trina for Q…": the tile and the panel header wrap the line instead of cutting the name; full
  text as the title too.
- TC-6953 Duplicate project name: the body names the folder the project will get (the "-2" one), as the hint does.
- TC-6954 Empty project name: inline "Enter a project name." (both dialogs).
- TC-6955 Default project name: the conversation's name, else "New project" (selected, so typing replaces it) instead
  of the other people's names.
- TC-6956 Someone saves while I edit: a quiet live line "<name> saved a newer version · View" in the editor; the
  conflict toast names them and has View (opens their version).
- TC-6957 A 0-byte file: "This file is empty." instead of a blank panel.
- TC-6958 read {versions}: already one line per version with the time, the person or "Trina for <person>": model
  error, no change.
- TC-6959 Private-again chat, "One step didn't work: Copy files": the AI tried copy_files to chat:files/ in a chat
  only the person sees (refused with personalSave). Steering: the copy_files description and the refusal say a chat
  only the person sees attaches nothing and a file in their own folder is linked instead. The "didn't work" rule
  itself is TC-6938's PR.
- TC-6960 403 of make-project in an admins-only team: "Only admins can make team projects in this team."
- TC-6961 A guest added to a people-shared chat: "Guests can't be added to a shared chat…" instead of "no longer on
  the team".
- TC-6962 (security) A k mark after a version save in the same answer: possible today (a connection call after a
  save records a k group; only attachments block that). Fix: an answer that saved a chat file version is never made a
  k answer (the connection's answer is refused, as for an attached file).

Out: the "didn't work" rule (TC-6938), the Word preview (TC-6947, PR #265), a per-version answer record.

## Steps

1. Plan (this file).
2. Server: pruned versions and the replaced head on ChatFileSaved; make-project default name and 403 words; guest
   words; personalSave and copy_files steering; the k guard after a version save. Tests in tests/unit.
3. Web: the dialogs, the file panel, the rooms store race. en.ts first, then ko, ja, zh, es, id. Tests in web/test/unit.
4. Checks with Bun 1.3.12, a look on a private QA copy (1440 and 390, light and dark), an independent review.

## Decisions

none (TC-6962 extends the existing "an answer with an attached file never becomes a k answer" rule to chat file
versions, docs/decisions/20261121-share-chat-files.md context).

## Risks

ChatFileSaved gets optional fields (older clients ignore them). No migration. The k guard refuses a connection call
after a chat file save in the same answer in a shared chat: the AI answers without it (the same as after an attach).

## Tests

`bun run typecheck`, `bun run check:prepush`, the area's unit tests (chat files, make-project, shared chats, places)
and web unit tests.

## Result

Built as planned, plus what the independent review asked for: the editor's "saved a newer version" line shows only
for a save past the version the editor opened and not my own; the restore notice says "20" from a constant; the
pruned line sits where the numbers jump (between the oldest kept and version 1); a connection call after a chat file
save in the same answer gets its own words ("this answer already saved a new version of a file of this chat…")
instead of "could not check"; ko/ja put no honorific on the AI's name; the closing line and the body name the "-2"
folder through a new optional EventProject.folder. TC-6846 is left to PR #265; TC-6958 needs no change (model error).
