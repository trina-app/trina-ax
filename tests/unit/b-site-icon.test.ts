// The team logo from the company website (docs/decisions/20261128-team-icon-from-site.md; server/src/onboarding/
// site-icon.ts, admin/team-icon-site.ts): which icon of a page is picked (manifest, apple-touch-icon, rel=icon sizes, an
// ICO's PNG entry, a near-square logo; never SVG, og:image, a banner or a tiny favicon), the fetch rules (web_fetch's:
// private and exit addresses, redirects into them, oversize, slow servers, the fetch budget), the "only if no logo"
// write and its undo, the onboarding press (저장하고 계속) and the admin button. Fixtures are generated pictures and
// fictional *.example sites.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { checkTeamIcon, imageInfo } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { makeJpeg, makePng, pngOf, pngRgbaOf, SVG } from '../lib/images'
import { noteEgressIp } from '../../server/src/tools/egress'
import { which } from '../../server/src/config'
import { BrandCollector, rawRgba, stagedSiteIcon } from '../../server/src/onboarding/brand-assets'
import { icoPngEntry, iconCandidates, judgeIcon, manifestIcons, normaliseIcon, parseSizes, pickSiteIcon, SITE_ICON_IMAGE_FETCHES } from '../../server/src/onboarding/site-icon'
import { readTeamIcon, saveTeamIconIfAbsent, teamIconFile, removeTeamIcon } from '../../server/src/admin/team-icon'
import { setSiteIconNetForTests } from '../../server/src/admin/team-icon-site'

setDefaultTimeout(60_000)
const FFMPEG = which('ffmpeg')
const withFfmpeg = FFMPEG ? test : test.skip

/** An ICO file of these entries (PNG bytes, or a BMP-like stand-in of `size` px), with a correct directory. */
function ico(entries: ({ png: Uint8Array } | { bmp: number })[]): Uint8Array<ArrayBuffer> {
  const head = Buffer.alloc(6 + 16 * entries.length)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4)
  const bodies: Buffer[] = []
  let at = head.length
  entries.forEach((e, i) => {
    const body = 'png' in e ? Buffer.from(e.png) : Buffer.concat([Buffer.from([40, 0, 0, 0]), Buffer.alloc(e.bmp * e.bmp * 4)])
    const size = 'png' in e ? imageInfo(e.png)!.width : e.bmp
    const o = 6 + 16 * i
    head[o] = size >= 256 ? 0 : size; head[o + 1] = size >= 256 ? 0 : size
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(body.length, o + 8); head.writeUInt32LE(at, o + 12)
    at += body.length
    bodies.push(body)
  })
  return new Uint8Array(Buffer.concat([head, ...bodies]))
}

const page = (head: string, body = '') => `<!doctype html><html><head><title>Acme</title>${head}</head><body>${body}</body></html>`
const BASE = 'https://www.acme.example/'

