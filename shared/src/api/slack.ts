// The Slack connector (docs/SLACK.md, docs/DECISIONS.md "Slack 커넥터"). Owner: C (server/src/integrations/slack/,
// server/src/routes/slack.ts).
//
// Each team makes an internal Slack app in its own workspace from the manifest below and pastes its two tokens; the
// server keeps one Socket Mode connection to Slack (no public address needed). People link their Slack account to their
// own account here with a one-time link they get in Slack; asking @app in Slack then runs a normal chat turn as them.
// No response of this API ever carries a token: they come in sealed in the browser ('slack.token') and the screen
// only learns whether they are saved.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint, empty } from './endpoint'
import { SealedSecret } from './credentials'

/** off: not turned on (or no tokens) · connecting · connected · error: lastError says why */
export const SlackState = z.enum(['off', 'connecting', 'connected', 'error'])
export type SlackState = z.infer<typeof SlackState>
/** reason codes only (never Slack's own text): the screen puts them in the reader's words */
export const SlackErrorCode = z.enum(['invalid_auth', 'token_revoked', 'missing_scope', 'not_bot_token', 'not_app_token', 'enterprise_install', 'workspace_changed', 'socket_mode_off', 'unreachable', 'ratelimited', 'key_unsafe', 'unknown'])
export type SlackErrorCode = z.infer<typeof SlackErrorCode>

export const SlackWorkspace = z.object({ teamId: z.string(), name: z.string(), url: z.string().nullable() })
export type SlackWorkspace = z.infer<typeof SlackWorkspace>

export const SlackAdmin = z.object({
  /** the owner turned it on (off by default) */
  enabled: z.boolean(),
  /** both tokens are saved */
  tokens: z.boolean(),
  workspace: SlackWorkspace.nullable(),
  /** the bot's name in Slack, as people @mention it */
  botName: z.string().nullable(),
  state: SlackState,
  lastError: SlackErrorCode.nullable(),
  /** where the links in Slack open (the address the owner saved the tokens from) */
  linkOrigin: z.string().nullable(),
  /** people who linked their Slack account */
  linked: z.number().int(),
  /** the app manifest to paste in Slack (JSON), and the address that opens Slack's "create app" with it filled in */
  manifest: z.string(),
  createUrl: z.string().url(),
})
export type SlackAdmin = z.infer<typeof SlackAdmin>

export const SlackTokensBody = z.object({
  /** Bot User OAuth Token (xoxb-), sealed for 'slack.token' */
  botToken: SealedSecret,
  /** App-Level Token with connections:write (xapp-), sealed for 'slack.token' */
  appToken: SealedSecret,
})

export const MySlack = z.object({
  /** the team uses Slack (turned on, tokens saved) */
  available: z.boolean(),
  workspace: z.string().nullable(),
  link: z.object({ slackUserId: z.string(), slackName: z.string().nullable(), linkedAt: IsoTime }).nullable(),
})
export type MySlack = z.infer<typeof MySlack>

/** the token from the address /slack/link?t=<token> (43 characters); sent in a POST body, never in a path */
export const SlackLinkBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
export const SlackLinkPreview = z.object({
  workspace: z.string(),
  slack: z.object({ userId: z.string(), name: z.string().nullable() }),
  /** the person signed in here, who would be linked */
  me: z.object({ name: z.string(), username: z.string() }),
  expiresAt: IsoTime,
  /** this account is linked to another Slack account already: unlink that one first (confirm answers 409) */
  linkedElsewhere: z.boolean(),
})
export type SlackLinkPreview = z.infer<typeof SlackLinkPreview>

export const SLACK = {
  slackAdmin: endpoint({ method: 'GET', path: '/api/admin/slack', auth: 'owner', owner: 'C', response: SlackAdmin, summary: 'The Slack connector: state, workspace, the manifest to create the app with. Never a token.' }),
  saveSlackTokens: endpoint({ method: 'PUT', path: '/api/admin/slack/tokens', auth: 'owner', owner: 'C', body: SlackTokensBody, response: SlackAdmin, summary: 'Check and save the bot and app-level tokens (sealed in the browser). Another workspace than before removes every link.' }),
  setSlackEnabled: endpoint({ method: 'POST', path: '/api/admin/slack/enabled', auth: 'owner', owner: 'C', body: z.object({ enabled: z.boolean() }), response: SlackAdmin, summary: 'Turn the connector on (needs saved tokens) or off.' }),
  removeSlack: endpoint({ method: 'DELETE', path: '/api/admin/slack', auth: 'owner', owner: 'C', response: SlackAdmin, summary: 'Remove the tokens and every link; the connector is off.' }),
  mySlack: endpoint({ method: 'GET', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Whether the team uses Slack and the Slack account linked to me.' }),
  unlinkSlack: endpoint({ method: 'DELETE', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Unlink my Slack account.' }),
  previewSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/preview', auth: 'user', owner: 'C', body: SlackLinkBody, response: SlackLinkPreview, summary: 'What confirming this one-time link would link: the Slack account and me. Changes nothing.' }),
  confirmSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/confirm', auth: 'user', owner: 'C', body: SlackLinkBody, response: MySlack, summary: 'Link the Slack account of this one-time link to me (used up).' }),
  cancelSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/cancel', auth: 'user', owner: 'C', body: SlackLinkBody, response: empty, status: 204, summary: 'Throw this one-time link away without linking.' }),
} as const
