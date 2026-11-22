- Desktop app: finishing a Google sign-in (Google Drive, a team Drive share, Gmail, Calendar, Docs, Sheets) after
  "Back to the app" no longer gets lost on a network hiccup. The app sends the sign-in again a few times and logs each
  step. Before, the dialog could stay on "Waiting for Google…" until it timed out.
- Mac: when macOS opens another copy of Trina AX for a link (an old build or a mounted installer still registered on
  the Mac), that copy now hands the link to the app that is already open before it closes. Before, the link was lost
  and the app only came to the front. The app also registers itself again for `trina-ax://` links at every start.
  The steps go to a log file the person can send: `~/Library/Application Support/Team AX/logs/handoff.log`.
