# A wrong password in the restore dialog keeps the dialog open

- Date (UTC): 2026-11-11 14:43
- Branch: `fix/restore-wrong-password`
- Status: done
- Where: `web/src/pages/admin` (core web). Why: a bug in Admin › System's password dialogs (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a bug fix on an admin screen

## Goal

QA TC-221 (P3). Admin › System › Backups › 복원, a wrong password, 복원: the dialog closes and a toast says
"비밀번호가 맞지 않아요. 다시 입력해 주세요.", so the owner starts over (open the dialog again, read it again). The
restore was refused correctly. Cause: the dialog's `onConfirm` closes it before the request is sent. The update install
(System › 업데이트 설치 / 되돌리기, Admin home's 지금 설치: `useUpdateInstall`) does the same.

After the change a wrong password keeps the dialog open with the message under the password field, and the field is
selected for typing again. Any other error is a toast and closes the dialog, as before.

## Scope

In: `ReauthDialog` shows an error under its password field when `onConfirm` returns one (clears when the password
changes); `passwordRefusal(e, locale)` (the server's `fields['body.password']` answer); restore and update install use
them and close the dialog only when the job started.
Out: other ReauthDialog uses already stay open on an error (connection mode, connected folder, removing a member); they
keep their toast.

## Steps

1. common.tsx: `ReauthDialog` error state; `passwordRefusal`.
2. System.tsx restore, jobs.tsx update install: start the job inside the dialog; a password refusal goes back to it.
3. Tests: a web unit test of the dialog; e2e (mock server) for restore with a wrong password.

## Risks

No server change, no new text (the server's message is shown). Phone width: the field error is the same Field as
elsewhere.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, the related e2e spec.

## Result

As planned. `ReauthDialog` shows what `onConfirm` gives back under its password field and selects the field;
`passwordRefusal` / `useReauthCall` in admin/common.tsx; restore (System.tsx) and the update install (jobs.tsx) start
their job inside the dialog and close it only once it started (any other error: toast and close, as before). The mock
server got `startRestore` (owner password like the server). e2e `system-console.spec.ts`: a wrong password keeps the
dialog with the message under the field and the field focused; typing clears it; the right password closes it and shows
the done toast. A unit test of the dialog alone was not added (the e2e covers it in the real page).
