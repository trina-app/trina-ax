# 옮기기 from the after-upload line suggests team places, not 내 파일 subfolders

- Date (UTC): 2026-11-26 09:00
- Branch: `fix/share-move-suggestions`
- Status: in progress
- Where: web/ (FolderPicker, Files.tsx `pickFromTop`), server/src/team-files/move-suggest.ts, shared/src/api/files.ts
- Version impact: patch (a suggestion filter; one optional request field `widen`, old clients unaffected)

## Problem
The 옮기기 on "내 파일에 올렸어요 · 나만 봐요" (#593) is meant to share. On qa.trina.app the picker's 추천 folders
for a member were all subfolders of their own 내 파일, which share with nobody.

## Fix (general, one rule)
- `POST /api/files/move-suggestions` takes optional `widen: true`: the move is meant to widen who can see the file.
  The server then never suggests (neither 추천 nor 최근) a folder under `users/` (a person's own place); what is left
  are the team, department and project folders the person can write.
- `FolderPicker` gets `suggestWiden` and sends it; Files.tsx passes `pickFromTop` (set only by that line) for the
  single and the bulk picker. Every other Move picker use and the room "Save to team folder" are unchanged.

## Tests
- tests/unit/c-move-suggest.test.ts: with `widen` no `users/...` folder; without it unchanged.
- web/test/unit/folder-picker-suggestions.test.tsx: `suggestWiden` sends `widen: true`.
