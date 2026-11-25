# Invite and team links open the desktop app first on a computer

- Date (UTC): 2026-11-25 08:15
- Branch: `feat/invite-open-app-first`
- Status: in progress
- Where: web/ (join pages). Why: the owner wants computer browsers to lead with the desktop app (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new default flow on the join pages (no API or data change)

## Goal

Owner, 2026-11-25: "앱으로 우선 열도록하는게 나을 것 같은데.. 없으면 다운받게 하거나. 정 안되면 브라우저..".
Someone who opens a member invite link or a team link in a Mac, Windows or Linux web browser lands in the desktop app,
like Zoom and Slack do. Without the app they are led to download it; the browser form stays as the last way.

## Scope

In:
- The member invite page (`/invite/<token>`) and the team link page (`/join#t=`) in a computer's web browser, on a team
  the desktop app opens (https, or this machine for development): on load, one try of the existing
  `trina-ax://open?url=…` link (`openInAppHref`, unchanged). The page says the app is opening, with one primary button
  and two quiet links: Open the app (retry), Download the app (the edition's download page, `APP_DOWNLOADS`), Continue
  in the browser.
- Did the app open: page blur or hidden within about 2 s means yes; otherwise Download becomes the primary button. A
  later blur still counts (Chrome's "Open Trina AX?" prompt can take longer). One automatic try per page load, never a
  loop; Open the app tries again only on a press.
- "Continue in the browser" is remembered in this browser (localStorage), so later invites go straight to the form.
- Back from Google (`?google=`): the person chose the browser already, the form as today.

Out:
- Guest invites (lean): browser first as today (people from outside the team, usually joining once).
- Phones: unchanged (copy the link and go to the store).
- Inside our apps: unchanged.

## Steps

1. Pure rules in `web/src/lib/join-open-app.ts`: when to try, which button is primary, the remembered browser choice,
   how the launch is made (a hidden frame on Firefox, whose top-level try of an unknown scheme shows an error page).
2. `AppFirst` in `web/src/pages/Auth.tsx` `JoinChoices` for computers.
3. Six locales, en.ts the source.
4. Unit tests: `web/test/unit/join-open-app.test.ts`.
5. Decision file, changes note.
6. Check light and dark at 1440 and 390; real flow with the app installed and not installed where possible.

## Decisions

`docs/decisions/20261125-invite-open-app-first.md`. Changes "앱에서 열기" under the form on computers
(docs/DECISIONS.md "First run, phase 2") into the app-first page.

## Risks

- The token reaches the app the same way as today (the existing href); nothing new is logged; no clipboard, no
  fingerprinting. Detection is a guess a browser allows; all three actions stay on the page whatever it guesses.
- No migration, no server change. Six app languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, web unit tests for team-link,
open-app and join-open-app.

## Result

Filled in at the end.
