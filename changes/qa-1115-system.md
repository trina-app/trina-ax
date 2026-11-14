- Waiting for a sign-in (Google, a connector's sign-in page, Add to Slack, Sign in with Slack) now shows a spinner and
  says the wait stops by itself after 5 minutes. Slack's "Connecting" shows a spinner too, and its page says it
  usually takes a few seconds and what happens after 2 minutes.
- Slack's page in Admin › Connected apps says what the app reads before it is added: messages in the channels and
  threads it is invited to, other apps' alerts there included, and nothing outside them.
- A file that could not be attached (for example, storage full) shows the whole reason beside its chip, not a cut-off
  one. The ✕ on a file chip is easier to hit: 24 px on a computer, 44 px on a phone.
- An app posting to a room while the server's storage is full now gets "try again later" (503 with Retry-After)
  instead of being accepted, and the app's status line says the storage was full.
- Admin › System shows the "kept from deleted chats and rooms" line for any size, in KB under 1 MB.
