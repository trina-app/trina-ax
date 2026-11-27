// The Slack connector (docs/SLACK.md, docs/DECISIONS.md "Slack 커넥터"). Owner: C (server/src/integrations/slack/,
// server/src/routes/slack.ts).
//
// Each team makes an internal Slack app in its own workspace from the manifest below and pastes its two tokens; the
// server keeps one Socket Mode connection to Slack (no public address needed). Or, where the hosting service serves
// the server, the owner adds the official app with "Add to Slack" and copies nothing (mode 'official': the hosting
// service holds the app's secrets and its one connection, and hands this server only its workspace's envelopes and
// bot token). Admins manage Slack too (state, "Add to Slack", on/off, Remove); the team's own app (its tokens: save,
// replace, remove) stays the owner's (docs/DECISIONS.md "Admins manage Slack", 2026-11-13). People link their Slack account to their
// own account here with a one-time link they get in Slack; asking @app in Slack then runs a normal chat turn as them.
// No response of this API ever carries a token: they come in sealed in the browser ('slack.token') and the screen
// only learns whether they are saved.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint, empty, stream } from './endpoint'
import { SealedSecret } from './credentials'
import { UserRef } from './entities'

/** off: not turned on (or no tokens) · connecting · connected · error: lastError says why */
export const SlackState = z.enum(['off', 'connecting', 'connected', 'error'])
export type SlackState = z.infer<typeof SlackState>
/** Connecting for longer than this (seconds) is a problem, not a wait: a Socket Mode hello comes within seconds and
 * the hosting service answers its first poll at once, so two minutes means something is in the way. */
export const SLACK_CONNECTING_SLOW_S = 120

/** reason codes only (never Slack's own text): the screen puts them in the reader's words. The official app's own:
 * broker_unreachable (the hosting service does not answer now), not_served (it does not serve this server now),
 * removed (the app was removed from the workspace: "Add to Slack" again) */
export const SlackErrorCode = z.enum(['invalid_auth', 'token_revoked', 'missing_scope', 'not_bot_token', 'not_app_token', 'enterprise_install', 'workspace_changed', 'socket_mode_off', 'app_mismatch', 'unreachable', 'ratelimited', 'key_unsafe', 'broker_unreachable', 'not_served', 'removed', 'bot_refused', 'unknown'])
export type SlackErrorCode = z.infer<typeof SlackErrorCode>

export const SlackWorkspace = z.object({ teamId: z.string(), name: z.string(), url: z.string().nullable() })
export type SlackWorkspace = z.infer<typeof SlackWorkspace>

export const SlackAdmin = z.object({
  /** own: the team's own Slack app (its tokens pasted here); official: the hosting service's app, added with "Add to
   * Slack" (only its bot token is here) */
  mode: z.enum(['own', 'official']),
  /** the hosting service serves this server now: "Add to Slack" can be used (while no own app is saved) */
  official: z.boolean(),
  /** the owner turned it on (off by default) */
  enabled: z.boolean(),
  /** both tokens are saved (the official app: its bot token) */
  tokens: z.boolean(),
  workspace: SlackWorkspace.nullable(),
  /** the app's name as people find it in Slack (`@` and `/invite` go by it): the bot user's display name as Slack says
   * it (read when the tokens are saved and at each connection), else the manifest's; never its user name (`trinaax`) */
  botName: z.string().nullable(),
  /** the Slack app's id (A…), for links to its settings pages in Slack; null until known */
  appId: z.string().nullable(),
  state: SlackState,
  /** while `state` is connecting: how many seconds it has been (the server's clock); null otherwise. Over
   * SLACK_CONNECTING_SLOW_S the screens say Slack is not answering, with what to do (docs/DECISIONS.md "Slack: one
   * state for the list and the page"). Optional: an older server does not send it. */
  connectingFor: z.number().int().nonnegative().nullable().optional(),
  lastError: SlackErrorCode.nullable(),
  /** where the links in Slack open (the address the owner saved the tokens from) */
  linkOrigin: z.string().nullable(),
  /** people who linked their Slack account */
  linked: z.number().int(),
  /** the app manifest to paste in Slack (JSON), and the address that opens Slack's "create app" with it filled in */
  manifest: z.string(),
  createUrl: z.string().url(),
  /** the app's client id and secret are saved ("Sign in with Slack") */
  signIn: z.boolean(),
  /** where Slack sends people back after "Sign in with Slack" (in the manifest); null: the team has no https address */
  redirectUrl: z.string().nullable(),
  /** whether the bot may read threads and channels (docs/SLACK.md "Marketplace-safe reading": the bot scopes
   * channels:history and groups:history): ok, missing (an app from before them: "Update Slack permissions"), null (no
   * tokens, or Slack has not said yet) */
  readScopes: z.enum(['ok', 'missing']).nullable(),
  /** the bot scopes to add for reading (own app: OAuth & Permissions › Bot Token Scopes); empty when none is missing */
  missingScopes: z.array(z.string()),
})
export type SlackAdmin = z.infer<typeof SlackAdmin>

