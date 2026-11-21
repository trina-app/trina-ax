# Google connect: no failure page for a sign-in that worked

- Date (UTC): 2026-11-21 04:23
- Branch: `fix/google-connect-finish`
- Status: done
- Where: server/src/integrations/google-drive, google-apps, routes; web BrowserWait. Why: the return page and the
  flows live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix of the Google sign-in return; no new API, no migration

## Goal

The owner (2026-11-21) often lands on "This browser can't finish it" or "Not connected: this sign-in has expired or
was already used" after connecting Google Drive or a Google app, and back in the app it is sometimes connected anyway.
People must never see a failure page for a sign-in that worked, and a desktop app's sign-in must finish in the app.

## Findings (qa.trina.app flows, account.trina.app broker log, 2026-11-21)

1. Gmail, Calendar, Docs and Sheets have no desktop hand-off. A desktop app's sign-in comes back in the system
   browser, which has no session, so the return page always says "This browser can't finish it" (gmail flow 04:13:04,
   desktop session, no broker redeem). It worked only after the person signed that browser in and pressed Try again
   (04:13:59, redeemed 04:14:11, completed). Drive has had the one-time code hand-off since #98.
2. Drive's held result is lost when the person goes back to the app without pressing "Back to the app": the app
   still shows "waiting", and Try again or Cancel ends a flow Google already answered (drive flow 04:10:14 redeemed
   04:11:09, superseded 04:11:46 and its token revoked; 04:11:46 redeemed 04:12:01, cancelled 04:12:12). The third try
   (04:12:15) was claimed and completed.
3. The return page treats any flow that is no longer "pending" as "expired or already used": a second load of the
   same return address (a reload, a duplicate request while the first one still talks to the broker) shows the
   failure page while the first one made the flow ready or the person already confirmed it.
4. A window of an earlier try (Try again opens a new one) that finishes after a later one connected says "expired".

## Scope

In:
1. Google apps: the desktop hand-off of Drive (held result, one-time code in the app link's fragment, claimed by
   the session that started it). The desktop app already posts every code to the Drive claim address: that address
   now redeems a Google app's code too (no desktop update needed). The return page knows the app (desktop/phone).
2. Both services: a return to a flow that is already answered says so: "ready" (confirm in the app), "completed"
   (Connected, close this window), a held one says "go back to the app" (no new code: the starter has the state), an
   in-flight one is waited for (up to 15 s) and then reported. A superseded flow whose person connected the same thing since says
   Connected.
3. The held page: title "Go back to Trina AX to finish", and it opens the app link by itself (the button stays).
4. The app's wait line on the desktop says to press "Back to the app" in the browser when Google is done.

Out: the phone app's unsigned browser (no hand-off there yet); a broker change (the broker log shows every handoff
redeemed once; nothing to change in trina-cloud).

## Decisions

docs/decisions/20261121-google-return-already-answered.md: a return to an answered flow reports its result; Google
apps get the desktop hand-off. Builds on #98's security review (code only to the starter's session).

## Risks

Security: single use (the state is still taken once; a held result's code is replaced, not added), bound to the
starter (claim only with the session that started the flow), PKCE and state unchanged. A "done" page reveals only
that the flow behind a secret state finished. No migration. Five languages + English for the new strings.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit c-drive-*, c-google-*, connect-google-app, the security
tests. New: a reload and a concurrent duplicate of the return, a desktop Google app sign-in (and the phishing case),
a held page reloaded, a superseded window after a newer one connected.

## Result

Built as planned, with one change from review: a held page opened again first gave a fresh code (or finished for a
signed-in starter). The reviewer showed the starter has the state, so that would hand a phished victim's consent to
the starter. It now says "go back to the app" with no code. Review also tightened "connected since" (the same share;
a live connection) and the Google-app claim (it repeats the session and admin checks). No trina-cloud change: the
broker log shows every handoff redeemed once. PR: see the branch fix/google-connect-finish.
