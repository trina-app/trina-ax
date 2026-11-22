// A page that shows almost no text without its scripts (a client-rendered site, the owner's potenlab.dev in the company
// profile draft): what web_fetch adds (tools/page-data.ts: the markup's meta, JSON-LD and embedded data; the sitemap's
// likely pages) and the page drawn by its scripts in the locked-down browser (tools/page-render.ts), whose every request
// goes through web_fetch's address guard.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { attrOf, jsonLdLines, pageData, proseLike, proseStrings, sitemapLocs, sitemapPages, thinText, PAGE_DATA_MAX } from '../../server/src/tools/page-data'
import { webFetch, type FetchOptions } from '../../server/src/tools/web-fetch'
import { renderPage, RENDER_LIMITS } from '../../server/src/tools/page-render'
import { _queueForTest, findPdfBrowser, htmlPdfUnavailable, renderParallel, renderSlot, tryRenderSlot } from '../../server/src/files/html-pdf'
import { WORK } from '../lib/env'

setDefaultTimeout(60_000)

/** A Vite single-page app's shell, as potenlab.dev serves it: the title, the head's meta and JSON-LD, an empty root. */
const VITE_SHELL = `<!DOCTYPE html><html lang="ko"><head>
<script>(function(){ var host = window.location.hostname; })();</script>
<meta charset="UTF-8" /><title>Acme | Quiet desk fans</title>
<meta name="description" content="Acme makes quiet desk fans for small offices. Desk fans, ceiling fans &amp; repairs." />
<meta property="og:title" content="Acme | Quiet desk fans" />
<meta property="og:description" content="Quiet fans for small offices." />
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","@id":"https://acme.example/#org","name":"Acme","alternateName":"에이크미","url":"https://acme.example","description":"Quiet desk fans for small offices.",
   "makesOffer":[{"@type":"Offer","itemOffered":{"@type":"Service","name":"Fan repair","description":"Repairs in two days."}}]},
  {"@type":"WebSite","name":"Acme","url":"https://acme.example"}]}</script>
<script type="module" crossorigin src="/assets/index.js"></script></head>
<body><div id="root"></div></body></html>`

/** A client-rendered Next.js page: the text is only in __NEXT_DATA__. */
const NEXT_PAGE = `<!doctype html><html><head><title>Beta Studio</title></head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { hero: { title: 'We build booking apps for clinics', image: '/hero.png', className: 'flex items-center px-4' },
    customers: ['Dental clinics in Seoul', 'Physio studios'], id: 'abc123', slug: 'home', cta: { href: '/contact', label: 'Talk to us today' } } },
  page: '/', query: {}, buildId: 'x7Hk2', runtimeConfig: {},
})}</script></body></html>`

/** The App Router's RSC payload. */
const RSC_PAGE = `<!doctype html><html><head><title>Gamma</title></head><body>
<script>self.__next_f.push([1,"1:[\\"$\\",\\"h1\\",null,{\\"children\\":\\"Payroll software for restaurants\\"}]\\n2:[\\"$\\",\\"p\\",null,{\\"className\\":\\"text-lg\\",\\"children\\":\\"Used by 300 restaurant owners\\"}]"])</script>
</body></html>`

