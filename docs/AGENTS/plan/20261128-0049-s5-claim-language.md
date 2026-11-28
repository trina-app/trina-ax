# The new team's first screen (S5): a re-sent claim works, a reload keeps it, and it speaks the app's language

- Date (UTC): 2026-11-28 00:49
- Branch: `fix/s5-claim-language`
- Status: in progress
- Where: web (`pages/OpenApp.tsx` AppSetup, `i18n`), server (`auth/setup-console.ts`), shared (`api/auth.ts`,
  `desktop-bridge.ts`, `cloud-protocol/owner-claim.ts`), desktop (`preload/app.ts`, `main/main.ts`). Why: the screen is
  the web page the team server serves; only the app knows its own language (docs/REPOSITORY-RULES.md).
- Version impact: patch: fixes to an existing flow, one optional field in a request body and in the desktop bridge.

## Goal

Live QA of "Create a team for free" (desktop 0.20.2, a 0.20.1 team server) found the S5 page
(`/app-setup#c=<claim>`, "Welcome to {team}, {name}") fragile:

1. **A claim the app sends again never reaches the page.** Opening the team again from the app asks the console for a
   new claim (which revokes the one on screen) and loads `/app-setup#c=<new>` in the window that already shows
   `/app-setup`. The page took its claim out of the address, so that load differs only in the fragment: Chromium does
   not reload, and the page keeps its first claim (read once per page load). The CP DB of the test team shows six
   claims issued 25-35 s apart and never reserved, then Continue on the old one: "This link has expired". This was
   the "expired after 2 minutes"; the 10-minute TTL was never reached.
2. **A reload loses the claim** (it is out of the address by design) and shows "This link has expired".
3. **The page ignores the app's language** before sign-in: it reads only its own stored choice, else English. The
   owner account then takes the console team's language, not the one on screen.

## Scope

In:
- AppSetup takes a claim that arrives by `hashchange` (a new claim on the same page), starts its preview again and
  drops the old one.
- The claim is kept in this tab's sessionStorage while it can still be used, so a reload goes on with it; it is
  removed on success, on "expired/used" (410) and on "already set up" (409). Still never in the address or history.
- The desktop bridge says the app's language (`locale`, from `bridge:info` at each page load); the web's start
  language is: a language picked on this page, else the app's, else the recent one, else English.
- S5 sends the language on screen (`locale`, optional) with the setup; the server makes the team's language that one
  (as the normal setup page does), else the console's.
- The contract's `OWNER_CLAIM_TTL_MS` 10 → 30 minutes (a person reading the screen and choosing a password). The
  console issues the claim, so the change takes effect with a trina-cloud PR that re-pins its vendored copy.

Out: a "get a new link" button on the expired screen (needs a new desktop call); the console team's own language.

## Steps

1. Plan (this file).
2. web: AppSetup claim from hash / hashchange / sessionStorage; i18n start language with the desktop's; S5 sends
   `locale`.
3. shared + server: `ConsoleSetupBody.locale` optional; `consoleSetup` uses it.
4. shared + desktop: `DesktopBridge.locale?`, `bridge:info.locale`, preload exposes it.
5. shared contract TTL 30 min; trina-cloud PR re-pins `owner-claim.ts`.
6. Unit tests (web lib helpers, server setup-console, desktop bridge info), `changes/s5-claim-language.md`.

## Decisions

None new; follows docs/decisions/20261126-desktop-create-team.md (the claim stays out of the address and logs).

## Risks

- sessionStorage holds a bearer claim for up to its TTL in the team page's own origin (the same page already holds it
  in memory); cleared when used or refused. A plain browser never previews or keeps it (`outside`).
- An older team server ignores `locale` in the body (zod strips unknown keys); an older desktop app has no
  `bridge.locale` (the page keeps today's behaviour).
- No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, unit tests for
`server/src/auth/setup-console`, the web claim helpers and the desktop bridge, `tests/security`, desktop
`create-team.spec`.

## Result

(at the end)
