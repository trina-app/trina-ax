- Linux docs: step-by-step ways to go back to the version before an update (turn automatic updates off, put back the
  database copy from just before the update, then `sudo mycel-ctl update --version <old version>`; a plain restart
  started the new version again; how to cancel when that update does not finish) and to bring a team back on a new
  server from its archive (which file goes where, owner and modes, the database's `-wal`/`-shm` files, reconnecting AI
  accounts).
- `sudo mycel-ctl status` says "AN UPDATE DID NOT FINISH" and to run the update again when some root files differ from
  those of the version in `root/VERSION` (a reset or power cut while an update replaced them). It said only "root
  files 0.4.0".