describe('where the icon is looked for (pure)', () => {
  test('sizes: the largest square, "any", none', () => {
    expect(parseSizes('16x16 32x32 192x192')).toBe(192)
    expect(parseSizes('any')).toBe(-1)
    expect(parseSizes('')).toBe(0)
    expect(parseSizes('180X180')).toBe(180)
    expect(parseSizes('junk')).toBe(0)
  })

  test('order: apple-touch (largest first) > rel=icon >= 64 px (largest first, none without sizes last) > square logo > ico; never SVG, never og:image, never a small icon', () => {
    const html = page(`
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="icon" href="/icon-192.png" sizes="192x192">
      <link rel="icon" href="/icon-any.svg" sizes="any">
      <link rel="icon" type="image/svg+xml" href="/mark">
      <link rel="mask-icon" href="/safari.svg">
      <link rel="icon" href="/plain.png">
      <link rel="shortcut icon" href="/favicon.ico">
      <link rel="apple-touch-icon" href="/touch-120.png" sizes="120x120">
      <link rel="apple-touch-icon-precomposed" href="/touch-180.png" sizes="180x180">
      <meta property="og:image" content="/banner.jpg">
      <meta name="twitter:image" content="/tw.jpg">
      <meta property="og:logo" content="/og-logo.png">`, '<img src="/logo.svg" alt="logo"><img class="site-logo" src="/img/logo-wide.png">')
    const { manifest, candidates } = iconCandidates(html, BASE)
    expect(manifest).toBeNull()
    expect(candidates.map((c) => `${c.source} ${new URL(c.url).pathname}`)).toEqual([
      'apple /touch-180.png', 'apple /touch-120.png', 'icon /icon-192.png', 'icon /plain.png', 'logo /og-logo.png', 'logo /img/logo-wide.png', 'ico /favicon.ico',
    ])
    expect(candidates.some((c) => /svg|banner|tw\.jpg|favicon-32/.test(c.url))).toBe(false)
  })

  test('an <img> is a logo by its class, id or file name, never by its alt text alone (a product photo "… Logo Hoodie")', () => {
    const html = page('', '<img class="header-logo" src="/brand.png"><img id="logo" src="/b.png"><img src="/img/acme_logo_square.png"><img src="/p/hoodie.webp" alt="Acme Unisex Logo Embroidery Hoodie" width="510" height="637">')
    const logos = iconCandidates(html, BASE).candidates.filter((c) => c.source === 'logo').map((c) => new URL(c.url).pathname)
    expect(logos).toEqual(['/brand.png', '/b.png', '/img/acme_logo_square.png'])
    // the JSON-LD organization's logo comes first
    expect(iconCandidates(page('<script type="application/ld+json">{"@type":"Organization","logo":"https:\\/\\/www.acme.example\\/ld.png"}</script>', '<img class="logo" src="/x.png">'), BASE).candidates.filter((c) => c.source === 'logo').map((c) => c.url))
      .toEqual(['https://www.acme.example/ld.png', 'https://www.acme.example/x.png'])
  })

  test('relative addresses follow <base href>; without apple-touch or ico on the page the site root is tried', () => {
    const { manifest, candidates } = iconCandidates(page('<base href="https://cdn.acme.example/assets/"><link rel="manifest" href="app.webmanifest"><link rel="icon" href="i/512.png" sizes="512x512">'), 'https://www.acme.example/about/us')
    expect(manifest).toBe('https://cdn.acme.example/assets/app.webmanifest')
    expect(candidates.map((c) => c.url)).toEqual(['https://www.acme.example/apple-touch-icon.png', 'https://cdn.acme.example/assets/i/512.png', 'https://www.acme.example/favicon.ico'])
  })

  test('manifest: "any" before "maskable", largest first; SVG, "any" size, small icons and other types skipped; bad JSON is none', () => {
    const json = JSON.stringify({ icons: [
      { src: '/m-512.png', sizes: '512x512', purpose: 'maskable' },
      { src: '/a-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/a-512.webp', sizes: '512x512', type: 'image/webp', purpose: 'any maskable' },
      { src: '/a.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/vector', sizes: '512x512', type: 'image/svg+xml' },
      { src: '/a-48.png', sizes: '48x48' },
      { src: '/mono-1024.png', sizes: '1024x1024', purpose: 'monochrome' },
      { src: 'icons/a-1024.gif', sizes: '1024x1024', type: 'image/gif' },
      { nope: true }, 'x',
    ] })
    expect(manifestIcons(json, 'https://www.acme.example/static/site.webmanifest').map((c) => new URL(c.url).pathname)).toEqual(['/a-512.webp', '/a-192.png', '/m-512.png'])
    expect(manifestIcons('{not json', BASE)).toEqual([])
    expect(manifestIcons('{"icons": 3}', BASE)).toEqual([])
  })

  test('ICO: the largest embedded PNG of at least 64 px; BMP-only and malformed directories are none, never a throw', () => {
    const p64 = makePng(64, 64), p128 = makePng(128, 128)
    expect(icoPngEntry(ico([{ bmp: 16 }, { png: p64 }, { png: p128 }, { bmp: 48 }]))).toEqual(p128)
    expect(icoPngEntry(ico([{ bmp: 16 }, { bmp: 32 }, { bmp: 48 }]))).toBeNull()
    expect(icoPngEntry(ico([{ png: makePng(48, 48) }]))).toBeNull()
    const bad = ico([{ png: p64 }])
    const many = new Uint8Array(bad); many[4] = 0xff; many[5] = 0xff
    expect(icoPngEntry(many)).toBeNull()
    const past = new Uint8Array(bad); new DataView(past.buffer).setUint32(6 + 12, 1_000_000, true)
    expect(icoPngEntry(past)).toBeNull()
    const long = new Uint8Array(bad); new DataView(long.buffer).setUint32(6 + 8, 0xffffffff, true)
    expect(icoPngEntry(long)).toBeNull()
    expect(icoPngEntry(new Uint8Array([0, 0, 1, 0, 0, 0]))).toBeNull()
    expect(icoPngEntry(bad.slice(0, 10))).toBeNull()
  })

  test('judged by the bytes: square enough, 64 px or more, PNG / JPEG / WebP only', () => {
    expect(judgeIcon(makePng(64, 64))).toMatchObject({ ok: true, width: 64 })
    expect(judgeIcon(makePng(120, 100))).toMatchObject({ ok: true })
    expect(judgeIcon(makePng(48, 48))).toEqual({ ok: false, why: 'small' })
    expect(judgeIcon(makePng(300, 100))).toEqual({ ok: false, why: 'shape' })
    expect(judgeIcon(SVG)).toEqual({ ok: false, why: 'type' })
    expect(judgeIcon(new TextEncoder().encode('<!doctype html><p>hi</p>'))).toEqual({ ok: false, why: 'type' })
    expect(judgeIcon(makeJpeg(8000, 8000))).toEqual({ ok: false, why: 'huge' })
  })

  test('without ffmpeg: an opaque near-square original is kept as it is, a see-through one is skipped', async () => {
    const jpeg = makeJpeg(180, 180)
    expect(await normaliseIcon(jpeg, { type: 'image/jpeg', width: 180, height: 180 }, null)).toEqual({ bytes: jpeg, type: 'image/jpeg' })
    const opaque = makePng(180, 180)
    expect((await normaliseIcon(opaque, { type: 'image/png', width: 180, height: 180 }, null))?.bytes).toEqual(opaque)
    const clear = pngRgbaOf(180, 180, () => [0, 0, 0, 0])
    expect(await normaliseIcon(clear, { type: 'image/png', width: 180, height: 180 }, null)).toBeNull()
  })

  withFfmpeg('with ffmpeg: square 256 px PNG; a dark see-through mark on white, a light one on near-black; never scaled up', async () => {
    const mark = (rgb: [number, number, number]) => pngRgbaOf(400, 400, (x, y) => (Math.hypot(x - 200, y - 200) < 120 ? [...rgb, 255] : [0, 0, 0, 0]))
    const corner = async (b: Uint8Array) => [...(await rawRgba(Buffer.from(b), 'png', 32))!.subarray(0, 3)]
    const dark = (await normaliseIcon(mark([20, 30, 90]), { type: 'image/png', width: 400, height: 400 }))!
    expect(imageInfo(dark.bytes)).toEqual({ type: 'image/png', width: 256, height: 256 })
    expect(checkTeamIcon(dark.bytes, 'image/png').ok).toBe(true)
    expect(await corner(dark.bytes)).toEqual([255, 255, 255])
    const light = (await normaliseIcon(mark([250, 240, 220]), { type: 'image/png', width: 400, height: 400 }))!
    expect(await corner(light.bytes)).toEqual([0x1d, 0x19, 0x16])
    // a 120 × 100 opaque icon: cropped to 100 × 100, not scaled up to 256
    const small = (await normaliseIcon(makePng(120, 100), { type: 'image/png', width: 120, height: 100 }))!
    expect(imageInfo(small.bytes)).toEqual({ type: 'image/png', width: 100, height: 100 })
  })
})

