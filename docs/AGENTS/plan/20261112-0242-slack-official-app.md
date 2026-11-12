# Slack connects through the official Trina AX app, without copying tokens by hand

- Date (UTC): 2026-11-12 02:42
- Branch: `feat/slack-official-app`
- Status: done (PR into dev; security: merge needs the owner's OK)
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
| Owner presses Remove | The team server asks the broker to `uninstall` (the broker calls `apps.uninstall`, else `auth.revoke` of the bot token), then deletes its token and every link, as today. Broker unreachable: removed here anyway; the broker's operator can remove the install. Slack unreachable at the broker: it answers `unavailable` and keeps the install as this team's until it can end it (no other team gets the workspace meanwhile). |
| Team suspended | Not served: polls, token and sign-in answer `not_hosted`; queued events expire. It keeps its workspace (another team: `workspace_taken`). Back to active: works again, same install. |
| Team deleted | The broker removes the app from the workspace (the token useless at Slack) and only then deletes the install; Slack unreachable: tried again at the next sweep (5 minutes). |
| Team renamed / moved to another host | The install is bound to the team, not to its address or host: the browser goes to the new address; the relay key of the new primary tenant signs. |
| Registered server disabled / removed | Not served at once; disabled: it keeps its workspace; removed: as a deleted team. |
| Same workspace, a second team | Refused (`workspace_taken`), also while the first team is suspended or its server disabled (no automatic move: Slack hands back the same bot token on a reinstall). Free again once the first team removes it, the app is removed in Slack, the first team is deleted or its server removed, or the hosting service's operator removes it; each first makes the old token useless at Slack. |
| A member who is not a workspace admin presses Add to Slack | Refused (`not_workspace_admin`, "Slack 워크스페이스 관리자가 추가해야 해요."); the app is taken off the workspace again unless it is already added here. |
| Slack unreachable while the team server checks the new token (`auth.test`) | Kept at the broker (not removed), fetched again and checked shortly (`install_pending`: "turns on by itself"); only a definite no removes it. A switch to another workspace never leaves both without the app: the broker ends the first one before it binds the second, and refuses the second when it cannot. |
| A "removed" notice of an earlier install, handed out after the app was added again | Ignored: the notice names its install, and the team server acts only on the one it holds; a new install also clears the owner's queued notices at the broker. |
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

Done as planned, steps 1-6. The contract file is unchanged since its commit (the control plane's copy is re-pinned to
it after the rebase onto `dev`: the same bytes).

- `server/src/integrations/slack/broker.ts`: signed calls (the relay team key, the contract's own signing string), the
  bot token opened with a one-time X25519 key per request, Slack's own pages only (`slackBrokerAuthorizeUrl`), errors
  as the broker's code only, and the long-poll feed: one answer's events side by side, acknowledged with the next poll,
  backoff 1 s … 60 s, a minute while not served; a feed that stops acknowledges what it took at once.
- The connector's official mode (`slack_config.mode`, migration 345): "Add to Slack" bound to the owner who pressed it
  (state hashed, verifier sealed, 10 minutes, used once, the newest only; the owner's browser only, sign in first when it
  has no session); before the bot token is kept Slack is asked (`auth.test`: the install's workspace and bot, every
  scope); turned on at once. Envelopes from the feed go through the same `onEnvelope`; each broker event id once.
  Lifecycle events, an install the broker no longer has, and a token Slack refuses at a post all forget the token and
  keep the links ("removed": add it again). A token that does not open here is fetched again (`token`). Remove calls
  `uninstall` first (best effort). Sign in with Slack through the broker (`via = 'broker'`, a handoff instead of a code;
  the workspace checked again, then every check as before). The own app's tokens are refused while the official app is
  added (`official_saved`); "Add to Slack" while an own app is saved (`own_app_saved`).
- Routes `POST /api/admin/slack/official/install` (owner) and `GET /api/integrations/slack/official/callback`; the
  sign-in callback takes a `handoff`; the return page (`/slack/signin-return`) brings a handoff back (`to=install` for
  the install's callback).
- Shared: `SlackAdmin.mode`, `.official`; error codes `broker_unreachable`, `not_served`, `removed`.
- Admin › Slack: **Add to Slack** where the hosting service serves this server and nothing of our own is saved (also on
  a phone), *Use your own Slack app instead* for the four steps; added: the status line with Remove in place of
  Replace tokens; the outcome of "Add to Slack" said once. Five locales.
- Docs: `docs/SLACK.md` "The official app", `docs/DECISIONS.md` "Slack through the official Trina AX app",
  `changes/slack-official-app.md`, the HTTP API reference.
- Tests: `tests/unit/c-slack-broker.test.ts` (the seal vector shared with the control plane, signatures and nonces,
  refusals, Slack's pages only, origins, the feed), `tests/unit/c-slack-official.test.ts` (fake broker
  `tests/lib/fake-slack-broker.ts`: owner only, the owner's browser only, used once, Slack confirms the token, workspace
  and app isolation, an event id once, sign-in through the broker, removed and added again, a stale "removed" handed out
  again, a token refused at a post, a restore, the broker down and not serving, Remove, nothing secret in logs, rows or
  answers), the security matrix (`startSlackInstall` owner only, the install callback), web
  `slack-screens.test.tsx` and `slack-signin-pages.test.tsx`.

### Review fixes (2026-11-12, independent security review)

All twelve findings were checked against the code first; each was real. Contract: trina-ax `d5a51e7` (the control
plane re-pinned to it, byte for byte).

| # | Finding | Fixed |
|---|---|---|
| 1 | A queued "removed" wipes an install added again | Lifecycle payload `{ event, installId }` (`parseSlackBrokerLifecycle`); `onBrokerEvent` acts only when it is `slack_config.install_id`; the broker's `bind()` deletes the owner's queued notices. Test: the fake broker queues the notice on the tokenRefused path (`d5a51e7`, `485138b`; control plane) |
| 2 | A workspace moved to a new owner while the old one kept a working token | Control plane SB-10: no automatic move while the old owner exists (served or not); freed only after the token is useless at Slack (`apps.uninstall`, else `auth.revoke`), then forgotten; kept while Slack cannot be asked. Docs rows above |
| 3 | Anyone allowed to install apps can claim a workspace | Control plane: `users.info` of the installer at redeem, `is_admin` / `is_owner` / `is_primary_owner` (or an org admin/owner); else `not_workspace_admin` and the grant taken off again. Here: the outcome in five locales (`485138b`) |
| 4 | The poll limit drops a busy team's events | Control plane: events the team server ignores are not queued (`subtype`, `bot_id`, the app's own bot user: exactly `onEnvelope`'s drops); poll limit 3600 → 36000 an hour |
| 5 | Buttons routed by the presser's workspace only | Control plane: a button on a message in the channel must be on the receiving install's own bot's message (`message.user`); ephemeral buttons are shown only to the install's own people (this server's rule) |
| 6 | One address's junk locks out its tenants | Control plane: only calls without a valid signature of a known key count per address; owners' calls have their owner's limits; a known key not served now has its own limit |
| 7 | Sign-in limits throttle a rollout | Control plane: sign-in 1000 open states, 3000 starts and redeems an hour; Slack's returns 3000 an hour per address; installs keep 30 |
| 8 | 2-minute handoff too short for sign-in-first | `SLACK_BROKER_HANDOFF_TTL_MS` 10 minutes (`d5a51e7`) |
| 9 | A brief Slack outage at Add to Slack removes the app | `saveInstall` unreachable (or rate-limited): kept, fetched again and checked (5 s … 60 s, 30 minutes), `install_pending`; uninstall only on a definite no. The broker ends W1 before binding W2 and refuses W2 when W1 cannot be ended (`485138b`) |
| 10 | A poll whose caller hung up still takes events | Control plane: no `takeDue` once the request's signal is aborted |
| 11 | `slack_install_flows` never cleaned up | `sweep()` deletes them a day after their time (`485138b`) |
| 12 | `appToken` / `clientSecret` on a public field | Control plane: private fields only (`#`), tested with `JSON.stringify` and `Bun.inspect` |

Follow-ups (not done): the install kept after an unreachable check lives in memory only (after a restart the owner
presses Add to Slack again; the same install comes back); a Remove the broker could not end at Slack stays bound to its
team until it is added again, removed in Slack or by the operator (the sweep does not retry it).

Owner steps before it is used: the control plane's `docs/slack-broker.md` section 6 (the app's client secret and a new
app-level token with `connections:write` in the hosting service's secret store, the app id and client id in its
environment, the `app_uninstalled` and `tokens_revoked` bot events in the app's settings), then
`MYCEL_SLACK_BROKER_URL` (or the Drive broker's variable already there) on the team servers.
