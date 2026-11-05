// Company profile drafts (docs/DECISIONS.md "D — Company profile from the company website"): a draft is a chat turn
// of the owner or admin who asked, with its own instructions and web_fetch as its only tool, on the site of the typed
// address (same registrable domain), at most 4 pages per answer, with no card for anyone; pasted text gets no tool at
// all. GET reads the latest answer as JSON and keeps only what fits (sources on the site). Runs through the real
// runtime, launcher and gate with the fake engine (no model calls, no network: web_fetch is a stand-in here).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type ProfileDraftState } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { DRAFT_EMPTY_CHARS, DRAFT_PAGES_MAX, DraftPages, draftPages, draftScopeOf, draftSystemPrompt, draftToolRefusal, draftWebsite, inWebScope, parseDraftAnswer, webScope, type DraftScope, type DraftTurn } from '../../server/src/onboarding/draft'
import { toolPolicyOf } from '../../server/src/proxy/model-proxy'
import { noteEgressIp } from '../../server/src/tools/egress'
import { gateUrl, type TurnPerson } from '../../server/src/tools/url-gate'
import type { TurnTool } from '../../server/src/services'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const scopeOf = (website: string): DraftScope => ({ chatId: 'c', source: 'website', website, site: webScope(website)?.label ?? null, web: webScope(website) })
const SITE = scopeOf('https://www.acme.co.kr/')
const TEXT_SCOPE: DraftScope = { chatId: 'c', source: 'text', website: '', site: null, web: null }
const turn = (s: DraftScope = SITE): DraftTurn => ({ scope: s, fetched: new Set() })

