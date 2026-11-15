- Hosted trial AI credit removed. A hosted trial team is no longer answered on a key paid by Trina hosting before it
  connects its own AI: chats are answered only by an AI the team or the person connected (or the team's API engine).
  The trial-credit bar in Admin › AI providers, the "trial credit used up / ended" lines and errors, the
  `GET /api/admin/trial-credit` endpoint and the `hosted-chat-key-set` tenant command are gone, and a database update
  deletes a stored trial key and its spend count. Hosted speech-to-text is unchanged.
