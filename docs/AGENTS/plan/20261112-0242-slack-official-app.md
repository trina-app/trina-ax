# Slack connects through the official Trina AX app, without copying tokens by hand

- Date (UTC): 2026-11-12 02:42
- Branch: `feat/slack-official-app`
- Status: in progress
- Where: trina-ax common code (`server/src/integrations/slack/`, `shared/src/cloud-protocol/slack-broker.ts`, Admin ›
  Slack) and the hosting service's broker (private control plane, its own plan). Why: the connector is the same for
  every company; only whether a hosting service serves the server differs (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new way to set up Slack (one button); the own-app setup keeps working unchanged.
- QA: TC-203 "Slack connects without copying tokens by hand" (owner decision 2026-11-12).

## Goal

Today each team makes its own internal Slack app from our manifest and pastes four values (bot token, app-level token,
client id, client secret). That is the step people fail at. With one official, publicly distributed Slack app
("Trina AX") the owner of a team presses **Add to Slack** once; nothing is copied by hand. Members still link their own
Slack account once, as today ("Sign in with Slack" or the zero-click e-mail link).

## Decisions (owner, 2026-11-12)

1. One official app. "Add to Slack" = Slack's OAuth v2 install, returning to the hosting service's broker
   (`https://account.trina.app/slack-broker/`).
2. Served: hosted teams, and self-installed servers the hosting service registered (the same registry and rule as the
   Drive broker). A server with no connection to the hosting service keeps today's own-app setup. Both modes stay.
3. Events: the broker holds the ONE Socket Mode connection with the app-level token. That token is app-wide (it gets
   every workspace's events), so it never reaches a team server. The broker routes each envelope by Slack `team_id`
   to the one owner that installed that workspace. Team servers connect OUT to the broker, signed with their relay key.
4. Bot tokens: each workspace's xoxb token is delivered sealed only to the server it was installed for, sealed at rest
   on both sides. The team server posts its answers to Slack directly.
5. Only `app_mention`, `message.im` and interactivity go through the broker. The HTTP Events API is for later.
6. "Sign in with Slack" works with the official app through the broker's registered redirect URL.

## The wire contract

`shared/src/cloud-protocol/slack-broker.ts` (MIT, no imports, like `drive-broker.ts`; the control plane vendors it at a
pinned commit). All calls are `POST /api/slack-broker/v1/*` on the console host, JSON, signed:
`Authorization: TrinaSlackBroker key=<relay SPKI>, ts, nonce, sig`, Ed25519 over
`trina-slack-broker-v1\nPOST\n<path>\n<ts>\n<nonce>\n<sha256(body)>` (another prefix than the Drive broker's, so a
signature of one never verifies at the other). ±60 s, a (key, nonce) once.

| Call | Body | Answer |
|---|---|---|
| `status` | `{v}` | `{ok, appId, install \| null}`; `not_hosted` 403 / `not_configured` 503 → own-app setup |
| `install` | `{v, returnState, codeChallenge}` | `{authorizationUrl, expiresAt}` (Slack's `oauth/v2/authorize`) |
| `redeem` | `{v, handoff, codeVerifier, sealKey}` | `{install, token}` (sealed bot token) |
| `token` | `{v, sealKey}` | `{install, token}` (the same token again, e.g. after a restore) |
| `poll` | `{v, ack[], waitMs ≤ 25000}` | `{install \| null, events[]}` (long poll) |
| `uninstall` | `{v}` | `{slack: removed \| unavailable}` |
| `signin/start` | `{v, returnState, codeChallenge}` | `{authorizationUrl, expiresAt}` (Slack's OpenID Connect page) |
| `signin/redeem` | `{v, handoff, codeVerifier}` | `{slackUserId, slackTeamId, enterpriseId}` |

Events: `{id, kind: events_api | interactive | lifecycle, payload, receivedAt}`. `payload` is Slack's own payload with
its `token` field removed; `lifecycle` is `{event: uninstalled | tokens_revoked | removed}`.

Browser returns (only to the owner's recorded address, never one from a request):
`<team>/api/integrations/slack/official/callback?state&handoff` (install) and the existing
`<team>/api/integrations/slack/oauth/callback?state&handoff` (sign-in; `handoff` instead of `code`).

Sealed bot token: the team server sends a fresh X25519 public key per request (`sealKey`, inside the signed body);
the broker answers `X25519 → HKDF-SHA256 → AES-256-GCM` with AAD `trina-slack-broker-token-v1|<installId>|<T…>`.
So even a TLS-terminating proxy in front of the console never sees a bot token.

### Transport: long poll, not WebSocket

- **The same trust as every other broker call.** Each poll is one signed request (key, ts, nonce, body hash). A team
  that is suspended, deleted or moved, a registered server that is disabled, or an install that was removed stops
  getting events at its next poll (≤ 25 s), with nothing to kick out. A WebSocket would need its own handshake auth
  and a way to close live connections when any of that changes.
- **Works through anything that passes HTTPS**: Cloudflare in front of the console (100 s response limit), the
  console's 60 s idle timeout, office proxies that refuse WebSocket upgrades. No public address on the team server.
- **At least once, explicit acks.** Events wait in the broker (sealed, ≤ 30 min, only while the owner polled in the
  last 10 min) until acknowledged; one handed out and not acknowledged comes again after 60 s. The team server already
  handles an event id and a message once (`slack_events`), so a repeat is harmless. A team server that restarts
  mid-answer loses nothing.
- **Latency stays low**: the broker answers a held poll the moment an event is queued for that owner; Slack's 3 s ack
  is the broker's own job and never waits for a team server.
- **Cost**: one idle request per 25 s per server; the traffic is small by design (decision 5).

## Security model

- The app-level token and the client secret exist only in the hosting service's secret store. Nothing in this repo
  sees them; a team server never gets them (tested on the broker side: no answer, event or log carries them).
- **Per-workspace isolation.** The broker routes an envelope only when its `api_app_id` is the official app,
  its `team_id` names a workspace installed for exactly one served owner, and the envelope's other workspace fields
  (`authorizations`, `team.id`, `user.team_id`) agree with it. Anything else goes nowhere. One workspace is bound to
  one owner: an install of a workspace bound to another served owner is refused (`workspace_taken`) and nothing is
  handed out. The team server checks again: the envelope's workspace and app id must be the ones it installed.
- A team server only ever gets its own install's bot token, sealed to a key it made for that request. At rest it is
  sealed in `<secrets>/integrations/slack` as today's tokens are.
- PKCE-style binding of the browser return: the owner who pressed "Add to Slack" must be the signed-in person whose
  browser comes back, and only that server's verifier redeems the handoff. Slack's code is exchanged only at redeem.
- Sign in with Slack: the broker checks the id_token (issuer, audience = the official client id, time, its own nonce)
  and that it names the owner's installed workspace; the person's user token is revoked at once and never leaves the
  broker. The team server then does every check it does today (`users.info`: a person of this workspace, not a bot).
- Nothing about events is logged on either side beyond ids and short reasons.

## Failure modes

| What | What happens |
|---|---|
| The broker is down or unreachable | Admin › Slack says Problem: "can't reach the hosting service" ; polls back off 1 s … 60 s and resume by themselves. Events Slack sent meanwhile are acknowledged by the broker only if it is up; Slack retries unacknowledged ones itself. |
| Socket Mode down at the broker | No events; the broker reconnects (backoff). Team servers keep their bot token and can still answer what they already have. |
| Bot token revoked / app uninstalled in Slack | The broker gets `tokens_revoked` / `app_uninstalled` (manifest events), forgets the install and queues a `lifecycle` event; the team server shows "Removed from Slack. Add to Slack again." A token Slack refuses at a post (`invalid_auth`, `token_revoked`, `account_inactive`) gives the same state. Links stay (same workspace when added again). |
| Owner presses Remove | The team server asks the broker to `uninstall` (the broker calls `apps.uninstall`), then deletes its token and every link, as today. Broker unreachable: removed here anyway; the broker's operator can remove the install. |
| Team suspended | Not served: polls, token and sign-in answer `not_hosted`; queued events expire. Back to active: works again, same install. |
| Team deleted | The broker removes the app from the workspace and deletes the install. |
| Team renamed / moved to another host | The install is bound to the team, not to its address or host: the browser goes to the new address; the relay key of the new primary tenant signs. |
| Registered server disabled / removed | Not served at once; removed: the install is deleted. |
| Same workspace, a second team | Refused (`workspace_taken`); the first team's owner removes it there first. |
| Organization-wide (Enterprise Grid) install | Refused (`enterprise_install`), as today. |
| Server's sealed token lost (restore on a new machine) | It asks the broker for the token again (`token`). |

## Scope

In:
- The contract file above, with strict parsers, and its vectors in tests.
- `server/src/integrations/slack/broker.ts`: signed calls, the X25519 opening, the long-poll feed (backoff, acks).
- The connector's official mode: `slack_config.mode` (`own` | `official`), events from the feed through the same
  `onEnvelope` checks, the delivered bot token, `uninstall` on Remove, lifecycle events, "Sign in with Slack" through
  the broker. Migration `345_c_slack_official.sql`.
- Admin › Slack: **Add to Slack** when the broker serves this server and no own app is saved; the 4-step own-app
  checklist otherwise (unchanged). Status line, Turn off/on and Remove as today.
- When the official mode is used: `MYCEL_SLACK_BROKER_URL` (falls back to `MYCEL_GOOGLE_DRIVE_BROKER_URL`: both brokers
  are on the same console), and only once `status` answers yes.
- Five locales, docs (`SLACK.md`, `DECISIONS.md`, `changes/slack-official-app.md`), unit tests against a fake broker,
  the security cases, the web screen tests.

Out (later): the HTTP Events API (decision 5: the broker would take Slack's signed HTTP requests at
`/slack-broker/events` with the signing secret instead of Socket Mode; the queue, the routing and this contract stay
the same), Slack Marketplace listing, Enterprise Grid org installs, moving an own-app team to the official app
automatically (the owner removes the own app, then adds the official one).

## Steps

1. This plan; the contract with strict parsers.
2. The broker client and feed (`broker.ts`), with the seal vectors.
3. Migration 345; the connector's official mode; routes (`official/install`, `official/callback`); sign-in via broker.
4. Shared API fields (`SlackAdmin.mode`, `.official`), Admin › Slack, the five locales.
5. Tests: unit (fake broker: install, token, poll, isolation checks on the team side, lifecycle, sign-in, remove,
   failure modes), security cases for the new endpoints, web screen tests.
6. Docs and changes file.

## Risks

- Migration: the highest on `dev` is 344; this adds 345 (columns with defaults, one table). Additive.
- The broker must exist before a hosted team can use it; until `status` answers yes nothing changes on any server
  (own-app setup as today), so merging this first is safe.
- Phone: Admin › Slack keeps "Set this up on a computer" for the own app; "Add to Slack" works on a phone too (one
  button), so it is shown there.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/c-slack*.test.ts`, the
security matrix, `web/test/unit/slack-screens.test.tsx`; the web e2e for Admin › Slack.

## Result

(filled in at the end)
