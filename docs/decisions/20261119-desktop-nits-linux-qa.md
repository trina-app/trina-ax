# Desktop nits from Linux QA: wording, link on a cold start, Quit on Linux

- Date: 2026-11-19
- Status: accepted
- Supersedes: the updater wording in [Office update](../DECISIONS.md) ("couldn't be checked")
- Branch: fix/desktop-nits

- **Refused update wording:** the dialog said "couldn't be checked", but the file was checked and did not match. Now
  "This update didn't pass its safety check, so it wasn't installed." in all six languages. An unreadable answer still
  shows nothing (the download is kept for the next check).
- **"Open in the app" with the app closed:** a chat, room or project link of a team this app already has now opens
  that page at the first load (`startupLinkTarget`, `AppWindow.openLast`), instead of the team's Home with the link
  sent too early. A link to a team it does not have still goes to screen 4 as before.
- **Quit on Linux:** there is no tray on any system (closing the last window quits on Windows and Linux). Linux had no
  Quit item, so the Window menu now ends with "Quit {app}" (Ctrl+Q) on Linux. Windows keeps Alt+F4.
- Tests: `tests/unit/e-desktop-common.test.ts` (startupLinkTarget), `office-update-desktop-updater.test.ts`.
