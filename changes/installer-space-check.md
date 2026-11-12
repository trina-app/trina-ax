- Linux: `install-linux.sh update` (and `repair`) checks the free disk space before it changes anything. When there is
  not enough, it says how much it needs and how much is free, and the server keeps running. The new version is copied
  while the server still runs. If the update fails after the server stopped, the installer puts the old files back and
  starts the server again, so the team is never left with a stopped server. `sudo mycel-ctl update` also says how much
  space it needs before it downloads.
- Admin › System › Diagnostics no longer says "System packages: Not yet brought to this version's list" after a
  successful sync on Debian and Ubuntu.
