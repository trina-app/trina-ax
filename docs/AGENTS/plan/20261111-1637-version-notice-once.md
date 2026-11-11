# "A new version is ready" shows once, not once per reconnect

- Date (UTC): 2026-11-11 16:37
- Branch: `fix/version-notice-once`
- Status: done
- Where: web app (`web/src/store/live.ts`). Why: a web bug in the shared client, used by the browser, desktop and phone apps (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no API or data change

## Goal

QA TC-273 (from TC-099 on an Android phone): the phone app showed four identical sticky "A new version is ready.
[Reload]" notices stacked over the home screen. Every hello after a reconnect whose server version differs from the
first one raised a new sticky toast, and the toast list keeps up to five without removing duplicates. People should
see the notice once.

## Scope

In: the hello handler raises the notice only the first time it sees a newer server version in this page; later
reconnects (same or another newer version) add no second notice. The notice logic moves into a small exported
function so a unit test can drive it.
Out: de-duplicating other toasts in general; the office update banner (already hidden while updateReady is set).

## Steps

1. Move the onHello version check in `startLive` into `serverHello(serverVersion)`; return early when the version
   is the first one or when `updateReady` is already set.
2. Unit test in `web/test/unit/live.test.ts`: hellos with versions 1, 2, 2, 3 raise exactly one notice.
3. `changes/version-notice-once.md`.

## Risks

None for data or permissions. If a person dismisses the notice, a later reconnect does not bring it back; the app
already shows the ready state elsewhere (Layout reads `updateReady`).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test web/test/unit/live.test.ts`.

## Result

Built as planned: `serverHello()` in `web/src/store/live.ts` raises the notice once per page; the unit test drives hellos
1.0.0, 1.0.0, 1.1.0 ×3, 1.2.0 and sees one notice. Checked: web typecheck, check:i18n, check:docs, live.test.ts.
