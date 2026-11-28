// The Lightsail team image (trina-cloud docs/research/lightsail-paid-teams.md §6.2): the presigned R2 URLs, the signed
// manifest and its publish beside the AMI (scripts/image/lightsail-feed.ts), the prune rules, the launch script of
// scripts/image/build-lightsail.sh (a dry run) and the image files for a late data disk (§6.3).
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkLsManifest, lsManifestName, presign, publishLightsail, r2Delete, r2Get, selectLsPrune } from '../../scripts/image/lightsail-feed'
import { dirStore } from '../../scripts/release/publish-server'

const ROOT = path.resolve(import.meta.dir, '../..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lightsail-test-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PUB = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64')
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
let n = 0

describe('presign (SigV4 query)', () => {
  test('the AWS S3 example "GET object, presigned URL"', () => {
    const url = presign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', expires: 86400,
      creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, now: new Date('2013-05-24T00:00:00Z') })
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
  })
  test('a session token is signed; expiry is bounded', () => {
    const url = presign({ method: 'PUT', url: 'https://a.r2.cloudflarestorage.com/b/ci/lightsail-build/x/result.txt', region: 'auto', expires: 60, creds: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T/K' } })
    expect(url).toContain('X-Amz-Security-Token=T%2FK')
    // the launch script quotes it in single quotes: only these characters
    expect(url).toMatch(/^https:\/\/[A-Za-z0-9._~:/?=&%-]+$/)
    expect(() => presign({ method: 'GET', url: 'https://a/b', region: 'auto', expires: 604801, creds: { accessKeyId: 'A', secretAccessKey: 'S' } })).toThrow()
  })
  test('R2 calls stay under ci/lightsail-build/', async () => {
    const t = { endpoint: 'https://a.r2.cloudflarestorage.com', bucket: 'b', creds: { accessKeyId: 'A', secretAccessKey: 'S' },
      fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch }
    expect(await r2Get(t, 'ci/lightsail-build/x/result.txt')).toBeNull()
    await r2Delete(t, 'ci/lightsail-build/x/result.txt')
    await expect(r2Get(t, 'server/0.5.20/release.json')).rejects.toThrow('not under')
    await expect(r2Delete(t, 'ci/lightsail-build/../server/x')).rejects.toThrow('not under')
  })
})

/** a manifest as build-lightsail.sh writes it, with its .sha256 and a .sig of the test key */
function manifest(o: { version?: string; tv?: string; patch?: Record<string, unknown>; badSig?: boolean } = {}): string {
  const version = o.version ?? '0.5.20'
  const tv = o.tv ?? `${version}-d13-20261201`
  const dir = path.join(T, `m${++n}`); fs.mkdirSync(dir)
  const f = path.join(dir, lsManifestName(tv))
  const m = { v: 1, kind: 'lightsail', templateVersion: tv, region: 'ap-northeast-2', snapshotName: `teamax-${tv}`, fromBundleId: 'medium_3_0',
    blueprintId: 'debian_13', blueprintVersion: '13.7', kitVersion: version, builtAt: '2026-12-01T00:00:00Z', ...o.patch }
  fs.writeFileSync(f, JSON.stringify(m) + '\n')
  const s = sha(fs.readFileSync(f))
  fs.writeFileSync(`${f}.sha256`, `${s}  ${path.basename(f)}\n`)
  const sig = crypto.sign(null, Buffer.from(`ax-template-v1\n${o.badSig ? 'other' : tv}\n${s}`), privateKey).toString('base64')
  fs.writeFileSync(`${f}.sig`, sig)
  return f
}

