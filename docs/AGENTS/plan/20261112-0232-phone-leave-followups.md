# Phone: follow-ups to "leaving a team signs out of it"

- Date (UTC): 2026-11-12 02:32
- Branch: `fix/phone-leave-followups`
- Status: in progress
- Where: `mobile/`. Why: three low findings from the review of the phone's team switch (PR #537), all phone code.
- Version impact: patch, fixes in the phone app (ships with the next phone build)

## Goal

1. A second switch while the first one still waits for the old team's sign-out (up to a few seconds) was dropped
   silently: the link question closed, the link was used up, and the phone stayed in the team of the first switch.
2. A team link (`/join#t=…`) opened on a team the phone still owed a sign-out: the owed sign-out emptied the page's
   storage (where the join page keeps the link's token after taking it out of the address) and reloaded a page without
   it, so the person lost the join page.
3. When saving the new team failed, the switch took back the owed sign-out of the old team even when that entry was
   there before this switch (an earlier switch had owed it), so that earlier sign-out was forgotten.

## Scope

In:
- `connect` reports a switch that is already running (false). The link question and the switch box stay open and say
  "Still switching teams. Try again in a moment." with [Try again] (en, ko). Chosen over queueing the second switch:
  queueing needs the team as it is after the first switch (a ref, not the render's value) and a way to cancel a queued
  switch; telling the person keeps one switch at a time and loses nothing.
- The owed sign-out keeps the join page's token in session storage, and after the server's 204 opens the address the
  phone was sent to (the link's `/join#t=…` or `/invite/<token>`) instead of reloading whatever page is on screen
  (signed in, `/join` sends the person Home, and the token is gone from the address).
- The undo of a failed save removes only an owed entry this switch added.

Out: the server and the web app (no change there).

## Steps

1. `mobile/src/leave.ts`: `OneSwitch` (one switch at a time, false when busy), `oweForSwitch` (owes, returns the undo
   for this switch only), `wipeJs(keep)`.
2. `mobile/src/install.ts`: the owed sign-out script takes the entry address and keeps the join token.
3. `mobile/App.tsx`: connect uses both; Setup and LinkAsk show the busy line.
4. Strings (en, ko), unit tests, changelog fragment.

## Risks

Phone only. The token key is a copy of the web app's `mycel.joinToken`; a test compares the two.
