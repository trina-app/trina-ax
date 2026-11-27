- Slack: the app now has a **Home** tab in Slack with how to ask, whether your Slack account is linked, where to get
  help, and the note that AI answers can be wrong. A team's own Slack app made before this needs the Home tab and the
  `app_home_opened` event turned on in its Slack settings.
- Slack: when the official app is removed in Slack, its token and all the Slack data the server keeps for that
  workspace (each person's Slack link, Slack thread records, Slack user ids in the audit log) are deleted at once.
  After the app is added again, each person links their Slack account again.
