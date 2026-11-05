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

/** The owner proposes linking a Slack person to a member whose e-mails differ: nothing is linked until the member
 * accepts it here (their own session); 7 days. */
export const SlackProposal = z.object({
  id: z.string(),
  slack: z.object({ userId: z.string(), name: z.string().nullable(), realName: z.string().nullable(), handle: z.string().nullable(), email: z.string().nullable() }),
  proposedBy: z.string().nullable(),
  expiresAt: IsoTime,
  /** the two halves, either order: accepted here, and the Slack person's one-time link (from Slack) confirmed here */
  memberAccepted: z.boolean(),
  slackConfirmed: z.boolean(),
})
export type SlackProposal = z.infer<typeof SlackProposal>
export const MySlack = z.object({
  /** the team uses Slack (turned on, tokens saved) */
  available: z.boolean(),
  workspace: z.string().nullable(),
  link: z.object({ slackUserId: z.string(), slackName: z.string().nullable(), linkedAt: IsoTime }).nullable(),
  /** a link the owner proposed, waiting for this person */
  proposal: SlackProposal.nullable(),
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
   * mismatch / missing / recent: confirm is refused and the team owner proposes the link instead (Admin › Slack);
   * proposal: the owner proposed this Slack account for this person, so confirming is the Slack half of it;
   * unavailable: Slack did not answer now. */
  emailCheck: z.enum(['match', 'mismatch', 'missing', 'recent', 'unavailable', 'proposal']),
  /** the e-mail of this account that was compared (the person's own; Slack's is not shown) */
  email: z.string().nullable(),
})
export type SlackLinkPreview = z.infer<typeof SlackLinkPreview>

/** Admin › Slack: the people of the connected workspace, for the owner to link one whose e-mails differ */
export const SlackMember = z.object({
  slackUserId: z.string(), name: z.string().nullable(), realName: z.string().nullable(), handle: z.string().nullable(),
  /** as Slack gives it (scope users:read.email); null when Slack has none or hides it */
  email: z.string().nullable(),
  linkedTo: z.object({ id: z.string(), name: z.string(), username: z.string() }).nullable(),
  /** a proposal waiting for that member to accept */
  pending: z.object({ proposalId: z.string(), id: z.string(), name: z.string(), username: z.string(), expiresAt: IsoTime }).nullable(),
})
export type SlackMember = z.infer<typeof SlackMember>
export const SlackMembers = z.object({
  /** turned on with tokens saved; otherwise the list is empty */
  available: z.boolean(),
  members: z.array(SlackMember),
  /** more than the 2,000 people listed */
  truncated: z.boolean(),
})
export type SlackMembers = z.infer<typeof SlackMembers>

export const SLACK = {
  slackAdmin: endpoint({ method: 'GET', path: '/api/admin/slack', auth: 'owner', owner: 'C', response: SlackAdmin, summary: 'The Slack connector: state, workspace, the manifest to create the app with. Never a token.' }),
  saveSlackTokens: endpoint({ method: 'PUT', path: '/api/admin/slack/tokens', auth: 'owner', owner: 'C', body: SlackTokensBody, response: SlackAdmin, summary: 'Check and save the bot and app-level tokens (sealed in the browser). Another workspace than before removes every link.' }),
  setSlackEnabled: endpoint({ method: 'POST', path: '/api/admin/slack/enabled', auth: 'owner', owner: 'C', body: z.object({ enabled: z.boolean() }), response: SlackAdmin, summary: 'Turn the connector on (needs saved tokens) or off.' }),
  slackMembers: endpoint({ method: 'GET', path: '/api/admin/slack/members', auth: 'owner', owner: 'C', response: SlackMembers, summary: 'The people of the connected Slack workspace (no bots, no other workspaces) and whom each is linked to.' }),
  proposeSlackLink: endpoint({ method: 'POST', path: '/api/admin/slack/proposals', auth: 'owner', owner: 'C', status: 204, body: z.object({ slackUserId: z.string().regex(/^[A-Z0-9]{2,40}$/), userId: z.string().min(1).max(64) }), response: empty, summary: 'The owner proposes linking a Slack person of this workspace to a member (e-mails differ). Nothing is linked until the member accepts.' }),
  cancelSlackProposal: endpoint({ method: 'DELETE', path: '/api/admin/slack/proposals/:id', auth: 'owner', owner: 'C', status: 204, response: empty, summary: 'The owner withdraws a proposal still waiting.' }),
  acceptSlackProposal: endpoint({ method: 'POST', path: '/api/slack/proposals/:id/accept', auth: 'user', owner: 'C', body: z.object({}), response: MySlack, summary: 'The member accepts the owner\'s proposal: the Slack account is linked to them.' }),
  declineSlackProposal: endpoint({ method: 'POST', path: '/api/slack/proposals/:id/decline', auth: 'user', owner: 'C', body: z.object({}), response: MySlack, summary: 'The member declines the owner\'s proposal.' }),
  removeSlack: endpoint({ method: 'DELETE', path: '/api/admin/slack', auth: 'owner', owner: 'C', response: SlackAdmin, summary: 'Remove the tokens and every link; the connector is off.' }),
  mySlack: endpoint({ method: 'GET', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Whether the team uses Slack and the Slack account linked to me.' }),
  unlinkSlack: endpoint({ method: 'DELETE', path: '/api/slack/me', auth: 'user', owner: 'C', response: MySlack, summary: 'Unlink my Slack account.' }),
  previewSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/preview', auth: 'user', owner: 'C', body: SlackLinkBody, response: SlackLinkPreview, summary: 'What confirming this one-time link would link: the Slack account and me. Changes nothing.' }),
  confirmSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/confirm', auth: 'user', owner: 'C', body: SlackLinkBody, response: MySlack, summary: 'Link the Slack account of this one-time link to me (used up).' }),
  cancelSlackLink: endpoint({ method: 'POST', path: '/api/slack/link/cancel', auth: 'user', owner: 'C', body: SlackLinkBody, response: empty, status: 204, summary: 'Throw this one-time link away without linking.' }),
} as const
