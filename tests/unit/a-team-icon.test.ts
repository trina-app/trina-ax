// The team logo as the tab icon (Admin › Team settings; shared/src/team-icon.ts, server/src/admin/team-icon.ts,
// routes/web-static.ts): what an upload must be, who may set it, and that /team-icon, /favicon.ico, the manifest and
// index.html's icon links follow it, with the default icon back after removing it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { checkTeamIcon, ICON_LINKS_END, ICON_LINKS_START, iconLinks, iconLinksHtml, imageInfo, TEAM_ICON_MAX_BYTES, withIconLinks } from '@mycel/shared'
import { TEXT } from '../../server/src/admin/team-icon'
import { WORK } from '../lib/env'
import { makeJpeg, makePng, makeWebp, SVG } from '../lib/images'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const WEB = path.resolve(import.meta.dir, '../../web')
const DIST = path.join(WORK, 'a-team-icon-dist')
const ICON_CSP = "default-src 'none'; sandbox"

let h: Harness
let owner: Client
let admin: Client
let member: Client
const saved = process.env.MYCEL_WEB_DIST

beforeAll(async () => {
  // a build as the server serves it: index.html with the icon block, the manifest, the default icons
  fs.rmSync(DIST, { recursive: true, force: true })
  fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true })
  fs.writeFileSync(path.join(DIST, 'index.html'), fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace(/__PRODUCT_[A-Z_]+__/g, 'Team'))
  fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), fs.readFileSync(path.join(WEB, 'pwa', 'manifest.webmanifest'), 'utf8').replace(/__PRODUCT_[A-Z_]+__/g, 'Team'))
  fs.cpSync(path.join(WEB, 'public'), DIST, { recursive: true })
  process.env.MYCEL_WEB_DIST = DIST
  h = await harness('team-icon')
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  member = (await addMember(h, owner, { username: 'mia' })).client
})
afterAll(async () => {
  await h?.close()
  if (saved === undefined) delete process.env.MYCEL_WEB_DIST
  else process.env.MYCEL_WEB_DIST = saved
})

function put(c: Client | null, bytes: Uint8Array<ArrayBuffer>, type: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'x-mycel-csrf': '1', 'content-type': 'application/octet-stream', ...extra }
  if (c?.cookie) headers.cookie = c.cookie
  return h.fetch(`/api/admin/team-icon?type=${encodeURIComponent(type)}`, { method: 'PUT', headers, body: bytes })
}
const get = (p: string, headers: Record<string, string> = {}) => h.fetch(p, { headers })
const version = async (c: Client) => (await c.call('GET', '/api/me')).team.iconVersion as string | null
const iconFile = () => path.join(h.ctx.config.dataDir, 'team-icon')
const auditActions = async () => ((await owner.call('GET', '/api/admin/audit?source=admin&limit=200')).items as { action: string; actor: { id: string } | null; detail: Record<string, unknown> | null }[]).filter((e) => e.action.startsWith('team_icon.'))
const bytesOf = async (r: Response) => new Uint8Array(await r.arrayBuffer())
function expectIconHeaders(r: Response, type: string) {
  expect(r.headers.get('content-type')).toBe(type)
  expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  expect(r.headers.get('content-security-policy')).toBe(ICON_CSP)
  expect(r.headers.get('content-disposition')).toBe('inline')
}

