- When an AI file save (or another tool) fails with a server error, the server log now has a line with the cause and a
  short reference, and the AI says it failed on the server with that reference instead of guessing. It no longer sends
  people to the storage settings unless the storage is really full. A converter that could not start because the server
  was short of memory is tried again.
- Admin › Connected apps no longer lists Gmail, Calendar, Docs, Drive or Sheets as On while their page says Not set up.
- Windows setup script: `-WhatIf` no longer prints the Dism module's alias lines, and a sleep setting it could not read
  is no longer put back as -1 by the uninstall steps.
- On a Linux or Windows (WSL) server: the Ollama choice says "on the server's computer" instead of "this Mac", the
  connection check of a WSL server no longer mentions the office network, and a service that signs in only from the
  team's https address (such as Indeed) says so when the team is open at 127.0.0.1 or another non-https address.