describe('the Lightsail manifest', () => {
  test('a good one passes, with the fields hostd reads', () => {
    const m = checkLsManifest('0.5.20', manifest(), [PUB])
    expect(m).toMatchObject({ v: 1, kind: 'lightsail', region: 'ap-northeast-2', snapshotName: 'teamax-0.5.20-d13-20261201', fromBundleId: 'medium_3_0' })
  })
  test('refused: wrong key, other release, other kind, other snapshot name, a changed byte', () => {
    expect(() => checkLsManifest('0.5.20', manifest(), [Buffer.alloc(32, 7).toString('base64')])).toThrow('.sig')
    expect(() => checkLsManifest('0.5.20', manifest({ badSig: true }), [PUB])).toThrow('.sig')
    expect(() => checkLsManifest('0.5.21', manifest(), [PUB])).toThrow('not one of release')
    expect(() => checkLsManifest('0.5.20', manifest({ patch: { kind: 'ami' } }), [PUB])).toThrow('not a v1 Lightsail')
    expect(() => checkLsManifest('0.5.20', manifest({ patch: { snapshotName: 'teamax-other' } }), [PUB])).toThrow('snapshotName')
    expect(() => checkLsManifest('0.5.20', manifest({ patch: { kitVersion: '0.5.19' } }), [PUB])).toThrow('has kit')
    const f = manifest(); fs.chmodSync(f, 0o644); fs.appendFileSync(f, ' ')
    expect(() => checkLsManifest('0.5.20', f, [PUB])).toThrow('.sha256')
  })
  test('publish: three files beside the AMI, again = there, other bytes = refused', async () => {
    const feed = path.join(T, `feed${++n}`)
    const store = dirStore(feed, 'https://127.0.0.1:1')
    const f = manifest()
    const r = await publishLightsail({ version: '0.5.20', manifest: f, store, keys: [PUB], log: () => {} })
    expect(r.status).toBe('published')
    const name = path.basename(f)
    expect(r.uploaded).toEqual([`server/0.5.20/${name}.sha256`, `server/0.5.20/${name}.sig`, `server/0.5.20/${name}`])
    expect(fs.readFileSync(path.join(feed, 'server/0.5.20', name)).equals(fs.readFileSync(f))).toBe(true)
    expect((await publishLightsail({ version: '0.5.20', manifest: f, store, keys: [PUB], log: () => {} })).status).toBe('there')
    await expect(publishLightsail({ version: '0.5.20', manifest: manifest({ patch: { builtAt: '2026-12-02T00:00:00Z' } }), store, keys: [PUB], log: () => {} })).rejects.toThrow('never replaced')
    // team-image.json is the AMI's: never written here
    expect(fs.existsSync(path.join(feed, 'server/0.5.20/team-image.json'))).toBe(false)
  })
})

describe('prune (the rules of ami-prune.sh)', () => {
  const now = new Date('2026-12-30T00:00:00Z')
  const snap = (v: string, day: string, more: { key: string; value: string }[] = [], state = 'available') => ({
    name: `teamax-${v}-d13-${day.replace(/-/g, '')}`, createdAt: Date.parse(`${day}T00:00:00Z`) / 1000, state,
    tags: [{ key: 'ax:managed', value: 'image' }, { key: 'ax:built-by', value: 'release-ci' }, { key: 'ax:template', value: `${v}-d13-${day.replace(/-/g, '')}` }, ...more],
  })
  const snaps = ['0.5.10', '0.5.11', '0.5.12', '0.5.13', '0.5.14', '0.5.15', '0.5.16'].map((v, i) => snap(v, `2026-11-0${i + 1}`))
  test('keeps the newest 5, the in-use template, ax:keep; never a snapshot that is not the CI\'s', () => {
    const out = selectLsPrune({
      snapshots: [...snaps, { name: 'drjarvis-relay-seoul-1-final', createdAt: 1, state: 'available', tags: [] }, snap('0.5.9', '2026-10-01', [{ key: 'ax:keep', value: 'true' }])],
      instances: [{ name: 'ls-kr1t-01J-g1', tags: [{ key: 'ax:managed', value: 'ls-kr1' }, { key: 'ax:template', value: 'teamax-0.5.10-d13-20261101'.slice(7) }] }],
      keepReleases: 5, minAgeDays: 14, protectTemplates: [], now,
    })
    const act = Object.fromEntries(out.map((d) => [d.id, d.action]))
    expect(act['teamax-0.5.16-d13-20261107']).toBe('keep')
    expect(act['teamax-0.5.12-d13-20261103']).toBe('keep')
    expect(act['teamax-0.5.11-d13-20261102']).toBe('remove')
    expect(act['teamax-0.5.10-d13-20261101']).toBe('keep') // a team runs it: hostd's replace path needs it
    expect(act['teamax-0.5.9-d13-20261001']).toBe('keep')
    expect(act['drjarvis-relay-seoul-1-final']).toBeUndefined()
  })
  test('young, protected or not available = keep', () => {
    const out = selectLsPrune({ snapshots: [snap('0.5.1', '2026-12-25'), snap('0.5.2', '2026-01-01', [], 'pending'), snap('0.5.3', '2026-01-01'), snap('0.5.0', '2026-01-01')],
      instances: [], keepReleases: 1, minAgeDays: 14, protectTemplates: ['0.5.3-d13-20260101'], now })
    const act = Object.fromEntries(out.map((d) => [d.id, d.action]))
    expect(act['teamax-0.5.1-d13-20261225']).toBe('keep')
    expect(act['teamax-0.5.2-d13-20260101']).toBe('keep')
    expect(act['teamax-0.5.3-d13-20260101']).toBe('keep')
    expect(act['teamax-0.5.0-d13-20260101']).toBe('remove')
  })
})

