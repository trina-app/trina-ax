// Route module "slack" — owner: component C (docs/WORKPLAN.md). The Slack connector's screens (contract:
// shared/src/api/slack.ts; logic: server/src/integrations/slack/service.ts): Admin › Connected apps › Slack (the
// owner and admins; the team's own app's tokens the owner's alone: saveSlackTokens is 'owner', remove checks it), each person's own link (Settings) and the one-time link page (/slack/link?t=…, its token only ever in a POST
// body). With the hosting service's official app: "Add to Slack" (official/install) and the browser's return from it
// (official/callback), bound to the owner or admin who pressed it like "Sign in with Slack" is to its person.
// init() makes the connector and opens the connection when it was turned on.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { HttpError } from '../http/errors'
import { linkBase } from '../auth/accounts'
import { originAllowed } from '../http/middleware'
import type { Context } from 'hono'
import type { AppEnv } from '../http/env'
import type { AppContext } from '../context'
import { unsealOrFail } from '../credentials/service'
import { credentialsOf } from '../credentials/store'
import { SIGNIN_CODE, SLACK_CALLBACK_PATH, SlackError, slackOf } from '../integrations/slack/service'
import { SLACK_BROKER_TEAM_INSTALL_RETURN_PATH } from '@mycel/shared/cloud-protocol'
import type { AppContextC } from '../http/env'
import { refusal } from '../integrations/slack/text'
import { registerSlackRead } from '../integrations/slack/read'
import type { Locale } from '@mycel/shared/api'

async function safe<T>(locale: Locale, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof SlackError) {
      const { field, ...params } = e.params
      throw new HttpError(e.code, refusal(e.reason, locale, params), { params: { reason: e.reason, ...params }, ...(field ? { fields: { [`body.${field}`]: e.reason } } : {}) })
    }
    throw e
  }
}

/** The team's address as the owner's page sees it (window.location.origin, sent by the page with the GET that shows the
 * manifest and with the PUT that saves the tokens), when it is one of this server's; else what a link copied from
 * here would use. One source for the manifest's redirect URL and for where links open, so they never differ. */
function teamOrigin(c: Context<AppEnv>, ctx: AppContext, claimed: string | undefined): string {
  if (claimed) {
    try {
      const o = new URL(claimed).origin
      if (o === claimed && originAllowed(o, c.req.url, ctx.config.publicOrigins)) {
        // office mode: the owner on the server Mac itself; links are for the desks (the office address)
        if (ctx.config.office && ctx.config.publicOrigins[0] && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) return ctx.config.publicOrigins[0]
        return o
      }
    } catch {}
  }
  return linkBase(c, ctx)
}

/** Where a sign-in that came back to a browser with no session goes on after signing in there: one fixed page of the
 * app with only the state and the code (both checked), which sends the browser to the callback again. Never an address
 * from the request. */
export const SIGNIN_RETURN_PATH = '/slack/signin-return'
/** Slack's code (own app), or the hosting service's one-time handoff (official app; `to: install` for "Add to Slack") */
const resumePath = (state: string, back: { code: string } | { handoff: string; to?: 'install' }) => `${SIGNIN_RETURN_PATH}?${new URLSearchParams({ state, ...back })}`
const HANDOFF = /^[A-Za-z0-9_-]{43}$/

