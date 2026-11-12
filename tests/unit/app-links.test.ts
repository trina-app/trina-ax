// The files that let a tapped team link open the phone app (server/src/routes/app-links.ts, shared/src/app-links.ts):
// public, JSON, no redirect, the same for everyone, and the app ids are the edition's.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { APP_LINKS, appleAppSiteAssociation, assetLinks } from '../../shared/src/app-links'
import { harness, type Harness } from './a-lib'

setDefaultTimeout(30_000)
const ROOT = path.join(import.meta.dir, '../..')
const branding = JSON.parse(fs.readFileSync(path.join(ROOT, 'editions/trina/branding/mobile.json'), 'utf8')) as { scheme: string; bundleId: string; appleTeamId: string }

describe('the app ids come from the branding', () => {
  test('iOS <team>.<bundle id>, the Android package, the link scheme', () => {
    expect(APP_LINKS.iosAppIds).toEqual([`${branding.appleTeamId}.${branding.bundleId}`])
    expect(APP_LINKS.androidPackage).toBe(branding.bundleId)
    expect(String(PRODUCT.linkScheme)).toBe(branding.scheme)
  })
  test('the iOS file opens the app for invite links and the team link only', () => {
    const f = appleAppSiteAssociation()
    expect(f.applinks.details).toHaveLength(1)
    expect(f.applinks.details[0]!.components.map((c) => [c['/'], (c as { '#'?: string })['#'] ?? null])).toEqual([['/invite/*', null], ['/join', 't=*']])
  })
  test('the Android file needs a valid certificate fingerprint; a malformed one is never served', () => {
    expect(assetLinks({ ...APP_LINKS, androidCertSha256: [] })).toBeNull()
    expect(assetLinks({ ...APP_LINKS, androidCertSha256: ['not-a-print'] })).toBeNull()
    const print = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')
    expect(assetLinks({ ...APP_LINKS, androidCertSha256: [print] })).toEqual([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'app.trina.ax', sha256_cert_fingerprints: [print] } }])
  })
})

describe('served by every team server', () => {
  let h: Harness
  beforeAll(async () => { h = await harness('app-links') })
  afterAll(() => h.close())
  test('signed out, through the relay or directly: JSON with no redirect and no cookie', async () => {
    for (const via of ['relay', 'direct'] as const) {
      const r = await h.fetch('/.well-known/apple-app-site-association', { via, redirect: 'manual' })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/json')
      expect(r.headers.get('set-cookie')).toBeNull()
      expect(await r.json()).toEqual(appleAppSiteAssociation())
    }
  })
  test('assetlinks.json is 200 with the upload key\'s fingerprint, in the standard Digital Asset Links shape', async () => {
    expect(APP_LINKS.androidCertSha256).toContain('6F:9C:90:4B:59:83:9C:1C:F4:9C:95:95:77:EE:01:FE:78:02:63:35:CC:32:F8:FB:79:CA:F3:BA:08:C9:CA:7A')
    for (const via of ['relay', 'direct'] as const) {
      const r = await h.fetch('/.well-known/assetlinks.json', { via, redirect: 'manual' })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/json')
      expect(r.headers.get('set-cookie')).toBeNull()
      expect(await r.json()).toEqual([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'app.trina.ax', sha256_cert_fingerprints: [...APP_LINKS.androidCertSha256] } }])
    }
  })
})

describe("Apple's Smart App Banner on the join pages", () => {
  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
  let dist = ''
  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(import.meta.dir, '.tmp-banner-'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>')
  })
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }))
  const get = async (p: string, ua: string) => {
    const { serveWeb } = await import('../../server/src/routes/web-static')
    const res = serveWeb(new Request(`https://acme.trina.app${p}`, { headers: { 'user-agent': ua } }), { dist, dev: false, devPort: 0 })!
    return { res, html: await res.text() }
  }
  test('the App Store id is the listing\'s; no app-argument ever', async () => {
    const { appStoreId, smartAppBanner } = await import('../../shared/src/app-links')
    expect(appStoreId('https://apps.apple.com/app/trina-ax/id6829192435?platform=iphone')).toBe('6829192435')
    expect(appStoreId('https://apps.apple.com/app/id6829192435')).toBe('6829192435')
    for (const bad of ['', 'https://evil.example/app/id6829192435', 'http://apps.apple.com/app/id6829192435', 'https://apps.apple.com/app/trina-ax']) expect(appStoreId(bad)).toBeNull()
    expect(smartAppBanner('https://apps.apple.com/app/trina-ax/id6829192435?platform=iphone')).toBe('<meta name="apple-itunes-app" content="app-id=6829192435" />')
    expect(smartAppBanner('')).toBeNull()
  })
  test('an iPhone gets it on an invite and on the team link, with no token in it', async () => {
    for (const p of [`/invite/${TOKEN}`, '/join']) {
      const { res, html } = await get(p, IPHONE)
      expect(html).toContain('<meta name="apple-itunes-app" content="app-id=6829192435" />')
      expect(html).not.toContain('app-argument')
      expect(html).not.toContain(TOKEN)
      expect(res.headers.get('vary')).toBe('User-Agent')
      expect(res.headers.get('content-security-policy')).toBeTruthy()
    }
  })
  test('computers and Android get the page as before; other pages never get it', async () => {
    for (const ua of [MAC, ANDROID]) expect((await get(`/invite/${TOKEN}`, ua)).html).not.toContain('apple-itunes-app')
    for (const p of ['/', '/login', '/settings', `/reset-password/${TOKEN}`, '/invite', `/invite/${TOKEN}/x`]) expect((await get(p, IPHONE)).html).not.toContain('apple-itunes-app')
  })
  test('the page with the banner follows a new build', async () => {
    const first = (await get('/join', IPHONE)).html
    expect((await get('/join', IPHONE)).html).toBe(first)
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>new build</title></head><body></body></html>')
    const next = (await get('/join', IPHONE)).html
    expect(next).toContain('new build')
    expect(next).toContain('apple-itunes-app')
  })
})
