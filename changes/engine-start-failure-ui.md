- When the AI can't start on the server at all, the answer now says so ("Trina couldn't start the AI on the server, so
  nothing was done") instead of "The answer stopped partway", and the owners and admins get one notice in their Inbox.
  **Retry with another model** is not offered then, because every model fails the same way until the server is fixed.
- An answer stuck on "Thinking…" after it had already ended on the server now shows how it ended: **Stop** reads the
  chat again when there is nothing left to stop, and a running answer the page has heard nothing about for 20 seconds
  is checked with the server.
