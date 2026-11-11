# Phone sign-in and join pages: the button above the keyboard, app wording, an admin-only notice, invite retry

- Date (UTC): 2026-11-11 18:57
- Branch: `fix/phone-signin-join`
- Status: in progress
- Where: `web/src/pages/Auth.tsx`, `web/src/pages/admin/AdminLayout.tsx`, `web/src/i18n/*`. Why: sign-in, invites and
  Admin are core web UI (see docs/REPOSITORY-RULES.md)
- Version impact: patch, fixes to existing pages, no new feature

## Goal

QA TC-272 (phone audit ADM-24, ADM-27, ADM-28) and a QA find on 11-11:

1. On a phone with the keyboard up, the invite / team-link form and the forced password change hid their button
   (in a 480px view it sat at 519–559 and 452–492). The eye button had its own row under the fields.
2. Inside the phone app the sign-in pages showed the website's footer: the source code link and a language select.
   The setup page said "설치 토큰".
3. A member who opened an /admin link landed on Home without a word.
4. The personal invite page (/invite/<token>) had no Try again after its details failed to load (the team link has
   one since #404).

## Scope

In:
- The eye button goes inside the password field (its right edge); the Caps Lock note stays under the field.
- On phones the auth page scrolls in its own box, as high as the visible screen (`--app-h`, lib/viewport.ts), and
  the form's submit button sticks to that box's bottom, so it stays above the keyboard.
- Inside the phone app (lib/mobile.ts `mobileApp()`): no source code link, no language select on these pages
  (the app's Settings › About keeps the source offer; the language is the person's or the team's).
- Setup: "설정 코드" instead of "설치 토큰", a plain hint (the wording open PR #38 proposed), in five languages.
- AdminLayout: a member gets "관리자만 볼 수 있어요" and a way to Home, not a silent redirect.
- AcceptInvite: a failed load shows why and a Try again, like TeamJoin (one shared piece).

Out: the desktop app keeps the footer (a computer window); ResetPassword's load error (not reported).

## Steps

1. Auth.tsx: `PasswordInput` (input + eye inside), used by setup, join, forced/settings change; `PasswordRevealRow`
   becomes the Caps Lock note only. `AuthFrame`: own scroll box on phones; footer only outside the phone app.
   `SubmitBar` sticky wrapper. `LoadFailed` with retry, used by TeamJoin and AcceptInvite.
2. AdminLayout.tsx: `AdminOnly` notice instead of `<Navigate to="/">`.
3. i18n: `setup.token`, `setup.tokenHint`, `admin.onlyAdmins.*` in ko/en/id/ja/es.
4. Unit tests: invite retry, admin-only notice, eye inside the field, no footer in the app.

## Risks

No migration, no permission change (the server already refuses admin calls from members). Five languages. Open PR #38
(stale) changes `setup.tokenHint`: this takes its wording. Open PRs #468 / #457 change other lines of AdminLayout.tsx.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests for auth / team link / welcome /
admin, Playwright at 390×844 (WebKit) and 1440 with screenshots.

## Result

