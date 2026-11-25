// QA TC-9174 (docs/decisions/20261125-docs-no-web-fetch-card.md): after a trina_docs answer the AI also opened the docs
// page with web_fetch (5 of 8 real-AI doc questions on qa), and the address card asked "check that it doesn't contain
// your information" for our own public docs. Now (a) the docs tool's result and its instructions' line say the passages
// are the page's text, so there is nothing to fetch, and (b) web_fetch opens a page of the app's own docs, exactly one
// the docs tool links to, with no card (url-gate ①e). Everything else keeps its card: other pages of the site, other
// trina.app hosts, a query, http, a user name, save_url and the browser (no `docs`), a confidential chat.
// Every DNS lookup is a stub (node:dns/promises lookup replaced for this file): nothing resolves or opens a real name.
import dnsP from 'node:dns/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { noteEgressIp } from '../../server/src/tools/egress'
import { gateUrl, type TurnPerson } from '../../server/src/tools/url-gate'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { setWebAllowAll } from '../../server/src/tools/web-allow-all'
import { helpIndex, isDocsPage } from '../../server/src/docs-help/data'
import { searchDocs } from '../../server/src/docs-help/search'
import { docsRule, docsText } from '../../server/src/docs-help/tool'

setDefaultTimeout(60_000)

const index = helpIndex()!
const SLACK_EN = index.langs.en.find((p) => p.slug === 'use/slack')!.url
const SLACK_KO = index.langs.ko.find((p) => p.slug === 'use/slack')!.url
const HOME_KO = index.langs.ko.find((p) => p.slug === 'index')!.url

describe('(a) the docs tool says its text is the page', () => {
  test('the result says not to fetch the links; the line says not to fetch the page', () => {
    const hits = searchDocs(index, 'How do I connect Slack?', 'en')
    expect(hits.length).toBeGreaterThan(0)
    expect(docsText(hits, '', true)).toContain("Each passage is the page's own text, so do not fetch the links")
    expect(docsRule('Trina AX')).toContain("answer from its text (don't fetch the page)")
  })
})

describe('(b) isDocsPage: exactly the pages the docs tool links to', () => {
  test('every link the tool gives is one, in every language', () => {
    for (const q of ['How do I connect Slack?', '슬랙은 어떻게 연결해요?', 'How do I install it on our own Linux server?', '팀원은 어떻게 초대해요?']) {
      for (const lang of ['en', 'ko', 'ja'] as const) for (const h of searchDocs(index, q, lang)) expect([h.url, isDocsPage(h.url)]).toEqual([h.url, true])
    }
    for (const pages of Object.values(index.langs)) for (const p of pages) expect(isDocsPage(p.url)).toBe(true)
  })

  test('a trailing slash either way and a #fragment are the same page', () => {
    expect(SLACK_EN).toBe('https://ax.trina.app/docs/use/slack/')
    expect(isDocsPage(SLACK_EN.replace(/\/$/, ''))).toBe(true)
    expect(isDocsPage(`${SLACK_KO}#problems`)).toBe(true)
    expect(isDocsPage(HOME_KO)).toBe(true)
    expect(isDocsPage('HTTPS://AX.TRINA.APP/docs/use/slack/')).toBe(true)
  })

  test('near misses are not', () => {
    for (const u of [
      `${SLACK_EN}?q=secret`, // a query
      `${SLACK_EN}?x`,
      SLACK_EN.replace('https:', 'http:'), // not https
      SLACK_EN.replace('https://', 'https://user:pw@'), // a user name
      'https://ax.trina.app/docs/use/slack/secret-words/', // a path under a page
      'https://ax.trina.app/docs/use/slack//', // more than one last slash
      'https://ax.trina.app/docs/use/no-such-page/',
      'https://ax.trina.app/pricing', // the site, not the docs
      'https://ax.trina.app/',
      'https://trina.app/docs/use/slack/', // other trina.app hosts
      'https://qa.trina.app/docs/use/slack/',
      'https://docs.trina.app/use/slack/',
      'https://ax.trina.app.example.com/docs/use/slack/',
      'https://ax.trina.app:8443/docs/use/slack/',
      'not a url',
    ]) expect([u, isDocsPage(u)]).toEqual([u, false])
  })

  test('a server without docs has none', () => {
    expect(isDocsPage(SLACK_EN, '/nonexistent-root-for-docs-test')).toBe(false)
  })
})

