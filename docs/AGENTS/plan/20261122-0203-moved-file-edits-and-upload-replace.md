# A moved file is found where it is now; a same-name upload asks "Replace or keep both"

- Date (UTC): 2026-11-22 02:03
- Branch: `fix/moved-file-edits-and-upload-replace` (on top of PR #318, `fix/scenario-qa-file-versions`)
- Status: draft
- Where: server/src/files, server/src/team-files, server/src/tools, web/src (Files, FileBody), shared/src/api. Why:
  scenario QA TC-7234 (S-018, with rerun rows TC-r2b-01 and TC-r2b-02) and TC-7241 (S-029).
- Version impact: patch. Fixes to shipped features; one new read-only endpoint and one optional move warning.

## Goal

- **TC-7234 / TC-r2b-01.** The AI wrote a poster into a project folder, someone moved it to `shared/마케팅`, and the AI's
  next edit made a new copy in the chat (or claimed "박준호 님이 삭제했다"). The AI only got "not found or no access", so it
  guessed. Now a tool that cannot find a path that was moved is told the true fact: "moved by X on <date> to '<new
  path>'" (when the person may open it there) or "moved by X to a place this person cannot open; it was not deleted",
  or "X put it in the trash". With the new path the AI edits the file where it lives now; that edit is a new version
  under the usual team-file rules and edit_office's gates (#252, #318). If the person cannot write there, the refusal
  stands, and a prompt line tells the AI to say where the file is and where its edited copy went.
- **TC-r2b-02.** The moved file's link in the chat opens a panel that says only "can't be found, or you don't have
  access". Now the panel says "Moved to 전사 공유 › 마케팅 by 박준호 · Nov 22" with an Open button, or "박준호 moved this
  file to a folder you can't open", or that it went to the trash. Moving a project file into a company-wide folder
  now asks "N more people will see it" like a move out of a personal folder does (the Files screen's existing widen
  confirm, one new sentence).
- **TC-7241.** Uploading on the Files screen a file whose name is already in the folder silently made "(2)". Now one
  small dialog asks first: "A file named X is already here." [Replace (keeps the old one as a version)] [Keep both].
  Replace sends `onExists: 'replace'`, which already keeps the old bytes as a version (team-files placeUpload →
  snapshotVersion, the team folder's version store; chat files use putVersion, but a person's upload here lands in a
  team folder). Where the name is a folder (nothing to version), only Keep both is offered and the message says why.

## Scope

In:
1. `server/src/files/moved.ts`: `whereNow(db, rel)`: the newest delete event of the path or a folder above it, followed
   forward (moves and folder moves, trash and restore; files/timeline.ts placeNow style) to the place now: `moved` (to,
   by, at), `trashed` (by, at) or null. Callers judge access: the old folder must be one the person may list, the new
   path one they may read (authorize), else no new path is given.
2. AI tool results: files/service.ts `call` and tools/registry.ts `call`: a "not found" refusal (`not found or no
   access: 'x'`, `not found: 'x'`) gets the move fact appended. Only facts, never a guessed cause.
3. Prompt: one line (moved file: use the new place; cannot write there: say where it is and where the copy went).
   Prompt pin fixtures updated.
4. `GET /api/files/moved?path=` (owner C): `{status: 'moved', to?, by, at} | {status: 'trashed', by, at} | {status: 'no'}`
   with the same access rules. Web: FileBody's "missing" team-file error (and ChatFileAsk's "no") shows `FileMoved`.
5. team-files move: `askWiden` warns for any source where people are added, not only a personal folder. Web: a new
   body text `files.widenBodyAny` for a source that is not the person's own folder.
6. Files screen uploads (picked or dropped files, not folder uploads): taken names are checked against the folder's
   listing; one dialog per taken name (Replace / Keep both / Cancel). en.ts first, then ko, ja, zh, es, id.

Out: an artifact saved with "Save to team folder" keeps no link to its saved copy, so an artifact edit does not update
that copy (the rerun shows posters are now PNG files, which item 2 covers). Folder uploads, room and chat composer
uploads (no shared names there) keep today's behaviour.

## Decisions

none (follows docs/DECISIONS.md "Files from the computer…" and the version rules; no new design rule).

## Risks

- No migration. Access: the move fact is told only to someone who may list the old folder; the new path only to
  someone who may read it there (hidden folders stay hidden).
- The widen warning now shows for more moves (e.g. a group folder to `shared/`): only when people are added.
- Six locales; 1440 and 390 for both dialogs and the moved panel.

## Tests

- Unit: whereNow (file move, folder move above, trash, restore, hidden target); tool result texts; /api/files/moved
  access; move askWiden from a project folder; web: upload name-clash helper.
- `bun run typecheck`, `bun run check:prepush`, area tests, web unit tests (Bun 1.3.12). Visual check on a private QA
  copy at 1440 and 390.

## Result

(filled in at the end)
