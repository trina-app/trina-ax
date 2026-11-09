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
