# Step lines name a saved-to place in words, never users/<id>/...

- Date (UTC): 2026-11-24 13:11
- Branch: `fix/step-list-place-names` (off `dev`)
- Status: in progress
- Where: shared/src/step-labels.ts. Why: QA on qa.trina.app, "작업 N단계" of a Word report chat showed "작업 결과 저장 · … → users/qa-member/보고서/".
- Version impact: patch: a step line's wording only.

## Goal

Non-developers see where a file went as the file screen says it ("내 파일 › 보고서"), not a server path.

## Scope

In: `stepPlace` (the one function every step line passes) words the target after " → " of any tool's line through `placeName` (the file browser's names, all six languages, own-folder word from folder-labels.ts); a target that is no team path (a new name, a group) is left as it is. The save tools that end their line with a path after " · " (save_connector_file, save_promo_video, comment_docx) join the path tools.
Out: the "downloads" folder is a real folder name on disk and the file screen shows it as it is; no place label is involved, so it is left.

## Steps

1. Plan. 2. arrowPlace in step-labels.ts. 3. Tests in tests/unit/step-labels-tools.test.ts (six languages, cover suffix, non-path target).

## Decisions

none.

## Risks

None for data: display only.

## Tests

`bun run typecheck`, step-labels and chat-places unit tests, `bun run check:prepush`.

## Result

(after the PR)
