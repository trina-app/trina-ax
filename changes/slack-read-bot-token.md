- **Slack: Trina reads the thread you ask in, with the Slack app's own permissions.** Mention @Trina in a thread and it
  reads the thread so far; ask in the app about a Slack channel or thread and it reads channels it was invited to that
  you are in too (`/invite @Trina` first). It no longer reads Slack as you, has no Slack search, and nobody has to
  "Allow reading Slack". Nothing of Slack's messages is stored beyond the chat's answer.
- Admin › Connected apps › Slack shows **Update Slack permissions** when the Slack app does not have the two reading
  permissions yet. A team's own app: add `channels:history` and `groups:history` as Bot Token Scopes in Slack, reinstall
  the app, then press **I updated them**. The official app: **Add to Slack** again.
- An answer that used Slack messages from another channel or a DM still asks first before **Post to channel**.
- The AI no longer offers a "connect card" for Slack; it says how Slack is reached instead.
