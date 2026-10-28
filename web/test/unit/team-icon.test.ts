// The tab icon (shared/src/team-icon.ts, src/lib/team-icon.ts): the default icon files and links of the app shell, the
// links the page switches to after sign-in, and the checks before uploading a team logo.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ICON_LINKS_END, ICON_LINKS_START, iconLinks, iconLinksHtml, imageInfo, TEAM_ICON_MAX_BYTES, type TeamIconProblem } from '@mycel/shared'
import { checkIconFile, nextIconLinks } from '../../src/lib/team-icon'
import { DICTS } from '../../src/i18n'
import { makeJpeg, makePng, makeWebp, SVG } from '../../../tests/lib/images'

const WEB = path.resolve(import.meta.dir, '../..')
const PUBLIC = path.join(WEB, 'public')

describe('the default icon', () => {
  test('index.html carries exactly the default links between the markers (the server swaps that block)', () => {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
    const a = html.indexOf(ICON_LINKS_START)
    const z = html.indexOf(ICON_LINKS_END)
    expect(a).toBeGreaterThan(0)
    expect(html.slice(a + ICON_LINKS_START.length, z).trim()).toBe(iconLinksHtml(iconLinks(null)).trim())
    // no other icon link outside the block (it would stay behind when a logo is set)
    expect((html.slice(0, a) + html.slice(z)).match(/rel="(icon|apple-touch-icon)"/g)).toBeNull()
  })
  test('every default link points at a file of the build, PNGs at the size they say', () => {
    for (const l of iconLinks(null)) {
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

describe('the links after sign-in', () => {
  const defaults = iconLinks(null)
  test('an older server (no iconVersion) leaves the page alone; links already right are not touched', () => {
    expect(nextIconLinks(defaults, undefined)).toBeNull()
    expect(nextIconLinks(defaults, null)).toBeNull()
    expect(nextIconLinks(iconLinks('0123456789abcdef'), '0123456789abcdef')).toBeNull()
  })
  test('a logo: tab and home-screen icon point at /team-icon?v=…; removed: the default links again', () => {
    expect(nextIconLinks(defaults, '0123456789abcdef')).toEqual([
      { rel: 'icon', href: '/team-icon?v=0123456789abcdef' },
      { rel: 'apple-touch-icon', href: '/team-icon?v=0123456789abcdef' },
    ])
    expect(nextIconLinks(iconLinks('0123456789abcdef'), 'fedcba9876543210')?.[0]?.href).toBe('/team-icon?v=fedcba9876543210')
    expect(nextIconLinks(iconLinks('0123456789abcdef'), null)).toEqual(defaults)
    // a page whose links were changed some other way is put right
    expect(nextIconLinks(defaults.slice(1), null)).toEqual(defaults)
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
