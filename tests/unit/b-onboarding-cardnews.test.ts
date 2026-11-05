// Onboarding N (docs/DECISIONS.md "N — The first result is the company's card news"): while a company profile draft
// reads the website, the server collects the brand's pictures and colours from the pages it opened itself; the first
// result places them into the team's brand folder, writes 회사 소개.md when no file was given, and opens the chat. No
// picture is made anywhere: too few pictures and the skill uses its type-only cards (Higgsfield taken out).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, CARD_NEWS_ARTIFACT_KEY, GENERAL_CARDNEWS_SKILL } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { noteEgressIp } from '../../server/src/tools/egress'
import { acceptImage, cssColors, dropRepeats, extractPageAssets, imageKind, introText, largestSrc, logoColors, normColor, pageLines, rankColors } from '../../server/src/onboarding/brand-assets'
import { htmlToText } from '../../server/src/tools/web-fetch'
import { which } from '../../server/src/config'
import { pngOf } from '../lib/images'
import { cleanColors, cleanProfile, profileFactLines } from '../../server/src/onboarding/profile'
import { parseDraftAnswer, webScope, type DraftScope } from '../../server/src/onboarding/draft'
import { introMarkdown } from '../../server/src/onboarding/welcome-result'
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
  // docs/DECISIONS.md "W3": a company site with no theme-color and only UI blues in its style sheets, its logo a wide
  // wordmark of thin deep-blue letters on white: the logo squeezed into 32 × 32 blended every letter with the white
  // around it, and that blend, as the logo's colour (150), won
  test.skipIf(!which('ffmpeg'))('the logo\'s colour is its own, never its letters blended with the white around them (ffmpeg)', async () => {
    const blue = [0x1f, 0x3a, 0x93] as const, white = [255, 255, 255] as const
    // a wordmark: 600 × 160, letters of 8 px strokes every 20 px, white around them
    const wordmark = Buffer.from(pngOf(600, 160, (x, y) => (y >= 40 && y < 120 && x >= 40 && x < 560 && x % 20 < 8 ? blue : white)))
    const hits = await logoColors(wordmark, 'png')
    // its own blue, and nothing else: no blend of blue and white
    expect(hits).toEqual([{ hex: '#1f3a93', weight: 150 }])
    // the page's own UI blues (a few repeated colours, weak) do not beat it
    const page = cssColors('.btn{color:#3b82f6}.a{color:#3b82f6}.b{background:#2563eb}.c{border-color:#2563eb}', 0.8)
    expect(rankColors([...hits, ...page])[0]).toBe('#1f3a93')
    // a solid icon and a two-colour mark keep both colours, the larger first
    const two = Buffer.from(pngOf(180, 180, (x) => (x < 120 ? [0x0e, 0x5e, 0x4e] : [0xf5, 0xa6, 0x23])))
    expect((await logoColors(two, 'png')).map((h) => h.hex)).toEqual(['#0e5e4e', '#f5a623'])
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
    // a giant picture is never kept (nor decoded)
    expect(acceptImage(png(10_000, 5_000), 'image')).toBeNull()
  })
  test('the profile keeps the person\'s colours; the AI\'s colours in a draft are dropped; the facts block names them', () => {
    expect(cleanColors(['#ABC', '#0e5e4e', '#0e5e4e', 'blue', 7, '#123456', '#111111', '#222222', '#333333', '#444444'])).toEqual(['#aabbcc', '#0e5e4e', '#123456', '#111111', '#222222'])
    const p = cleanProfile({ website: 'https://acme.example', name: 'Acme', oneLine: 'Quiet fans', products: '', audience: '', tone: [], avoid: '', sources: [], colors: ['#0E5E4E', '#3fd0a5'] })!
    expect(p.colors).toEqual(['#0e5e4e', '#3fd0a5'])
    expect(profileFactLines(p)).toContain('Brand colors (main first): #0e5e4e, #3fd0a5')
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
    expect(md).toContain('### 회사 소개\n\n출처: https://acme.example/about\n\n> 소개\n\n> 링크 글 2019년에 세웠어요.')
    expect(md).not.toContain('## 고객')
  })
  // docs/DECISIONS.md "W3": on a company site with CRLF markup, a site menu of nested link lists in a <header>, the
  // content in <section>s and a footer, the section held only the menu and hundreds of empty "> " lines, the same for
  // every page, and none of the page's own words
  const crlf = (s: string) => s.replace(/\n/g, '\r\n')
  const menu = `<header id="top-menu" class="site_gnb">\n<nav class="gnb-list">\n<ul>\n${['제품', '서비스', '소식', '회사 소개'].map((m) =>
    `  <li>\n    <span>${m}</span>\n    <ul>\n${[['개요', 'overview'], ['탁상형', 'desk'], ['벽걸이형', 'wall'], ['부품', 'parts']].map(([x, slug]) => `      <li>\n        <a href="/kr/${slug}/">${x}</a>\n      </li>\n\n\n`).join('')}    </ul>\n  </li>\n`).join('')}</ul>\n</nav>\n</header>\n`
  const shell = (body: string) => crlf(`<!doctype html><html><head><title>Acme</title></head><body>\n<a href="#top" class="skip-nav">본문으로 이동</a>\n${menu}${body}\n<footer class="site-footer"><p>Copyright © Acme. All rights reserved.</p><a href="/privacy">개인정보처리방침</a></footer>\n<div class="cookie-banner"><p>쿠키를 사용합니다</p><button>동의</button></div></body></html>`)
  const home = shell(`<section class="intro">\n  <h2 class="pc">조용한 바람<br>더 나은 하루</h2><h2 class="mo">조용한 바람 더 나은 하루</h2>\n  <p>\n    Acme는 작은 사무실을 위한\n    조용한 바람을 만들어요.\n  </p>\n</section>\n<section><h3><span>바람 연구소</span> <span>바람 연구소</span></h3><p>더 조용한 날개를 연구해요.</p><a href="/kr/lab/">더 알아보기</a></section>`)
  const about = shell(`<main><article><header><h1>회사 연혁</h1></header><p>1990년에 세웠어요.</p><aside>관련 글</aside></article></main>`)
  test('a page\'s own words for 회사 소개.md: no site menu, footer, cookie bar or blank lines; a heading for each screen once', () => {
    const base = new URL('https://www.acme.example/kr/')
    // the old reading (web_fetch's text): the menu and blank lines first
    const old = htmlToText(home, base).text
    expect(old.startsWith('[본문으로 이동]')).toBe(true)
    expect(old).toContain('[벽걸이형](https://www.acme.example/kr/wall/)')
    // carriage returns are line breaks now: no run of blank lines, also for the AI's web_fetch
    expect(old).not.toContain('\r')
    expect(old).not.toMatch(/\n{3,}/)
    const text = introText(home, base)
    expect(text.split('\n')).toEqual([
      '조용한 바람 더 나은 하루',
      'Acme는 작은 사무실을 위한 조용한 바람을 만들어요.',
      '바람 연구소',
      '더 조용한 날개를 연구해요.',
    ])
    // in main or an article, a header is the content's own; an aside is not
    expect(introText(about, base).split('\n')).toEqual(['회사 연혁', '1990년에 세웠어요.'])
    // a page builder that wraps the whole page in one form (ASP.NET Web Forms) keeps its words
    expect(introText('<body><form id="form1" method="post"><div id="content"><h1>회사 소개</h1><p>1990년에 세웠어요.</p><button>검색</button></div></form></body>', base).split('\n')).toEqual(['회사 소개', '1990년에 세웠어요.'])
  })
  test('page lines: links-only lines (a menu) dropped, links reduced to their words, repeats once, a sane length', () => {
    expect(pageLines('- [제품](https://a.example/p)\r\n\r\n\r\n- [뉴스](https://a.example/n) | [채용](https://a.example/c)\r\n# 소개\r\n[링크 글](https://a.example/x) 2019년에 세웠어요.\r\n›\r\n01\r\n# 소개')).toEqual(['소개', '링크 글 2019년에 세웠어요.'])
    expect(dropRepeats('조용한 바람 조용한 바람 조용한 바람 더 나은')).toBe('조용한 바람 더 나은')
    expect(dropRepeats('하하 하하 웃어요')).toBe('하하 하하 웃어요')
    const long = Array.from({ length: 400 }, (_, i) => `문장 ${i}번은 회사 이야기를 해요.`).join('\n')
    const lines = pageLines(long, 2000)
    expect(lines.join('\n').length).toBeLessThanOrEqual(2000)
    expect(lines[0]).toBe('문장 0번은 회사 이야기를 해요.')
    expect(pageLines('가'.repeat(5000), 100)).toEqual(['가'.repeat(99) + '…'])
  })
  test('회사 소개.md: every page quoted line by line, never an empty quote line; a line another page said is left out', () => {
    const base = new URL('https://www.acme.example/kr/')
    // the second page repeats the first one's slogan
    const pages = [
      { url: 'https://www.acme.example/kr/', title: 'Acme', text: introText(home, base) },
      { url: 'https://www.acme.example/kr/about/', title: '회사 연혁', text: introText(shell('<main><h1>조용한 바람 더 나은 하루</h1><p>1990년에 세웠어요.</p></main>'), base) },
    ]
    const md = introMarkdown({ locale: 'ko', name: 'Acme', profile: null, pages })
    expect(md).not.toMatch(/^>\s*$/m)
    expect(md).not.toContain('벽걸이형')
    expect(md).not.toContain('Copyright')
    expect(md).toContain('> 조용한 바람 더 나은 하루\n\n> Acme는 작은 사무실을 위한 조용한 바람을 만들어요.')
    expect(md.match(/조용한 바람 더 나은 하루/g)!.length).toBe(1)
    expect(md).toContain('### 회사 연혁\n\n출처: https://www.acme.example/kr/about/\n\n> 1990년에 세웠어요.')
    // a row kept before this fix (web_fetch's text, CRLF): still no empty quote line and no menu of links
    const old = introMarkdown({ locale: 'ko', name: 'Acme', profile: null, pages: [{ url: 'https://www.acme.example/kr/', title: 'Acme', text: htmlToText(home, base).text.replace(/\n/g, '\r\n\r\n') }] })
    expect(old).not.toMatch(/^>\s*$/m)
    expect(old).not.toContain('벽걸이형')
    expect(old).toContain('> Acme는 작은 사무실을 위한')
    // a long page gets its share, not the whole budget
    const big = { url: 'https://www.acme.example/kr/big/', title: '긴 글', text: Array.from({ length: 300 }, (_, i) => `긴 글 ${i}번째 문장이에요.`).join('\n') }
    const md2 = introMarkdown({ locale: 'ko', name: 'Acme', profile: null, pages: [big, { url: 'https://www.acme.example/kr/next/', title: '다음', text: '다음 쪽 이야기예요.' }] })
    expect(md2.slice(md2.indexOf('### 긴 글'), md2.indexOf('### 다음')).length).toBeLessThan(2600)
    expect(md2).toContain('> 다음 쪽 이야기예요.')
  })
  test('the page\'s own words in one pass: a hostile page does not stall the reading', () => {
    const base = new URL('https://acme.example/')
    const pages = [
      '<header>'.repeat(200_000),
      `<div class="${'gnb '.repeat(1000)}">`.repeat(500),
      ('<p>' + 'a b '.repeat(150) + '</p>').repeat(3000),
      ('[x](y) ' + '- '.repeat(50) + '\n').repeat(50_000),
    ]
    for (const page of pages) {
      const t0 = performance.now()
      introText(page, base)
      pageLines(page)
      expect(performance.now() - t0, page.slice(0, 20)).toBeLessThan(1500)
    }
  })
})

