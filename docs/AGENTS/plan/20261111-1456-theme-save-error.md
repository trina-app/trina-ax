# A theme change that can't be saved says so and doesn't flip back later

- Date (UTC): 2026-11-11 14:56
- Branch: `fix/theme-save-error`
- Status: done
- Where: `web/src/store/session.ts`, `web/src/pages/Settings.tsx`. Why: settings are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: a failed save says so instead of failing silently

## Goal

QA TC-239: offline, Settings › 프로필 › 테마 › 어둡게 turns the screen dark at once with no error, while the selected
button stays 밝게 (or 시스템 설정 따르기). The account keeps light, so a reload or a second tab is light again, with no
word. `setTheme` applies the theme before saving and never puts it back; Settings swallows the error
(`setTheme(x).catch(() => {})`).

## Scope

In:
- `setTheme`: still shown at once; when the save fails, the theme in use before goes back (the account's theme, else
  the one this device used before the picks not saved yet) and the error goes to the caller. Only the latest pick
  decides (two quick picks: an earlier answer never undoes a later one).
- Settings shows the error like the language buttons next to it do (`error.network` text when offline).

Out: the text size (it keeps what was picked on this device and already says when the save fails).

## Steps

1. `web/src/store/session.ts` setTheme.
2. `web/src/pages/Settings.tsx`: the theme buttons toast the error.
3. Unit test (`web/test/unit/session-theme.test.ts`): offline pick goes back and throws; a saved pick stays; two picks
   in a row, the earlier saved and the later not, and both not saved.
4. `changes/theme-save-error.md`.

## Risks

No new UI text (the existing network error). No server change. Phone and computer use the same Settings page.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new unit test, `bun run test:web`; a local dev
server check offline (Playwright `setOffline`).

## Result

Built as planned. `setTheme` keeps `themePick` (the latest pick still saving, and the theme in use before the picks not
saved yet); a failed save of the latest pick puts back the account's theme, else that one, and rethrows. Settings shows
the error with the network text, as the language buttons beside it do. No new strings.