describe('fetching (web_fetch\'s rules, a local web)', () => {
  let web: ReturnType<typeof Bun.serve>
  const hits: string[] = []
  const net = () => ({ testAllow: (ip: string) => ip === '127.0.0.1', lookup: async (h: string) => [{ address: h === 'private.example' ? '10.0.0.5' : h === 'exit.example' ? '203.0.113.9' : '127.0.0.1', family: 4 }], blockedIps: () => ['203.0.113.9'] })
  const site = (p = '/') => `http://www.acme.example:${web.port}${p}`
  beforeAll(() => {
    web = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const u = new URL(req.url)
      hits.push(u.pathname)
      if (u.pathname === '/touch.png') return new Response(makePng(180, 180), { headers: { 'content-type': 'image/png' } })
      if (u.pathname === '/icon-256.png') return new Response(makePng(256, 256))
      if (u.pathname === '/favicon.ico') return new Response(ico([{ bmp: 16 }, { png: makePng(128, 128, [200, 30, 30]) }]), { headers: { 'content-type': 'image/x-icon' } })
      if (u.pathname === '/html.png') return new Response('<!doctype html><p>not a picture</p>', { headers: { 'content-type': 'image/png' } })
      if (u.pathname === '/vector.png') return new Response(SVG, { headers: { 'content-type': 'image/png' } })
      if (u.pathname === '/huge.png') { const b = Buffer.alloc(7 * 1024 * 1024); Buffer.from(makePng(256, 256)).copy(b); return new Response(b) }
      if (u.pathname === '/slow.png') { await Bun.sleep(3000); return new Response(makePng(256, 256)) }
      if (u.pathname === '/to-private.png') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      if (u.pathname === '/to-touch.png') return new Response(null, { status: 302, headers: { location: '/touch.png' } })
      if (u.pathname === '/site.webmanifest') return new Response(JSON.stringify({ icons: [{ src: '/icon-256.png', sizes: '256x256', type: 'image/png' }] }))
      if (u.pathname === '/big.webmanifest') return new Response('{"icons":[' + ' '.repeat(70 * 1024) + ']}')
      return new Response('nothing', { status: 404 })
    } })
  })
  afterAll(() => web?.stop(true))
  const pick = (html: string, o: Parameters<typeof pickSiteIcon>[3] = {}) => pickSiteIcon(html, site(), net(), { ffmpeg: null, ...o })

  test('manifest icon first; then apple-touch; an ICO\'s PNG entry when nothing else', async () => {
    expect((await pick(page(`<link rel="manifest" href="${site('/site.webmanifest')}"><link rel="apple-touch-icon" href="/touch.png">`)))?.url).toBe(site('/icon-256.png'))
    expect((await pick(page('<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/icon-256.png" sizes="256x256">')))?.source).toBe('apple')
    const fromIco = await pick(page(''))
    expect(fromIco?.source).toBe('ico')
    expect(imageInfo(fromIco!.bytes)).toEqual({ type: 'image/png', width: 128, height: 128 })
    // a manifest over 64 KiB is ignored; the page's own icons still count
    expect((await pick(page(`<link rel="manifest" href="/big.webmanifest"><link rel="icon" href="/icon-256.png" sizes="256x256">`)))?.url).toBe(site('/icon-256.png'))
    // a redirect inside the public web is followed (each hop checked)
    expect((await pick(page('<link rel="apple-touch-icon" href="/to-touch.png">')))?.url).toBe(site('/to-touch.png'))
  })

  test('refused: private and exit addresses, a redirect into a private address, HTML or SVG served as a PNG, more than 6 MiB', async () => {
    for (const href of ['http://10.0.0.1/a.png', 'http://169.254.169.254/latest/meta-data', `http://private.example:${web.port}/touch.png`, `http://exit.example:${web.port}/touch.png`, '/to-private.png', '/html.png', '/vector.png', '/huge.png']) {
      // the page names only this one; what is left is the site root's /favicon.ico (its PNG entry)
      const got = await pick(page(`<link rel="apple-touch-icon" href="${href}">`))
      expect({ href, source: got?.source }).toEqual({ href, source: 'ico' })
    }
    // the private and exit hosts were never reached (the local server saw no request for them)
    expect(hits).not.toContain('/latest/meta-data')
  })

  test('a slow server stops at the deadline; at most one manifest and six image fetches', async () => {
    const t0 = Date.now()
    // the slow one is given up after its limit; the site root's /favicon.ico still comes in time
    expect((await pick(page('<link rel="apple-touch-icon" href="/slow.png">'), { fetchMs: 300, deadline: Date.now() + 1500 }))?.source).toBe('ico')
    expect(Date.now() - t0).toBeLessThan(2500)
    const fetched: string[] = []
    const many = Array.from({ length: 12 }, (_, i) => `<link rel="icon" href="/missing-${i}.png" sizes="${512 - i}x${512 - i}">`).join('')
    expect(await pick(page(`<link rel="manifest" href="/site-missing.webmanifest">${many}`), { onFetch: (u) => fetched.push(u) })).toBeNull()
    expect(fetched.length).toBe(1 + SITE_ICON_IMAGE_FETCHES)
  })
})

