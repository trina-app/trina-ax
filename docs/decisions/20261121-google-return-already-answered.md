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
- **Rule 3, a held page opened again** says "this sign-in is waiting for the app: press Back to the app on the first
  page, or Try again", with no code, and finishes nothing, in any browser. The starter has the state too (it is in the
  Google address the app was given), so a second code or a finish for whoever brings the state again would hand a
  phished victim's consent to the starter (found in this change's review). The held page opens the app link by
  itself (`meta refresh`; the browser asks first).
- **Security:** unchanged properties. Single use: the state is exchanged once, and a held result has exactly one code, given only on the first return's page. A held page opened again never gives a new code and never finishes the flow.
  Bound to the starter: the claim needs the starting session; a browser needs the same person. PKCE and the hashed
  state as before. The "done" answers say only how the starter's own flow ended, which the starter can poll anyway; "Connected
  since" needs a later confirmed flow of the same person and app (or share) and a connection that is there now.
  The app's poll still shows a held result as plain "pending" (no "answered" hint: it would tell a phisher when the
  victim consented).
- **Rule 4, a refusal at the claim address** (a Google app's sign-in whose starter is no longer active, or no longer an
  owner or admin for a team sign-in) is a plain 401/403 with its reason, never a 500, and ends the held result.
- **Rule 5, one waiter per sign-in.** Only one return waits (up to 15 s) for another that is still talking to Google;
  any further return gets the state as it is now at once ("almost done" while it is still being finished).
- **Rule 6, results never used are revoked at Google.** A held or answered result that runs out, is replaced (Try
  again), cancelled or refused at the claim has its refresh token revoked, for Drive and the four apps, by the rule of
  a disconnect: not while the person keeps another Google sign-in here or anyone keeps one with the same Google
  account (Google revokes a whole grant, which would end a live connection).
- **Rule 7, reverse linking is shown on the confirm step.** Someone may consent with their own Google account on
  another person's sign-in (a passed-on Google link; the desktop code then reaches the starter's app). The account is
  still the starter's to confirm, so the confirm step (Drive, the four apps and the team dialogs alike) shows a
  highlighted line "This Google account is not your sign-in email: <address>" when the Google address differs from the
  person's own sign-in email (both known). A person without an email on file gets no line.
- **Left out:** the phone app's browser without a session (no hand-off there yet); flows of two sessions still
  replace each other (a later start of the same person and app ends the earlier one, as before).