export const SlackTokensBody = z.object({
  /** Bot User OAuth Token (xoxb-), sealed for 'slack.token' */
  botToken: SealedSecret,
  /** App-Level Token with connections:write (xapp-), sealed for 'slack.token' */
  appToken: SealedSecret,
  /** Basic Information › App Credentials: the Client ID (not a secret) and the Client Secret, sealed for 'slack.token' */
  clientId: z.string().max(64),
  clientSecret: SealedSecret,
  /** the address the page is open at (window.location.origin), as with GET /api/admin/slack: where links open and the
   * redirect URL of "Sign in with Slack", the same one the manifest showed */
  origin: z.string().max(200).optional(),
})

export const MySlack = z.object({
  /** the team uses Slack (turned on, tokens saved) */
  available: z.boolean(),
  workspace: z.string().nullable(),
  link: z.object({ slackUserId: z.string(), slackName: z.string().nullable(), linkedAt: IsoTime }).nullable(),
  /** "Sign in with Slack" can be used to link (the app's client id and secret saved, an https address) */
  signIn: z.boolean(),
  /** someone else set this account's e-mail in the last 7 days: the e-mail proves nothing until then */
  emailSetByOther: z.boolean(),
  /** the AI may read Slack threads and channels for me: linked, and the Slack app has the reading permissions (only
   * conversations the app was invited to and I am in) */
  read: z.boolean(),
})
export type MySlack = z.infer<typeof MySlack>

/** the token from the address /slack/link?t=<token> (43 characters); sent in a POST body, never in a path */
export const SlackLinkBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
export const SlackLinkPreview = z.object({
  workspace: z.string(),
  /** as Slack's profile says: the display name, the full name and the user name (all set by the person, so the page
   * shows them together with the id) */
  slack: z.object({ userId: z.string(), name: z.string().nullable(), realName: z.string().nullable(), handle: z.string().nullable() }),
  /** the person signed in here, who would be linked */
  me: z.object({ name: z.string(), username: z.string() }),
  expiresAt: IsoTime,
  /** this account is linked to another Slack account already: unlink that one first (confirm answers 409) */
  linkedElsewhere: z.boolean(),
  /** the proof (docs/DECISIONS.md "Slack 커넥터"): the Slack account's e-mail, as Slack gives it, is this account's.
   * mismatch / missing / recent: confirm is refused; the person links with "Sign in with Slack" instead (`signIn`);
   * unavailable: Slack did not answer now. */
  emailCheck: z.enum(['match', 'mismatch', 'missing', 'recent', 'unavailable']),
  /** "Sign in with Slack" can be used here instead */
  signIn: z.boolean(),
  /** the e-mail of this account that was compared (the person's own; Slack's is not shown) */
  email: z.string().nullable(),
})
export type SlackLinkPreview = z.infer<typeof SlackLinkPreview>

// ---------------------------------------------------------------- the channel relay (docs/SLACK.md "Channel relay")
// One Slack channel and one team conversation or project, both ways (plan
// docs/AGENTS/plan/20261127-0329-slack-channel-relay.md, docs/decisions/20261127-slack-channel-relay.md). A team owner or
// admin who is in the conversation, has their own Slack account linked and is in the channel connects it; everyone in
// the conversation sees the relay from then on (owner decision 3). The link is a room app (preset 'slack'); its
// messages are that app's messages with `slackAuthor` (shared/src/api/rooms.ts).

/** A Slack channel id the relay takes: public (C…) or private (G… or C…), never a DM. */
export const SLACK_RELAY_CHANNEL_ID = /^[CG][A-Z0-9]{2,40}$/
/** active: relaying · bot_removed: the app left the channel (nothing comes in or goes out; invite it again) ·
 * archived: the channel was archived or deleted in Slack (the link has ended) */
