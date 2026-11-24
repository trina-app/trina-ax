# Place names, not storage paths, wherever the app shows a team path

- Date (UTC): 2026-11-24 16:05
- Branch: `fix/files-referenced-place-names`
- Status: in progress
- Where: shared/src/step-labels.ts (the place-name helper), web/src (the screens that print a path). Why: one helper
  says a team path in words for every screen (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a display fix with no new feature or API change

## Goal

QA TC-8922: under an answer, "N files referenced" lists each file's folder as a raw storage path
(`users/qa-admin/공문/`) where the rest of the app says "My files › 공문" / "내 파일 › 공문". PR #531 fixed the step
lines with `placeName`; this list and a few other screens still print the disk path.

## Scope

In:
- `placeName` (shared/src/step-labels.ts) learns who is looking (optional `viewer: { me, nameOf }`): my own folder is
  "My files", another person's folder is "<name>'s folder" (never "My files", never their id), `users/` alone is
  "Personal". Without a viewer it says what it said before (the server and the step lines of older callers).
- A web hook `useTeamPlace()` (web/src/lib/teamPlace.ts): `placeName` with this person and the people directory, else the
  Files screen's words (`folderWords().path`), so a path never reaches the screen raw.
- Use it in: the answer's sources list (the bug), step lines (Steps.tsx: a shared chat's viewer is not the asker), the
  "saved to" toast of the artifact panel, the conflict copy line in a file's versions, the skills screens (registered
  at, from, source file, same-name clash, the path line, broken-skill notes), scheduled task template folders, and the
  screen-reader text of a team file chip. Tooltips keep the disk path (folderLabels.ts rule).

Out: server-made texts (server/src/chat/place-words.ts already words them), admin-only debug lists
(admin/FolderLists), the AI's own prompt text.

## Steps

1. `placeName(path, locale, viewer?)` with the other-person branch; unit tests.
2. web/src/lib/teamPlace.ts (`teamPlace` pure + `useTeamPlace` hook); unit tests.
3. Route the screens above through it; SourcesList test for users/<me>/, another person, shared/, groups/<x>/, projects/.
4. changes/files-referenced-place-names.md.

## Decisions

none (follows "Plain words in errors, cards and steps" in docs/DECISIONS.md).

## Risks

Five app languages: the words come from the shared tables. No migration. A people directory read is made only when a
path names another person.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/step-labels-*.test.ts, web/test/unit/answer-sources.test.tsx
and the new web/test/unit/team-place.test.ts.

## Result

(at the end)
