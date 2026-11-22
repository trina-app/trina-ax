# The failed-step line: superseded steps, the answer's language, the sign-in claim's words

- Date (UTC): 2026-11-21 23:36
- Branch: `fix/honest-superseded-steps`
- Status: done
- Where: server (`engine/api-honest.ts`, `engine/api-agent.ts`, `auth/messages.ts`). Why: the API engine's honesty
  rules and the claim route's words live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Fewer wrong "didn't work" lines and corrected words; no API change.

## Goal

QA rows TC-7051 / TC-6959, TC-7052, TC-7045 and TC-7053:

- TC-7051 / TC-6959: in a chat made private again, a save to `chat:files/todo.md` is refused on purpose and the AI
  saves `users/<id>/todo.md`. The answer still ends "One step didn't work: Save." Only refused `chat:work/` saves were
  settled by another route.
- TC-7052: `chat_file` called with no file (bad arguments), then a `read` of `chat:files/<id>/notes.md` worked. The
  answer ends "One step didn't work: Read chat file." (different step keys).
- TC-7045: a failed `edit_pdf` of a chat file, then the AI made the file again with `make_file` and attached it. The
  line still names Edit PDF, and it is in English in a Korean chat (the line follows the app's language, not the
  answer's).
- TC-7053: the desktop claim refusal says "Start the Drive connection again" for every connector.

## Scope

In:
- `FailedSteps`: a refused write, edit or file-edit tool (`edit_pdf`, `edit_office`, `edit_hwp`, `stamp_pdf`) of a
  chat place (`chat:files/`, `chat:work/`, `$TRINA_WORK/`) is settled when a later call that worked made a file with
  the same name anywhere (write, make_file, save_work_file, copy_files, a command's output, a file-edit tool's output).
  A failed file-edit tool of a team file is settled only by a later file made at the same path. A refused team-file
  write still counts.
- `FailedSteps`: `chat_file` and `read` are one read step. A failed one without a target is settled by any later read
  that worked; a failed read of a chat file is settled by a later read of the same file (same id or same name).
- The line's language: the answer's script (Hangul -> ko, kana -> ja, Han -> zh); a Latin-script answer keeps the app
  language when that is a Latin one, else English. Step names stay the server's plain words (stepWords), never ids.
- `driveClaimGone` -> generic words, "Start the connection again from the app.", in all six languages.

Out:
- A failed `copy_files` that nothing replaced (flow 5 in TC-7045) stays a failure: the file was not attached.

## Tests

- `tests/unit/api-engine-honest.test.ts`: each rule above, plus the localized line in the loop.
- A test of the claim refusal's words (no "Drive" in any language).
