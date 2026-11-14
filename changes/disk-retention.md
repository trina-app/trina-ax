- A team server no longer grows without limit on a small disk. Team backups leave out folders a tool makes again
  (`node_modules`, `.next`, a Python virtual environment), which were most of a 1.8 GB daily backup; after an
  `npm install` they are back. The server also clears, once an hour, the npm / pip / bun download caches nobody used for
  14 days (or over 1 GB), and the `node_modules` of a chat's work folder when the chat was idle for 14 days. Your own
  files are never touched. The newest 5 database copies from before an update stay for 14 days and longer; the system
  log is capped at 100 MB and downloaded system packages are removed after an install.
