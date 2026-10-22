// Component G: release bundles, staging, signatures, the release feed, and root/bootstrap's health check and
// roll-back (native/cmd/mycel-bootstrap) with fake server versions.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppState } from '@mycel/shared/install'
import { silentLogger } from '../../server/src/log'
import { packBundle, publicKeyB64, signManifest, writeManifest } from '../../server/src/system/bundle'
import { compareVersions, UpdateManager, verifyBundleDir } from '../../server/src/system/update'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-update')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })
const BOOTSTRAP = path.resolve(import.meta.dir, '..', '..', 'native', 'bin', `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'mycel-bootstrap')
// a free port per run, not a fixed one: a fake server left over from a killed run (or a second run at the same time)
// answering /api/health on it made every later run fail at the first step
const PORT = (() => { const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const p = l.port; l.stop(true); return p })()

/** A fake server version: bin/bun (wrapper around the real bun) + server/src/main.js with a chosen behaviour. */
async function fakeVersion(appDir: string, v: string, behaviour: 'ok' | 'crash' | 'unhealthy', extra: Record<string, string> = {}) {
  const dir = path.join(appDir, 'versions', v)
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'server', 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'bin', 'bun'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'server', 'src', 'main.js'), `
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync(process.env.MYCEL_CONFIG, 'utf8'))
const B = ${JSON.stringify(behaviour)}, V = ${JSON.stringify(v)}
if (B === 'crash') process.exit(3)
// the bootstrap puts the server in its own process group, so killing the test run (or afterAll's SIGKILL) leaves it
// running: exit once the bootstrap that started it is gone
const parent = process.ppid
setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 500)
Bun.serve({ hostname: '127.0.0.1', port: cfg.listen.port, fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/exit') { setTimeout(() => process.exit(0), 30); return new Response('bye') }
  return Response.json({ ok: B === 'ok', version: V, mode: process.env.MYCEL_MODE })
} })
process.on('SIGTERM', () => process.exit(0))
`)
  for (const [k, c] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), c) }
  await writeManifest(dir, v)
  return dir
}

describe('versions and signatures', () => {
  test('version order', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    // the installer decides switch / older with this: pre-release numbers compare as numbers (rc.10 after rc.9)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1)
    expect(compareVersions('0.9.0-test.4', '0.9.0-test.12')).toBe(-1)
    expect(compareVersions('1.0.0-rc-2', '1.0.0-rc-1')).toBe(1)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0+build.5', '1.0.0+build.7')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  test('manifest check catches changed, extra, missing files and symlinks; signatures need a known key', async () => {
    const app = path.join(W, 'verify')
    const dir = await fakeVersion(app, '1.0.0', 'ok')
    await expect(verifyBundleDir(dir, { keys: [], allowUnsigned: true })).resolves.toMatchObject({ version: '1.0.0' })
    await expect(verifyBundleDir(dir, { keys: [], allowUnsigned: false })).rejects.toThrow(/not signed/)
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await signManifest(dir, pem)
    await expect(verifyBundleDir(dir, { keys: [publicKeyB64(pem)], allowUnsigned: false })).resolves.toBeTruthy()
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await expect(verifyBundleDir(dir, { keys: [publicKeyB64(other)], allowUnsigned: false })).rejects.toThrow(/signature/)
    // tampering after signing
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    m.files['server/src/main.js'].size += 1
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m))
    await expect(verifyBundleDir(dir, { keys: [publicKeyB64(pem)], allowUnsigned: false })).rejects.toThrow(/signature/)

    const d2 = await fakeVersion(app, '1.0.1', 'ok')
    fs.appendFileSync(path.join(d2, 'server', 'src', 'main.js'), '\n// evil')
    await expect(verifyBundleDir(d2, { keys: [], allowUnsigned: true })).rejects.toThrow(/changed since release/)
    const d3 = await fakeVersion(app, '1.0.2', 'ok')
    fs.writeFileSync(path.join(d3, 'server', 'extra.js'), 'x')
    await expect(verifyBundleDir(d3, { keys: [], allowUnsigned: true })).rejects.toThrow(/not in manifest/)
    const d4 = await fakeVersion(app, '1.0.3', 'ok')
    fs.rmSync(path.join(d4, 'bin', 'bun'))
    await expect(verifyBundleDir(d4, { keys: [], allowUnsigned: true })).rejects.toThrow(/missing/)
    const d5 = await fakeVersion(app, '1.0.4', 'ok')
    fs.symlinkSync('/etc/passwd', path.join(d5, 'server', 'link'))
    await expect(verifyBundleDir(d5, { keys: [], allowUnsigned: true })).rejects.toThrow(/symlink/)
  })
})

describe('update manager', () => {
  test('stage a packed bundle, report it as available, switch with pending state; dev has no updates', async () => {
    const app = path.join(W, 'mgr', 'app')
    fs.mkdirSync(path.join(app, 'versions'), { recursive: true })
    const src = path.join(W, 'mgr', 'build', '2.0.0')
    fs.mkdirSync(path.dirname(src), { recursive: true })
    await fakeVersion(path.join(W, 'mgr', 'build-app'), '2.0.0', 'ok', { 'RELEASE_NOTES.md': '새 기능', 'server/migrations/900_x.sql': '-- min_compatible_reader: 7\n' })
    fs.renameSync(path.join(W, 'mgr', 'build-app', 'versions', '2.0.0'), src)
    const archive = path.join(W, 'mgr', 'b.tar.zst')
    await packBundle(src, archive)
    fs.mkdirSync(path.join(app, 'versions', '1.0.0'))
    fs.symlinkSync('versions/1.0.0', path.join(app, 'current'))
    const u = new UpdateManager({ appDir: app, dataDir: path.join(W, 'mgr', 'data'), version: '1.0.0', channel: 'stable', feedUrl: null, log: silentLogger })
    const m = await u.stage(archive)
    expect(m.version).toBe('2.0.0')
    expect(fs.statSync(path.join(app, 'versions', '2.0.0', 'bin', 'bun')).mode & 0o111).toBeTruthy()
    const s = u.status()
    expect(s.available).toMatchObject({ version: '2.0.0', notes: '새 기능', needsBackupRestoreToRollBack: true })
    expect(s.previous).toBeNull()
    expect(await u.stage(archive)).toMatchObject({ version: '2.0.0' }) // idempotent
    const r = await u.switchTo('2.0.0')
    expect(r).toEqual({ from: '1.0.0', to: '2.0.0' })
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('versions/2.0.0')
    const st = AppState.parse(JSON.parse(fs.readFileSync(path.join(app, 'state.json'), 'utf8')))
    expect(st).toMatchObject({ pending: '2.0.0', previous: '1.0.0', attempts: 0 })
    await expect(u.switchTo('9.9.9')).rejects.toThrow(/not staged/)
    // a version is a folder name, never a path: a verified bundle outside versions/ cannot become app/current
    await fakeVersion(path.join(W, 'mgr', 'outside'), 'evil', 'ok')
    await expect(u.switchTo('../../outside/versions/evil')).rejects.toThrow(/not a version name/)
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('versions/2.0.0')

    const dev = new UpdateManager({ appDir: null, dataDir: path.join(W, 'mgr', 'data'), version: '1.0.0', channel: 'stable', feedUrl: null, log: silentLogger })
    expect(dev.status()).toMatchObject({ current: '1.0.0', available: null, previous: null })
    await expect(dev.stage(archive)).rejects.toThrow(/installed/)
  })

  test('release feed: signed feed accepted, unsigned or wrongly signed refused, bundle hash checked', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const key = publicKeyB64(pem)
    const build = path.join(W, 'feed', 'build-app')
    const dir = await fakeVersion(build, '3.0.0', 'ok')
    await signManifest(dir, pem)
    const archive = path.join(W, 'feed', '3.0.0.tar.zst')
    const packed = await packBundle(dir, archive)
    const os = process.platform === 'darwin' ? 'darwin' : process.platform
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const feed = { version: '3.0.0', publishedAt: new Date().toISOString(), notes: 'n', bundles: [{ os, arch, url: 'https://releases.test/3.0.0.tar.zst', sha256: packed.sha256, size: packed.size }] }
    const feedBytes = Buffer.from(JSON.stringify(feed))
    let sig = JSON.stringify({ keyId: crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 16), sig: crypto.sign(null, feedBytes, privateKey).toString('base64') })
    const fakeFetch = (async (url: string) => {
      if (url.endsWith('.json')) return new Response(feedBytes)
      if (url.endsWith('.json.sig')) return new Response(sig)
      if (url.endsWith('.tar.zst')) return new Response(Bun.file(archive))
      return new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    const app = path.join(W, 'feed', 'app')
    fs.mkdirSync(path.join(app, 'versions'), { recursive: true })
    const mk = (keys: string[]) => new UpdateManager({ appDir: app, dataDir: path.join(W, 'feed', 'data'), version: '2.0.0', channel: 'stable', feedUrl: 'https://releases.test/stable.json', log: silentLogger, keys, allowUnsigned: false, fetch: fakeFetch })
    expect(await mk([]).checkFeed()).toBeNull() // no release key in the build: remote updates disabled
    const u = mk([key])
    const f = await u.checkFeed()
    expect(f?.version).toBe('3.0.0')
    expect(u.status().available?.version).toBe('3.0.0')
    expect(u.status().lastCheckedAt).not.toBeNull()
    const m = await u.download(f!)
    expect(m.version).toBe('3.0.0')
    expect(fs.existsSync(path.join(app, 'versions', '3.0.0', 'manifest.sig'))).toBe(true)
    // a bad signature on the feed
    sig = JSON.stringify({ keyId: JSON.parse(sig).keyId, sig: Buffer.alloc(64).toString('base64') })
    expect(await u.checkFeed()).toBeNull()
    // a bundle that does not match the announced hash
    await expect(u.download({ ...f!, version: '3.0.1', bundles: [{ ...f!.bundles[0]!, sha256: '0'.repeat(64) }] })).rejects.toThrow(/hash/)
  })
})

describe('bootstrap (native/cmd/mycel-bootstrap)', () => {
  const app = path.join(W, 'boot', 'app')
  const cfgFile = path.join(W, 'boot', 'server.json')
  let proc: ReturnType<typeof Bun.spawn> | null = null
  afterAll(() => { proc?.kill('SIGKILL') })
  const health = async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as { ok: boolean; version: string; mode: string } } catch { return null } }
  const state = () => AppState.parse(JSON.parse(fs.readFileSync(path.join(app, 'state.json'), 'utf8')))
  async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (ok(v)) return v
      if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`)
      await Bun.sleep(100)
    }
  }
  const mgr = (running: string) => new UpdateManager({ appDir: app, dataDir: path.join(W, 'boot', 'data'), version: running, channel: 'stable', feedUrl: null, log: silentLogger })
  const exitServer = () => fetch(`http://127.0.0.1:${PORT}/exit`).catch(() => {})

  test('starts the verified version, applies an update, rolls back crashing / unhealthy / tampered versions', async () => {
    expect(fs.existsSync(BOOTSTRAP)).toBe(true)
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(cfgFile, JSON.stringify({ listen: { host: '127.0.0.1', port: PORT } }))
    await fakeVersion(app, '1.0.0', 'ok')
    fs.symlinkSync('versions/1.0.0', path.join(app, 'current'))
    proc = Bun.spawn([BOOTSTRAP, '--app', app, '--config', cfgFile, '--allow-unsigned', '--health-timeout', '4s', '--update-log', path.join(W, 'boot', 'update.log')], { stdout: 'ignore', stderr: 'ignore' })
    const h1 = await until(health, (h) => h?.version === '1.0.0')
    expect(h1!.mode).toBe('prod')
    expect(state().current).toBe('1.0.0')

    // a good update: the server switches app/current and exits; the bootstrap starts and confirms the new version
    await fakeVersion(app, '2.0.0', 'ok')
    await mgr('1.0.0').switchTo('2.0.0')
    await exitServer()
    await until(health, (h) => h?.version === '2.0.0')
    await until(state, (s) => s.pending === null)
    expect(state()).toMatchObject({ current: '2.0.0', previous: '1.0.0' })
    expect(state().history.at(-1)).toMatchObject({ to: '2.0.0', result: 'ok' })

    // a version that crashes at start: 3 attempts, then back to 2.0.0
    await fakeVersion(app, '3.0.0', 'crash')
    await mgr('2.0.0').switchTo('3.0.0')
    await exitServer()
    await until(state, (s) => s.history.at(-1)?.result === 'rolled_back')
    await until(health, (h) => h?.version === '2.0.0')
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('versions/2.0.0')
    expect(state()).toMatchObject({ current: '2.0.0', pending: null })

    // a version that runs but never reports healthy: rolled back after the health timeout
    await fakeVersion(app, '4.0.0', 'unhealthy')
    await mgr('2.0.0').switchTo('4.0.0')
    await exitServer()
    await until(health, (h) => h?.version === '4.0.0')
    await until(health, (h) => h?.version === '2.0.0', 15_000)
    expect(state().history.at(-1)).toMatchObject({ from: '4.0.0', to: '2.0.0', result: 'rolled_back' })

    // a version whose files changed after release: never started
    await fakeVersion(app, '5.0.0', 'ok')
    await mgr('2.0.0').switchTo('5.0.0')
    fs.appendFileSync(path.join(app, 'versions', '5.0.0', 'server', 'src', 'main.js'), '\n// tampered')
    await exitServer()
    await until(state, (s) => s.history.at(-1)?.to === '2.0.0' && /verify failed/.test(s.history.at(-1)?.detail ?? ''))
    await until(health, (h) => h?.version === '2.0.0')
    expect(fs.readFileSync(path.join(W, 'boot', 'update.log'), 'utf8')).toContain('rolled_back')

    // SIGTERM stops the server and the bootstrap
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
    await until(health, (h) => h === null)
    proc = null
  }, 60_000)
})
