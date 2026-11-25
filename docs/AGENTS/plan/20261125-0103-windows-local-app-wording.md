# Apps on the computer: say the real reason, the install link and a visible Check again

- Date (UTC): 2026-11-25 01:03
- Branch: `fix/windows-local-app-wording`
- Status: done
- Where: shared/src/api/local-apps.ts, desktop/src/common/programs.ts, server/src/integrations/connections (local.ts,
  text.ts, tools.ts), web Settings › Connectors. Why: QA on 0.18.0 for Windows apps on the computer (TC-9006..9009).
- Version impact: patch (wording and one visible button; no API, protocol or data change)

## Goal

When an app on the computer cannot start, the person and the AI hear the real reason and the one thing to do:

- TC-9006: ego lite not installed: the AI said it "isn't set up" with no link. Its words now come from the connection's
  last check: not installed, with the app's download page (one function also used for a failed call).
- TC-9007: a program on a network share (`\\server\share\x.exe`) said "could not start, check the command". It now says
  network paths are not allowed and to copy the program to this computer (the form says so before saving, too).
- TC-9008: the form's error listed only `| & ;`. The characters it refuses and the ones a batch file refuses are one
  list each in shared/src/api/local-apps.ts; the splitter, the desktop app and the words all read that list.
- TC-9009: "press Check again" pointed at an action inside ⋯. A failed check whose fix is to check again shows a
  Check again button next to its message.

## Scope

In: the reasons `local_share`, `local_unsupported`, `local_unsafe` (from the desktop's existing `cause` and the command
the server already keeps: no protocol change), the AI's line for an app with no tools yet, the form's error, the button.
Out: new presets, changing what is refused.

## Steps

1. Shared: refused-character lists and `windowsShare` in local-apps.ts; splitter and desktop use them.
2. Server: LocalError reasons from cause + command; texts in six languages; tools.ts line from the last check.
3. Web: form error with the list and the share case; Check again button by the error note; en is the source, ko too.
4. Tests in tests/unit (e-local-apps-windows*.test.ts).

## Decisions

none

## Risks

Six languages for every new text. An older desktop app sends no `cause`: it still reads `local_failed` as before.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, tests/unit/e-local-apps-windows*.test.ts and the
other local-app unit tests.

## Result

Built as planned. The Check again button shows for local_declined, local_failed, local_missing and for a slow or
failing service (the step's words now say "Press Check again"); local_share, local_unsupported and local_unsafe say to
add the program again, so they get no button. The es and ja words for the existing local reasons now name the button as
it reads. Tests: tests/unit/e-local-apps-windows-wording.test.ts, web/test/unit/local-app-page.test.tsx. PR: see the
pull request that links this plan.
