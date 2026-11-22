# Plain step labels for dev-environment commands

- Date (UTC): 2026-11-22 01:56
- Branch: `fix/step-labels-plain`
- Status: in progress
- Where: shared/src/step-labels.ts, server/src/devenv/tool.ts. Why: the step list is shared display code (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a display fix of the step list (one optional tool field, no API break)

## Goal

The step list under an answer shows raw shell lines ("개발 환경 명령 · cd $TRINA_WORK/hf/promo && export NODE_…").
People are not developers. Each box_shell step should read as a short plain sentence in the screen's language
("영상 프레임 만들기", "프로그램 설치"); the command shows only when the person opens the step.

## Scope

In:
- box_shell gets an optional `description` field: one line in its schema asks the AI for a short plain sentence of what
  the command does, in the person's language. Both engines call the same box_shell (Claude Code's own Bash is denied).
- The stored line becomes `<description or the old verb> · <command>` (+ job / background ending), so older apps still
  show something sensible.
- The web app (localizeStep) shows only the words: the AI's description, or, for a step without one (every chat
  before this change too), a plain word by the command's kind: install, make (render / build), download, check files,
  wait, or "run a task". The command moves to the step's opened part.
- The words never show `$TRINA_WORK` paths, env assignments or anything that looks like a command.

Out: prompt.ts and api-honest.ts (no change), notifications, shared-chat code, mobile apps (they keep the stored line).

## Steps

1. shared: `shellStepWords` (description clean-up + kind fallback), box_shell case of stepLabel, box_shell branch of
   localizeStep (label = words, detail = command + any earlier detail).
2. server: `description` in BoxShellInput.
3. Unit tests in tests/unit; web unit tests; visual check on a private QA copy at 1440 and 390.

## Decisions

None (display only).

## Risks

- A description written in one language stays in it after a language switch (the fallback words are translated).
- Shared chats: the command moves from the line into the opened part on the same viewer's screen; nothing new is sent.

## Tests

tests/unit/step-labels-shell.test.ts; existing step-labels tests updated.

## Result

(filled in at the end)
