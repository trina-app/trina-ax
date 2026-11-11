- A failed update can no longer leave the server down for good. When the older version cannot open the database the
  new version already updated, the server starts the new version again instead of restarting the old one forever. If
  no version can start, it stops trying and says why in `mycel-ctl status` and the update history.
