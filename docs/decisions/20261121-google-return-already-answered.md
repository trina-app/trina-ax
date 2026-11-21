# A Google sign-in's return page reports an answered sign-in; Google apps get the desktop hand-off

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (extends the desktop hand-off of trina-ax #98, server/src/integrations/google-drive/app-return.ts)
- Branch: fix/google-connect-finish (owner 2026-11-21: "can't finish" and "expired or already used" pages after a
  Google sign-in that sometimes had connected anyway)

Plan: [docs/AGENTS/plan/20261121-0423-google-connect-finish.md](../AGENTS/plan/20261121-0423-google-connect-finish.md).

- **Rule 1, no failure page for a sign-in that worked.** A return to a flow that is no longer waiting for Google says
  how it went: answered and waiting for the confirm: the "almost done" page; confirmed: "Connected, you can close this
  window"; replaced by a later sign-in of the same person and the same app (Try again) that is connected now:
  "Connected". A return that finds another return of the same sign-in still talking to Google waits for it (up to
  15 s) and then reports it. Google is asked once: the state still moves `pending` → `exchanging` once, atomically.
  A flow that ended otherwise (cancelled, timed out, replaced and not connected, refused) still says "expired or
  already used".
- **Rule 2, the desktop hand-off for Gmail, Calendar, Docs and Sheets.** As for Drive: a desktop session's flow
  answered in a browser without a session keeps its result sealed and "waiting", with a one-time code in the app
  link's fragment; only the session that started the flow redeems it, at the Drive claim address the desktop app
  already calls (Drive's flows first, then the Google apps'). No page before Google for these four (the return page
  names the Trina account and the Google account, as Drive's does).
- **Rule 3, a held page opened again** gives a new code (the old one stops working; its time does not grow), or, in
  a browser signed in as the same person, finishes at once (as a first return there would). A browser signed in as
  someone else gets nothing. The held page also opens the app link by itself (`meta refresh`; the browser asks first).
- **Security:** unchanged properties. Single use: the state is exchanged once; a code is replaced, never added.
  Bound to the starter: the claim needs the starting session; a browser needs the same person. PKCE and the hashed
  state as before. The "done" answers go only to a holder of the flow's secret state and say only that it finished.
  The app's poll still shows a held result as plain "pending" (no "answered" hint: it would tell a phisher when the
  victim consented).
- **Left out:** the phone app's browser without a session (no hand-off there yet); flows of two sessions still
  replace each other (a later start of the same person and app ends the earlier one, as before).
