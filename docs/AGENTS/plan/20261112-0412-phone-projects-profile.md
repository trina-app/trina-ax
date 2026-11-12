# Phones: Projects as rows, a project's files without the path, Profile and Change password like a phone

- Date (UTC): 2026-11-12 04:12
- Branch: `fix/phone-projects-profile-2` (first `fix/phone-projects-profile`, #562, which had #560 merged in; replaced
  so this branch leaves the bar to #560)
- Status: in progress
- Where: `web/` (pages/Projects.tsx, pages/Settings.tsx, pages/Auth.tsx). Why: the phone app shows the web app; these
  screens' phone layouts are web code.
- Version impact: patch, phone layout only; computers unchanged

## Goal

The owner, testing the iPhone app: "아직도 우리 모바일 화면이 많이 구린데… 아직도 데스크톱 화면이 그냥 단순히 모바일로만 된게
많은데". Member screens still look like a shrunk desktop page. QA rows:

1. TC-380: ☰ › Projects shows bordered cards with "No instructions."; a project's Files shows the raw folder path
   ("projects/QA 프로젝트"). Phones get one row per project (name, who sees it, when its last chat was, ›) and no path
   line on the project's files.
2. TC-381 (Settings part): Me › Security & devices › Other devices and › Change password show ‹ without its name in
   English ("Security & devices" does not fit beside the centred title, so the bar hides it). ‹ names the page it
   returns to. Admin's pages are another session's.
3. TC-382 items 1–2: Profile has a "Choose a photo" outline box beside the avatar and web form fields; Change password
   has a small orange button on the left. Phones get a centred photo you tap to change (the same photo choices), the
   name, job title and email as grouped rows, Save in the bar (it still shows only after a change and saves the same
   way), and one full-width button under the password form.

## Scope

In:
- `Projects.tsx` list on a phone: a phone list (components/phone/PhoneList.tsx) of rows; a long press on a row opens
  its menu as a sheet (rename, members, copy link, delete), as the Chats list does; the "+" stays in the bar.
- `Projects.tsx` ProjectFiles: no path line.
- Settings › Profile on a phone: the photo block, the fields as rows, Save in the bar (SettingsBar.tsx), username and
  role as list rows. Save stays one button that appears after a change and saves name, title, photo and email.
- Change password on a phone: the button full width.
- The ‹ label on the two pages under Security & devices: both pages already pass "Security & devices" (SettingsDialog
  `useBackLabel`); the bar hid it in English because it does not fit beside the centred title. That rule is in the
  shared `PhonePageBar.tsx`, which #560 (fix/phone-admin-system-2) changes for every page (the title moves over instead
  of the name hiding). This branch does not touch the bar or the label mechanism; it adds the Settings e2e (the name
  passed on both pages, shown whole in Korean now and in English once #560 is in).
- Strings in 5 locales, phone e2e (Chromium + WebKit), 1440 screenshots before/after, changes fragment.

Out: Admin pages (another session), `pages/Connectors.tsx`, the desktop layouts, the profile's save model, server
changes (the list's last-chat time comes from the chats the app already holds).

## Steps

1. Plan (this file).
2. Projects rows and the files page; Profile; password button.
3. ‹ labels: check both pages pass the name; e2e (the bar's English layout is #560's).
4. e2e `phone-member-pages.cases.ts` (Chromium + WebKit specs); computer screenshots; checks; PR.

## Risks

Phone layout only; computers keep their markup (checked with 1440 screenshots). PhoneList.tsx gains optional props
only. The profile's Save in the bar is the same submit of the same form (the `form` attribute), so Enter and the
button behave as before. Existing phone e2e that tapped a project card's "···" changes to the long press.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, the new
phone e2e (Chromium and WebKit) and the phone specs that cover these screens.

## Result

(filled in at the end)
