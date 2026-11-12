- Linux servers: an update now replaces `mycel-ctl` before the other root programs, so after a reset or power cut in
  the middle of an update `sudo mycel-ctl status` always says "AN UPDATE DID NOT FINISH". Before, the bootstrap, the
  launcher and the sandbox helper could already be new while the old `mycel-ctl` had no such check.
- That message now says to run the same command again: `sudo ./install-linux.sh update --from .` in the kit's folder
  after an update from a kit, otherwise `sudo mycel-ctl update`. A plain `sudo mycel-ctl update` used to be named
  first and answered "already at" when the kit was newer than the feed; it now says that it cannot finish the update
  and why, instead of "nothing changed".
- Backup guide: going back to the version before an update no longer says that 0.4.0 shows the restored backup in
  Admin › System › Backups and the activity log (that comes with 0.5.0); cancelling the staged copy also removes
  `restore-staged.db`; on a new server, `mycel-ctl status` right after the start can show "connection refused" for a
  few seconds.