describe('the "only if no logo" write and its undo', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'site-icon-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  test('an uploaded logo is never replaced, even one that appears between a check and the write; undo removes only its own version', () => {
    const uploaded = makePng(100, 100, [1, 2, 3])
    fs.writeFileSync(teamIconFile(dir), uploaded)
    expect(saveTeamIconIfAbsent(dir, makePng(200, 200), 'image/png')).toBeNull()
    expect(new Uint8Array(fs.readFileSync(teamIconFile(dir)))).toEqual(uploaded)
    expect(fs.readdirSync(dir)).toEqual(['team-icon'])
    fs.rmSync(teamIconFile(dir))
    const set = saveTeamIconIfAbsent(dir, makePng(200, 200), 'image/png')!
    expect(readTeamIcon(dir)?.version).toBe(set.version)
    expect(fs.readdirSync(dir)).toEqual(['team-icon'])
    // something that is no logo is never stored
    fs.rmSync(teamIconFile(dir))
    expect(saveTeamIconIfAbsent(dir, new Uint8Array(SVG), 'image/png')).toBeNull()
    expect(fs.existsSync(teamIconFile(dir))).toBe(false)
    // the undo of an older version leaves a newer logo
    const a = saveTeamIconIfAbsent(dir, makePng(200, 200), 'image/png')!
    fs.writeFileSync(teamIconFile(dir), uploaded)
    expect(removeTeamIcon(dir, a.version)).toBe('stale')
    // the newer logo is back in place as it was, and nothing is left aside
    expect(new Uint8Array(fs.readFileSync(teamIconFile(dir)))).toEqual(uploaded)
    expect(fs.readdirSync(dir)).toEqual(['team-icon'])
    expect(removeTeamIcon(dir, readTeamIcon(dir)!.version)).toBe(true)
    expect(removeTeamIcon(dir, a.version)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('the onboarding press and the admin button (a team server)', () => {
  let h: Harness
  let web: ReturnType<typeof Bun.serve>
  let slow = 0
  const port = () => web.port
  const site = (p = '/') => `http://www.acme.example:${port()}${p}`
  const icon = pngOf(192, 192, (x, y) => (Math.hypot(x - 96, y - 96) < 60 ? [255, 255, 255] : [14, 94, 78]))
  const net = { testAllow: (ip: string) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }] }
  beforeAll(async () => {
    web = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const u = new URL(req.url)
      const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '')
      if (host === 'www.acme.example') {
        if (u.pathname === '/') {
          if (slow) await Bun.sleep(slow)
          return new Response(page('<link rel="apple-touch-icon" sizes="192x192" href="/touch.png"><meta property="og:image" content="/og.png">'), { headers: { 'content-type': 'text/html' } })
        }
        if (u.pathname === '/touch.png') return new Response(icon, { headers: { 'content-type': 'image/png' } })
      }
      return new Response('nothing', { status: 404 })
    } })
    h = await startHarness({ name: 'b-site-icon', fetch: { ...net, timeoutMs: 3000 } })
    // the rules alone here (the team's AI help: b-site-icon-ai.test.ts)
    setSiteIconNetForTests(h.ctx, { net, ai: false })
  })
  afterAll(async () => { setSiteIconNetForTests(h?.ctx, null); await h?.close(); web?.stop(true) })

  const me = async () => (await h.api('dana').call(API.me)).team.iconVersion ?? null
  /** a website reading's draft chat of the owner, its first page given to the collector as web_fetch would */
  async function readSite(siteIcon = true): Promise<string> {
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    h.ctx.db.query("INSERT INTO onboarding_profile_drafts (chat_id, user_id, source, website, site, created_at) VALUES (?, 'dana', 'website', ?, 'acme.example', ?)").run(chat.id, site(), new Date(Date.now() + Math.random()).toISOString())
    const c = new BrandCollector(h.ctx.db, chat.id, { dataDir: h.ctx.engineConfig.dataDir, log: h.ctx.log, inScope: () => true, siteIcon })
    const html = page('<link rel="apple-touch-icon" sizes="192x192" href="/touch.png">', '<p>Acme makes quiet desk fans for small offices since 2019.</p>')
    c.page({ url: site(), title: 'Acme', text: 'Acme makes quiet desk fans for small offices since 2019.', html }, net)
    await c.idle()
    return chat.id
  }
  const audits = () => h.ctx.db.query("SELECT action, detail FROM audit_log WHERE action LIKE 'team_icon.%' ORDER BY rowid").all() as { action: string; detail: string }[]

  test('a shared platform\'s page stages nothing; a company site stages its square icon (shown as assets.icon)', async () => {
    const shared = await readSite(false)
    expect(stagedSiteIcon(h.ctx.engineConfig.dataDir, shared)).toBeNull()
    const chat = await readSite()
    const staged = stagedSiteIcon(h.ctx.engineConfig.dataDir, chat)!
    expect(staged.url).toBe(site('/touch.png'))
    expect(checkTeamIcon(staged.bytes, imageInfo(staged.bytes)!.type).ok).toBe(true)
    expect((await h.api('dana').call(API.getProfileDraft, { params: { chatId: chat } })).assets?.icon).toBe(true)
  })

  test('저장하고 계속: sets it when the team has no logo, says so once (teamIcon), undo removes only that version; used once', async () => {
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://www.acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [] } })
    expect(await me()).toBeNull()
    const r = await h.api('dana').call(API.welcomeBrand, { body: { files: [] } })
    expect(r.teamIcon?.version).toMatch(/^[0-9a-f]{16}$/)
    expect(await me()).toBe(r.teamIcon!.version)
    const set = audits().at(-1)!
    expect(set.action).toBe('team_icon.set')
    expect(JSON.parse(set.detail)).toMatchObject({ source: 'site', url: site('/touch.png'), before: null })
    // the undo of another version is refused and keeps the logo; its own version removes it
    expect((await h.req('dana', '/api/admin/team-icon?version=0123456789abcdef', { method: 'DELETE' })).status).toBe(409)
    expect(await me()).toBe(r.teamIcon!.version)
    expect((await h.req('dana', `/api/admin/team-icon?version=${r.teamIcon!.version}`, { method: 'DELETE' })).status).toBe(204)
    expect(await me()).toBeNull()
    expect(audits().at(-1)!.action).toBe('team_icon.remove')
    // a 고치기 save later: the staged icon was used, the undo stays undone
    expect((await h.api('dana').call(API.welcomeBrand, { body: { files: [] } })).teamIcon).toBeNull()
    expect(await me()).toBeNull()
  })

  test('a logo already there is never replaced by the press (and the staged icon is used up)', async () => {
    const chat = await readSite()
    expect(stagedSiteIcon(h.ctx.engineConfig.dataDir, chat)).not.toBeNull()
    const put = await h.req('dana', '/api/admin/team-icon?type=image%2Fpng', { method: 'PUT', body: makePng(100, 100, [9, 9, 9]), headers: { 'content-type': 'application/octet-stream' } })
    expect(put.status).toBe(200)
    const uploaded = await put.json() as { version: string }
    const r = await h.api('dana').call(API.welcomeBrand, { body: { files: [] } })
    expect(r.teamIcon).toBeNull()
    expect(await me()).toBe(uploaded.version)
    expect(stagedSiteIcon(h.ctx.engineConfig.dataDir, chat)).toBeNull()
  })

  test('admin button: members refused, not while the exit address is unknown, the saved website only, replaces an uploaded logo, one at a time, "not found" in plain words', async () => {
    const post = (who: string) => h.req(who, '/api/admin/team-icon/from-site', { method: 'POST' })
    expect((await post('alice')).status).toBe(403)
    setSiteIconNetForTests(h.ctx, { net, site: () => site(), ai: false })
    // the server does not know its own public address yet: refused, nothing fetched
    const notReady = await post('carol')
    expect(notReady.status).toBe(503)
    expect((await notReady.json()).error).toMatchObject({ params: { reason: 'not_ready' }, message: '서버가 아직 준비 중이에요. 잠시 후 다시 눌러 주세요.' })
    noteEgressIp(h.ctx, '203.0.113.9')
    const before = await me()
    const ok = await post('carol')
    expect(ok.status).toBe(200)
    const info = await ok.json() as { version: string }
    expect(info.version).not.toBe(before)
    expect(await me()).toBe(info.version)
    expect(JSON.parse(audits().at(-1)!.detail)).toMatchObject({ source: 'site', url: site('/touch.png'), before })
    // a request cannot name another address: the body is ignored, the saved website is read
    expect((await h.req('carol', '/api/admin/team-icon/from-site', { method: 'POST', body: JSON.stringify({ url: 'http://169.254.169.254/' }), headers: { 'content-type': 'application/json' } })).status).toBe(200)
    // one at a time
    slow = 1500
    const [a, b] = await Promise.all([post('carol'), (async () => { await Bun.sleep(200); return post('dana') })()])
    slow = 0
    expect([a.status, b.status].sort()).toEqual([200, 409])
    // nothing usable: one plain line
    setSiteIconNetForTests(h.ctx, { net, site: () => `http://nothing.example:${port()}/`, ai: false })
    const none = await post('carol')
    expect(none.status).toBe(404)
    expect((await none.json()).error).toMatchObject({ params: { reason: 'not_found' }, message: '홈페이지에서 쓸 만한 아이콘을 찾지 못했어요. 로고 파일을 올려 주세요.' })
    // no website saved: says so
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: '', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [] } })
    const noSite = await post('carol')
    expect(noSite.status).toBe(409)
    expect((await noSite.json()).error.params).toEqual({ reason: 'no_website' })
  })
})
