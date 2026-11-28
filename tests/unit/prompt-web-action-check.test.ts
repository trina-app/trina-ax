// Sends, submits and posts on a web page (docs/decisions/20261128-irreversible-web-readback.md): the AI sent a webmail
// through Aside with an empty body after "첨부했어. 이어서 해": its script had written another field and its check
// searched the whole page. One rule, in every place where the AI acts on a web page (the in-app browser, the person's
// own Chrome, a connected app), and two short lines for every turn (say a warning once; keep to the tool the person
// chose). General words only: no site, service or wording is named.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { buildTurnContext, buildTurnPrompt, buildSubagentPrompt, CHOSEN_TOOL_RULE, ONCE_RULE, type PromptInput } from '../../server/src/chat/prompt'
import { WEB_ACTION_CHECK_RULE } from '../../server/src/chat/web-action-rule'

setDefaultTimeout(60_000)

let A: CApp, fake: FakeServices
beforeAll(async () => {
  A = await makeCApp('prompt-web-action-check')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
})
afterAll(async () => { fake?.stop(); await A?.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: A.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: ['ask_user', 'make_file'], history: null, ...extra,
})
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('the rule', () => {
  test('reads each field back from its own element, also after a go-ahead, and checks the result after', () => {
    for (const s of ['cannot be undone', "from that field's own element", 'inside a frame', 'recipient chips', 'attachment list',
      'a search of the whole page', 'prove nothing', 'already said to go ahead', 'stops the action', 'say which one',
      'where its result shows', 'report only what that showed'])
      expect(WEB_ACTION_CHECK_RULE).toContain(s)
    // no site, service, product or wording of the incident
    expect(WEB_ACTION_CHECK_RULE).not.toMatch(/Daum|Gmail|Aside|이어서|첨부/i)
    // it goes with the browser's and the connections' context of every message: short
    expect(WEB_ACTION_CHECK_RULE.length).toBeLessThanOrEqual(900)
  })

  test('in the in-app browser and the Chrome sections, once, and in the context a resumed session gets', () => {
    for (const via of ['app', 'chrome'] as const) {
      const i = input({ browser: true, browserVia: via, browserUpload: true })
      expect(count(buildTurnPrompt(A.ctx.files, i), WEB_ACTION_CHECK_RULE)).toBe(1)
      expect(count(buildTurnContext(A.ctx.files, i), WEB_ACTION_CHECK_RULE)).toBe(1)
    }
    // no browser and no connection: not there
    expect(buildTurnPrompt(A.ctx.files, input())).not.toContain(WEB_ACTION_CHECK_RULE)
    expect(buildTurnPrompt(A.ctx.files, input({ browserInDesktopApp: true }))).not.toContain(WEB_ACTION_CHECK_RULE)
  })

  test('in the connected services section (an app that drives a browser is a connection), instructions and context', async () => {
    const c = await A.json('/api/integrations', { method: 'POST', as: 'alice', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'mcp', name: 'Pilot', url: `${fake.base}/mcp-open?pilot`, auth: 'none' }) })
    expect(c.body.status).toBe('connected')
    const user: Person = 'alice'
    const chat = A.chat(user)
    const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId: A.turn(user, chat), browser: false, scheduled: false })
    expect(count(built.prompt ?? '', WEB_ACTION_CHECK_RULE)).toBe(1)
    expect(count(built.context ?? '', WEB_ACTION_CHECK_RULE)).toBe(1)
    // nothing connected: not there
    const none = integrationToolProvider(A.ctx).build({ userId: 'bob', chatId: A.chat('bob'), turnId: A.turn('bob', A.chat('bob')), browser: false, scheduled: false })
    expect(none.prompt ?? '').not.toContain(WEB_ACTION_CHECK_RULE)
  })
})

describe('every turn', () => {
  test('a warning once; the tool the person chose holds for the task; short; not in a sub-agent', () => {
    expect(ONCE_RULE).toContain('once')
    expect(ONCE_RULE).toContain('still matters')
    expect(CHOSEN_TOOL_RULE).toContain('rest of that task')
    expect(ONCE_RULE.length + CHOSEN_TOOL_RULE.length).toBeLessThanOrEqual(500)
    for (const i of [input(), input({ tools: [] }), input({ locale: 'en', browser: true })]) {
      const p = buildTurnPrompt(A.ctx.files, i)
      expect(count(p, ONCE_RULE)).toBe(1)
      expect(count(p, CHOSEN_TOOL_RULE)).toBe(1)
    }
    const sub = buildSubagentPrompt(A.ctx.files, input(), ['read'])
    expect(sub).not.toContain(ONCE_RULE)
    expect(sub).not.toContain(WEB_ACTION_CHECK_RULE)
  })
})