const lookups: string[] = []
const original = dnsP.lookup
;(dnsP as unknown as { lookup: unknown }).lookup = async (host: string) => {
  lookups.push(host.toLowerCase())
  throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' })
}

let h: Harness
beforeAll(async () => {
  h = await startHarness({ name: 'docs-web-fetch', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  noteEgressIp(h.ctx, '198.51.100.7')
})
afterAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = original
  await h?.close()
})
const db = () => h.ctx.db
beforeEach(() => {
  updateTeamSettings(db(), { browserAllowAll: true, webAllowAll: true })
  setWebAllowAll(db(), 'alice', false, { via: 'settings' })
  db().query('DELETE FROM user_allowed_sites').run()
})

function person(answer: string | null, asked: string[], o: { unattended?: boolean } = {}): TurnPerson {
  return {
    locale: 'ko',
    async confirm(question) { asked.push(question); return answer === 'allow' },
    async choose(question) { asked.push(question); return answer },
    turnUrls: () => [],
    allSitesHere: () => true,
    sitesForGood: () => !o.unattended,
    ...(o.unattended ? { unattended: true } : {}),
  }
}
// the person asked about the app; the AI answered from trina_docs (whose links are not "in the chat")
async function chatOf(content = '슬랙은 어떻게 연결해요?') {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  db().query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'alice', ?, 'done')").run(uuidv7(), chat.id, content)
  return chat.id as string
}
const gate = (chat: string | null, url: string, p: TurnPerson | null, o: { egressKnown?: boolean; docs?: boolean } = {}) =>
  gateUrl(db(), chat, url, p, { turnId: 't-docs', userId: 'alice', docs: true, ...o })

describe('(b) the address gate: web_fetch of a docs page asks nothing', () => {
  test('the docs pages open with no card, in every state the card used to show', async () => {
    const chat = await chatOf()
    const asked: string[] = []
    for (const u of [SLACK_EN, SLACK_KO, `${SLACK_KO}#problems`, HOME_KO]) expect(await gate(chat, u, person(null, asked))).toBe('docs')
    // the server's exit address not known yet, a run nobody watches, no turn at all
    expect(await gate(chat, SLACK_KO, person(null, asked), { egressKnown: false })).toBe('docs')
    expect(await gate(chat, SLACK_KO, person(null, asked, { unattended: true }))).toBe('docs')
    expect(await gate(null, SLACK_KO, null)).toBe('docs')
    expect(asked).toHaveLength(0)
    // decided from the address text: nothing looked up
    expect(lookups).toHaveLength(0)
  })

  test('other addresses keep the card as before', async () => {
    const chat = await chatOf()
    for (const u of ['https://ax.trina.app/pricing', 'https://qa.trina.app/docs/use/slack/', `${SLACK_EN}?q=secret`, 'https://ax.trina.app/docs/use/slack/secret-words/', 'https://example.com/docs/use/slack/']) {
      const asked: string[] = []
      await expect(gate(chat, u, person(null, asked))).rejects.toThrow(/did not allow/)
      expect([u, asked.length]).toEqual([u, 1])
      expect(asked[0]).toContain('주소에 내 정보가 들어 있지 않은지 확인해 주세요')
    }
  })

  test('only web_fetch: without `docs` (save_url, the browser) the docs page keeps its card', async () => {
    const chat = await chatOf()
    const asked: string[] = []
    await expect(gate(chat, SLACK_KO, person(null, asked), { docs: false })).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
  })

  test('a confidential chat keeps the card', async () => {
    const chat = await chatOf()
    db().query('INSERT INTO safe_ops_chats(chat_id, material) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET material = 1').run(chat)
    const asked: string[] = []
    await expect(gate(chat, SLACK_KO, person(null, asked))).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(1)
  })
})