describe('page-data: what the markup says', () => {
  test('a Vite shell: meta description, social card and JSON-LD, each value on its own line as written (entities decoded)', () => {
    const d = pageData(VITE_SHELL)
    const lines = d.split('\n')
    for (const v of ['Acme makes quiet desk fans for small offices. Desk fans, ceiling fans & repairs.', 'Acme | Quiet desk fans', 'Quiet fans for small offices.',
      'Acme', '에이크미', 'Quiet desk fans for small offices.', 'Fan repair', 'Repairs in two days.']) expect(lines).toContain(`- ${v}`)
    // no labels or joins of our own: every value line is text of the page
    for (const l of lines.filter((x) => x.startsWith('- '))) expect(VITE_SHELL.replace(/&amp;/g, '&')).toContain(l.slice(2))
    // the scripts' code is no text
    expect(d).not.toContain('window.location')
  })

  test('__NEXT_DATA__: prose strings of the page props, not ids, class names, addresses or the build', () => {
    const d = pageData(NEXT_PAGE)
    for (const s of ['We build booking apps for clinics', 'Dental clinics in Seoul', 'Physio studios', 'Talk to us today']) expect(d).toContain(s)
    for (const s of ['abc123', 'flex items-center', '/hero.png', 'x7Hk2', '/contact']) expect(d).not.toContain(s)
  })

  test('the RSC payload: the text children of its elements', () => {
    const d = pageData(RSC_PAGE)
    expect(d).toContain('Payroll software for restaurants')
    expect(d).toContain('Used by 300 restaurant owners')
    expect(d).not.toContain('text-lg')
  })

  test('nothing in the markup: nothing added; a page with text is not thin', () => {
    expect(pageData('<html><head><title>x</title></head><body><div id="app"></div></body></html>')).toBe('')
    expect(thinText('Loading')).toBe(true)
    expect(thinText('word '.repeat(60))).toBe(false)
  })

  test('hostile markup: broken JSON, deep nesting, a huge page and unclosed tags stay quick and capped', () => {
    expect(pageData('<script type="application/ld+json">{"name": </script><meta name="description" content="ok text here">')).toContain('ok text here')
    let deep: unknown = 'deep prose string here'
    for (let i = 0; i < 5000; i++) deep = { a: deep }
    expect(proseStrings(deep)).toEqual([])
    const many = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: Array.from({ length: 50_000 }, (_, i) => `sentence number ${i} about fans`) })}</script>`
    const t0 = performance.now()
    const d = pageData('<meta name=description content="x y z w">' + many + '<meta '.repeat(200_000) + '<script'.repeat(100_000))
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(d.length).toBeLessThanOrEqual(PAGE_DATA_MAX)
  })

  test('helpers: attributes, prose, JSON-LD lines', () => {
    expect(attrOf(' name="description" content=\'a &amp; b\'', 'content')).toBe('a & b')
    expect(attrOf(' data-content="no" content=yes', 'content')).toBe('yes')
    expect(proseLike('Quiet fans')).toBe(true)
    expect(proseLike('조용한 선풍기')).toBe(true)
    expect(proseLike('https://acme.example/x')).toBe(false)
    expect(proseLike('heroImage_2x')).toBe(false)
    expect(jsonLdLines({ '@type': 'Product', name: 'Fan X', description: 'Silent.' })).toEqual(['Fan X', 'Silent.'])
  })
})

describe('the print slots: a drawing takes one, never waits, never goes before a print', () => {
  test('free: a slot; all taken by prints: null; given back: free again', async () => {
    const before = _queueForTest()
    const a = tryRenderSlot('page-render:t1')
    expect(a).not.toBeNull()
    a!()
    const prints = await Promise.all(Array.from({ length: renderParallel() }, (_, i) => renderSlot(`print-user-${i}`)))
    expect(tryRenderSlot('page-render:t2')).toBeNull()
    // a print waiting: the drawing does not take the slot it waits for
    const waiter = renderSlot('print-user-waiting')
    prints[0]!()
    const w = await waiter
    expect(tryRenderSlot('page-render:t3')).toBeNull()
    w()
    for (const p of prints.slice(1)) p()
    const c = tryRenderSlot('page-render:t4')
    expect(c).not.toBeNull()
    c!()
    expect(_queueForTest()).toEqual(before)
  })
})

describe('sitemap: likely pages of the same site', () => {
  const base = new URL('https://acme.example/')
  test('about, services and customers first; blog posts, policies, other hosts, files and queries left out', () => {
    const { index, locs } = sitemapLocs(`<?xml version="1.0"?><urlset>
      <url><loc>https://acme.example/</loc></url><url><loc>https://acme.example/blog/post-1</loc></url>
      <url><loc>https://acme.example/privacy</loc></url><url><loc>https://acme.example/pricing</loc></url>
      <url><loc>https://acme.example/about</loc></url><url><loc>https://evil.example/about</loc></url>
      <url><loc>https://acme.example/brochure.pdf</loc></url><url><loc>https://acme.example/about?x=1</loc></url>
      <url><loc>https://acme.example/customers</loc></url><url><loc>https://acme.example/회사소개</loc></url>
      <url><loc><![CDATA[https://acme.example/contact]]></loc></url><url><loc>https://acme.example/a/b/c/deep</loc></url>
    </urlset>`)
    expect(index).toBe(false)
    const pages = sitemapPages(locs, base)
    expect(pages.slice(0, 2).map((p) => decodeURI(new URL(p).pathname)).sort()).toEqual(['/about', '/회사소개'])
    expect(pages).toContain('https://acme.example/pricing')
    expect(pages).toContain('https://acme.example/customers')
    for (const no of ['blog', 'privacy', 'evil.example', '.pdf', '?x=1', 'contact', 'deep']) expect(pages.join(' ')).not.toContain(no)
    expect(pages).not.toContain('https://acme.example/')
  })
  test('a sitemap index is recognized', () => {
    expect(sitemapLocs('<sitemapindex><sitemap><loc>https://acme.example/s1.xml</loc></sitemap></sitemapindex>')).toEqual({ index: true, locs: ['https://acme.example/s1.xml'] })
  })
})

describe('web_fetch on a page that shows almost no text', () => {
  let web: ReturnType<typeof Bun.serve>
  const hits: string[] = []
  let posts = 0
  let heavyNow = 0, heavyPeak = 0
  const T = (): FetchOptions => ({ testAllow: (ip) => ip === '127.0.0.1', lookup: async (h) => [{ address: h === 'private.test' ? '10.0.0.5' : h === 'meta.test' ? '169.254.169.254' : '127.0.0.1', family: 4 }], timeoutMs: 3000 })
  const U = (host: string, p: string) => `http://${host}:${web.port}${p}`
  beforeAll(() => {
    web = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url)
      const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '')
      hits.push(`${req.method} ${host}${u.pathname}`)
      const html = (s: string) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (req.method === 'POST') { posts++; return new Response('posted') }
      if (host === 'shell.test') {
        if (u.pathname === '/') return html(VITE_SHELL)
        if (u.pathname === '/sitemap.xml') return new Response(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${U('shell.test', '/pages.xml')}</loc></sitemap></sitemapindex>`, { headers: { 'content-type': 'application/xml' } })
        if (u.pathname === '/pages.xml') return new Response(`<urlset><url><loc>${U('shell.test', '/')}</loc></url><url><loc>${U('shell.test', '/about')}</loc></url><url><loc>${U('other.test', '/about')}</loc></url><url><loc>${U('shell.test', '/blog/x')}</loc></url></urlset>`, { headers: { 'content-type': 'application/xml' } })
      }
      if (host === 'away.test' && u.pathname === '/sitemap.xml') return Response.redirect(U('other.test', '/sitemap.xml'), 302)
      if (host === 'away.test') return html('<title>Away</title><div id="app"></div>')
      if (host === 'drawn.test') {
        // a page its script fills: from a data request of its own site, after trying the office network, the cloud
        // metadata address, a POST and a picture (none of which may reach anything)
        if (u.pathname === '/') return html(`<!doctype html><html><head><title>Drawn</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`)
        if (u.pathname === '/app.js') return new Response(`(async () => {
          const out = []
          const tryGet = async (url) => { try { const r = await fetch(url); return (await r.text()).slice(0, 40) } catch { return 'BLOCKED' } }
          out.push('private=' + await tryGet('http://private.test:${web.port}/secret'))
          out.push('metadata=' + await tryGet('http://meta.test:${web.port}/latest'))
          try { await fetch('/post', { method: 'POST', body: 'x' }); out.push('post=SENT') } catch { out.push('post=BLOCKED') }
          const img = new Image(); img.src = '/pic.png'
          const data = await (await fetch('/data.json')).json()
          document.getElementById('root').innerHTML = '<h1>' + data.title + '</h1><p>' + data.body + '</p><p>' + out.join(' ') + '</p><a href="/about">About us</a>'
        })()`, { headers: { 'content-type': 'text/javascript' } })
        if (u.pathname === '/data.json') return Response.json({ title: 'Drawn Fans Co', body: 'We sell quiet fans to hotels and clinics. '.repeat(8) })
      }
      if (host === 'heavy.test') {
        // a page that asks for 40 large answers at once
        if (u.pathname === '/') return html(`<!doctype html><html><head><title>Heavy</title></head><body><div id="root"></div><script src="/heavy.js"></script></body></html>`)
        if (u.pathname === '/heavy.js') return new Response(`(async () => {
          const got = await Promise.all(Array.from({ length: 40 }, (_, i) => fetch('/big?i=' + i).then((r) => r.text()).then((t) => t.length).catch(() => 0)))
          document.getElementById('root').innerHTML = '<p>' + 'Heavy page answers: '.repeat(12) + got.filter((n) => n > 0).length + ' of 40 arrived</p>'
        })()`, { headers: { 'content-type': 'text/javascript' } })
        if (u.pathname === '/big') {
          heavyNow++; heavyPeak = Math.max(heavyPeak, heavyNow)
          return new Promise((r) => setTimeout(() => { heavyNow--; r(new Response('x'.repeat(900 * 1024), { headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } })) }, 150))
        }
      }
      if (host === 'private.test' || host === 'meta.test') return new Response('SECRET-CANARY')
      return new Response('not here', { status: 404 })
    } })
  })
  afterAll(() => web?.stop(true))

  test('a Vite shell: the markup\'s own data below the title text, and the sitemap\'s likely pages (through a sitemap index, same host only)', async () => {
    const r = await webFetch(U('shell.test', '/'), { ...T(), sitePages: true })
    expect(r.text).toContain('- Acme makes quiet desk fans for small offices.')
    expect(r.text).toContain('- 에이크미')
    expect(r.text).toContain(`- ${U('shell.test', '/about')}`)
    expect(r.text).not.toContain('other.test')
    expect(r.text).not.toContain('/blog/x')
    expect(hits.filter((h) => h.includes('other.test'))).toEqual([])
  })

  test('without sitePages no sitemap is read; a sitemap that redirects to another site is not followed', async () => {
    hits.length = 0
    await webFetch(U('shell.test', '/'), T())
    expect(hits).toEqual(['GET shell.test/'])
    hits.length = 0
    const r = await webFetch(U('away.test', '/'), { ...T(), sitePages: true })
    expect(r.text).not.toContain('sitemap')
    expect(hits).toEqual(['GET away.test/', 'GET away.test/sitemap.xml'])
  })

  test('a render hook that draws the page: its text replaces the shell\'s; one that fails changes nothing', async () => {
    const drawn = '<html><body><h1>Drawn heading</h1><p>' + 'We repair fans for hotels. '.repeat(12) + '</p></body></html>'
    const r = await webFetch(U('shell.test', '/'), { ...T(), render: async (p) => (p.html.includes('id="root"') ? drawn : null), keepHtml: true })
    expect(r.text).toContain('Drawn heading')
    expect(r.text).not.toContain('Acme makes quiet desk fans')
    expect(r.html).toBe(drawn)
    // reading on (offset > 0): the first read's drawing, never a second one
    let again = 0
    const on = await webFetch(U('shell.test', '/'), { ...T(), offset: 5, render: async () => { again++; return null } })
    expect(again).toBe(0)
    expect(on.text).toBe(r.text.slice(5, 5 + on.text.length))
    // a failed drawing (another language: not the drawing above) changes nothing
    const f = await webFetch(U('shell.test', '/'), { ...T(), acceptLanguage: 'ja', render: async () => { throw new Error('no browser') } })
    expect(f.text).toContain('- Acme makes quiet desk fans')
  })

  const BROWSER = htmlPdfUnavailable() === null ? findPdfBrowser() : null
  if (!BROWSER) console.warn(`web-thin-page: no headless browser in the isolation here (${htmlPdfUnavailable()}); the drawn-page cases are skipped`)
  const drawing = BROWSER ? test : test.skip
  const workBase = path.join(WORK, `web-thin-page-${process.pid}`)

  drawing('the page drawn by its script: its own data request answered; the office network, cloud metadata, a POST and a picture never reached', async () => {
    fs.mkdirSync(workBase, { recursive: true })
    hits.length = 0
    posts = 0
    const t0 = Date.now()
    const r = await webFetch(U('drawn.test', '/'), { ...T(), render: (p) => renderPage({ ...p, ...T(), workBase }) })
    expect(Date.now() - t0).toBeLessThan(RENDER_LIMITS.timeoutMs + 8_000)
    expect(r.text).toContain('Drawn Fans Co')
    expect(r.text).toContain('We sell quiet fans to hotels and clinics.')
    expect(r.text).toContain('private=BLOCKED')
    expect(r.text).toContain('metadata=BLOCKED')
    expect(r.text).toContain('post=BLOCKED')
    expect(r.text).not.toContain('SECRET-CANARY')
    expect(posts).toBe(0)
    expect(hits.filter((h) => /private\.test|meta\.test|POST|pic\.png/.test(h))).toEqual([])
    // the page itself was not fetched twice: the browser got the HTML web_fetch had read
    expect(hits.filter((h) => h === 'GET drawn.test/')).toHaveLength(1)
    // the drawn page's links are there for the AI
    expect(r.text).toContain(`[About us](${U('drawn.test', '/about')})`)
    // the work folder is gone
    expect(fs.readdirSync(path.join(workBase, 'work')).length).toBe(0)
  })

  drawing('parallel large answers: the bytes fetched stay within the budget (reserved before each fetch), at most maxInFlight at once', async () => {
    fs.mkdirSync(workBase, { recursive: true })
    const stats = { fetchedBytes: 0 }
    const limits = { maxBytes: 3 * 1024 * 1024, maxOneBytes: 1024 * 1024, maxInFlight: 6 }
    const r = await webFetch(U('heavy.test', '/'), { ...T(), render: (p) => renderPage({ ...p, ...T(), workBase, limits, stats }) })
    expect(r.text).toContain('Heavy page answers')
    expect(stats.fetchedBytes).toBeGreaterThan(0)
    expect(stats.fetchedBytes).toBeLessThanOrEqual(limits.maxBytes)
    const arrived = Number(/(\d+) of 40 arrived/.exec(r.text)?.[1])
    expect(arrived).toBeGreaterThan(0)
    expect(arrived).toBeLessThan(40)
    expect(heavyPeak).toBeLessThanOrEqual(limits.maxInFlight)
  })

  drawing('without the isolation runBrowser refuses, even with a browser named directly (and renderPage draws nothing)', () => {
    const mod = path.join(import.meta.dir, '..', '..', 'server', 'src', 'files', 'html-pdf.ts')
    const code = `const { runBrowser } = await import(${JSON.stringify(mod)}); try { await runBrowser(${JSON.stringify(workBase)}, { browser: ${JSON.stringify(BROWSER)}, limits: { timeoutMs: 5000, maxRssMiB: 512, maxWorkBytes: 1e8 }, maxMessage: 1e6, tooLarge: () => new Error('x'), scripts: true, timeoutText: 't', memoryText: 'm' }, async () => 'ran'); console.log('RAN') } catch (e) { console.log('REFUSED ' + e.code) }`
    const r = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, MYCEL_ISOLATION: 'none', MYCEL_HTML_PDF_TEST_NO_ISOLATION: '' } })
    expect(r.stdout.toString().trim()).toBe('REFUSED unavailable')
  })

  drawing('no browser: nothing drawn, quietly', async () => {
    expect(await renderPage({ url: U('drawn.test', '/'), html: '<p>x</p>', browser: null })).toBeNull()
  })
})
