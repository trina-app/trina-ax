# Slack: one connect links the account and lets the AI read Slack

- Date (UTC): 2026-11-13 02:06
- Branch: `feat/slack-read-one-connect`
- Status: in progress
- Where: Team AX core (`server/src/integrations/slack/`, `server/src/chat/`, `web/`). Why: the Slack connector is core
  (docs/SLACK.md); the hosting service's part is only written down here (it lives in another repo).
- Version impact: minor, a new ability (the AI reads Slack) and a migration.

## Goal

The owner tested in real Slack (2026-11-13): after "Connect Trina AX account" the AI still could not read any Slack
message, not even the thread it was asked in, did not know the question came from Slack, and when asked "can you see
Slack?" offered a "connect card" that does not exist. The owner's rule: everything connects in ONE step.

## Scope

In:
1. **One step.** "Sign in with Slack" (Settings, the link page, the zero-click link's fallback) becomes Slack's OAuth v2
   with user scopes (`oauth/v2/authorize?user_scope=…`, the same redirect URL `/api/integrations/slack/oauth/callback`).
   It proves who signed in (`authed_user.id`, checked again with `auth.test` of that token) AND gives the person's user
   token. User scopes, exactly: `channels:history groups:history im:history mpim:history channels:read groups:read
   im:read mpim:read users:read search:read`. The token is kept sealed per person (SecretBox, the Slack key directory,
   AAD bound to the person). Unlink, Remove and a disabled account revoke it at Slack (`auth.revoke`) and delete it.
   A Slack app without the user scopes yet (`invalid_scope`): the link falls back to the old OpenID Connect sign-in in
   the same click, and Admin › Slack shows "Update Slack permissions".
2. **Tools** (turn tool provider `slack`, only for a person with a token, never in shared, confidential or draft
   chats): `slack_read_thread`, `slack_read_channel`, `slack_search`. What they return counts in the chat's read scope
   (a new source `{type:'slack', id: channel}`: only the reader sees it), so saving it somewhere wider asks first.
3. **Questions from Slack**: the turn's instructions say it came from Slack (workspace, channel name, thread) and carry
   the thread's messages so far (at most 50 messages / 12,000 characters, read with the asker's token), framed as
   other people's words.
4. **Already linked, no token**: the "working…" message of the first question of a thread gets **Allow reading Slack**
   (a link straight to Slack's consent page, bound to that person's flow, no app sign-in needed because Slack itself
   says who allowed it and it must be the linked Slack account). Once allowed, the question is answered again with the
   thread. The first answer is not held back.
5. **No made-up cards**: the prompt says how Slack is reached (the Slack link, never connect_service) and its state for
   this person; `connect_service` refuses Slack with that sentence.
6. **Post to channel**: an answer that used Slack messages from another conversation than the one it is posted to
   (another channel, a DM, search results) gets the existing notice; the asked thread's own channel does not.
7. **Both app modes**: own: the manifest gains the user scopes; official: new broker ops `readStart` / `readRedeem`
   (new paths, so an older hosting service answers "not found" and linking falls back to the old sign-in). What the
   hosting service must change is in docs/SLACK.md "The hosting service's part".
8. Slack's 2025 limit for non-Marketplace distributed apps (conversations.history / .replies: 1 a minute, 15 messages):
   the official app reads 15 at a time and says "Slack lets this app read this once a minute" instead of failing
   silently; the own (internal) app is not limited.

Out: files in Slack messages; reading Slack from scheduled runs' cards; writing to Slack beyond today's answers.

## Steps

1. Migration `348_c_slack_read.sql`: `slack_user_tokens`; `slack_signin_flows.kind/method/question`;
   `slack_config.read_scopes`.
2. service.ts: OAuth v2 sign-in, token store/revoke, allow-reading flow, thread context, broker read ops.
3. `read.ts` (tools + provider), read-scope source, post-check, connect_service refusal.
4. API + web: MySlack.read, SlackAdmin.readScopes, Settings line, link page, Admin prompt; en → es/id/ja/ko.
5. Tests (fake Slack: oauth.v2.access, conversations.replies/history/info, search.messages), docs, changes fragment.

## Risks

- Migration 348 (dev's highest is 347).
- Tokens: sealed, never in logs, prompts or answers; revoked on every way out.
- Existing workspaces: the owner adds the user scopes (own app) / the hosting service updates its app (official);
  until then linking works as before and reading is simply not offered.