describe('reading an image header (shared/src/team-icon.ts)', () => {
  test('PNG, JPEG (with segments and fill bytes before the frame) and the three WebP kinds', () => {
    expect(imageInfo(makePng(200, 100))).toEqual({ type: 'image/png', width: 200, height: 100 })
    expect(imageInfo(makeJpeg(640, 480))).toEqual({ type: 'image/jpeg', width: 640, height: 480 })
    expect(imageInfo(makeJpeg(300, 200, 0xc2))).toEqual({ type: 'image/jpeg', width: 300, height: 200 }) // progressive
    for (const kind of ['VP8X', 'VP8 ', 'VP8L'] as const) expect(imageInfo(makeWebp(512, 256, kind))).toEqual({ type: 'image/webp', width: 512, height: 256 })
  })
  test('anything else is no image: SVG, GIF, HTML, a cut-off header, a JPEG without a frame', () => {
    for (const b of [SVG, new TextEncoder().encode('GIF89a' + 'x'.repeat(40)), new TextEncoder().encode('<!doctype html><title>x</title>'), makePng(64, 64).slice(0, 20), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), new Uint8Array()]) {
      expect(imageInfo(b)).toBeNull()
    }
  })
  test('the checks, in order: type, size, first bytes, pixel size', () => {
    expect(checkTeamIcon(makePng(64, 64), 'image/png')).toEqual({ ok: true, type: 'image/png', width: 64, height: 64 })
    expect(checkTeamIcon(makePng(64, 64), 'IMAGE/PNG; x=1')).toMatchObject({ ok: true })
    expect(checkTeamIcon(SVG, 'image/svg+xml')).toEqual({ ok: false, problem: 'type' })
    expect(checkTeamIcon(makePng(64, 64), 'image/gif')).toEqual({ ok: false, problem: 'type' })
    expect(checkTeamIcon(makeJpeg(64, 64), 'image/png')).toEqual({ ok: false, problem: 'mismatch' })
    expect(checkTeamIcon(SVG, 'image/png')).toEqual({ ok: false, problem: 'mismatch' })
    expect(checkTeamIcon(makePng(31, 64), 'image/png')).toEqual({ ok: false, problem: 'too_small' })
    expect(checkTeamIcon(makeWebp(4097, 64), 'image/webp')).toEqual({ ok: false, problem: 'too_large' })
    expect(checkTeamIcon(makePng(32, 32), 'image/png')).toMatchObject({ ok: true })
    expect(checkTeamIcon(makeJpeg(4096, 4096), 'image/jpeg')).toMatchObject({ ok: true })
  })
  test('the icon block of index.html: swapped between the markers, left alone without them', () => {
    const html = `<head>\n    ${ICON_LINKS_START}\n${iconLinksHtml(iconLinks(null))}\n    ${ICON_LINKS_END}\n</head>`
    const out = withIconLinks(html, iconLinks('0123456789abcdef'))
    expect(out).toContain('<link rel="icon" href="/team-icon?v=0123456789abcdef" />')
    expect(out).toContain('<link rel="apple-touch-icon" href="/team-icon?v=0123456789abcdef" />')
    expect(out).not.toContain('favicon')
    expect(withIconLinks(out, iconLinks(null))).toBe(html)
    expect(withIconLinks('<head></head>', iconLinks('0123456789abcdef'))).toBe('<head></head>')
  })
})

describe('uploads that are refused', () => {
  test('signed out: 401; a member: 403; nothing is stored', async () => {
    expect((await put(null, makePng(64, 64), 'image/png')).status).toBe(401)
    expect((await put(member, makePng(64, 64), 'image/png')).status).toBe(403)
    expect((await member.try('DELETE', '/api/admin/team-icon')).status).toBe(403)
    expect(fs.existsSync(iconFile())).toBe(false)
  })
  const refused = async (bytes: Uint8Array<ArrayBuffer>, type: string, status: number, reason: string, extra?: Record<string, string>) => {
    const r = await put(admin, bytes, type, extra)
    const body = (await r.json()) as { error: { code: string; message: string; params?: Record<string, unknown> } }
    expect({ type, status: r.status, reason: body.error.params?.reason }).toEqual({ type, status, reason })
    expect(body.error.message).toBe(TEXT[reason as keyof typeof TEXT].ko) // the admin follows the team language (ko)
  }
  test('wrong type and SVG (by its type or dressed up as a PNG)', async () => {
    await refused(new TextEncoder().encode('GIF89a' + 'x'.repeat(40)), 'image/gif', 400, 'type')
    await refused(SVG, 'image/svg+xml', 400, 'type')
    await refused(SVG, 'image/png', 400, 'mismatch')
    await refused(makePng(64, 64), 'text/html', 400, 'type')
  })
  test('a type that lies about the first bytes', async () => {
    await refused(makeJpeg(64, 64), 'image/png', 400, 'mismatch')
    await refused(makePng(64, 64), 'image/webp', 400, 'mismatch')
    await refused(new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'image/jpeg', 400, 'mismatch')
  })
  test('more than 1 MiB (said up front or only sent), under 32 or over 4096 pixels a side', async () => {
    const big = new Uint8Array(TEAM_ICON_MAX_BYTES + 1)
    big.set(makePng(64, 64))
    await refused(big, 'image/png', 413, 'too_big')
    const r = await h.fetch('/api/admin/team-icon?type=image%2Fpng', {
      method: 'PUT', headers: { cookie: admin.cookie!, 'x-mycel-csrf': '1' },
      body: new ReadableStream({ start(c) { c.enqueue(big.slice(0, 600_000)); c.enqueue(big.slice(600_000)); c.close() } }),
    })
    expect(r.status).toBe(413)
    await refused(makePng(31, 64), 'image/png', 400, 'too_small')
    await refused(makePng(64, 16), 'image/png', 400, 'too_small')
    await refused(makeJpeg(4097, 300), 'image/jpeg', 400, 'too_large')
    await refused(makeWebp(300, 5000), 'image/webp', 400, 'too_large')
  })
  test('after all that: still the default icon, no audit entry', async () => {
    expect(await version(owner)).toBeNull()
    expect(fs.existsSync(iconFile())).toBe(false)
    expect(await auditActions()).toEqual([])
    const r = await get('/team-icon')
    expect(r.status).toBe(200)
    expectIconHeaders(r, 'image/png')
    expect(await bytesOf(r)).toEqual(new Uint8Array(fs.readFileSync(path.join(DIST, 'icons', 'icon-512.png'))))
  })
})