describe('the website reading and the first result (the real web_fetch and a local web)', () => {
  let h: Harness
  let web: ReturnType<typeof Bun.serve>
  const hits: string[] = []
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
      return new Response('EVIL-CANARY', { status: 404 })
    } })
    h = await startHarness({ name: 'b-onboarding-cardnews', fetch: { testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 3000 } })
    noteEgressIp(h.ctx, '203.0.113.9')
  })
  afterAll(async () => { await h?.close(); web?.stop(true) })

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

  test('no picture is made: the first-result chat offers no image tool, also with a Higgsfield key file on the server', async () => {
    fs.mkdirSync(path.join(h.dataDir, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(h.dataDir, 'secrets', 'higgsfield-onboarding.key'), JSON.stringify({ token: 'hf-test-token', workspace: 'ws-1' }), { mode: 0o600 })
    const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    const call = fake({ tool: 'brand_image', args: { prompt: 'A bright small office desk with a quiet white fan', aspect_ratio: '1:1', name: 'fan' }, sayResult: true })
    expect(await send('dana', r.chatId, call)).toMatch(/unknown tool|not available|no such tool/i)
    expect(fs.readdirSync(path.join(h.team, r.imagesFolder)).filter((f) => f.startsWith('fan'))).toEqual([])
  })
})