describe('build-lightsail.sh --dry-run (no AWS session: placeholders)', () => {
  test('the launch script is POSIX sh, pins the stage sha256, and starts the guest after cloud-final', () => {
    const out = path.join(T, `dry${++n}`)
    const env = { ...process.env, AWS_CONFIG_FILE: path.join(T, 'none'), AWS_SHARED_CREDENTIALS_FILE: path.join(T, 'none'), AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: '', AWS_EC2_METADATA_DISABLED: 'true' }
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/image/build-lightsail.sh'), '--dry-run', '--allow-missing-kit', '--template-version', '0.0.0-kitless-d13-20261128', '--out', out], { env, encoding: 'utf8', timeout: 120_000 })
    if (r.status !== 0) throw new Error(`build-lightsail.sh failed:\n${r.stdout}\n${r.stderr}`)
    const launch = fs.readFileSync(path.join(out, 'lightsail-launch-0.0.0-kitless-d13-20261128.dry-run.sh'), 'utf8')
    expect(launch).not.toContain('#cloud-config')
    expect(launch).not.toMatch(/^#!/m) // Lightsail's own #!/bin/sh comes first
    expect(launch).toMatch(/echo '[0-9a-f]{64} {2}\/root\/ax-build\/stage\.tgz' \| sha256sum -c/)
    expect(launch).toContain('--property=After=cloud-final.service')
    expect(launch).toContain('lightsail-guest.sh')
    const dash = spawnSync('sh', ['-n', path.join(out, 'lightsail-launch-0.0.0-kitless-d13-20261128.dry-run.sh')])
    expect(dash.status).toBe(0)
    expect(r.stderr).toContain('lightsail create-instances')
    expect(r.stderr).toContain('key=ax:managed\\,value=image-build')
    expect(r.stderr).toContain('create-instance-snapshot')
    expect(r.stderr).toContain('key=ax:managed\\,value=image ')
    const m = JSON.parse(fs.readFileSync(path.join(out, 'teamax-0.0.0-kitless-d13-20261128.lightsail.json.dry-run'), 'utf8'))
    expect(m).toMatchObject({ v: 1, kind: 'lightsail', snapshotName: 'teamax-0.0.0-kitless-d13-20261128', fromBundleId: 'medium_3_0', blueprintId: 'debian_13' })
  }, 150_000)
})

describe('the image: a data disk that arrives late (§6.3)', () => {
  test('customize.sh installs the udev rule; the mount unit stays not enabled', () => {
    const c = fs.readFileSync(path.join(ROOT, 'scripts/image/customize.sh'), 'utf8')
    expect(c).toContain('put_file "$FILES/99-axdata-mount.rules" /etc/udev/rules.d/99-axdata-mount.rules 0644')
    expect(c).not.toMatch(/svc_enable var-lib-mycel\.mount/)
    const rule = fs.readFileSync(path.join(ROOT, 'scripts/image/files/99-axdata-mount.rules'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    expect(rule).toEqual(['ACTION=="add", SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="axdata", ENV{ID_FS_TYPE}=="ext4", ENV{SYSTEMD_WANTS}+="var-lib-mycel.mount"'])
    const mount = fs.readFileSync(path.join(ROOT, 'scripts/image/files/var-lib-mycel.mount'), 'utf8')
    expect(mount).toContain('Where=/var/lib/mycel')
    expect(mount).toContain('nofail')
    expect(mount).not.toContain('[Install]')
  })
})
