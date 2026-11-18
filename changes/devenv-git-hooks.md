- Security: in the dev environment, a git hook or a git setting that one person's command left in a shared project
  folder no longer runs in another person's command. git refuses to run in a repository whose settings would start a
  program, and commands in a project use a home folder of their own.
