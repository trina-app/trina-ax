// The Windows app installs a downloaded update only when the product's signed release names it
// (desktop/src/common/update-verify.ts, shared/src/release-manifest.ts; owner decision 2026-11-11): the signature with a
// baked key, the product, the channel, the version, no downgrade, the installer's SHA-256; where the manifest is looked
// for; when the check may be skipped. The team server side (the manifest next to the installer) is in
// office-update.test.ts and g-windows-app.test.ts.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RELEASE_CHANNEL } from '@mycel/shared'
import { openSignedManifest, releaseKeyId } from '@mycel/shared/release-manifest'
import { fileUrl, OFFICE_PRODUCT, publicKeyOf, signRelease, type OfficeRelease } from '../../server/src/office/release'
import { placeSignedManifest } from '../../server/src/office/update'
import { serveDownload } from '../../server/src/routes/downloads'
import { manifestSources, verificationRequired, verifyInstaller } from '../../desktop/src/common/update-verify'
import { WORK } from '../lib/env'

const FEED = 'https://updates.example.test'
const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
const otherPem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
const KEYS = [publicKeyOf(pem)]
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const EXE = crypto.randomBytes(4096)
const NAME = 'Team-AX-Setup-0.3.0-win-x64.exe'

function release(over: Partial<OfficeRelease> = {}, exe: Uint8Array = EXE): OfficeRelease {
  const version = over.version ?? '0.3.0'
  const zip = new Uint8Array([1, 2, 3])
  return {
    format: 1, product: OFFICE_PRODUCT, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: new Date().toISOString(), notes: '',
    office: [{ arch: 'universal', file: 'x.zip', url: fileUrl(FEED, version, 'x.zip'), sha256: sha(zip), size: 3 }],
    windows: {
      version,
      installer: { file: NAME, url: fileUrl(FEED, version, NAME), sha256: sha(exe), size: exe.byteLength },
      latestYml: { file: 'latest.yml', url: fileUrl(FEED, version, 'latest.yml'), sha256: sha('y'), size: 1 },
    },
    ...over,
  }
}
const check = (manifest: string, over: Partial<Parameters<typeof verifyInstaller>[0]> = {}) =>
  verifyInstaller({ manifest, installerSha256: sha(EXE), channel: 'stable', version: '0.3.0', current: '0.2.5', keys: KEYS, product: OFFICE_PRODUCT, ...over })

describe('the Windows app checks a downloaded update against the signed release', () => {
  test('a release signed with a baked key that names this installer: ok', () => {
    const v = check(signRelease(release(), pem))
    expect(v).toEqual({ ok: true, keyId: releaseKeyId(Buffer.from(KEYS[0]!, 'base64')) })
    // the hash may come in capitals
    expect(check(signRelease(release(), pem), { installerSha256: sha(EXE).toUpperCase() }).ok).toBe(true)
  })

  test('another key, a changed payload, a broken signature, plain JSON, a build without keys: refused', () => {
    expect(check(signRelease(release(), otherPem))).toEqual({ ok: false, reason: expect.stringMatching(/unknown key/) })
    const env = JSON.parse(signRelease(release(), pem))
    const tampered = { ...env, payload: env.payload.replace(sha(EXE), sha('evil')) }
    expect(check(JSON.stringify(tampered), { installerSha256: sha('evil') })).toEqual({ ok: false, reason: expect.stringMatching(/does not verify/) })
    const sig = Buffer.from(env.sig, 'base64')
    sig[0] = sig[0]! ^ 1
    expect(check(JSON.stringify({ ...env, sig: sig.toString('base64') })).ok).toBe(false)
    expect(check(JSON.stringify({ ...env, sig: 'x' })).ok).toBe(false)
    expect(check(JSON.stringify(release()))).toEqual({ ok: false, reason: expect.stringMatching(/not a signed manifest/) })
    expect(check('not json').ok).toBe(false)
    expect(check(signRelease(release(), pem), { keys: [] })).toEqual({ ok: false, reason: 'no release key in this build' })
  })

  test('the downloaded installer must be the one the signed release names', () => {
    expect(check(signRelease(release(), pem), { installerSha256: sha('another program') })).toEqual({ ok: false, reason: expect.stringMatching(/not the one the signed release names/) })
    expect(check(signRelease(release({ windows: null }), pem))).toEqual({ ok: false, reason: expect.stringMatching(/no Windows app/) })
  })

  test('the channel, the version and the product must match', () => {
    expect(check(signRelease(release({ channel: 'beta' }), pem))).toEqual({ ok: false, reason: expect.stringMatching(/stable manifest is a beta release/) })
    expect(check(signRelease(release({ channel: 'beta' }), pem), { channel: 'beta' }).ok).toBe(true)
    // latest.yml says 0.3.1, the signed release names 0.3.0
    expect(check(signRelease(release(), pem), { version: '0.3.1' })).toEqual({ ok: false, reason: expect.stringMatching(/names the Windows app 0.3.0, not 0.3.1/) })
    // another product (an edition's release with a shared key) is not this app's
    expect(check(signRelease(release(), pem), { product: 'other-office' })).toEqual({ ok: false, reason: expect.stringMatching(/not other-office/) })
  })

  test('never a downgrade or the same version again', () => {
    expect(check(signRelease(release(), pem), { current: '0.3.0' })).toEqual({ ok: false, reason: expect.stringMatching(/not newer/) })
    expect(check(signRelease(release(), pem), { current: '0.4.0' }).ok).toBe(false)
    // a release is newer than its own pre-release
    expect(check(signRelease(release(), pem), { current: '0.3.0-beta.4' }).ok).toBe(true)
  })

  test('the build trusts the release channel\'s keys by default (an edition sets its own at build time)', () => {
    expect(RELEASE_CHANNEL.keys.length).toBeGreaterThan(0)
    // our test key is not one of them: a release signed with it is refused without an explicit key list
    expect(verifyInstaller({ manifest: signRelease(release(), pem), installerSha256: sha(EXE), channel: 'stable', version: '0.3.0', current: '0.2.5' }).ok).toBe(false)
    expect(openSignedManifest(signRelease(release(), pem), KEYS).ok).toBe(true)
  })
})