describe('a logo set by an admin', () => {
  const logo = makePng(256, 256)
  let v = ''
  test('stored in the data folder (not the team folder), named by the start of its hash', async () => {
    const before = h.hub.events.length
    const r = await put(admin, logo, 'image/png')
    expect(r.status).toBe(200)
    const info = (await r.json()) as { version: string; type: string; width: number; height: number; size: number }
    expect(info).toMatchObject({ type: 'image/png', width: 256, height: 256, size: logo.byteLength })
    expect(info.version).toMatch(/^[0-9a-f]{16}$/)
    v = info.version
    expect(new Uint8Array(fs.readFileSync(iconFile()))).toEqual(logo)
    expect((fs.statSync(iconFile()).mode & 0o777).toString(8)).toBe('600')
    expect(iconFile().startsWith(h.ctx.config.teamRoot)).toBe(false)
    // everyone's windows hear it and ask GET /api/me again
    expect(h.hub.events.slice(before)).toContainEqual({ kind: 'publish', target: '*', data: { type: 'notice', data: { level: 'info', code: 'team_icon_changed', message: '' } } })
    expect(await version(member)).toBe(v)
    expect(await version(owner)).toBe(v)
  })
  test('audited: who, and what the file is', async () => {
    const [e] = await auditActions()
    expect(e!.action).toBe('team_icon.set')
    expect(e!.actor?.id).toBe('adam')
    expect(e!.detail).toMatchObject({ version: v, type: 'image/png', width: 256, height: 256, before: null })
  })
  test('GET /team-icon serves those bytes to anyone, with the image-only headers; long cache only at its version', async () => {
    const r = await get(`/team-icon?v=${v}`) // no session: the sign-in page shows it too
    expect(r.status).toBe(200)
    expectIconHeaders(r, 'image/png')
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(r.headers.get('etag')).toBe(`"${v}"`)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('last-modified')).toBeNull()
    expect(await bytesOf(r)).toEqual(logo)
    for (const p of ['/team-icon', '/team-icon?v=0000000000000000']) {
      const s = await get(p)
      expect(s.headers.get('cache-control')).toBe('public, max-age=300')
      expect(await bytesOf(s)).toEqual(logo)
    }
    const again = await get('/team-icon', { 'if-none-match': `"${v}"` })
    expect(again.status).toBe(304)
  })
  test('/favicon.ico and /apple-touch-icon.png are the logo too', async () => {
    for (const p of ['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
      const r = await get(p)
      expect({ p, status: r.status }).toEqual({ p, status: 200 })
      expectIconHeaders(r, 'image/png')
      expect(await bytesOf(r)).toEqual(logo)
    }
  })
  test('index.html points its icon links at it from the first load (any page, signed in or not)', async () => {
    for (const p of ['/', '/login', '/admin/settings', '/index.html']) {
      const html = await (await get(p)).text()
      expect(html).toContain(`<link rel="icon" href="/team-icon?v=${v}" />`)
      expect(html).toContain(`<link rel="apple-touch-icon" href="/team-icon?v=${v}" />`)
      expect(html).not.toContain('/favicon.svg')
      expect(html).toContain('<div id="root">')
    }
  })
  test('the manifest of an installed app (PWA) has it as its only icon, the rest as built', async () => {
    const r = await get('/manifest.webmanifest')
    expect(r.headers.get('content-type')).toBe('application/manifest+json')
    const m = (await r.json()) as { name: string; start_url: string; icons: unknown[] }
    expect(m.icons).toEqual([{ src: `/team-icon?v=${v}`, sizes: '256x256', type: 'image/png', purpose: 'any' }])
    expect(m.start_url).toBe('/')
    expect(m.name).toBe('Team')
  })
  test('replaced by a JPEG: a new version and type', async () => {
    const jpeg = makeJpeg(400, 400)
    const info = (await (await put(owner, jpeg, 'image/jpeg')).json()) as { version: string }
    expect(info.version).not.toBe(v)
    const r = await get(`/team-icon?v=${info.version}`)
    expectIconHeaders(r, 'image/jpeg')
    expect(await bytesOf(r)).toEqual(jpeg)
    expect((await auditActions())[0]!.detail).toMatchObject({ type: 'image/jpeg', before: v })
    v = info.version
  })
})

