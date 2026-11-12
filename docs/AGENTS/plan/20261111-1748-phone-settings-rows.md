# Phones: Settings sections as rows and switches; computer-only setup not offered; no loops

- Date (UTC): 2026-11-11 17:48
- Branch: `fix/phone-settings-rows` (started on `batch/phone-settings`; base `dev` once #344 merged)
- Status: done
- Where: `web/` (Settings sections, Notifications, AI apps, Apps, the connection dialog in the phone app). Why: phone
  layouts of the shared Settings are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Phone layouts and wording only; no API or data change

## Goal

QA TC-261, TC-262, TC-263 (phone audit 2026-11-11). On a phone the owner found Settings "too web": text buttons, web
radios and chips, a trash that deletes at once, a push button under "this device" that turns push off everywhere, an
"Open Activity" box that loops back to Activity, three sections about what the AI may open, and setup screens for
things a phone cannot do (connecting a service, setting up Claude Code, downloading the Mac/Windows app).

## Scope

In (below 768 px; the phone app where noted; computers unchanged):
- TC-261
  - Memory: "+" in the bar; a row opens its edit sheet; delete there asks first; "Forget all" a red row.
  - Security & devices: "Change password" and "All devices" rows open pages under the section; device icons from the
    user agent (Safari on iPhone is a phone).
  - Notifications › This device: push is a switch; turning it off on every device is its own red row with a confirm.
  - Notifications › messages to be notified about: checkmark rows instead of radios.
  - AI accounts: an "Add account" row under each provider.
  - Profile: language and theme as checkmark lists (the theme's save handling stays #426's).
  - Sign out asks first.
- TC-262 (the phone app)
  - Adding a service (+, a service's Connect, adding by address) says "connect on a computer" instead of a form with
    Save and Advanced; a connection's row has no Edit there.
  - AI apps: the connected apps and Disconnect, and one line to set apps up on a computer.
  - Apps: a row that sends the team's Apps page to a computer instead of Mac/Windows downloads; no server hint.
  - The owner's "no installers" hint no longer names the office command (`~/TeamAX/teamax`).
- TC-263
  - Notifications: no "Open Activity" box on a phone (the 나 list has Activity).
  - Browser, Allowed for Trina and Dev environment sites: one phone page (Allowed for Trina) with three sections; the
    list shows only that row; the old addresses open it. Each part keeps its own condition (Browser's from #432, the dev
    environment's while it is on).
  - "Just for you" not on a phone's Settings sections.
  - The schedule-review banner on Trina-tab pages as one row on a phone.

Out: Connectors page layout (#399, admin agent), Me › Connectors in the 나 tab (nav-model), Activity's tools row
(menus-tabs), Admin's own pages (admin agent), a server route to sign out every other device.

## Steps

1. Plan (this file).
2. TC-263: Notifications box, scope line, the folded page, the banner row.
3. TC-261: Memory, Security pages (two routes under /settings/security), push switch, checkmark rows, Add account row,
   Profile lists, sign-out confirm.
4. TC-262: the phone app's connection dialog and row, AI apps, Apps.
5. i18n in five locales, `changes/phone-settings-rows.md`, phone e2e `web/test/e2e/phone-settings-rows.spec.ts`.

## Risks

- #432 changes when Browser shows (its lines are left alone; the fold uses whatever the dialog shows).
- #399 removes Settings › Connectors; this touches neither its lines nor the Connectors page.
- #426 owns the theme's save error; the phone list calls the same setter.
- Two new addresses (/settings/security/password, /settings/security/devices): nav-model's screens.ts should name their
  parent /settings/security.
- Five languages; desktop screenshots at 1440 before and after.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, and the new
phone spec at 390×844 (owner and member) on its own port.

## Result

Built as planned, PR #469. Differences:
- Apps and AI apps change on a phone itself (the phone app, or a browser on an iPhone or Android phone), not by
  width: a narrow window on a computer keeps the Mac/Windows files and the setup steps.
- Also on a phone: Profile's account deletion request is the page's last row; Settings' schedule folder pickers are
  value rows; Allowed for Trina's own Delete is a 44 px icon.
- "This device off" uses the existing per-session endpoints; the phone app remembers it (`mycel.phonePush.offHere`)
  so it does not register the phone again by itself.
- Not here: the Google Drive page and the Connectors page layout (#399 and the admin agent), Me › Connectors staying in
  the 나 tab (nav-model; #457's screens.ts should give /settings/security/password and /settings/security/devices the
  parent /settings/security).
