# Removing the Slack app in Slack deletes the workspace's Slack data at once; the app has a Home tab

- Date: 2026-11-27
- Status: accepted
- Supersedes: the line "People's links stay (the same workspace when it is added again)" of docs/SLACK.md "The official app" (2026-11-12)
- Branch: feat/slack-marketplace-gaps (Slack Marketplace submission prep for the official app A0CGU1CK47M; trina-cloud branch of the same name)

- **Ask:** the official "Trina AX" Slack app is to be listed in the Slack Marketplace. Slack's Developer Policy: delete
  all data associated with a workspace within 14 business days after the app is removed; the Marketplace guidelines:
  support information on the Home tab, help reachable in the app, an AI-accuracy note.
- **Rule, removal:** when the official app is removed in Slack (Slack's `app_uninstalled` / `tokens_revoked` through
  the hosting service, the hosting service saying the install is gone, or Slack refusing the bot token), the team
  server deletes at once: the token, every `slack_links` row (Slack user id and name), `slack_link_tokens`,
  `slack_threads`, `slack_requests`, `slack_events`, `slack_signin_flows`, `slack_user_tokens`, the workspace's name,
  address, enterprise id, bot user, bot name and bot scopes on `slack_config`, the in-memory Slack caches, and the
  `slackUser` field of the audit log's `slack.*` rows. The config row keeps the mode, the workspace id and
  `last_error = 'removed'` (Admin's "add it again"); an "Add to Slack" in progress goes on. **Remove** in Admin deletes
  the same (it already deleted the tables; now also the audit field and the caches). People link again after the app
  is added again. The hosting service drops the install, its sealed token, its queued events and open sign-ins at once
  (it already did: trina-cloud `forgetInstall`).
- **Kept:** the chats people had from Slack (their own data here: the question and the answer they asked for); the
  audit rows themselves (the team's security record, without Slack user ids). A team's own app removed in Slack is
  unchanged (the team's own internal app: Admin says the token is refused; Remove deletes the same data).
- **Why at once, not after 7 days:** each trigger means the token no longer works, so the data is no use until a new
  install, and a re-link takes a person one click; a grace period would need a sweep and a timestamp for no gain.
- **Rule, Home tab:** `app_home_opened` (tab `home`) is answered with `views.publish` (no scope): what the app does,
  how to ask, the person's link state, what it reads, help (the official app: the hosting service's help page), "AI
  answers can be wrong. Check important ones before you rely on them." The own app's manifest turns the tab on and
  subscribes to the event. The live official app's settings are the owner's step (trina-cloud docs/slack-broker.md 6b).
- **Left out:** the console's privacy text (trina-cloud `src/web/legal.ts` §10 Slack item) and the website's policy
  section are separate, owner-approved texts.
- **Tests:** `tests/unit/c-slack-official.test.ts` "removed in Slack", `tests/unit/c-slack.test.ts` "the Home tab".
- **Version impact:** minor (a new feature in Slack; a changed data rule).
