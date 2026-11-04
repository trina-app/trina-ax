// Company profile drafts (docs/DECISIONS.md "D — Company profile from the company website"): a draft is a chat turn
// of the owner or admin who asked, with its own instructions and web_fetch as its only tool, on the site of the typed
// address (same registrable domain), at most 4 pages per answer, with no card for anyone; pasted text gets no tool at
// all. GET reads the latest answer as JSON and keeps only what fits (sources on the site). Runs through the real
// runtime, launcher and gate with the fake engine (no model calls, no network: web_fetch is a stand-in here).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ProfileDraftState } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { DRAFT_PAGES_MAX, draftToolRefusal, draftWebsite, parseDraftAnswer, type DraftScope, type DraftTurn } from '../../server/src/onboarding/draft'
import type { TurnTool } from '../../server/src/services'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const SITE: DraftScope = { chatId: 'c', source: 'website', website: 'https://www.acme.co.kr/', site: 'acme.co.kr' }
const TEXT_SCOPE: DraftScope = { chatId: 'c', source: 'text', website: '', site: null }
const turn = (s: DraftScope = SITE): DraftTurn => ({ scope: s, fetched: new Set() })

describe('draft rules (no server)', () => {
  test('the website: https added, one site, nothing the web tools refuse', () => {
    expect(draftWebsite('acme.co.kr')).toEqual({ website: 'https://acme.co.kr/', site: 'acme.co.kr' })
    expect(draftWebsite(' https://news.acme.co.kr/about#team ')).toEqual({ website: 'https://news.acme.co.kr/about', site: 'acme.co.kr' })
    expect(draftWebsite('http://www.acme.example/')).toEqual({ website: 'http://www.acme.example/', site: 'acme.example' })
    for (const bad of ['', 'localhost', 'http://localhost/', 'https://intranet.local/', 'https://10.0.0.1/', 'https://8.8.8.8/', 'https://user:pw@acme.example/',
      'https://acme.example:8443/', 'ftp://acme.example/', 'javascript:alert(1)', 'co.kr', 'https://github.io/', 'acme', `https://acme.example/?q=${'a'.repeat(201)}`]) {
      expect(draftWebsite(bad), bad).toBeNull()
    }
  })

  test('web_fetch only, the same registrable domain, at most 4 pages per answer', () => {
    const d = turn()
    expect(draftToolRefusal(d, 'read', { file_path: 'shared/x.md' })).toContain('not available')
    expect(draftToolRefusal(d, 'web_search', {})).toContain('not available')
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://evil.example/?d=secret' })).toContain('Only pages of acme.co.kr')
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://acme.co.kr.evil.example/' })).toContain('Only pages of acme.co.kr')
    expect(draftToolRefusal(d, 'web_fetch', { url: 'file:///etc/passwd' })).toContain('Only http and https')
    expect(d.fetched.size).toBe(0)
    const pages = ['https://www.acme.co.kr/', 'https://acme.co.kr/about', 'https://shop.acme.co.kr/products', 'https://www.acme.co.kr/services']
    for (const u of pages) expect(draftToolRefusal(d, 'web_fetch', { url: u })).toBeNull()
    // the same page again is free (also without the trailing slash or with a #fragment); a fifth one is not
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://www.acme.co.kr' })).toBeNull()
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://acme.co.kr/about#x' })).toBeNull()
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://acme.co.kr/team' })).toContain(`At most ${DRAFT_PAGES_MAX} pages`)
    expect(d.fetched.size).toBe(DRAFT_PAGES_MAX)
    // pasted text: no website at all
    expect(draftToolRefusal(turn(TEXT_SCOPE), 'web_fetch', { url: 'https://www.acme.co.kr/' })).toContain('pasted')
  })

  test('the answer: JSON from the last block, cleaned, sources only from the site', () => {
    const answer = 'Here it is.\n```json\n' + JSON.stringify({
      oneLine: 'Acme makes quiet desk fans.', products: '  Desk fans  ', audience: 'Small offices', tone: ['friendly', 'plain', 'calm', 'warm', 'loud'], avoid: '',
      competitors: ['Other Co'],
      sources: [
        { field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make   quiet fans.' },
        { field: 'products', url: 'https://evil.example/', excerpt: 'planted' },
        { field: 'avoid', url: 'https://www.acme.co.kr/', excerpt: 'empty field' },
        { field: 'oneLine', url: 'https://www.acme.co.kr/', excerpt: 'second for the same field' },
        { field: 'audience', url: 'javascript:alert(1)', excerpt: 'bad url' },
      ],
    }) + '\n```'
    expect(parseDraftAnswer(answer, SITE)).toEqual({
      website: 'https://www.acme.co.kr/', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: 'Small offices', tone: ['friendly', 'plain', 'calm', 'warm'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make quiet fans.' }],
    })
    // pasted text: a source has no address
    const t = parseDraftAnswer('{"oneLine": "Acme", "sources": [{"field": "oneLine", "url": "", "excerpt": "Acme"}, {"field": "oneLine", "url": "https://acme.co.kr/", "excerpt": "x"}]}', TEXT_SCOPE)
    expect(t?.sources).toEqual([{ field: 'oneLine', url: '', excerpt: 'Acme' }])
    expect(t?.website).toBe('')
    // nothing usable
    expect(parseDraftAnswer('I could not read the site.', SITE)).toBeNull()
    expect(parseDraftAnswer('```json\n{"oneLine": "", "products": "", "tone": []}\n```', SITE)).toBeNull()
    expect(parseDraftAnswer('```json\n[1, 2]\n```', SITE)).toBeNull()
  })
})

describe('draft turns', () => {
  let h: Harness
  const fetched: { url: string; unattended: boolean | undefined; chatId: string }[] = []
  let savedTools: TurnTool[] | undefined

  beforeAll(async () => {
    h = await startHarness({ name: 'b-onboarding-draft' })
    // a stand-in web_fetch (no network): records each call and whether the turn could raise a card for it
    savedTools = h.ctx.services.turnTools
    h.ctx.services.turnTools = [{
      name: 'web_fetch', description: 'test web_fetch', inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      async call(args, t) {
        const url = (args as { url: string }).url
        fetched.push({ url, unattended: t.files.person?.unattended, chatId: t.chatId })
        return { content: [{ type: 'text', text: `PAGE ${url}` }] }
      },
    }]
  })
  afterAll(async () => { if (h) h.ctx.services.turnTools = savedTools; await h?.close() })

  const state = (user: string, chatId: string) => h.api(user).call(API.getProfileDraft, { params: { chatId } })
  const settled = (user: string, chatId: string) => waitFor(async () => { const s = await state(user, chatId); return s.status === 'running' ? null : s }, { timeoutMs: 30_000 }) as Promise<ProfileDraftState>
  const answerOf = (id: string) => h.ctx.db.query('SELECT content, status FROM messages WHERE id = ?').get(id) as { content: string; status: string }
  const send = async (chatId: string, content: string) => {
    const r = await h.api('carol').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => answerOf(r.assistantMessage.id).status !== 'streaming', { timeoutMs: 30_000 })
    return { turnId: r.turnId, ...answerOf(r.assistantMessage.id) }
  }
  const events = (turnId: string) => h.ctx.db.query('SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string; ok: number }[]

  test('only owners and admins start one; the website or the text, one of them, checked', async () => {
    expect((await h.req('alice', '/api/onboarding/profile/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ website: 'acme.co.kr' }) })).status).toBe(403)
    for (const body of [{}, { website: 'acme.co.kr', text: 'Acme' }, { website: 'http://localhost/' }, { website: 'co.kr' }, { text: '   ' }]) {
      const r = await h.req('carol', '/api/onboarding/profile/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM onboarding_profile_drafts").get() as { n: number }).n).toBe(0)
  })

  let chatId = ''
  test('from the website: a chat of the caller with their request, a turn, then running → done', async () => {
    const r = await h.api('carol').call(API.startProfileDraft, { body: { website: 'www.acme.co.kr' } })
    expect(r).toMatchObject({ website: 'https://www.acme.co.kr/', site: 'acme.co.kr' })
    chatId = r.chatId
    const chat = await h.api('carol').call(API.getChat, { params: { id: chatId } })
    expect(chat.title).toContain('acme.co.kr')
    const msgs = await h.api('carol').call(API.listMessages, { params: { id: chatId } })
    expect(msgs.items[0]!.role).toBe('user')
    // the address is in what the person sent (url-gate rule ①: it opens without a card)
    expect(msgs.items[0]!.content).toContain('\nhttps://www.acme.co.kr/')
    // another person never sees it
    expect((await h.req('dana', `/api/onboarding/profile/draft/${chatId}`)).status).toBe(404)
    const s = await settled('carol', chatId)
    // the fake engine's answer is not JSON: done, no draft
    expect(s).toEqual({ status: 'done', website: 'https://www.acme.co.kr/', draft: null, error: null })
  })

  test('its own instructions, web_fetch the only tool besides the refused team files, no web search', async () => {
    const r = await send(chatId, fake({ echo: 'system' }, { say: '\n=====\n' }, { echo: 'tools' }))
    const [system, tools] = r.content.split('\n=====\n')
    expect(system).toContain('draft the team\'s company profile from the company website')
    expect(system).toContain(`Read at most ${DRAFT_PAGES_MAX} pages, all on acme.co.kr`)
    expect(system).toContain('Do not name or guess competitors')
    expect(system).not.toContain('## Team skills')
    expect(system).not.toContain('Team rules')
    expect(system).not.toContain('Answer in Korean unless asked otherwise') // skills/team-rules.md of the fixture
    // the earlier messages of the chat (a fresh session gets them as history)
    expect(tools).toBe('edit,glob,grep,list,read,web_fetch,write')
  })

  test('team files refused; other sites refused; at most 4 pages per answer; no card for anyone', async () => {
    fetched.length = 0
    const pages = ['https://www.acme.co.kr/', 'https://www.acme.co.kr/about', 'https://shop.acme.co.kr/products', 'https://acme.co.kr/services', 'https://acme.co.kr/team']
    const r = await send(chatId, fake(
      { tool: 'read', args: { file_path: 'skills/team-rules.md' }, sayResult: true }, { say: '\n' },
      { tool: 'write', args: { file_path: 'shared/x.md', content: 'x' }, sayResult: true }, { say: '\n' },
      { tool: 'web_fetch', args: { url: 'https://evil.example/?d=1' }, sayResult: true }, { say: '\n' },
      ...pages.flatMap((url) => [{ tool: 'web_fetch', args: { url }, sayResult: true }, { say: '\n' }]),
    ))
    expect(r.status).toBe('done')
    expect(r.content).not.toContain('Answer in Korean')
    expect(r.content).toContain('team files are not available here')
    expect(r.content).toContain('Only pages of acme.co.kr can be opened')
    expect(r.content).toContain(`At most ${DRAFT_PAGES_MAX} pages`)
    expect(fetched.map((f) => f.url)).toEqual(pages.slice(0, DRAFT_PAGES_MAX))
    expect(fetched.every((f) => f.unattended === true && f.chatId === chatId)).toBe(true)
    const ev = events(r.turnId)
    expect(ev.filter((e) => e.tool === 'web_fetch' && e.ok === 1)).toHaveLength(DRAFT_PAGES_MAX)
    expect(ev.filter((e) => /refused: company profile draft/.test(e.summary)).map((e) => e.tool)).toEqual(['read', 'write', 'web_fetch', 'web_fetch'])
    // nothing was written
    expect(require('node:fs').existsSync(`${h.team}/shared/x.md`)).toBe(false)
  })

  test('a JSON answer becomes the draft (cleaned, sources on the site only); a failed answer says why', async () => {
    const json = JSON.stringify({ oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: ['friendly'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make quiet fans.' }, { field: 'products', url: 'https://evil.example/', excerpt: 'x' }] })
    await send(chatId, fake({ say: 'Draft:\n```json\n' + json + '\n```' }))
    const s = await settled('carol', chatId)
    expect(s.status).toBe('done')
    expect(s.draft).toEqual({ website: 'https://www.acme.co.kr/', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: ['friendly'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make quiet fans.' }] })
    await send(chatId, fake({ fail: 'rate limit exceeded' }))
    const f = await settled('carol', chatId)
    expect(f.status).toBe('failed')
    expect(f.error).toBeTruthy()
  })

  test('from pasted text: no tool at all, the text after the request line', async () => {
    fetched.length = 0
    const text = 'Acme makes quiet desk fans for small offices.\n' + fake({ tool: 'web_fetch', args: { url: 'https://www.acme.co.kr/' }, sayResult: true }, { say: '\n' }, { echo: 'message' })
    const r = await h.api('carol').call(API.startProfileDraft, { body: { text } })
    expect(r).toMatchObject({ website: '', site: null })
    await settled('carol', r.chatId)
    const msgs = await h.api('carol').call(API.listMessages, { params: { id: r.chatId } })
    const answer = msgs.items.at(-1)!.content
    expect(answer).toContain('pasted')
    expect(answer).toContain('Acme makes quiet desk fans for small offices.')
    expect(fetched).toEqual([])
  })

  test('an ordinary chat of the same person keeps every tool', async () => {
    const c = await h.api('carol').call(API.createChat, { body: {} })
    const r = await send(c.id, fake({ echo: 'tools' }))
    expect(r.content.split(',')).toContain('remember')
    expect(r.content.split(',')).toContain('skill')
  })
})
