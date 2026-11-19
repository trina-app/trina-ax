- Security: a git hook that someone left in a shared project folder no longer runs in another person's command, also
  when the command sets git's hooks folder itself (`git -c core.hooksPath=…`, `--config-env`, a bare repository, `git -C`).
  Files that git could run as hooks in shared folders lose their run permission before and after each command.
