- Tests only: the permission matrix agrees with the server again (14 cases failed with no code fault: a person who
  must change the password is refused with 403 before any lookup, the invite info has a `full` field, the dev
  environment is on by default, a made-up Drive id answers 404 to an admin). No access changed.