export const slackRoutes: RouteModule = {
  name: 'slack',
  owner: 'C',
  init(ctx) {
    // after the chat runtime (routes/chats.ts init): questions from Slack become its turns
    try { slackOf(ctx).refresh() } catch (e) { ctx.log.error('slack connector failed to start; it stays off', { err: String(e) }) }
    // the AI reads Slack with the bot token (integrations/slack/read.ts): its tools and its section of the instructions
    registerSlackRead(ctx)
  },
  register(kit, ctx) {
    const slack = () => slackOf(ctx)
    kit.handle(API.slackAdmin, ({ c, query }) => slack().freshAdminView(teamOrigin(c, ctx, query.origin)))
    kit.handle(API.saveSlackTokens, ({ c, body, auth }) => safe(c.get('locale'), async () => {
      const cc = credentialsOf(ctx), L = c.get('locale')
      const bot = await unsealOrFail(cc, body.botToken, 'slack.token', L)
      const app = await unsealOrFail(cc, body.appToken, 'slack.token', L)
      const clientSecret = await unsealOrFail(cc, body.clientSecret, 'slack.token', L)
      return slack().saveTokens(auth.user.id, bot, app, { id: body.clientId, secret: clientSecret }, teamOrigin(c, ctx, body.origin))
    }))
    kit.handle(API.setSlackEnabled, ({ c, body, auth }) => safe(c.get('locale'), () => slack().setEnabled(auth.user.id, body.enabled)))
    kit.handle(API.startSlackSignIn, ({ c, auth }) => safe(c.get('locale'), () => slack().startSignIn(auth.user.id, auth.session.id, auth.session.client)))
    // "I updated them": Slack is asked again which scopes the bot has (reading threads and channels)
    kit.handle(API.recheckSlackReadScopes, ({ auth }) => slack().recheckReadScopes(auth.user.id))
    // Slack sends the browser back here after "Sign in with Slack". Signed in as the person who started it: linked.
    // No session in this browser (the desktop app's system browser, the phone app's in-app browser, another address):
    // sign in first, then the fixed return page brings it back here. The answer is a redirect: Settings for a flow
    // started on the web, else a page saying it is done and the app can be used again.
    kit.raw('GET', SLACK_CALLBACK_PATH, async (c) => {
      const auth = (c as unknown as AppContextC).get('auth')
      // the official app: the hosting service's handoff in place of Slack's code
      const state = c.req.query('state') ?? '', code = c.req.query('code') ?? '', handoff = c.req.query('handoff') ?? ''
      let out = { result: 'signin_failed', client: 'web' }
      try { out = await slack().finishSignIn({ state, code, handoff, error: c.req.query('error') }, auth ? { userId: auth.user.id } : null) }
      catch (e) { ctx.log.error('slack sign-in failed', { err: String(e) }) }
      c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
      // (finishSignIn answers signin_needed only for a state and a code, or a handoff, of the right shape)
      if (out.result === 'signin_needed' && (SIGNIN_CODE.test(code) || HANDOFF.test(handoff))) return c.redirect(`/login?next=${encodeURIComponent(resumePath(state, SIGNIN_CODE.test(code) ? { code } : { handoff }))}`, 303)
      const r = encodeURIComponent(out.result === 'signin_needed' ? 'signin_failed' : out.result)
      return c.redirect(out.client === 'web' ? `/settings/connectors?slack=${r}` : `/slack/done?slack=${r}`, 303)
    })
    // the team's own app (its tokens) is the owner's alone: the service refuses an admin there
    kit.handle(API.removeSlack, ({ c, auth }) => safe(c.get('locale'), () => slack().remove(auth.user.id, { owner: auth.user.role === 'owner' })))
    // "Add to Slack" (the hosting service's official app): Slack's install page; the browser comes back below
    kit.handle(API.startSlackInstall, ({ c, body, auth }) => safe(c.get('locale'), () => slack().startInstall(auth.user.id, auth.session.id, auth.session.client, teamOrigin(c, ctx, body.origin))))
    // The hosting service sends the browser back here after Slack's "Add to Slack" (only to this team's address it
    // recorded). Signed in as the owner or admin who pressed it: added. No session in this browser: sign in first, then the
    // fixed return page brings it back here. Another person's session: refused. Then Admin › Connected apps › Slack
    // (/admin/connectors/slack; the web app sends the old /admin/slack there too) says how it went (a flow started in
    // the desktop or phone app: a page saying it is done).
    kit.raw('GET', SLACK_BROKER_TEAM_INSTALL_RETURN_PATH, async (c) => {
      const auth = (c as unknown as AppContextC).get('auth')
      const state = c.req.query('state') ?? '', handoff = c.req.query('handoff') ?? ''
      let out = { result: 'install_failed', client: 'web' }
      try { out = await slack().finishInstall({ state, handoff, error: c.req.query('error') }, auth ? { userId: auth.user.id } : null) }
      catch (e) { ctx.log.error('slack install failed', { err: e instanceof Error ? e.name : 'unknown' }) }
      c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
      if (out.result === 'signin_needed' && HANDOFF.test(handoff)) return c.redirect(`/login?next=${encodeURIComponent(resumePath(state, { handoff, to: 'install' }))}`, 303)
      const r = encodeURIComponent(out.result === 'signin_needed' ? 'install_failed' : out.result)
      return c.redirect(out.client === 'web' ? `/admin/connectors/slack?slack=${r}` : `/slack/done?slack=${r}`, 303)
    })
    kit.handle(API.mySlack, ({ auth }) => slack().mine(auth.user.id))
    kit.handle(API.unlinkSlack, ({ auth }) => slack().unlink(auth.user.id))
    kit.handle(API.previewSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => slack().preview(auth.user.id, body.token)))
    kit.handle(API.confirmSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => slack().confirm(auth.user.id, body.token)))
    kit.handle(API.cancelSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => { slack().cancel(auth.user.id, body.token) }))
  },
}
