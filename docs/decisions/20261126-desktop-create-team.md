# A new person creates a free team from the desktop app with one sign-in in the browser

- Date: 2026-11-26
- Status: accepted
- Supersedes: screen ③ ("No team yet") of [20261116-desktop-first-onboarding](20261116-desktop-first-onboarding.md)
- Branch: feat/desktop-create-team (the owner, 2026-11-26; plan [20261126-1512-desktop-create-team](../AGENTS/plan/20261126-1512-desktop-create-team.md))

- **Ask:** people download the app and none of them reach a team: the first screen is "Join your team" and they have
  none. The owner: a new person picks "Create a team for free", signs in once in the browser, names the team, waits,
  and lands in it signed in, like Plex or Tailscale. No card, no setup link.
- **Rule:**
  - The first screen offers "Create a team for free" (primary) and "Join with an invite link", and a small "Just look
    around first" to `https://demo.trina.app` (all builds). Remembered teams stay on top. If the console's
    `/api/app/v1/me` answers 404 (a hosting service without this flow), the app keeps today's first screen.
  - The app signs in to the hosting console as a native app does (RFC 8252): the system browser, a loopback return to
    `http://127.0.0.1:<port>/console-callback` on a listener of its own (never the connector sign-in's listener), PKCE
    S256 and a `state`; the code becomes a 2-hour bearer token for `/api/app/v1/*` only, kept with the system's secure
    storage. The contract is `shared/src/cloud-protocol/owner-claim.ts` (MIT).
  - The console makes the team on the Free plan only, with its existing rules (one team per account, one free team
    ever, waiting list, free-pool room, network limits). The app shows each refusal as its own line.
  - **Owner claim, two-phase.** When the team is ready, the console gives the app
    `https://<team>/app-setup#c=<claim>` (32 random bytes, only the sha256 kept, 10 minutes, bound to the team). The
    page takes the claim out of the address and sends it to its own team server (`POST /api/setup/console/preview`,
    `POST /api/setup/console`; CSRF-checked, only on a hosted team with no account yet, the per-IP guard and a shape
    check before any outbound call). The team server asks the console who the owner is (`owner/reserve`, signed with
    the team's relay key, repeatable), makes the owner account (`bootstrapOwner`, username from the e-mail), and only
    then spends the claim (`owner/confirm`). A weak password leaves the claim unspent; a failed confirm is tried again.
  - A Google owner is made with the Google account the console proved (no password). An owner who signed in with an
    e-mail code chooses a password on that page, so the account never exists without a way in and the phone works at
    once.
  - The Mac App Store build has no create row and no prices: "Already made a team? Sign in" signs in with `store=1`,
    whose token can only read and open.
  - Admin › Plan shows "Choose a plan" (the console's paid checkout) to the **owner only**, as the console does, and not
    in the store build.
- **Why a claim and not the setup link:** the setup link asks for a second account and a password the person never
  chose; the claim reuses the sign-in they just did. It works only from the team's own signed server and only once.
- **Left out:** "Use this computer as the server" (the first screen keeps a slot), signing in to a set-up team from
  the console.
- **Open questions taken as recommended:** the upgrade link is owner only; the hosting switch goes on for everyone at
  once after the QA walk.
- **Tests:** tests/unit/cloud-owner-claim.test.ts, tests/unit/a-setup-console.test.ts,
  tests/unit/e-desktop-console-return.test.ts, tests/unit/e-desktop-common.test.ts, web/test/unit/open-app.test.ts,
  desktop/e2e/create-team.spec.ts.
- **Version impact:** minor (new screens and endpoints, nothing removed).