describe('where the Windows app looks for the signed release', () => {
  test('the team server first (offline offices), then the feed\'s copy of that version, then the channel head', () => {
    expect(manifestSources('https://acme.example.test/downloads/', '0.3.0', FEED, 'office').map((s) => `${s.team ? 'team' : 'feed'} ${s.channel} ${s.url}`)).toEqual([
      'team stable https://acme.example.test/downloads/stable.json',
      'team beta https://acme.example.test/downloads/beta.json',
      `feed stable ${FEED}/office/0.3.0/stable.json`,
      `feed beta ${FEED}/office/0.3.0/beta.json`,
      `feed stable ${FEED}/office/stable.json`,
      `feed beta ${FEED}/office/beta.json`,
    ])
    // a pre-release is tried as beta first
    expect(manifestSources('https://acme.example.test/downloads/', '0.4.0-beta.2', FEED, 'office')[0]!.channel).toBe('beta')
    // a version that is not a release version is never put into a feed path
    expect(manifestSources('https://acme.example.test/downloads/', '../../x', FEED, 'office').some((s) => s.url.includes('..'))).toBe(false)
    expect(manifestSources('https://acme.example.test/downloads/', '0.3.0')[2]!.url).toBe(`${RELEASE_CHANNEL.feed}/${RELEASE_CHANNEL.officeDir}/0.3.0/stable.json`)
  })

  test('a packaged app always checks; only a development run may skip it', () => {
    expect(verificationRequired(true, KEYS, {})).toBe(true)
    expect(verificationRequired(true, KEYS, { MYCEL_DESKTOP_UPDATE_UNVERIFIED: '1' })).toBe(true)
    expect(verificationRequired(true, [], {})).toBe(true)
    expect(verificationRequired(false, KEYS, {})).toBe(true)
    expect(verificationRequired(false, KEYS, { MYCEL_DESKTOP_UPDATE_UNVERIFIED: '1' })).toBe(false)
    expect(verificationRequired(false, [], {})).toBe(false)
  })
})

describe('the team server keeps the signed release next to the installer', () => {
  test('<channel>.json is written, replaced, the other channel\'s removed, and served', async () => {
    const dir = path.join(WORK, 'office-update-desktop', 'downloads')
    fs.rmSync(path.dirname(dir), { recursive: true, force: true })
    const stable = signRelease(release(), pem)
    placeSignedManifest(dir, { channel: 'stable', text: stable })
    expect(fs.readFileSync(path.join(dir, 'stable.json'), 'utf8')).toBe(stable)
    expect(fs.statSync(path.join(dir, 'stable.json')).mode & 0o777).toBe(0o600)
    const r = serveDownload(new Request('http://x/downloads/stable.json'), '/stable.json', dir)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe(stable)
    // the server moved to beta: beta.json in, stable.json out; no temporary file left
    const beta = signRelease(release({ channel: 'beta' }), pem)
    placeSignedManifest(dir, { channel: 'beta', text: beta })
    expect(fs.readdirSync(dir).sort()).toEqual(['beta.json'])
    expect(serveDownload(new Request('http://x/downloads/stable.json'), '/stable.json', dir).status).toBe(404)
    // nothing to place: nothing changes
    placeSignedManifest(dir, undefined)
    expect(fs.readdirSync(dir)).toEqual(['beta.json'])
    // other json files are still not served
    fs.writeFileSync(path.join(dir, 'other.json'), '{}')
    expect(serveDownload(new Request('http://x/downloads/other.json'), '/other.json', dir).status).toBe(404)
  })
})
