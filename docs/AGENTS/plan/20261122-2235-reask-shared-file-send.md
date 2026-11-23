# A late press on a post card is not asked again for a file count

- Date (UTC): 2026-11-22 22:35
- Branch: `fix/reask-shared-file-send`
- Status: done
- Where: server/src/chat/open-questions.ts. Why: the rule that compares a pressed card with the card the call raises again (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to an extra card with no new feature

## Goal

On qa.trina.app (dev 02ea01f89), a person sent a file to a teammate and pressed "보내기" on the card. The card came
back with "누르신 뒤에 바뀐 게 있어요. 한 번 더 확인해 주세요". The second press sent it. The two cards on the
server (answered_questions) differ in one place only: "1명은 이 내용의 일부 출처(내 파일)를 볼 수 없어요." on the
card that was pressed, "(내 파일의 파일 1개)" on the card after the press. The file, the person, the text and the
buttons are the same.

Cause: the card names how many files were read in a place only when the answer's saved list holds all of them
(answer-share.ts `of`, `fromScope`). The live run counts the file it just read from the turn's read scope, so no number.
The run after the press reads the saved list, so "1 file". This is the same source for the same people, so it is a
false change. It is not the #415 chat-file copy: the file was a team file in the person's own folder.

## Scope

In: `sameCard` treats a source place with or without its file count as the same place, in every language. The people
count, the places and every other line are still compared.
Out: making the live run and the saved run count the same way (a wider change to the share check).

## Steps

1. A test that sends a file after a read in the same answer, presses the card late and expects no second card. It
   fails on dev.
2. `sameCard` drops the file count from each place inside the sources line's brackets before it compares.
3. A rules test with the two QA cards word for word, plus cases that must still ask again.

## Decisions

None. This narrows "a card that reads differently now" (docs/decisions/20261122-late-card-answer-resumes.md).

## Risks

A real change in only the number of files read in one place no longer asks again. The people who cannot see the sources
and the places are still compared.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/b-late-card-answer.test.ts and the share and post card tests.

## Result

Built as planned.