export const SlackRelayState = z.enum(['active', 'bot_removed', 'archived'])
export type SlackRelayState = z.infer<typeof SlackRelayState>
export const SlackRelayLink = z.object({
  /** the room app that is the link (Disconnect removes it) */
  appId: z.string(),
  channelId: z.string(),
  /** the channel's name in Slack, without "#" */
  channelName: z.string(),
  private: z.boolean(),
  /** a Slack Connect channel (shared with another organization) */
  extShared: z.boolean(),
  state: SlackRelayState,
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  /** messages go to Slack as "Name (Trina)" (the bot has chat:write.customize); false: as the app, the name first */
  customName: z.boolean(),
})
export type SlackRelayLink = z.infer<typeof SlackRelayLink>
/** Why a channel cannot be connected here: not_added (Slack is not added to the team, or turned off), room_kind (only
 * a team conversation or a project), guests (a guest is in the conversation), not_manager (only its owners and admins
 * who are in it). */
export const SlackRelayBlocked = z.enum(['not_added', 'room_kind', 'guests', 'not_manager'])
export type SlackRelayBlocked = z.infer<typeof SlackRelayBlocked>
export const SlackRelayStatus = z.object({
  /** the link of this conversation, for anyone in it (the header chip) */
  link: SlackRelayLink.nullable(),
  /** why I cannot connect one here; absent: I can (or one is connected and I may disconnect it) */
  blocked: SlackRelayBlocked.optional(),
  /** my own Slack account is linked (else the dialog shows only "Sign in with Slack") */
  meLinked: z.boolean(),
  /** "Sign in with Slack" can be used here (else the person links by mentioning the app in Slack) */
  signIn: z.boolean(),
  /** the app's name in Slack, for "/invite @<name>" */
  botName: z.string().nullable(),
  /** the official app was added before the relay asked for chat:write.customize: "Add to Slack again to post with
   * each person's name" (admins) */
  needsReAdd: z.boolean(),
})
export type SlackRelayStatus = z.infer<typeof SlackRelayStatus>
export const SlackRelayChannel = z.object({
  id: z.string(),
  name: z.string(),
  private: z.boolean(),
  extShared: z.boolean(),
  /** already connected to another conversation (one conversation per channel) */
  taken: z.boolean(),
})
export type SlackRelayChannel = z.infer<typeof SlackRelayChannel>
/** The channels both I and the app are in (Slack's users.conversations with the bot token). */
export const SlackRelayChannels = z.object({ items: z.array(SlackRelayChannel) })
export type SlackRelayChannels = z.infer<typeof SlackRelayChannels>
export const ConnectSlackRelayBody = z.object({ channelId: z.string().regex(SLACK_RELAY_CHANNEL_ID) }).strict()
export type ConnectSlackRelayBody = z.infer<typeof ConnectSlackRelayBody>
/** A relayed message from Slack per conversation link and day, at most (the room apps' 500 a day does not apply). */
export const SLACK_RELAY_DAILY_CAP = 5000
/** The relayed text of one message, at most (characters). */
export const SLACK_RELAY_TEXT_MAX = 8000

const RELAY_WHO = 'Anyone in the room reads it (404 otherwise). Connect and Disconnect: its owners and admins who are in it (403 otherwise).'
export const SLACK_RELAY = {
  slackRelay: endpoint({ method: 'GET', path: '/api/rooms/:id/slack', auth: 'user', owner: 'C', response: SlackRelayStatus,
    summary: `The conversation's Slack channel link (the header chip, the Slack row of Add an app) and whether I may connect one. ${RELAY_WHO}` }),
  slackRelayChannels: endpoint({ method: 'GET', path: '/api/rooms/:id/slack/channels', auth: 'user', owner: 'C', response: SlackRelayChannels,
    summary: 'The Slack channels both I (my linked Slack account) and the app are in, to connect one. The conversation\'s owners and admins who are in it (403 otherwise; 404 not in it); 409 slack_not_linked without my own Slack account, 409 slack_off when Slack is not added.' }),
  connectSlackRelay: endpoint({ method: 'POST', path: '/api/rooms/:id/slack', auth: 'user', owner: 'C', status: 201, body: ConnectSlackRelayBody, response: SlackRelayStatus,
    summary: 'Connect a Slack channel: everyone in the conversation sees its messages from now on, and what they write goes to it. A team conversation or project only (409 room_kind), no guest in it (409 guests), my Slack account linked and in the channel (409 slack_not_linked, 409 not_in_channel), the app in the channel (409 bot_not_in_channel), one channel per conversation and one conversation per channel (409 linked). Audited (slack.relay_linked).' }),
  disconnectSlackRelay: endpoint({ method: 'DELETE', path: '/api/rooms/:id/slack', auth: 'user', owner: 'C', status: 204, response: empty,
    summary: 'Disconnect the Slack channel: nothing more comes or goes; the messages so far stay. Audited (slack.relay_unlinked).' }),
  retrySlackRelay: endpoint({ method: 'POST', path: '/api/rooms/:id/slack/messages/:messageId/retry', auth: 'user', owner: 'C', status: 204, response: empty,
    summary: '"Retry" on my own message that Slack refused ("Not sent to Slack"). Its author only (404 otherwise).' }),
  slackRelayAvatar: endpoint({ method: 'GET', path: '/api/rooms/:id/slack/avatar/:slackUserId', auth: 'user', owner: 'C', response: stream(false),
    summary: 'The Slack picture of someone whose message was relayed into this conversation (fetched from Slack\'s own image hosts only, kept in memory). Anyone in the room (404 otherwise, and for a person never relayed here). An image only: nosniff and a sandbox policy.' }),
} as const