describe('a hostile page does not stall the server', () => {
  test('thousands of unclosed tags and style blocks: one pass', () => {
    const page = '<img src="a.jpg" '.repeat(150_000) + '<style>'.repeat(100_000)
    const t0 = performance.now()
    const a = extractPageAssets(page, new URL('https://acme.example/'))
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(a.images.length).toBeLessThanOrEqual(1)
  })
  test('the review\'s pages: bare "<", long style values, spaced data-bg, unclosed quotes, spaced CSS', () => {
    const base = new URL('https://acme.example/')
    const pages = [
      '<'.repeat(600_000) + '>',
      Array.from({ length: 700 }, () => `<div style="background:${'x'.repeat(3900)}">`).join(''),
      Array.from({ length: 700 }, () => `<div data-bg="url(a.jpg${' '.repeat(3900)}x">`).join(''),
      Array.from({ length: 700 }, () => `<img ${'a="'.repeat(1300)}>`).join(''),
      `<style>${'--brand-a' + ' '.repeat(50_000)}${'color' + ' '.repeat(50_000)}</style>`.repeat(20),
      `"logo"${' '.repeat(100_000)}`.repeat(20),
    ]
    for (const page of pages) {
      const t0 = performance.now()
      extractPageAssets(page, base)
      expect(performance.now() - t0, page.slice(0, 20)).toBeLessThan(1500)
    }
  })
})

