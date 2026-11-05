// Onboarding N (docs/DECISIONS.md "N — The first result is the company's card news"): while a company profile draft
// reads the website, the server collects the brand's pictures and colours from the pages it opened itself; the first
// result places them into the team's brand folder, writes 회사 소개.md when no file was given, and opens a chat where
// the brand photo tool (Higgsfield, at most 4 a team) may run; nowhere else.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, GENERAL_CARDNEWS_SKILL } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { noteEgressIp } from '../../server/src/tools/egress'
import { acceptImage, cssColors, extractPageAssets, imageKind, largestSrc, normColor, rankColors } from '../../server/src/onboarding/brand-assets'
import { cleanColors, cleanProfile, profileFactLines } from '../../server/src/onboarding/profile'
import { parseDraftAnswer, webScope, type DraftScope } from '../../server/src/onboarding/draft'
import { introMarkdown } from '../../server/src/onboarding/welcome-result'
import { BRAND_IMAGE_TOOL, BRAND_IMAGES_PER_TEAM, PROMPT_RULES } from '../../server/src/onboarding/brand-image'
import { outsideContentTool } from '../../server/src/chat/team-content-tools'
import { WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { getSetting, setSetting } from '../../server/src/admin/settings'

setDefaultTimeout(60_000)

/** A PNG header with a real size (enough for the byte checks; no decoder runs on it). */
function png(w: number, h: number, pad = 4096): Buffer {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8; b[25] = 6
  return b
}
const jpeg = (w: number, h: number) => {
  const b = Buffer.alloc(4096)
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(b, 0)
  b.writeUInt16BE(h, 7)
  b.writeUInt16BE(w, 9)
  return b
}

describe('what a page offers (pure)', () => {
  const base = new URL('https://www.acme.example/about')
  const page = `<!doctype html><html><head>
    <meta property="og:image" content="/img/og.jpg"><meta name="twitter:image" content="https://cdn.acme-cdn.example/tw.jpg">
    <meta name="theme-color" content="#0E5E4E"><link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
    <link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="https://fonts.other.example/x.css">
    <script type="application/ld+json">{"@type":"Organization","logo":{"@type":"ImageObject","url":"https:\\/\\/www.acme.example\\/logo-ld.png"}}</script>
    <style>:root{--brand-primary:#0e5e4e;--color-red:#ff0000} .btn{background:#3fd0a5}.cta{background-color:#3fd0a5}</style>
    </head><body><header><img src="/img/logo.svg" alt="Acme"><img class="site-logo" src="/img/logo.png" alt="Acme 로고"></header>
    <section style="background-image:url('/img/hero.jpg')"><h1>Quiet fans</h1></section>
    <img srcset="/img/p-640.jpg 640w, /img/p-1600.jpg 1600w" src="/img/p-640.jpg" alt="product">
    <img data-src="/img/lazy.webp" src="data:image/gif;base64,R0lGOD" alt="factory">
    <img src="/img/pixel.gif" width="1" height="1"><img src="/img/icon-mail.png" width="24" height="24"><img src="/img/sprite.png">
    <a href="/img/linked.jpg">a linked picture is no picture of the page</a>
    </body></html>`
  test('logos, pictures (largest srcset, lazy, background), colours and style sheets; icons, pixels, SVG and GIF left out', () => {
    const a = extractPageAssets(page, base)
    expect(a.logos.map((c) => c.url)).toEqual(['https://www.acme.example/logo-ld.png', 'https://www.acme.example/img/logo.png', 'https://www.acme.example/icon-180.png'])
    const imgs = a.images.map((c) => c.url)
    expect(imgs.slice(0, 2)).toEqual(['https://www.acme.example/img/og.jpg', 'https://cdn.acme-cdn.example/tw.jpg'])
    expect(imgs).toContain('https://www.acme.example/img/hero.jpg')
    expect(imgs).toContain('https://www.acme.example/img/p-1600.jpg')
    expect(imgs).toContain('https://www.acme.example/img/lazy.webp')
    for (const no of ['pixel.gif', 'icon-mail', 'sprite', 'logo.svg', 'favicon.ico', 'linked.jpg', 'p-640.jpg']) expect(imgs.some((u) => u.includes(no)), no).toBe(false)
    expect(a.stylesheets).toEqual(['https://www.acme.example/css/site.css', 'https://fonts.other.example/x.css'])
    // a colour the CSS only repeats a few times is not a brand colour by itself
    expect(rankColors(a.colors)).toEqual(['#0e5e4e'])
  })
  test('colours: forms, a palette of many variables does not win, greys and white never count, a black brand keeps its black', () => {
    expect(['#abc', '#AABBCC', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.9)', 'rgba(1,2,3,0.1)', 'red'].map(normColor)).toEqual(['#aabbcc', '#aabbcc', '#010203', '#010203', null, null])
    const palette = cssColors(':root{--brand-a:#e1535d;--brand-b:#e67f2b;--brand-c:#edae0d;--brand-d:#20ab55;--brand-e:#3292e3}')
    expect(rankColors([...palette, { hex: '#4d24fc', weight: 150 }])).toEqual(['#4d24fc'])
    expect(rankColors([{ hex: '#ffffff', weight: 120 }, { hex: '#808080', weight: 120 }, { hex: '#212121', weight: 120 }, { hex: '#05b2f5', weight: 16 }])).toEqual(['#212121'])
    expect(largestSrc('a.jpg 1x, b.jpg 2x')).toBe('b.jpg')
  })
  test('pictures are judged by their bytes: PNG, JPEG, WebP of a real size; never SVG, HTML or a strip', () => {
    expect(imageKind(png(10, 10))).toBe('png')
    expect(imageKind(jpeg(10, 10))).toBe('jpg')
    expect(imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(imageKind(Buffer.from('<!doctype html><p>not found</p>'))).toBeNull()
    expect(acceptImage(png(1200, 630), 'image')).toEqual({ ext: 'png', width: 1200, height: 630 })
    expect(acceptImage(png(200, 200), 'image')).toBeNull()
    expect(acceptImage(png(2400, 500), 'image')).toBeNull()
    expect(acceptImage(png(180, 180), 'logo')).toEqual({ ext: 'png', width: 180, height: 180 })
    expect(acceptImage(png(32, 32), 'logo')).toBeNull()
  })
  test('the profile keeps the person\'s colours; the AI\'s colours in a draft are dropped; the facts block names them', () => {
    expect(cleanColors(['#ABC', '#0e5e4e', '#0e5e4e', 'blue', 7, '#123456', '#111111', '#222222', '#333333', '#444444'])).toEqual(['#aabbcc', '#0e5e4e', '#123456', '#111111', '#222222'])
    const p = cleanProfile({ website: 'https://acme.example', name: 'Acme', oneLine: 'Quiet fans', products: '', audience: '', tone: [], avoid: '', sources: [], colors: ['#0E5E4E', '#3fd0a5'] })!
    expect(p.colors).toEqual(['#0e5e4e', '#3fd0a5'])
    expect(profileFactLines(p)).toContain('Brand colours (main first): #0e5e4e, #3fd0a5')
    expect(cleanProfile({ website: '', oneLine: 'x', products: '', audience: '', tone: [], avoid: '', sources: [] })!.colors).toBeUndefined()
    const scope: DraftScope = { chatId: 'c', source: 'website', website: 'https://acme.example/', site: 'acme.example', web: webScope('https://acme.example/') }
    const d = parseDraftAnswer('```json\n{"name":"Acme","oneLine":"Quiet fans","products":"","audience":"","tone":[],"avoid":"","sources":[],"colors":["#ff0000"]}\n```', scope)!
    expect(d.colors).toBeUndefined()
  })
  test('회사 소개.md: the confirmed profile and the pages read, each under its source; nothing else', () => {
    const md = introMarkdown({
      locale: 'ko', name: 'Acme',
      profile: { website: 'https://acme.example/', name: 'Acme', oneLine: '조용한 선풍기를 만들어요', products: '탁상 선풍기', audience: '', tone: ['친근하게'], avoid: '', colors: ['#0e5e4e'], sources: [{ field: 'oneLine', url: 'https://acme.example/', excerpt: '조용한 선풍기' }], updatedAt: '2026-11-05T00:00:00.000Z' },
      pages: [{ url: 'https://acme.example/about', title: '회사 소개', text: '# 소개\n[링크 글](https://acme.example/x) 2019년에 세웠어요.' }],
    })
    expect(md).toContain('# Acme 회사 소개')
    expect(md).toContain('홈페이지(https://acme.example/)')
    expect(md).toContain('## 한 줄 소개\n\n조용한 선풍기를 만들어요\n\n출처: https://acme.example/ — "조용한 선풍기"')
    expect(md).toContain('## 브랜드 색\n\n#0e5e4e')
    expect(md).toContain('### 회사 소개\n\n출처: https://acme.example/about\n\n> 소개\n> 링크 글 2019년에 세웠어요.')
    expect(md).not.toContain('## 고객')
  })
  test('the brand photo is the team\'s own content (a skill can be made of the chat); every prompt carries the rules', () => {
    expect(outsideContentTool(`mcp__team__${BRAND_IMAGE_TOOL}`)).toBe(false)
    expect(PROMPT_RULES).toMatch(/No people, no faces.*no text.*no logos/)
  })
})

describe('the website reading, the first result and the brand photo (the real web_fetch, a local web and a stand-in photo service)', () => {
  let h: Harness
  let web: ReturnType<typeof Bun.serve>
  let hf: ReturnType<typeof Bun.serve>
  const hits: string[] = []
  const hfCalls: { path: string; body: unknown }[] = []
  let hfFail = false
  const site = () => `http://www.acme.example:${web.port}/`
  beforeAll(async () => {
    web = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url)
      const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '')
      hits.push(host + u.pathname)
      const p = `http://${host}:${web.port}`
      const text = 'Acme makes quiet desk fans for small offices since 2019. '.repeat(12)
      if (host === 'www.acme.example') {
        if (u.pathname === '/') return new Response(`<!doctype html><html><head><title>Acme</title>
          <meta property="og:image" content="/og.png"><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"><meta name="theme-color" content="#0e5e4e">
          <link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="http://other.example:${web.port}/theirs.css"></head>
          <body><p>${text}</p><img src="http://cdn.example:${web.port}/product.jpg" alt="fan"><img src="/small.png"><img src="/fake.jpg"><img src="/og.png?again=1">
          <img src="/logo.svg" alt="logo"><a href="/about">About</a></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        if (u.pathname === '/about') return new Response(`<!doctype html><html><head><title>About Acme</title></head><body><p>ABOUT ${text}</p><img src="/og.png"></body></html>`, { headers: { 'content-type': 'text/html' } })
        if (u.pathname === '/og.png') return new Response(new Uint8Array(png(1200, 630)), { headers: { 'content-type': 'image/png' } })
        if (u.pathname === '/touch.png') return new Response(new Uint8Array(png(180, 180)), { headers: { 'content-type': 'image/png' } })
        if (u.pathname === '/small.png') return new Response(new Uint8Array(png(120, 90)), { headers: { 'content-type': 'image/png' } })
        // claims to be a JPEG, is a web page: judged by the bytes
        if (u.pathname === '/fake.jpg') return new Response('<!doctype html><p>nope</p>', { headers: { 'content-type': 'image/jpeg' } })
        if (u.pathname === '/logo.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', { headers: { 'content-type': 'image/svg+xml' } })
        if (u.pathname === '/site.css') return new Response(':root{--brand-accent:#3fd0a5}', { headers: { 'content-type': 'text/css' } })
      }
      if (host === 'cdn.example' && u.pathname === '/product.jpg') return new Response(new Uint8Array(jpeg(1000, 800)), { headers: { 'content-type': 'image/jpeg' } })
      if (host === '127.0.0.1' && u.pathname === '/out.png') return new Response(new Uint8Array(png(1024, 1024)), { headers: { 'content-type': 'image/png' } })
      return new Response('EVIL-CANARY', { status: 404 })
    } })
    hf = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get('authorization') !== 'Bearer hf-test-token' || req.headers.get('hf-workspace-id') !== 'ws-1') return Response.json({ detail: 'Invalid or expired token' }, { status: 401 })
      hfCalls.push({ path: u.pathname, body: req.method === 'POST' ? await req.json() : null })
      if (req.method === 'POST' && u.pathname === '/developer/v2alpha/images/z_image/generations') return Response.json({ id: `job-${hfCalls.length}`, job_type: 'z_image', credits: 0.15 })
      if (u.pathname.startsWith('/developer/v2alpha/jobs/')) return Response.json(hfFail ? { status: 'failed' } : { status: 'completed', result_url: `http://127.0.0.1:${web.port}/out.png` })
      return new Response('no', { status: 404 })
    } })
    process.env.MYCEL_HIGGSFIELD_ONBOARDING_API = `http://127.0.0.1:${hf.port}`
    h = await startHarness({ name: 'b-onboarding-cardnews', fetch: { testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 3000 } })
    noteEgressIp(h.ctx, '203.0.113.9')
  })
  afterAll(async () => { delete process.env.MYCEL_HIGGSFIELD_ONBOARDING_API; await h?.close(); web?.stop(true); hf?.stop(true) })

  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const send = async (user: string, chatId: string, content: string, attachmentIds: string[] = []) => {
    const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    return (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content
  }
  let draftChat = ''

  test('reading the website keeps the page\'s own pictures and colours aside; the AI\'s answer is unchanged', async () => {
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    draftChat = chat.id
    h.ctx.db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, 'dana', 'website', ?, 'acme.example', ?)").run(chat.id, site(), new Date().toISOString())
    const fetches = fake({ tool: 'web_fetch', args: { url: site() }, sayResult: true }, { tool: 'web_fetch', args: { url: `${site()}about` } }, { say: '```json\n{"name":"Acme","oneLine":"Quiet fans","products":"Desk fans","audience":"","tone":[],"avoid":"","sources":[]}\n```' }).replace(/:\/\//g, '\\u003a//')
    const answer = await send('dana', chat.id, `Read ${site()}\n${fetches}`)
    expect(answer).toContain('Acme makes quiet desk fans')
    // the pictures come a moment after the pages (in the background)
    let s = await h.api('dana').call(API.getProfileDraft, { params: { chatId: chat.id } })
    await waitFor(async () => { s = await h.api('dana').call(API.getProfileDraft, { params: { chatId: chat.id } }); return (s.assets?.images ?? 0) >= 3 }, { timeoutMs: 15_000 })
    expect(s.assets).toEqual({ images: 3, logo: true, colors: ['#0e5e4e', '#3fd0a5'] })
    // the same picture twice (another address, another page) is kept once; the CDN picture the page shows is fetched;
    // never the other site's style sheet, the SVG kept, or anything an <a> links
    expect(hits).toContain(`cdn.example/product.jpg`)
    expect(hits).not.toContain('other.example/theirs.css')
    const rows = h.ctx.db.query("SELECT kind, url, file FROM onboarding_brand_assets WHERE chat_id = ? AND file IS NOT NULL ORDER BY seq").all(chat.id) as { kind: string; url: string; file: string }[]
    expect(rows.map((r) => [r.kind, new URL(r.url).pathname])).toEqual([['logo', '/touch.png'], ['image', '/og.png'], ['image', '/product.jpg']])
    // staged in the server's data folder, not in the team folder yet
    expect(fs.readdirSync(path.join(h.dataDir, 'onboarding-assets', chat.id)).sort()).toEqual(rows.map((r) => r.file).sort())
    expect(fs.existsSync(path.join(h.team, 'groups'))).toBe(fs.existsSync(path.join(h.team, 'groups')))
  })

  test('the first result: owner only; the pictures into the brand folder once, 회사 소개.md from the profile and pages, a titled chat (an English team)', async () => {
    expect((await h.req('carol', '/api/onboarding/welcome/first-result', { method: 'POST', body: JSON.stringify({ files: [] }), headers: { 'content-type': 'application/json' } })).status).toBe(403)
    expect((await h.req('alice', '/api/onboarding/welcome/first-result', { method: 'POST', body: JSON.stringify({ files: [] }), headers: { 'content-type': 'application/json' } })).status).toBe(403)
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://www.acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], colors: ['#0e5e4e'] } })
    const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    expect(r.skillPath).toBe(GENERAL_CARDNEWS_SKILL)
    // names in the team's language (the harness team is English): Brand/Images, logo, website-n, Company intro.md
    expect(r.images.map((p) => path.basename(p))).toEqual(['logo.png', 'website-1.png', 'website-2.jpg'])
    for (const p of r.images) expect(fs.existsSync(path.join(h.team, p))).toBe(true)
    expect(r.imagesFolder).toMatch(/^groups\/[^/]+\/Brand\/Images$/)
    expect(r.intro).toBe(r.imagesFolder.replace(/\/Images$/, '/Company intro.md'))
    expect(r.files).toEqual([r.intro!])
    const md = fs.readFileSync(path.join(h.team, r.intro!), 'utf8')
    expect(md).toContain('# Acme company intro')
    expect(md).toContain('Quiet desk fans')
    expect(md).toContain(`Source: ${site()}about`)
    expect(md).not.toContain('EVIL-CANARY')
    // the history of the file is the owner's save
    expect((h.ctx.db.query("SELECT user_id FROM file_events WHERE path = ? ORDER BY rowid LIMIT 1").get(r.intro) as { user_id: string }).user_id).toBe('dana')
    const chat = h.ctx.db.query('SELECT title, title_source, user_id FROM chats WHERE id = ?').get(r.chatId) as { title: string; title_source: string; user_id: string }
    expect(chat).toEqual({ title: '우리 회사 홍보 카드뉴스', title_source: 'user', user_id: 'dana' })
    // a second start: the pictures are there once, 회사 소개.md is kept as it is (someone may have edited it)
    fs.writeFileSync(path.join(h.team, r.intro!), '# 손본 소개\n')
    const again = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    expect(again.images).toEqual(r.images)
    expect(again.intro).toBeNull()
    expect(fs.readFileSync(path.join(h.team, r.intro!), 'utf8')).toBe('# 손본 소개\n')
    expect(fs.readdirSync(path.join(h.team, r.imagesFolder)).length).toBe(3)
    // the owner's own files instead: they are the material, no 회사 소개.md is written; a file that is not there is refused
    const deck = `${r.imagesFolder.replace(/\/Images$/, '')}/deck.pdf`
    fs.writeFileSync(path.join(h.team, deck), '%PDF-1.4 deck')
    const withFile = await h.api('dana').call(API.startFirstResult, { body: { files: [deck] } })
    expect(withFile.files).toEqual([deck])
    expect(withFile.intro).toBeNull()
    expect((await h.req('dana', '/api/onboarding/welcome/first-result', { method: 'POST', body: JSON.stringify({ files: ['groups/none/x.pdf'] }), headers: { 'content-type': 'application/json' } })).status).toBe(400)
  })

  test('a row from before the skill: "카드뉴스" is added on its own once, and recorded', async () => {
    const raw = getSetting<Record<string, any>>(h.ctx.db, WELCOME_SETTING)!
    const skill = path.join(h.team, GENERAL_CARDNEWS_SKILL)
    fs.rmSync(path.dirname(skill), { recursive: true, force: true })
    setSetting(h.ctx.db, WELCOME_SETTING, { ...raw, general: { at: raw.general.at, tasksPath: raw.general.tasksPath, briefPath: raw.general.briefPath } })
    const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    expect(r.skillPath).toBe(GENERAL_CARDNEWS_SKILL)
    expect(fs.existsSync(skill)).toBe(true)
    expect(getSetting<Record<string, any>>(h.ctx.db, WELCOME_SETTING)!.general.cardNewsPath).toBe(GENERAL_CARDNEWS_SKILL)
  })

  test('the brand photo: only in a first-result chat of its owner, with the key; saved in the brand folder; at most 4 a team', async () => {
    const tool = (args: unknown) => fake({ tool: BRAND_IMAGE_TOOL, args, sayResult: true })
    const args = { prompt: 'A bright small office desk with a quiet white fan, deep green accents', aspect_ratio: '1:1', name: '조용한-선풍기' }
    const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    // no key on the server: not offered
    expect(await send('dana', r.chatId, tool(args))).toMatch(/unknown tool|not available|no such tool/i)
    fs.mkdirSync(path.join(h.dataDir, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(h.dataDir, 'secrets', 'higgsfield-onboarding.key'), JSON.stringify({ token: 'hf-test-token', workspace: 'ws-1' }), { mode: 0o600 })
    // an ordinary chat of the owner: not offered either
    const plain = await h.api('dana').call(API.createChat, { body: {} })
    expect(await send('dana', plain.id, tool(args))).toMatch(/unknown tool|not available|no such tool/i)
    expect(hfCalls).toEqual([])
    // the first-result chat: made, saved as a team file in the brand images folder
    const made = await send('dana', r.chatId, tool(args))
    expect(made).toContain(`Saved the brand photo: ${r.imagesFolder}/조용한-선풍기.png`)
    expect(fs.existsSync(path.join(h.team, r.imagesFolder, '조용한-선풍기.png'))).toBe(true)
    expect((hfCalls[0]!.body as { params: { prompt: string; aspect_ratio: string } }).params).toEqual({ prompt: `${args.prompt} ${PROMPT_RULES}`, aspect_ratio: '1:1' })
    // a failed job gives its photo back
    hfFail = true
    expect(await send('dana', r.chatId, tool(args))).toContain('could not be made')
    hfFail = false
    const counts = () => h.ctx.db.query("SELECT status, count(*) AS n FROM onboarding_images GROUP BY status ORDER BY status").all()
    expect(counts()).toEqual([{ status: 'done', n: 1 }, { status: 'failed', n: 1 }])
    // three more fit (four in all), then the tool is not offered any more
    for (let i = 0; i < BRAND_IMAGES_PER_TEAM - 1; i++) expect(await send('dana', r.chatId, tool({ ...args, name: `사진-${i}` }))).toContain('Saved the brand photo')
    expect(await send('dana', r.chatId, tool(args))).toMatch(/unknown tool|not available|no such tool/i)
    expect((h.ctx.db.query("SELECT count(*) AS n FROM onboarding_images WHERE status = 'done'").get() as { n: number }).n).toBe(BRAND_IMAGES_PER_TEAM)
  })
})
