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
export const SlackErrorCode = z.enum(['invalid_auth', 'token_revoked', 'missing_scope', 'not_bot_token', 'not_app_token', 'enterprise_install', 'workspace_changed', 'socket_mode_off', 'app_mismatch', 'unreachable', 'ratelimited', 'key_unsafe', 'unknown'])
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
  /** the Slack app's id (A…), for links to its settings pages in Slack; null until known */
  appId: z.string().nullable(),
  state: SlackState,
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

export const SLACK = {
  slackAdmin: endpoint({ method: 'GET', path: '/api/admin/slack', auth: 'owner', owner: 'C', response: SlackAdmin, summary: 'The Slack connector: state, workspace, the manifest to create the app with. Never a token.' }),
  saveSlackTokens: endpoint({ method: 'PUT', path: '/api/admin/slack/tokens', auth: 'owner', owner: 'C', body: SlackTokensBody, response: SlackAdmin, summary: 'Check and save the bot and app-level tokens (sealed in the browser). Another workspace than before removes every link.' }),
  setSlackEnabled: endpoint({ method: 'POST', path: '/api/admin/slack/enabled', auth: 'owner', owner: 'C', body: z.object({ enabled: z.boolean() }), response: SlackAdmin, summary: 'Turn the connector on (needs saved tokens) or off.' }),
  removeSlack: endpoint({ method: 'DELETE', path: '/api/admin/slack', auth: 'owner', owner: 'C', response: SlackAdmin, summary: 'Remove the tokens and every link; the connector is off.' }),
  mySlack: endpoint({ method: 'GET', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Whether the team uses Slack and the Slack account linked to me.' }),
  unlinkSlack: endpoint({ method: 'DELETE', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Unlink my Slack account.' }),
  previewSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/preview', auth: 'user', owner: 'C', body: SlackLinkBody, response: SlackLinkPreview, summary: 'What confirming this one-time link would link: the Slack account and me. Changes nothing.' }),
  confirmSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/confirm', auth: 'user', owner: 'C', body: SlackLinkBody, response: MySlack, summary: 'Link the Slack account of this one-time link to me (used up).' }),
  startSlackSignIn: endpoint({ method: 'POST', path: '/api/slack/signin', auth: 'user', owner: 'C', body: z.object({}), response: z.object({ authorizationUrl: z.string().url() }), summary: 'Start "Sign in with Slack" to link the Slack account I sign in to (10 minutes, this session only).' }),
  cancelSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/cancel', auth: 'user', owner: 'C', body: SlackLinkBody, response: empty, status: 204, summary: 'Throw this one-time link away without linking.' }),
} as const