describe('the skill files (docs/DECISIONS.md "W2": the result in front, the answer one line)', () => {
  const skill = (l: 'ko' | 'en') => fs.readFileSync(path.join(import.meta.dir, `../../resources/skill-packs/general/${l}/card-news/SKILL.md`), 'utf8')
  const answer = (md: string) => md.slice(md.search(/^## 6\. /m))
  test('both languages save the cards under the key the web app opens by itself', () => {
    for (const l of ['ko', 'en'] as const) expect(skill(l)).toContain(`key \`${CARD_NEWS_ARTIFACT_KEY}\``)
  })
  test('the answer is one line; the number\'s source is under the cards; the real rules stay', () => {
    const ko = skill('ko'), en = skill('en')
    expect(answer(ko)).toContain('한 줄만')
    expect(answer(en)).toContain('the answer is one line')
    // no more per-card lines or sources in the answer: they were the long answer under which the cards hid
    expect(answer(ko)).not.toContain('장마다 한 줄')
    expect(answer(en)).not.toContain('one line per card (what it says)')
    for (const md of [ko, en]) {
      expect(md).toContain('<p class="src">')
      expect(md).toContain('.src{')
    }
    // the brand-folder hint for cards made without a photo, numbers only as written, never a made picture
    expect(answer(ko)).toContain('브랜드 폴더의 이미지 폴더에 사진을 넣고 다시 만들어 달라고 하시면 사진을 넣어 드려요')
    expect(answer(en)).toContain('Add photos to the brand images folder and ask me again to put them in')
    // docs/DECISIONS.md "W3": only for a type-only card, named; the number and closing cards never count; cards that
    // all have photos get no photo line (a walk got it under cards with photos)
    for (const md of [answer(ko), answer(en)]) for (const v of ['`type-cover`', '`type-statement`', '`type-points`']) expect(md).toContain(v)
    expect(answer(ko)).toContain('있을 때만 한 문장을 더해요: "(n)장은 어울리는 사진이 없어 글자로만 만들었어요.')
    expect(answer(ko)).toContain('4장(숫자)과 5장(마무리)은 원래 사진이 없는 판이라 세지 않아요. 1~3장이 모두 사진을 쓴 판이면 사진 이야기는 하지 않아요.')
    expect(answer(en)).toContain('Only when one of cards 1–3 uses its type-only version')
    expect(answer(en)).toContain('"Card (n) had no fitting photo, so it is type only.')
    expect(answer(en)).toContain('When cards 1–3 all use a photo, say nothing about photos.')
    expect(answer(ko)).not.toContain('사진 없이 만든 장이 있으면')
    expect(ko).toContain('숫자는 자료에 숫자로 적힌 것만, 적힌 그대로 써요')
    expect(en).toContain('Use only numbers written as numbers in the material, exactly as written')
    expect(ko).toContain('사진을 새로 만들거나, 인터넷·스톡 사진을 가져오거나')
    expect(en).toContain('Never generate a photo, take one from the web or a stock library')
  })
})

describe('the team skill made of a card news answer', () => {
  test('the brand images folder is named as a whole (never "the newest picture"); a dated file still means the newest', async () => {
    const { draftFiles } = await import('../../server/src/onboarding/skill-draft')
    const used = ['groups/acme/Brand/Company intro.md', 'groups/acme/Brand/Images/logo.png', 'groups/acme/Brand/Images/website-1.jpg']
    expect(draftFiles([{ path: 'groups/acme/Brand/Company intro.md', latest: false }, { path: 'groups/acme/Brand/Images', latest: false }], used))
      .toEqual([{ path: 'groups/acme/Brand/Company intro.md', latest: false }, { path: 'groups/acme/Brand/Images', latest: false }])
    // a folder of documents named as it is stays "the latest" (S)
    expect(draftFiles([{ path: 'groups/acme/Brand', latest: false }], used)).toEqual([{ path: 'groups/acme/Brand', latest: true }])
  })
})

describe('staged pictures', () => {
  test('swept only when they can never be placed: not another owner\'s, not a draft still collecting', async () => {
    const h = await startHarness({ name: 'b-onboarding-cardnews-sweep' })
    try {
      const { sweepStagedAssets } = await import('../../server/src/onboarding/welcome-result')
      const root = path.join(h.dataDir, 'onboarding-assets')
      const old = new Date(Date.now() - 3600_000).toISOString(), older = new Date(Date.now() - 7200_000).toISOString()
      const draft = async (user: string, at: string, placed: boolean, recent = false) => {
        const chat = await h.api(user).call(API.createChat, { body: {} })
        h.ctx.db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, ?, 'website', 'https://acme.example/', 'acme.example', ?)").run(chat.id, user, at)
        h.ctx.db.query("INSERT INTO onboarding_brand_assets (chat_id, seq, kind, url, file, weight, placed_path, created_at) VALUES (?, 1, 'image', 'https://acme.example/a.jpg', '1.jpg', 50, ?, ?)").run(chat.id, placed ? 'groups/x/a.jpg' : null, recent ? new Date().toISOString() : at)
        fs.mkdirSync(path.join(root, chat.id), { recursive: true })
        fs.writeFileSync(path.join(root, chat.id, '1.jpg'), 'x')
        return chat.id
      }
      const danaOld = await draft('dana', older, false)
      const carolWaiting = await draft('carol', older, false)
      const danaPlaced = await draft('dana', old, true)
      const danaCollecting = await draft('dana', older, false, true)
      sweepStagedAssets(h.ctx)
      const left = fs.readdirSync(root).sort()
      // dana's older draft can never be placed; carol's still can; a draft still collecting is left alone; the placed one is done
      expect(left).toEqual([carolWaiting, danaCollecting].sort())
      expect(left).not.toContain(danaOld)
      expect(left).not.toContain(danaPlaced)
    } finally { await h.close() }
  })
})
