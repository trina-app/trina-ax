// Route module "slack" — owner: component C (docs/WORKPLAN.md). The Slack connector's screens (contract:
// shared/src/api/slack.ts; logic: server/src/integrations/slack/service.ts): the owner's Admin › Slack, each person's
// own link (Settings) and the one-time link page (/slack/link?t=…, its token only ever in a POST body).
// init() makes the connector and opens the connection when the owner turned it on.
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
import type { AppContextC } from '../http/env'
import { refusal } from '../integrations/slack/text'
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
const resumePath = (state: string, code: string) => `${SIGNIN_RETURN_PATH}?${new URLSearchParams({ state, code })}`

export const slackRoutes: RouteModule = {
  name: 'slack',
  owner: 'C',
  init(ctx) {
    // after the chat runtime (routes/chats.ts init): questions from Slack become its turns
    try { slackOf(ctx).refresh() } catch (e) { ctx.log.error('slack connector failed to start; it stays off', { err: String(e) }) }
  },
  register(kit, ctx) {
    const slack = () => slackOf(ctx)
    kit.handle(API.slackAdmin, ({ c, query }) => slack().adminView(teamOrigin(c, ctx, query.origin)))
    kit.handle(API.saveSlackTokens, ({ c, body, auth }) => safe(c.get('locale'), async () => {
      const cc = credentialsOf(ctx), L = c.get('locale')
      const bot = await unsealOrFail(cc, body.botToken, 'slack.token', L)
      const app = await unsealOrFail(cc, body.appToken, 'slack.token', L)
      const clientSecret = await unsealOrFail(cc, body.clientSecret, 'slack.token', L)
      return slack().saveTokens(auth.user.id, bot, app, { id: body.clientId, secret: clientSecret }, teamOrigin(c, ctx, body.origin))
    }))
    kit.handle(API.setSlackEnabled, ({ c, body, auth }) => safe(c.get('locale'), () => slack().setEnabled(auth.user.id, body.enabled)))
    kit.handle(API.startSlackSignIn, ({ c, auth }) => safe(c.get('locale'), () => slack().startSignIn(auth.user.id, auth.session.id, auth.session.client)))
    // Slack sends the browser back here after "Sign in with Slack". Signed in as the person who started it: linked.
    // No session in this browser (the desktop app's system browser, the phone app's in-app browser, another address):
    // sign in first, then the fixed return page brings it back here. The answer is a redirect: Settings for a flow
    // started on the web, else a page saying it is done and the app can be used again.
    kit.raw('GET', SLACK_CALLBACK_PATH, async (c) => {
      const auth = (c as unknown as AppContextC).get('auth')
      const state = c.req.query('state') ?? '', code = c.req.query('code') ?? ''
      let out = { result: 'signin_failed', client: 'web' }
      try { out = await slack().finishSignIn({ state, code, error: c.req.query('error') }, auth ? { userId: auth.user.id } : null) }
      catch (e) { ctx.log.error('slack sign-in failed', { err: String(e) }) }
      c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
      // (finishSignIn answers signin_needed only for a state and a code of the right shape)
      if (out.result === 'signin_needed' && SIGNIN_CODE.test(code)) return c.redirect(`/login?next=${encodeURIComponent(resumePath(state, code))}`, 303)
      const r = encodeURIComponent(out.result === 'signin_needed' ? 'signin_failed' : out.result)
      return c.redirect(out.client === 'web' ? `/settings/connectors?slack=${r}` : `/slack/done?slack=${r}`, 303)
    })
    kit.handle(API.removeSlack, ({ c, auth }) => safe(c.get('locale'), () => slack().remove(auth.user.id)))
    kit.handle(API.mySlack, ({ auth }) => slack().mine(auth.user.id))
    kit.handle(API.unlinkSlack, ({ auth }) => slack().unlink(auth.user.id))
    kit.handle(API.previewSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => slack().preview(auth.user.id, body.token)))
    kit.handle(API.confirmSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => slack().confirm(auth.user.id, body.token)))
    kit.handle(API.cancelSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => { slack().cancel(auth.user.id, body.token) }))
  },
}