export const SLACK = {
  slackAdmin: endpoint({ method: 'GET', path: '/api/admin/slack', auth: 'admin', owner: 'C', query: z.object({ origin: z.string().max(200).optional() }), response: SlackAdmin, summary: 'The Slack connector: state, workspace, the manifest to create the app with. Never a token.' }),
  saveSlackTokens: endpoint({ method: 'PUT', path: '/api/admin/slack/tokens', auth: 'owner', owner: 'C', body: SlackTokensBody, response: SlackAdmin, summary: 'Check and save the bot and app-level tokens (sealed in the browser). The owner only. Another workspace than before removes every link.' }),
  setSlackEnabled: endpoint({ method: 'POST', path: '/api/admin/slack/enabled', auth: 'admin', owner: 'C', body: z.object({ enabled: z.boolean() }), response: SlackAdmin, summary: 'Turn the connector on (needs saved tokens) or off.' }),
  removeSlack: endpoint({ method: 'DELETE', path: '/api/admin/slack', auth: 'admin', owner: 'C', response: SlackAdmin, summary: 'Remove the tokens and every link; the connector is off. The team\'s own Slack app (mode own, tokens saved): the owner only (an admin: 403 owner_only).' }),
  mySlack: endpoint({ method: 'GET', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Whether the team uses Slack and the Slack account linked to me.' }),
  unlinkSlack: endpoint({ method: 'DELETE', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Unlink my Slack account.' }),
  previewSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/preview', auth: 'user', owner: 'C', body: SlackLinkBody, response: SlackLinkPreview, summary: 'What confirming this one-time link would link: the Slack account and me. Changes nothing.' }),
  confirmSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/confirm', auth: 'user', owner: 'C', body: SlackLinkBody, response: MySlack, summary: 'Link the Slack account of this one-time link to me (used up).' }),
  startSlackSignIn: endpoint({ method: 'POST', path: '/api/slack/signin', auth: 'user', owner: 'C', body: z.object({}), response: z.object({ authorizationUrl: z.string().url() }), summary: 'Start "Sign in with Slack" to link the Slack account I sign in to (10 minutes, this session only).' }),
  recheckSlackReadScopes: endpoint({ method: 'POST', path: '/api/admin/slack/read-scopes/recheck', auth: 'admin', owner: 'C', body: z.object({}), response: SlackAdmin, summary: '"I updated them": asks Slack again now which permissions the Slack app\'s bot has (reading threads and channels).' }),
  startSlackInstall: endpoint({ method: 'POST', path: '/api/admin/slack/official/install', auth: 'admin', owner: 'C', body: z.object({ origin: z.string().max(200).optional() }), response: z.object({ authorizationUrl: z.string().url() }), summary: '"Add to Slack": Slack\'s install page of the hosting service\'s official app (10 minutes, this owner or admin only). `origin`: the address the page is open at, where links in Slack open.' }),
  cancelSlackSignIn: endpoint({ method: 'DELETE', path: '/api/slack/signin/flow', auth: 'user', owner: 'C', response: empty, status: 204, summary: 'Cancel my "Sign in with Slack" of this session that is still waiting: a window left open cannot finish it afterwards.' }),
  cancelSlackInstall: endpoint({ method: 'DELETE', path: '/api/admin/slack/install/flow', auth: 'admin', owner: 'C', response: empty, status: 204, summary: 'Cancel my "Add to Slack" of this session that is still waiting: a window left open cannot finish it afterwards.' }),
  cancelSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/cancel', auth: 'user', owner: 'C', body: SlackLinkBody, response: empty, status: 204, summary: 'Throw this one-time link away without linking.' }),
} as const
