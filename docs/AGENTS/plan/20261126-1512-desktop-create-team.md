# Create a free team from the desktop app with one sign-in

- Date (UTC): 2026-11-26 15:12
- Branch: `feat/desktop-create-team` (with `docs/try-demo-button`, `feat/owner-claim-contract`, `feat/setup-console`,
  `feat/create-team-docs`); the hosting side is `feat/app-create-team` in the hosting repository
- Status: in progress (approved by the owner, 2026-11-26)
- Where: `desktop/`, `server/src/auth`, `web/src/pages`, `shared/src/cloud-protocol` (MIT). Why: the app and the owner
  account are in the open repository; plans, hosts and billing stay in the hosting repository (docs/REPOSITORY-RULES.md).
- Version impact: minor overall (new screens and endpoints, nothing removed). Per PR below.

## Goal

People who download the app have no team, and the app's first screen is "Join your team" (`desktop/src/ui/welcome.ts`).
After this change a new person picks "Create a team for free", signs in once in the browser, names the team, waits, and
lands in it signed in, like Plex or Tailscale. No card, no setup link.

## Scope

In: the flow below, Free plan only, owner claim, store build, upgrade and demo links.
Out: "Use this computer as the server" (S0 keeps a slot), console single sign-on into a team that is set up.

## Steps

### 1. Screens (Mac and Windows)

- **S0 First screen.** Remembered teams first, as today. Then two full-width rows: primary "Create a team for free"
  ("Your own team in about 5 minutes. Free, no card."), secondary "Join with an invite link". At the bottom a small link
  "Just look around first", which opens `https://demo.trina.app` in the browser (fixed URL, all builds).
- **S1 Join.** Today's box and errors, "I don't know the address" inside it. Back and Esc go to S0.
- **S2 Sign in.** "Continue in your browser to sign in." and Cancel. The console page `/app/connect` signs in (Google or
  email code, terms), asks "Continue in the app as {email}?", then "You can close this tab." Errors: cancelled, expired
  (10 min), offline; each offers Try again and Back.
- **S3 Name your team.** One field, "Team name"; the address is derived and shown small ("acme.trina.app · Change").
  Region, zone and language come from the computer. Under it the Free plan rules from the console's `freePlan`, the
  Free terms and privacy links and one agree box; the button sends `planId:'free'` with the consent shown.
- **S4 Starting.** "Setting up {team}… about 3 to 5 minutes. You can close the app." Three steps. The pending team id
  is saved; reopening the app returns to S4.
- **S5 Signed in.** The team opens at `/app-setup` in the app window: "Welcome to {team}, {name}". Google owners press
  Continue. Email-code owners choose a password (for the phone and other computers), then Continue.
- **States** (from `/me`, team create and the claim): has a live team ("Open it"), free already used ("See plans",
  hidden in the store build), canceled team coming back, paused for no use ("Start it again" → resume → S4; free
  servers busy), on hold, free pool full, waiting list ("Put me on the list"), network limit, unverified email, no free
  host in the region, provision failed (Try again), image older than this change (`unsupported`: the app loads the old
  setup link in its own window), token expired on resume ("Sign in again to finish").
- **Upgrade.** Admin › Plan: "Free plan · sleeps when idle · [Choose a plan]" opens the console's paid checkout. Owner
  only (open question 1). Hidden in the store build.
- **Mac App Store build.** No create row. Under Join: "Already made a team? [Sign in]" runs S2 with `store=1`: sign-in
  only; the token cannot create a team. Then the owned team opens, or "No team yet."
- **Removed:** "Install it yourself" on S0 (stays in the docs).
- If the console's `/me` answers 404 (the hosting side is older), the app keeps today's first screen.

### 2. Identity handoff

1. **App ↔ console (RFC 8252).** New `desktop/src/common/console-return.ts`, not `sign-in-return.ts` (which forwards to
   the team and keeps one listener). Shared checks move to `common/loopback.ts`; the new listener runs on its own
   instance and path, so a connector sign-in is never closed. `https://account.trina.app/app/connect?state&challenge
   (S256)&port&locale[&store=1]` → `http://127.0.0.1:<port>/console-callback?code&state` → `POST /api/app/v1/token
   {code, verifier}` → opaque bearer, 2 h, kept with `safeStorage`.
