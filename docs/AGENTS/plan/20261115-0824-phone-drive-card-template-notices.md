# Phone app Drive card follows Settings; template notices say sign in or key, and tell people left out

- Date (UTC): 2026-11-15 08:24
- Branch: `fix/phone-drive-card-template-notices`
- Status: in progress
- Where: web/src/components/chat, web/src/components/settings, server/src/notifications, server/src/integrations/connections. Why: QA TC-2977, TC-2980.
- Version impact: patch: fixes wording and adds one notice; no API removed, no migration.

## Goal

1. TC-2977. In the phone app, Settings › Connectors › Google Drive says "Connect Google Drive on a computer." with no
   button. The chat card for Drive offered "Connect Google account" and a browser sign-in. The card now says the same
   line and has no connect button in the phone app (the same `mobileApp()` check Settings uses).
2. TC-2980. Team template notices: a sign-in template says "sign in again with your own account", a key template "enter
   your own key again"; the "is ready" notice follows too. A member that an admin's narrowing leaves out (alone or with
   an address change) and whose connection is dropped gets one notice: "You no longer have access to {name}." The
   earlier notices keep the template's name (no link) while the template is there.

## Scope

In: the chat card's Drive case on the phone app; the template notice texts (6 languages); one new notice row (same
table and event type as the reconnect notice, its own source form, so no migration).
Out: Drive on a phone browser (unchanged, it can sign in there); other connector cards.

## Steps

1. ConnectCard: in the phone app, `google_drive` shows `integrations.onComputer` (or `reconnectOnComputer` for a
   reconnect card) and no Drive button; "Not now" stays. Remove `drive.mobileBrowserLogin` if unused.
2. Server: the template notice view adds `template.signIn` (oauth templates) and `templateLeft` (the left-out
   notice); the name shows while the template is there, the link only while it is still for the person.
3. dropFromTemplate(..., 'not_covered') records the left-out notice (source `<template>.left.<connection>`).
4. Web: Notifications.tsx picks the words from `signIn` / `templateLeft`; generic words when the template is gone.

## Risks

No migration. An older app reading the new row shows the old reconnect words (same code). The name of a template is
shown to someone it was for before; they saw it then. Plain-words check: "sign in", "key", "no longer have access",
no "template" jargon beyond the existing "team template".

## Tests

typecheck, check:i18n, check:docs, unit tests c-integration-templates and the notifications tests, test:web, build:web,
e2e integration-templates and the chat connect card specs. Screenshots 1440/390 before and after.

## Result

