- **Go back** in Admin › System › Updates is no longer offered for a version that cannot read the team's database
  after the update changed it (0.4 after the update to 0.5, for example). The row says so and that going back needs the
  backup made before the update; the steps are in the backup and restore guide
  ([Going back to the version before an update](docs/BACKUP-RESTORE.md#going-back-to-the-version-before-an-update-linux)). Before, Go back to 0.4 looked like it
  worked, but the server came straight back to 0.5.
- An update or a Go back says **"finished"** only once the server runs the new version. When it comes back on the
  version it started from, it says so ("Could not go back to 0.4.0; still on 0.5.0") and why, and Admin › System ›
  Health says it in plain words too.
- After an update where the new version first missed its health check and then started fine, `mycel-ctl status` no
  longer says "HELD: release … was rolled back" while that version runs. The next `mycel-ctl status` or update check
  clears that hold and says so in one line.
- Starting an older Docker image tag (or an older Linux kit) on a server whose database a newer version has changed
  now says that the older version cannot read it and points to the restore steps (in Docker: a copy of the whole
  volume from before the update), instead of suggesting Go back.
