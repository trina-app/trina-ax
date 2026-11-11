- The Linux installer works on a minimal Debian 13 again. It stopped with "/etc/sysctl.d/60-mycel.conf.tmp: No such file
  or directory" because such a system has no `procps`. The installer now installs `procps` (with `--skip-apt` it must be
  installed first), makes the folders it writes into, and `check` says when `sysctl` is missing.
