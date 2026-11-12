- A self-install on Debian 13 turns the dev environment (srt) on by itself: the installer runs `install-srt.sh` once the
  server answers. You no longer run it by hand. `--no-dev-env` keeps it off (and removes it on a repair); `--dev-env`
  stops the install when this system cannot have it. Ubuntu 24.04, Debian 12, `--minimal` and `--no-systemd` stay
  without it, and the installer says why.
- The server kit carries the srt install files (root/dev-env-srt/). `mycel-ctl update` runs the new `install-srt.sh`
  when srt is on and a release changes them, so a new pinned srt or node comes with the update.
- `uninstall` removes the dev environment too (`uninstall-srt.sh`; `--purge` also deletes its run data).
