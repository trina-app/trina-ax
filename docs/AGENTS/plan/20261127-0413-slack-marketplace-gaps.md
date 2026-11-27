# Slack Marketplace gaps on the team server: delete Slack data on removal, App Home tab

- Date (UTC): 2026-11-27 04:13
- Branch: `feat/slack-marketplace-gaps`
- Status: done
- Where: trina-ax `server/src/integrations/slack/`. Why: the team server holds the Slack links and answers the
  Home tab (docs/REPOSITORY-RULES.md: Slack connector, component C).
- Version impact: minor. A new user-visible feature (the Slack app's Home tab) and a changed data rule (Slack data is
  deleted when the app is removed in Slack).

## Goal

The official "Trina AX" Slack app is to be submitted to the Slack Marketplace (gap analysis kept outside the repo,
items G5 and G10). Two of its gaps are on the team server:

1. **Data deletion.** Slack's Developer Policy: delete all data associated with a workspace within 14 business days
   after the app is removed. Today a removal in Slack (Slack's `app_uninstalled` or `tokens_revoked`, the hosting
   service's operator, a bot token Slack refuses) forgets only the token and keeps every person's link "for a re-add".
2. **App Home.** Slack's guidelines: support information on the Home tab, help reachable in the app. Today
   `home_tab_enabled: false`.

## Scope

In:
- Removed in Slack (the official app): at once delete what came from Slack for that workspace: `slack_links` (Slack
  user ids and names), `slack_link_tokens`, `slack_threads`, `slack_requests`, `slack_events`, `slack_signin_flows`,
  `slack_user_tokens`; clear the workspace's Slack metadata on `slack_config` (name, address, enterprise id, bot
  user id, bot name, bot scopes); empty the in-memory Slack caches (`asked`, `names`, `shared`). The config row stays
  (mode, team id, `last_error = 'removed'`) so Admin says "removed, add it again". In-flight "Add to Slack" flows stay.
- The same deletion on **Remove** (already deletes the tables) now also covers the caches and `slack_user_tokens`.
- Audit rows keep the action and who did it; the Slack user id in `detail.slackUser` of `slack.*` rows is removed at
  the same time (the rows are the team's security record; the Slack id is not needed after the link is gone).
- App Home: `app_home_opened` (tab `home`) answered with `views.publish` (no new scope): what the app does, how to
  ask, how to link, the person's link state, a support link, "AI answers can be wrong. Check important ones." In the
  person's language when linked (Trina's language), else the team's default.
- Manifest of the team's own app: `home_tab_enabled: true`, bot event `app_home_opened`.
- docs/SLACK.md: the deletion rule, the Home tab, the official app's settings for the owner, the HTTP Events switch
  pointer (trina-cloud `docs/slack-broker.md` 6b).

Out:
- The hosting service (trina-cloud): routing `app_home_opened`, the install started from Slack, the HTTP Events
  check: a separate trina-cloud PR. The contract file `shared/src/cloud-protocol/slack-broker.ts` is not changed (its
  envelope shape is the same; only a comment lists event types).
- The team's own app removed in Slack: unchanged (the team's own internal app; Slack refuses its token, Admin says so;
  Remove deletes everything). The Marketplace rule is about the official app.
- Chats: the question and the answer a person got in Trina stay in that person's chat (their own data in Trina).
- The live Slack app settings: not changed; listed for the owner in docs/SLACK.md.

## Steps

1. `service.ts`: one `dropSlackData()` used by `removedInSlack` and `remove`; the audit scrub; caches cleared.
2. `home.ts` (new file, so the relay branch's edits of `service.ts` meet few lines): the Home view blocks.
3. `envelope.ts`: the `app_home_opened` shape; `service.ts onEnvelope`: one branch that calls `home.ts`.
4. `manifest.ts`: home tab on, the event.
5. Tests: `tests/unit/c-slack-official.test.ts` (removed in Slack deletes links, threads, requests, scrubs audit;
   added again needs a new link), `tests/unit/c-slack.test.ts` (Home tab published for a linked and an unlinked
   person, other workspace / other app ignored, manifest).
6. docs/SLACK.md, `changes/slack-marketplace-gaps.md`, a decision file.

## Decisions

`docs/decisions/20261127-slack-marketplace-gaps.md`: removed in Slack deletes the Slack data at once (supersedes the
"links stay" line of docs/SLACK.md "The official app").

## Risks

- No migration. The relay branch (`feat/slack-channel-relay`) edits `service.ts`, `manifest.ts`, `broker.ts`: this
  branch keeps to a few lines there (a new file for the Home view).
- A wrong "removed" (none known: only Slack's own events, the hosting service saying the install is gone, or Slack
  refusing the token) now costs people a re-link. Accepted: Slack's policy, and each of those means the token is dead.
- Home tab text in five app languages (server-side strings, en/ko/ja/zh/es/id as the Slack texts are).

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun test tests/unit/c-slack*.test.ts`, `tests/security` Slack cases.

## Result

Built as planned. Removal (in Slack, or Remove) deletes the workspace's Slack data at once (`removedInSlack`,
`forgetWorkspace`, `scrubAudit`, `forgetCaches`); `slack_install_flows` stay so an Add to Slack in progress goes on.
The Home tab is `home.ts` plus one branch in `onEnvelope`; the own app's manifest has the tab and the event.
`tests/unit/c-slack-read.test.ts` (a simulated official removal) now puts the workspace's links back after it, since
removal deletes them. `home.ts` is listed in `tests/unit/i18n-languages.test.ts` (its ko text sits next to the others,
as `text.ts` does). The trina-cloud side (routing `app_home_opened`, `/slack/add`, the manifest file, the switch steps)
is trina-cloud branch `feat/slack-marketplace-gaps`; the website page and privacy section are trina-ax-website
`feat/slack-page-privacy`.
