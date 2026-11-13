- On Ubuntu 24.04 the installer and `install-srt.sh` now give the real reason why the dev environment stays off: the
  system's systemd 255 cannot limit the team server to its own run scopes. AppArmor is not the reason.
