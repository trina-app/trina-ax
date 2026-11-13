# Slack: Marketplace-safe reading with the bot token only

- Date (UTC): 2026-11-13 09:12
- Branch: `feat/slack-read-bot-token` (PR to dev), QA TC-879
- Status: done
- Where: Team AX core (`server/src/integrations/slack/`, `shared/src/cloud-protocol/slack-broker.ts`, `web/`). The
  hosting service's part (the official app's settings in Slack) is written down in docs/SLACK.md.
- Version impact: minor (reading changes, a migration), replaces what #674 built before it was released.

## Goal

The owner (2026-11-13): make Slack reading Marketplace-safe. Slack's Marketplace rules: no `search:read`; user token
scopes only when acting as the user; `*:history` gets enhanced review for AI apps (each scope must trace to a testable
feature); AI apps must not store Slack data; real-time search only for listed/internal apps.

## Scope

1. No user scopes (`SLACK_BROKER_USER_SCOPES = []`); bot scopes add `channels:history`, `groups:history`. "Sign in with
   Slack" back to OpenID Connect (`openid profile`, its own flow).
2. @app in a thread: the thread read with the bot token; keep question-last, taint, size bounds, the official app's rate
   limit behind a new `listed` flag (default false).
3. `slack_read_thread` / `slack_read_channel`: bot token, only conversations the bot AND the linked Slack user are in
   (`users.conversations` with `user=`); otherwise "invite @app first". `channelByName` lists the bot's channels only.
   Remove `slack_search` / `search.messages` (TODO for phase 2, no code).
4. Remove the user-token flow (Allow reading Slack, read_scopes, keepUserToken, OAuth v2 user_scope, broker
   `signin/read/*`). Migration 350 (additive: `slack_config.bot_scopes`); the stored user tokens revoked at Slack and
   deleted by a start-time job.
5. readsSlack = linked + bot has the history scopes; admins see "Update Slack permissions" until then.
6. Storage: keep the injected thread out of what a resumed session keeps; document what is kept.
7. Post to channel notice unchanged.

Out: search (phase 2), files, group DMs.

## Steps

1. manifest / contract scopes; service.ts back to the OIDC sign-in, bot scopes kept and checked, retire job.
2. read.ts rewritten for the bot token and the shared-membership rule; provider `context` without the thread.
3. API (SlackAdmin.missingScopes, MySlack.read), web screens, i18n en → es/id/ja/ko.
4. Tests (fake Slack: bot membership, history scopes, users.conversations), docs, changes fragment.

## Risks

- Existing installs lack the two scopes: reading off until updated (said in Admin and Settings), answering unchanged.
- The hosting service's copy of the contract: `signin/read/*` and the read seal are gone; its app's User Token Scopes
  must be emptied and the two bot scopes added (docs/SLACK.md).

## Result

Built as planned. Migration 350. The official app's settings to change are listed in docs/SLACK.md "Scopes (bot
token)".