describe('draft rules (no server)', () => {
  test('the website: https added, one site, nothing the web tools refuse', () => {
    expect(draftWebsite('acme.co.kr')).toEqual({ website: 'https://acme.co.kr/', site: 'acme.co.kr' })
    expect(draftWebsite(' https://news.acme.co.kr/about#team ')).toEqual({ website: 'https://news.acme.co.kr/about', site: 'news.acme.co.kr' })
    // a shared platform: the customer's path is the scope; the platform alone is no website
    expect(draftWebsite('blog.naver.com/Acme_Shop')).toEqual({ website: 'https://blog.naver.com/Acme_Shop', site: 'blog.naver.com/acme_shop' })
    expect(draftWebsite('https://sites.google.com/view/acme/home')).toEqual({ website: 'https://sites.google.com/view/acme/home', site: 'sites.google.com/view/acme' })
    for (const bare of ['blog.naver.com', 'https://smartstore.naver.com/', 'sites.google.com/view', 'www.instagram.com']) expect(draftWebsite(bare), bare).toBeNull()
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

  test('the scope: the typed host and its subdomains; on a shared platform only the typed path', () => {
    const cases: [string, string[], string[]][] = [
      ['https://www.acme.co.kr/', ['https://acme.co.kr/about', 'https://www.acme.co.kr/x', 'https://shop.acme.co.kr/p'], ['https://acme.co.kr.evil.example/', 'https://notacme.co.kr/', 'https://co.kr/']],
      // a hosted shop on a builder's subdomain: never the builder's other customers
      ['https://acme.imweb.me/', ['https://acme.imweb.me/about', 'https://shop.acme.imweb.me/'], ['https://other.imweb.me/', 'https://imweb.me/', 'https://www.imweb.me/']],
      ['https://blog.naver.com/acme', ['https://blog.naver.com/acme/223344556677', 'https://m.blog.naver.com/Acme/1', 'https://blog.naver.com/PostView.naver?blogId=acme&logNo=1'],
        ['https://blog.naver.com/other/1', 'https://blog.naver.com/acmex', 'https://blog.naver.com/PostView.naver?blogId=other', 'https://naver.com/', 'https://smartstore.naver.com/acme', 'https://cafe.naver.com/acme']],
      ['https://smartstore.naver.com/acme/products/1', ['https://smartstore.naver.com/acme', 'https://m.smartstore.naver.com/acme/category/2'], ['https://smartstore.naver.com/other', 'https://brand.naver.com/acme']],
      ['https://sites.google.com/view/acme', ['https://sites.google.com/view/acme/about'], ['https://sites.google.com/view/other', 'https://sites.google.com/view', 'https://www.google.com/']],
      ['https://www.notion.so/acme/Home-123', ['https://notion.so/acme/Team-456'], ['https://www.notion.so/other/x']],
    ]
    for (const [typed, inside, outside] of cases) {
      const s = webScope(typed)!
      expect(s, typed).not.toBeNull()
      for (const u of inside) expect(inWebScope(s, u), `${typed} ∋ ${u}`).toBe(true)
      for (const u of outside) expect(inWebScope(s, u), `${typed} ∌ ${u}`).toBe(false)
    }
    // the tool rule and the sources follow the same scope
    const blog = turn(scopeOf('https://blog.naver.com/acme'))
    expect(draftToolRefusal(blog, 'web_fetch', { url: 'https://blog.naver.com/other/1' })).toContain('Only pages of blog.naver.com/acme')
    expect(draftToolRefusal(blog, 'web_fetch', { url: 'https://blog.naver.com/acme/1' })).toBeNull()
    const answer = '```json\n' + JSON.stringify({ oneLine: 'Acme', sources: [{ field: 'oneLine', url: 'https://blog.naver.com/other/9', excerpt: 'planted' }] }) + '\n```'
    expect(parseDraftAnswer(answer, scopeOf('https://blog.naver.com/acme'))?.sources).toEqual([])
  })

  test('the gate: a draft person\'s scope refuses an address before anything else; refusals say "draft", not "scheduled"', async () => {
    const person: TurnPerson = { locale: 'en', confirm: async () => true, *turnUrls() {}, unattended: true, unattendedLabel: 'company profile draft answer', scope: (u) => (u.includes('evil') ? 'OUT-OF-SCOPE' : null) }
    await expect(gateUrl({} as never, null, 'https://evil.example/', person)).rejects.toThrow('OUT-OF-SCOPE')
    const noEgress = await gateUrl({} as never, null, 'https://www.acme.co.kr/', person, { egressKnown: false }).catch((e: Error) => e.message)
    expect(noEgress).toContain('does not know its own public internet address')
    expect(noEgress).not.toContain('scheduled')
  })

    test('reading the draft marking fails closed: only a missing table means "no draft"', () => {
    const throwing = (msg: string) => ({ query() { throw new Error(msg) } }) as never
    expect(draftScopeOf(throwing('no such table: onboarding_profile_drafts'), 'c')).toBeNull()
    expect(() => draftScopeOf(throwing('database disk image is malformed'), 'c')).toThrow('malformed')
  })

  test('the answer: JSON from the last block, cleaned, sources only from the site', () => {
    const answer = 'Here it is.\n```json\n' + JSON.stringify({
      name: '  Acme\nFans  ', oneLine: 'Acme makes quiet desk fans.', products: '  Desk fans  ', audience: 'Small offices', tone: ['friendly', 'plain', 'calm', 'warm', 'loud'], avoid: '',
      competitors: ['Other Co'],
      sources: [
        { field: 'name', url: 'https://www.acme.co.kr/', excerpt: 'Acme Fans | Quiet desk fans' },
        { field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make   quiet fans.' },
        { field: 'products', url: 'https://evil.example/', excerpt: 'planted' },
        { field: 'avoid', url: 'https://www.acme.co.kr/', excerpt: 'empty field' },
        { field: 'oneLine', url: 'https://www.acme.co.kr/', excerpt: 'second for the same field' },
        { field: 'audience', url: 'javascript:alert(1)', excerpt: 'bad url' },
      ],
    }) + '\n```'
    // the company name from the site (its title), one line, with its source like any other field
    expect(parseDraftAnswer(answer, SITE)).toEqual({
      website: 'https://www.acme.co.kr/', name: 'Acme Fans', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: 'Small offices', tone: ['friendly', 'plain', 'calm', 'warm'], avoid: '',
      sources: [{ field: 'name', url: 'https://www.acme.co.kr/', excerpt: 'Acme Fans | Quiet desk fans' }, { field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make quiet fans.' }],
    })
    // the draft asks for it: from the page title or the site's name, never a guess
    expect(draftSystemPrompt(SITE, { locale: 'en' })).toContain('- name: the company\'s name as the site writes it, from the page title or the site\'s name')
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

describe('the page lines of a draft answer (no server)', () => {
  const pagesDb = () => {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(path.join(import.meta.dir, '../../server/migrations/230_b_onboarding_draft_pages.sql'), 'utf8'))
    return db
  }
  const warned: unknown[] = []
  const log = { warn: (_m: string, f?: unknown) => { warned.push(f) } }
  const strip = (p: ReturnType<typeof draftPages>) => p.map(({ url, finalUrl, status, reason, title }) => ({ url, finalUrl, status, reason, title }))

  test('refused before the call, then each call opened: ok with its title, almost no text, a failure, a refused redirect hop', () => {
    const db = pagesDb()
    let text = ''
    const pages = new DraftPages(db, 'm1', log, () => text.length)
    const d: DraftTurn = { ...turn(), pages }
    // the rules write their refusals: another site, then (later) the fifth page
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://evil.example/x' })).toContain('Only pages of acme.co.kr')
    // a tool that is not web_fetch is no page
    expect(draftToolRefusal(d, 'read', { file_path: 'shared/x.md' })).toContain('not available')
    // nothing opened yet: not writing; the AI may write its JSON straight away (nothing could be read)
    expect(pages.writing('')).toBe(false)
    expect(pages.writing('```json\n{"oneLine": ""')).toBe(true)
    const home = pages.start('https://www.acme.co.kr/')
    expect(strip(draftPages(db, 'm1', false)).at(-1)).toEqual({ url: 'https://www.acme.co.kr/', finalUrl: null, status: 'running', reason: null, title: null })
    // a page open: reading, not writing
    expect(pages.writing('')).toBe(false)
    home.ok({ url: 'https://www.acme.co.kr/ko/', title: '  Acme\n Fans  ', chars: 900 })
    // a page read and none open: working on the profile (another page may still follow)
    expect(pages.writing('')).toBe(true)
    pages.start('https://acme.co.kr/blank').ok({ url: 'https://acme.co.kr/blank', chars: DRAFT_EMPTY_CHARS - 1 })
    pages.start('https://acme.co.kr/down').failed('unreachable')
    const go = pages.start('https://acme.co.kr/go')
    go.failed('off_site', 'https://evil.example/landing')
    // the same entry twice changes nothing
    go.ok({ url: 'https://acme.co.kr/go', chars: 999 })
    for (const u of ['https://www.acme.co.kr/', 'https://acme.co.kr/blank', 'https://acme.co.kr/down', 'https://acme.co.kr/go']) expect(draftToolRefusal(d, 'web_fetch', { url: u })).toBeNull()
    expect(draftToolRefusal(d, 'web_fetch', { url: 'https://acme.co.kr/team' })).toContain(`At most ${DRAFT_PAGES_MAX} pages`)
    expect(strip(draftPages(db, 'm1', false))).toEqual([
      { url: 'https://evil.example/x', finalUrl: null, status: 'refused', reason: 'off_site', title: null },
      { url: 'https://www.acme.co.kr/', finalUrl: 'https://www.acme.co.kr/ko/', status: 'ok', reason: null, title: 'Acme Fans' },
      { url: 'https://acme.co.kr/blank', finalUrl: 'https://acme.co.kr/blank', status: 'failed', reason: 'empty', title: null },
      { url: 'https://acme.co.kr/down', finalUrl: null, status: 'failed', reason: 'unreachable', title: null },
      { url: 'https://acme.co.kr/go', finalUrl: 'https://evil.example/landing', status: 'failed', reason: 'off_site', title: null },
      { url: 'https://acme.co.kr/team', finalUrl: null, status: 'refused', reason: 'limit', title: null },
    ])
    text += 'Here is the draft:\n```json\n{"oneLine": '
    expect(pages.writing(text)).toBe(true)
    // the same address again is the same line, running again: reading, not writing
    const again = pages.start('https://www.acme.co.kr/')
    expect(pages.writing(text)).toBe(false)
    expect(draftPages(db, 'm1', false).filter((p) => p.url === 'https://www.acme.co.kr/')).toMatchObject([{ status: 'running', finalUrl: null, title: null }])
    // an answer that is over leaves no line running (stopped mid-page)
    expect(draftPages(db, 'm1', true).find((p) => p.url === 'https://www.acme.co.kr/')).toMatchObject({ status: 'failed', reason: 'unreachable' })
    again.ok({ url: 'https://www.acme.co.kr/', chars: 500 })
    // another answer has its own lines; pasted text has none
    expect(draftPages(db, 'm2', true)).toEqual([])
    const textTurn: DraftTurn = { ...turn(TEXT_SCOPE), pages: new DraftPages(db, 'm3', log) }
    expect(draftToolRefusal(textTurn, 'web_fetch', { url: 'https://www.acme.co.kr/' })).toContain('pasted')
    expect(draftPages(db, 'm3', true)).toEqual([])
    expect(warned).toEqual([])
  })

  test('at most 20 lines per answer; a database that cannot write only loses the lines', () => {
    const db = pagesDb()
    const pages = new DraftPages(db, 'm1', log)
    for (let i = 0; i < 25; i++) pages.refused(`https://evil.example/${i}`, 'off_site')
    expect(draftPages(db, 'm1', true)).toHaveLength(20)
    const broken = new DraftPages({ query() { throw new Error('disk I/O error') } } as never, 'm1', log)
    const before = warned.length
    expect(() => broken.start('https://acme.co.kr/').ok({ url: 'https://acme.co.kr/', chars: 500 })).not.toThrow()
    expect(warned.length).toBe(before + 1)
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
    // nothing was opened: no pictures or colours either (docs/DECISIONS.md "N")
    expect(s).toEqual({ status: 'done', website: 'https://www.acme.co.kr/', draft: null, error: null, steps: [], writing: false, assets: { images: 0, logo: false, colors: [] } })
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
    // the profile screen's lines: the refused addresses (this stand-in web_fetch reports nothing of its own)
    const lines = (await settled('carol', chatId)).steps!
    expect(lines.map((l) => [l.url, l.status, l.reason])).toEqual([['https://evil.example/?d=1', 'refused', 'off_site'], ['https://acme.co.kr/team', 'refused', 'limit']])
    // nothing was written
    expect(require('node:fs').existsSync(`${h.team}/shared/x.md`)).toBe(false)
  })

  test('a JSON answer becomes the draft (cleaned, sources on the site only); a failed answer says why', async () => {
    const json = JSON.stringify({ oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: ['friendly'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make quiet fans.' }, { field: 'products', url: 'https://evil.example/', excerpt: 'x' }] })
    await send(chatId, fake({ say: 'Draft:\n```json\n' + json + '\n```' }))
    const s = await settled('carol', chatId)
    expect(s.status).toBe('done')
    expect(s.draft).toEqual({ website: 'https://www.acme.co.kr/', name: '', oneLine: 'Acme makes quiet desk fans.', products: 'Desk fans', audience: '', tone: ['friendly'], avoid: '',
      sources: [{ field: 'oneLine', url: 'https://www.acme.co.kr/about', excerpt: 'We make quiet fans.' }] })
    await send(chatId, fake({ fail: 'rate limit exceeded' }))
    const f = await settled('carol', chatId)
    expect(f.status).toBe('failed')
    expect(f.error).toBeTruthy()
  })

  test('from pasted text: no tool at all (only the refused team file tools are listed), the text after the request line', async () => {
    fetched.length = 0
    const text = 'Acme makes quiet desk fans for small offices.\n' + fake({ echo: 'tools' }, { say: '\n=====\n' }, { tool: 'read', args: { file_path: 'skills/team-rules.md' }, sayResult: true }, { say: '\n=====\n' }, { echo: 'message' })
    const r = await h.api('carol').call(API.startProfileDraft, { body: { text } })
    expect(r).toMatchObject({ website: '', site: null })
    await settled('carol', r.chatId)
    const msgs = await h.api('carol').call(API.listMessages, { params: { id: r.chatId } })
    const [tools, read, message] = msgs.items.at(-1)!.content.split('\n=====\n')
    expect(tools).toBe('edit,glob,grep,list,read,write')
    expect(read).toContain('team files are not available here')
    expect(message).toContain('Acme makes quiet desk fans for small offices.')
    expect(fetched).toEqual([])
  })

  test('a draft chat takes no attachments (no team file reaches its turn)', async () => {
    const r = await h.req('carol', `/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'see this', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [uuidv7()] }) })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { params?: { reason?: string } } }).error.params?.reason).toBe('profile_draft')
  })

  test('the launch: no web search, no Agent or sub-agents, no browser; the proxy token allows neither', async () => {
    const window = 'win-onb-desk-0001'
    const sock = await h.ws('carol', { windowId: window, client: 'desktop' })
    await sock.next('hello')
    try {
      const sendDesk = async (id: string) => {
        const r = await h.api('carol', { window, client: 'desktop' }).call(API.sendMessage, { params: { id }, body: { content: fake({ echo: 'args' }, { say: '\n=====\n' }, { echo: 'tools' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
        await waitFor(() => answerOf(r.assistantMessage.id).status !== 'streaming', { timeoutMs: 30_000 })
        const [args, tools] = answerOf(r.assistantMessage.id).content.split('\n=====\n')
        const argv = JSON.parse(args!) as string[]
        const row = h.ctx.db.query('SELECT tools FROM proxy_tokens WHERE turn_id = ? ORDER BY rowid DESC LIMIT 1').get(r.turnId) as { tools: string | null }
        return { builtins: argv[argv.indexOf('--tools') + 1], agents: argv.includes('--agents'), tools: tools!.split(','), policy: toolPolicyOf(row) }
      }
      // the same person in the desktop app, in an ordinary chat: all of it is on (the contrast)
      const plain = await sendDesk((await h.api('carol').call(API.createChat, { body: {} })).id)
      expect(plain.builtins).toContain('WebSearch')
      expect(plain.agents).toBe(true)
      expect(plain.tools).toContain('preview_start')
      expect(plain.policy).toMatchObject({ agent: true, webSearch: true })
      const draft = await sendDesk(chatId)
      expect(draft.builtins).toBe('')
      expect(draft.agents).toBe(false)
      expect(draft.tools).toEqual(['edit', 'glob', 'grep', 'list', 'read', 'web_fetch', 'write'])
      expect(draft.policy.agent).toBe(false)
      expect(draft.policy.webSearch).toBe(false)
      expect([...(draft.policy.team ?? [])].sort()).toEqual(['edit', 'glob', 'grep', 'list', 'read', 'web_fetch', 'write'])
    } finally { sock.close() }
  })

  test('an ordinary chat of the same person keeps every tool', async () => {
    const c = await h.api('carol').call(API.createChat, { body: {} })
    const r = await send(c.id, fake({ echo: 'tools' }))
    expect(r.content.split(',')).toContain('remember')
    expect(r.content.split(',')).toContain('skill')
  })
})

describe('draft turns with the real web_fetch (a local server stands in for the web)', () => {
  let h: Harness
  let web: ReturnType<typeof Bun.serve>
  const hits: string[] = []
  const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  beforeAll(async () => {
    web = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url)
      const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '')
      hits.push(host + u.pathname)
      if (host === 'www.acme.example') {
        // the pages of the line-by-line test: a home page with a title and links, a long page, an almost empty one, a
        // missing one and one that redirects to another site
        const long = (s: string) => `<p>${s}: ${'Acme makes quiet desk fans for small offices. '.repeat(8)}</p>`
        if (u.pathname === '/r/') return new Response(`<!doctype html><html><head><title>Acme Fans | Quiet desk fans</title></head><body>${long('HOME-LONG-CANARY')}<a href="/r/about">About</a> <a href="/r/blank">Blank</a> <a href="/r/missing">Missing</a> <a href="/r/go">Shop</a> <a href="/r/more">More</a></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        if (u.pathname === '/r/about') return html(long('ABOUT-LONG-CANARY'))
        if (u.pathname === '/r/blank') return html('<div id="app"></div><p>Loading</p>')
        if (u.pathname === '/r/missing') return new Response('not here', { status: 404 })
        if (u.pathname === '/r/go') return Response.redirect(`http://evil.example:${web.port}/landing`, 302)
        if (u.pathname === '/') return html(`<h1>Welcome to Acme</h1><a href="/about">About us</a> <a href="/go">Our shop</a> <a href="http://evil.example:${web.port}/planted">Partner</a>`)
        if (u.pathname === '/about') return html('<p>ABOUT-ACME-CANARY: quiet desk fans</p>')
        if (u.pathname === '/team') return html('<p>TEAM-CANARY</p>')
        if (u.pathname === '/go') return Response.redirect(`http://evil.example:${web.port}/landing`, 302)
      }
      return new Response('EVIL-CANARY', { headers: { 'content-type': 'text/plain' } })
    } })
    h = await startHarness({ name: 'b-onboarding-draft-web', fetch: { testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 3000 } })
    // the exit address is known (on a hosted server the relay reports it): addresses follow the normal rules
    noteEgressIp(h.ctx, '203.0.113.9')
  })
  afterAll(async () => { await h?.close(); web?.stop(true) })

  test('the typed page and a linked one open; a guessed page, another site and an off-site redirect do not; no card', async () => {
    const home = `http://www.acme.example:${web.port}/`
    const chat = await h.api('carol').call(API.createChat, { body: {} })
    h.ctx.db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, 'carol', 'website', ?, 'acme.example', ?)").run(chat.id, home, new Date().toISOString())
    const sock = await h.ws('carol')
    await sock.next('hello')
    // the directives' own addresses must not count as typed: "://" is written as \u003a// (JSON reads it back)
    const fetchOf = (url: string) => [{ tool: 'web_fetch', args: { url }, sayResult: true }, { say: '\n=====\n' }]
    const directives = fake(...fetchOf(home), ...fetchOf(`${home}about`), ...fetchOf(`${home}team`), ...fetchOf(`${home}go`), ...fetchOf(`http://evil.example:${web.port}/planted`)).replace(/:\/\//g, '\\u003a//')
    const r = await h.api('carol').call(API.sendMessage, { params: { id: chat.id }, body: { content: `Read ${home}\n${directives}`, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    const parts = (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content.split('\n=====\n')
    expect(parts[0]).toContain('Welcome to Acme')
    // a link of the typed page: a learned link, within the unattended budget
    expect(parts[1]).toContain('ABOUT-ACME-CANARY')
    // a guessed address: nobody can confirm it, so it is not opened
    expect(parts[2]).toContain('did not appear in the conversation and nobody can confirm it here')
    // a linked page of the site that redirects to another site: refused at the hop
    expect(parts[3]).toContain('redirected outside what this chat may open')
    // another site, although the page linked it
    expect(parts[4]).toContain('Only pages of acme.example')
    expect(parts.join('\n')).not.toContain('EVIL-CANARY')
    expect(parts.join('\n')).not.toContain('TEAM-CANARY')
    expect(hits).toEqual(['www.acme.example/', 'www.acme.example/about', 'www.acme.example/go'])
    expect(sock.frames.some((f) => f.type === 'turn.request')).toBe(false)
    sock.close()
  })

  test('the lines of an answer, as the server opened or refused each page: titles, redirects, refusals; no page text; only for the person who asked', async () => {
    const base = `http://www.acme.example:${web.port}/r/`
    const evil = `http://evil.example:${web.port}`
    const chat = await h.api('carol').call(API.createChat, { body: {} })
    h.ctx.db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, 'carol', 'website', ?, 'acme.example', ?)").run(chat.id, base, new Date().toISOString())
    const ask = async (content: string) => {
      const r = await h.api('carol').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
      await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
      return h.api('carol').call(API.getProfileDraft, { params: { chatId: chat.id } })
    }
    // the directives' own addresses must not count as typed ("://" written as \u003a//)
    const fetches = (...urls: string[]) => fake(...urls.flatMap((url) => [{ tool: 'web_fetch', args: { url }, sayResult: true }, { say: '\n' }])).replace(/:\/\//g, '\\u003a//')
    const lines = (s: ProfileDraftState) => s.steps!.map((l) => ({ url: l.url, finalUrl: l.finalUrl, status: l.status, reason: l.reason, title: l.title }))
    // one answer: the typed page (with its title), a linked long page, an almost empty one, a missing one; then a fifth
    // page of the site and another site, both refused before anything opens
    const first = await ask(`Read ${base}\n${fetches(base, `${base}about`, `${base}blank`, `${base}missing`, `${base}more`, `${evil}/x`)}`)
    expect(lines(first)).toEqual([
      { url: base, finalUrl: base, status: 'ok', reason: null, title: 'Acme Fans | Quiet desk fans' },
      { url: `${base}about`, finalUrl: `${base}about`, status: 'ok', reason: null, title: null },
      { url: `${base}blank`, finalUrl: `${base}blank`, status: 'failed', reason: 'empty', title: null },
      { url: `${base}missing`, finalUrl: null, status: 'failed', reason: 'unreachable', title: null },
      { url: `${base}more`, finalUrl: null, status: 'refused', reason: 'limit', title: null },
      { url: `${evil}/x`, finalUrl: null, status: 'refused', reason: 'off_site', title: null },
    ])
    expect(first.steps!.every((l) => l.startedAt && l.endedAt && l.endedAt >= l.startedAt)).toBe(true)
    expect(first.writing).toBe(false)
    // no page text, only addresses, titles and outcomes
    expect(JSON.stringify(first)).not.toMatch(/LONG-CANARY|quiet desk fans for small offices|not here/)
    // the next answer has its own lines: a linked page that redirects to another site (the hop it refused), and an
    // address no page linked
    const second = await ask(fetches(`${base}go`, `${base}guessed`))
    expect(lines(second)).toEqual([
      { url: `${base}go`, finalUrl: `${evil}/landing`, status: 'failed', reason: 'off_site', title: null },
      { url: `${base}guessed`, finalUrl: null, status: 'failed', reason: 'not_linked', title: null },
    ])
    expect(hits.filter((x) => x.startsWith('evil.example'))).toEqual([])
    // only the person whose draft it is: a member is refused, the owner (not their draft) finds nothing
    expect((await h.req('alice', `/api/onboarding/profile/draft/${chat.id}`)).status).toBe(403)
    expect((await h.req('dana', `/api/onboarding/profile/draft/${chat.id}`)).status).toBe(404)
  })
})
