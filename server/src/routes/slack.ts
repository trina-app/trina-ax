// Route module "slack" — owner: component C (docs/WORKPLAN.md). The Slack connector's screens (contract:
// shared/src/api/slack.ts; logic: server/src/integrations/slack/service.ts): the owner's Admin › Slack, each person's
// own link (Settings) and the one-time link page (/slack/link?t=…, its token only ever in a POST body).
// init() makes the connector and opens the connection when the owner turned it on.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { HttpError } from '../http/errors'
import { linkBase } from '../auth/accounts'
import { unsealOrFail } from '../credentials/service'
import { credentialsOf } from '../credentials/store'
import { SLACK_CALLBACK_PATH, SlackError, slackOf } from '../integrations/slack/service'
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

export const slackRoutes: RouteModule = {
  name: 'slack',
  owner: 'C',
  init(ctx) {
    // after the chat runtime (routes/chats.ts init): questions from Slack become its turns
    try { slackOf(ctx).refresh() } catch (e) { ctx.log.error('slack connector failed to start; it stays off', { err: String(e) }) }
  },
  register(kit, ctx) {
    const slack = () => slackOf(ctx)
    kit.handle(API.slackAdmin, ({ c }) => slack().adminView(linkBase(c, ctx)))
    kit.handle(API.saveSlackTokens, ({ c, body, auth }) => safe(c.get('locale'), async () => {
      const cc = credentialsOf(ctx), L = c.get('locale')
      const bot = await unsealOrFail(cc, body.botToken, 'slack.token', L)
      const app = await unsealOrFail(cc, body.appToken, 'slack.token', L)
      const clientSecret = await unsealOrFail(cc, body.clientSecret, 'slack.token', L)
      return slack().saveTokens(auth.user.id, bot, app, { id: body.clientId, secret: clientSecret }, linkBase(c, ctx))
    }))
    kit.handle(API.setSlackEnabled, ({ c, body, auth }) => safe(c.get('locale'), () => slack().setEnabled(auth.user.id, body.enabled)))
    kit.handle(API.startSlackSignIn, ({ c, auth }) => safe(c.get('locale'), () => slack().startSignIn(auth.user.id, auth.session.id)))
    // Slack sends the browser back here after "Sign in with Slack": only the person and session that started it finish
    // it (their cookie); the code and state go nowhere else. The answer is a redirect to Settings with the outcome.
    kit.raw('GET', SLACK_CALLBACK_PATH, async (c) => {
      const auth = (c as unknown as AppContextC).get('auth')
      let result = 'signin_failed'
      try { result = await slack().finishSignIn({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error') }, auth ? { userId: auth.user.id, sessionId: auth.session.id } : null) }
      catch (e) { ctx.log.error('slack sign-in failed', { err: String(e) }) }
      c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
      return c.redirect(`/settings/connectors?slack=${encodeURIComponent(result)}`, 303)
    })
    kit.handle(API.removeSlack, ({ c, auth }) => safe(c.get('locale'), () => slack().remove(auth.user.id)))
    kit.handle(API.mySlack, ({ auth }) => slack().mine(auth.user.id))
    kit.handle(API.unlinkSlack, ({ auth }) => slack().unlink(auth.user.id))
    kit.handle(API.previewSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => slack().preview(auth.user.id, body.token)))
    kit.handle(API.confirmSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => slack().confirm(auth.user.id, body.token)))
    kit.handle(API.cancelSlackLink, ({ c, body, auth }) => safe(c.get('locale'), () => { slack().cancel(auth.user.id, body.token) }))
  },
}