describe('removing it brings the default back', () => {
  test('DELETE: the default icon, links, ICO and manifest; audited once', async () => {
    const r = await admin.try('DELETE', '/api/admin/team-icon')
    expect(r.status).toBe(204)
    expect(fs.existsSync(iconFile())).toBe(false)
    expect(await version(member)).toBeNull()
    const icon = await get('/team-icon')
    expectIconHeaders(icon, 'image/png')
    expect(await bytesOf(icon)).toEqual(new Uint8Array(fs.readFileSync(path.join(DIST, 'icons', 'icon-512.png'))))
    // /favicon.ico is the ICO of the build, an icon and never the app page
    const ico = await get('/favicon.ico')
    expect(ico.status).toBe(200)
    expect(ico.headers.get('content-type')).not.toContain('text/html')
    expect([...(await bytesOf(ico)).slice(0, 4)]).toEqual([0, 0, 1, 0])
    const html = await (await get('/')).text()
    const block = html.slice(html.indexOf(ICON_LINKS_START), html.indexOf(ICON_LINKS_END))
    expect(block).toContain(iconLinksHtml(iconLinks(null)))
    expect(html).not.toContain('/team-icon')
    const m = (await (await get('/manifest.webmanifest')).json()) as { icons: { src: string }[] }
    expect(m.icons.map((i) => i.src)).toEqual(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'])
    const acts = await auditActions()
    expect(acts[0]).toMatchObject({ action: 'team_icon.remove', actor: { id: 'adam' }, detail: { before: expect.stringMatching(/^[0-9a-f]{16}$/) } })
    // nothing to remove: fine, and no second entry
    expect((await admin.try('DELETE', '/api/admin/team-icon')).status).toBe(204)
    expect((await auditActions()).length).toBe(acts.length)
  })
  test('a file there that is not a logo we accept (an SVG put by hand) counts as none', async () => {
    fs.writeFileSync(iconFile(), SVG)
    expect(await version(owner)).toBeNull()
    const r = await get('/team-icon')
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(await r.text()).not.toContain('<script>')
    fs.rmSync(iconFile())
  })
})

describe('icon-like and other missing files are never the app page', () => {
  test('a missing file with an extension: 404 text; app pages still get the shell', async () => {
    for (const p of ['/favicon.png', '/apple-touch-icon-120x120.png', '/robots.txt', '/icon.svg', '/browserconfig.xml']) {
      const r = await get(p)
      expect({ p, status: r.status }).toEqual({ p, status: 404 })
      expect(r.headers.get('content-type')).not.toContain('text/html')
    }
    for (const p of ['/c/0192f0a0-0000-7000-8000-000000000000', '/admin/settings', '/invite/abc_DEF-123', '/files?path=a.pdf']) {
      const r = await get(p)
      expect({ p, status: r.status }).toEqual({ p, status: 200 })
      expect(await r.text()).toContain('<div id="root">')
    }
  })
})