2. **Console creates the team** (`POST /api/app/v1/teams`, Free path, hosting repository). `GET /api/app/v1/me`
   returns `{accountId, email, team?, freeLeft, waitlist, freePlan}`.
3. **Owner claim, two-phase.** `POST /api/app/v1/teams/:id/owner-claim` returns `https://<team>/app-setup#c=<claim>`
   (32 random bytes, SHA-256 stored, 10 min, bound to the team). The app's main process loads it; the page strips the
   fragment.
   - `POST /api/setup/console/preview {claim}` and `POST /api/setup/console {claim, password?}` (`csrf()`, hosted, no
     user yet). Before any outbound call: the per-IP guard and a shape check (43 base64url characters).
   - Reserve: signed with the team's relay key (as `team-name.ts`), `POST /api/hosted-team/v1/owner/reserve
     {v:1, claim}` → `{email, name, locale, timeZone, google|null}` (repeatable).
   - `bootstrapOwner` runs; only after it succeeds does `.../owner/confirm` spend the claim. A weak password leaves it
     unspent. A failed confirm is retried. Then a desktop session, audit `setup` `method:'console'`.
4. **Email-code owners choose a password on S5**: the account never exists without a way in, and the phone works at once.
5. **`bootstrapOwner`:** `OwnerInput` gets `username?`, derived with `usernameFromEmail` from `email` when absent.
6. **Google owners** sign in again later through the hosting service's Google broker (a hosting-side dependency).
7. **Threat model.** The loopback `code` needs the verifier. The claim rides in a fragment, works only from this team's
   own signed server, and is spent once. Forged callbacks fail `state`.

### 3. Pull requests (each into `dev`, later ones on the one before)

1. `docs/try-demo-button`: the "Try it in 1 minute, no sign-up" button to `https://demo.trina.app` in the six READMEs
   (centered, above the download badges) and the note atop the docs site's index in six languages. Version: none.
2. `feat/owner-claim-contract`: `shared/src/cloud-protocol/owner-claim.ts` (MIT), vectors, README row. Version: none.
3. `feat/setup-console`: `server/src/auth/setup-console.ts`, `accounts.ts`, `routes/auth.ts`, `shared/src/api/auth.ts`,
   `web/src/pages` (`/app-setup`). Version: minor.
4. `feat/desktop-create-team`: desktop S0–S5, states, store build, demo link, `console-return.ts`, `loopback.ts`,
   six locales, e2e against a stub console. Version: minor.
5. `feat/create-team-docs`: `docs/site/get-started/team-setup.md` and the Admin › Plan "Choose a plan" link. Version:
   minor.

## Decisions

`docs/decisions/20261126-desktop-create-team.md` (supersedes screen ③ of
[20261116-desktop-first-onboarding](../../decisions/20261116-desktop-first-onboarding.md)). Open questions taken as
recommended: the upgrade link is owner only; the switch goes on for everyone at once after the QA walk.

## Risks

- Migrations: none in this repository.
- App Review: no create path or price in the store build (`store=1`, token scope).
- The bearer surface stays on the console; the team server only sees a claim, signed calls and the owner's password.
- Image lag: a team server older than `feat/setup-console` answers `unsupported`; the app falls back to the setup link.
- Six desktop languages, English first.

## Tests

- Unit: `tests/unit/a-setup-console.test.ts` (guard and shape check before any outbound call, reserve → bootstrap →
  confirm, unspent after a weak password, derived username, CSRF), `tests/unit/e-desktop-console-return.test.ts`
  (state, PKCE, next to a connector listener), `tests/unit/e-desktop-common.test.ts` (`/app-setup`), the
  cloud-protocol vectors, `web/test/unit/open-app.test.ts`.
- Desktop e2e `desktop/e2e/create-team.spec.ts` against a stub console.
- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`.
- Manual QA on the QA server with test data only.

## Result

To fill in at the end.
