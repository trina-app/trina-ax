// The tab icon and the team logo (shared/src/team-icon.ts, src/lib/team-icon.ts): the product's icon files and links
// of the app shell, which signing in leaves alone whatever logo the team has (since 2026-11-07 the logo shows only in
// the computer's sidebar header; docs/DECISIONS.md), and the checks before uploading a team logo.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { imageInfo, TEAM_ICON_MAX_BYTES, type TeamIconProblem } from '@mycel/shared'
import type { Me } from '@mycel/shared/api'
import { checkIconFile } from '../../src/lib/team-icon'
import { DICTS } from '../../src/i18n'
import { applyTheme } from '../../src/lib/theme'
import { useSession } from '../../src/store/session'
import { makeJpeg, makePng, makeWebp, SVG } from '../../../tests/lib/images'
import { installDom, removeDom } from './dom-host'

const WEB = path.resolve(import.meta.dir, '../..')
const PUBLIC = path.join(WEB, 'public')

/** the product's icon links of web/index.html, in order: PNG tab icons, the SVG last for browsers that take it, the
 * home-screen icon */
const PRODUCT_LINKS = [
  { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/icons/favicon-16.png' },
  { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
  { rel: 'icon', type: 'image/png', sizes: '48x48', href: '/icons/favicon-48.png' },
  { rel: 'icon', type: 'image/svg+xml', sizes: 'any', href: '/favicon.svg' },
  { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
]
const linkTags = (html: string) =>
  [...html.matchAll(/<link\s+rel="(icon|apple-touch-icon)"([^>]*)>/g)].map((m) => {
    const attr = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(m[2]!)?.[1]
    return { rel: m[1]!, ...(attr('type') ? { type: attr('type') } : {}), ...(attr('sizes') ? { sizes: attr('sizes') } : {}), href: attr('href')! }
  })

describe('the product\'s icon', () => {
  test('index.html links exactly the product\'s icons, never the team logo', () => {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
    expect(linkTags(html)).toEqual(PRODUCT_LINKS)
    expect(html).not.toContain('/team-icon')
  })
  test('every link points at a file of the build, PNGs at the size they say', () => {
    for (const l of PRODUCT_LINKS) {
      const file = path.join(PUBLIC, l.href)
      expect({ href: l.href, exists: fs.existsSync(file) }).toEqual({ href: l.href, exists: true })
      if (l.type === 'image/png') {
        const n = Number(l.sizes!.split('x')[0])
        expect(imageInfo(new Uint8Array(fs.readFileSync(file)))).toEqual({ type: 'image/png', width: n, height: n })
      }
    }
  })
  test('favicon.ico is a real ICO with the 16, 32 and 48 pixel PNGs', () => {
    const b = fs.readFileSync(path.join(PUBLIC, 'favicon.ico'))
    expect([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)]).toEqual([0, 1, 3])
    const sizes: number[] = []
    for (let i = 0; i < 3; i++) {
      const e = 6 + 16 * i
      const size = b.readUInt32LE(e + 8)
      const offset = b.readUInt32LE(e + 12)
      const png = new Uint8Array(b.subarray(offset, offset + size))
      expect(imageInfo(png)).toEqual({ type: 'image/png', width: b[e]!, height: b[e + 1]! })
      expect(png).toEqual(new Uint8Array(fs.readFileSync(path.join(PUBLIC, 'icons', `favicon-${b[e]}.png`))))
      sizes.push(b[e]!)
    }
    expect(sizes).toEqual([16, 32, 48])
  })
})

describe('signing in leaves the page\'s icon links alone', () => {
  const me = (team: Record<string, unknown>): Me => ({
    user: { id: 'alice', username: 'alice', name: 'Alice', email: null, role: 'member', locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: {} },
    team: { name: 'Acme', defaultLocale: 'en', ...team }, groups: [],
    session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' },
    server: { version: 'test', dev: true },
  } as Me)
  const links = () => [...document.head.querySelectorAll('link')].map((l) => `${l.getAttribute('rel')} ${l.getAttribute('href')}`)

  beforeEach(() => {
    installDom()
    // the theme, applied with it on sign-in, toggles a class the fake document has no list for
    const html = document.documentElement as unknown as { classList?: unknown }
    html.classList ??= { toggle() {} }
    for (const l of PRODUCT_LINKS) {
      const el = document.createElement('link')
      for (const [k, v] of Object.entries(l)) el.setAttribute(k, v)
      document.head.appendChild(el)
    }
  })
  afterEach(() => {
    applyTheme('system')
    useSession.setState({ status: { kind: 'loading' } })
    removeDom()
  })

  test('no logo, a logo, and a logo from an older server that still says appIcon: the product\'s links stay', () => {
    const before = links()
    expect(before).toEqual(PRODUCT_LINKS.map((l) => `${l.rel} ${l.href}`))
    for (const team of [{ iconVersion: null }, { iconVersion: '0123456789abcdef' }, { iconVersion: 'fedcba9876543210', appIcon: true }, {}]) {
      useSession.getState().signedIn(me(team))
      expect({ team, links: links() }).toEqual({ team, links: before })
    }
  })
})

describe('checks before uploading a logo', () => {
  const file = (b: Uint8Array<ArrayBuffer>, type: string) => new Blob([b], { type })
  test('PNG, JPEG and WebP of a fitting size pass', async () => {
    expect(await checkIconFile(file(makePng(180, 180), 'image/png'))).toEqual({ ok: true, type: 'image/png', width: 180, height: 180 })
    expect(await checkIconFile(file(makeJpeg(512, 512), 'image/jpeg'))).toMatchObject({ ok: true, type: 'image/jpeg' })
    expect(await checkIconFile(file(makeWebp(64, 64, 'VP8L'), 'image/webp'))).toMatchObject({ ok: true, type: 'image/webp' })
  })
  test('refused, each with its own words in every language', async () => {
    const cases: [Blob, TeamIconProblem][] = [
      [file(SVG, 'image/svg+xml'), 'type'],
      [file(makePng(64, 64), ''), 'type'],
      [file(makeJpeg(64, 64), 'image/png'), 'mismatch'],
      [file(new Uint8Array(TEAM_ICON_MAX_BYTES + 1), 'image/png'), 'too_big'],
      [file(makePng(20, 20), 'image/png'), 'too_small'],
      [file(makeWebp(5000, 100), 'image/webp'), 'too_large'],
    ]
    for (const [f, problem] of cases) {
      expect(await checkIconFile(f)).toEqual({ ok: false, problem })
      for (const [l, d] of Object.entries(DICTS)) expect({ l, problem, has: `teamIcon.problem.${problem}` in d }).toEqual({ l, problem, has: true })
    }
  })
})
