# Desktop updates install quietly; no "Restart" question

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "업데이트 준비됨 — 다시 시작" prompt of the desktop updater (docs/OFFICE.md, desktop/src/main/updater.ts)
- Branch: fix/mac-update-restart

- **Report:** the owner's Mac (Developer ID dmg, 0.5.7) on a 0.5.9 team server showed "Restart"; after Restart it was
  still 0.5.7, and it asked again. Then: "근데 restart 까지 해야해?"
- **Cause (reproduced 2026-11-16 on a scratch copy of the released 0.5.7 with the released 0.5.9 update and its signed
  manifest):** Squirrel.Mac's ShipIt installs only after every copy of the app has quit, and it takes about 18 s to
  install and 23 s to open the app again. Restart, then a Dock click 0.3 s after the app closed, gave
  `Aborting update attempt because there are 1 running instances of the target app` →
  `Installation cancelled: ... App Still Running Error` → `ShipIt quitting`: the update was dropped, 0.5.7 stayed, and
  the next start downloaded and asked again. Without the click the same build installed and relaunched as 0.5.9. An
  app run from the dmg never got to "Restart" (Squirrel: "Cannot update while running on a read-only volume").
- **Rule:**
  - A verified update is never announced. It installs when the app quits (Mac: Squirrel.Mac on quit; Windows: the
    checked installer from our quit handler, as before) and the menu keeps "Update ready — restart" for whoever wants it
    now.
  - The app restarts by itself into a ready update only when nobody uses it and nothing would be lost: no window of it
    focused; the computer untouched for 20 minutes or the screen locked; the team page says a reload would lose nothing
    (`window.__mycelBusy` = not web/src/lib/reload-guard.ts `mayReloadNow`, the same rule as the web's own reload after
    a server update: uploads, drafts, unsaved file or sharing edits, a recording, an answer streaming, a message not
    sent, the server unreachable; a page that cannot say within 5 s counts as busy, so an older team server never gets
    an idle restart); no page in the in-app browser. The page that was open comes back (`update-resume.json`, at most 15
    minutes old, same origin), and the window comes back as it was (shown, minimized, or closed → minimized) without
    taking the focus, so it never pops up over a video or a shared screen.
  - The run that made an update ready writes `update-pending.json` (version, time). The next start (right after the
    single-instance lock, before any window) reads it: the new version → forget it; ShipIt's launchd job
    (`<bundle id>.ShipIt`) has a process → this start quits at once and leaves a `/bin/sh` waiter that opens the app when
    ShipIt is done (at most 3 minutes; installing took 9–66 s on the test Mac), so a Dock click right after quit still ends in the new
    version; at most once per staged version, so a stuck ShipIt cannot keep delaying starts; still the old version with
    nothing installing → retried quietly (download, install on the next quit), and after the second such start one
    plain line, "couldn't update to X", with the website's download page (an edition without one: Settings › Apps).
  - Squirrel refuses because of where the app runs (the dmg, a translocated download) → one line, "can't update itself
    from where it is now", with "Move to Applications" (Electron `app.moveToApplicationsFolder`, which also handles a
    translocated app and starts it again from /Applications). Any other Squirrel refusal is tried again quietly at the
    next check; the same refusal a second time in one run gives the download line and no more downloads of it.
  - Trade-off: a start steps aside only before the first failed install of a version (`failedStarts` 0). A Dock click
    during the retry install is not protected, but that start counts as the second failure and shows the download
    line, so the person is never stuck in a loop.
- **Windows:** the same: no question, install on quit, idle restart, the pending record and the download line after two
  starts on the old version. The NSIS installer closes a copy opened during the install itself, so no waiter there.
- **Why not a splash in the reopened app:** ShipIt counts every running copy of the bundle, a splash included, and gives
  up. The second copy has to be gone within a second; only something outside the bundle can wait.
- **Left out:** a progress window while ShipIt installs (would need a separate helper app); a restart while the person
  uses the computer; a `trina-ax://` link that starts the app during the install is not handed on (the app opens
  without it).
- **Tests:** tests/unit/desktop-update-guard.test.ts (start decisions, waiter, resume, idle rule),
  tests/unit/office-update-desktop-updater.test.ts (no dialog when ready, pending record, move and download lines, idle
  restart). Manual: a Developer ID signed build of this branch as 0.5.8 updated to the released 0.5.9, reopened 0.3 s,
  5 s and 10 s after quit, and quit without reopening (the PR has the ShipIt log lines).
