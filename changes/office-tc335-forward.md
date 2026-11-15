- Office mode: an update that changed the database and then failed no longer leaves the team down (QA TC-335). The
  installer of a new version moves an old app that cannot read the changed database out of the way (`app.unreadable`),
  so no update rolls back to it, and the updater does not roll back to it either. When the old version's updater still
  stops the server, the new version's update agent starts it again within 15 minutes. The supervisor no longer restarts
  a server that exits 75 ("database needs schema reader level …") every 30 s: it goes forward to the newer version kept
  on the Mac, or stops with one line that names the fix. The advice now says to run `office-install.sh` from the newest
  zip, not from the old version's zip, and a reinstall clears the failed update's advice in `teamax update status`.
  A Mac that is on 0.4.0 gets this only from the update to a version with this fix; the 0.4.0 → 0.5.5 update is not
  changed.
