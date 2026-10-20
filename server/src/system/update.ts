// Updates without root (design tab 6 "업데이트"). Component G.
//
// A release bundle is a .tar.zst of one version folder: bin/bun, server/ (bundled main.js + migrations), native/,
// web/, manifest.json (sha256 of every file) and, for real releases, manifest.sig (Ed25519, offline release key).
// Staging unpacks it into app/versions/.staging-*, verifies it exactly like root/bootstrap will, and renames it to
// app/versions/<version>. Switching writes app/state.json {previous: <running>, pending: <new>}, points app/current
// at the new folder and restarts; the bootstrap starts the new version, waits for /api/health, and rolls back to
// `previous` when the new version does not come up (it also refuses versions whose files changed since release).
// The DB is never rolled back automatically (tab 6): migrations are additive, a release that is not readable by the
// previous version says so (needsBackupRestoreToRollBack) and then roll-back means restoring the pre-update backup.
//
// Release feed: https://releases.<domain>/<channel>.json + .sig. No release key exists yet (owner/infra, see
// docs/WORKPLAN.md "막힌 것"), so remote feeds are refused until keys are configured; locally staged bundles work.
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { UpdateStatus } from '@mycel/shared/api'
import { AppState, BundleManifest, BundleSignature, emptyAppState } from '@mycel/shared/install'
import { SCHEMA_READER_LEVEL } from '../db'
import type { Logger } from '../log'
import { readFileChunks, writeAtomic, zstdDecompress } from './streams'
import { extractTar } from './tar'

/** Ed25519 release public keys (base64, raw 32 bytes): current + spare. Empty until the release key is made. */
export const RELEASE_PUBLIC_KEYS: readonly string[] = []

export class UpdateError extends Error { name = 'UpdateError' }

export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const [main, pre] = v.split('-', 2) as [string, string | undefined]; return { nums: main.split('.').map((x) => parseInt(x, 10) || 0), pre } }
  const x = split(a), y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre < y.pre ? -1 : 1
}

export const keyId = (pubRaw: Uint8Array) => crypto.createHash('sha256').update(pubRaw).digest('hex').slice(0, 16)

function ed25519Key(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, 'base64')
  if (raw.length !== 32) throw new UpdateError('release key must be 32 bytes')
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
}

/** Verify an Ed25519 signature file ({keyId, sig}) over `data` against the given keys. */
export function verifySignature(data: Uint8Array, sigJson: string, keys: readonly string[]): boolean {
  const s = BundleSignature.parse(JSON.parse(sigJson))
  for (const k of keys) {
    if (keyId(Buffer.from(k, 'base64')) !== s.keyId) continue
    return crypto.verify(null, data, ed25519Key(k), Buffer.from(s.sig, 'base64'))
  }
  return false
}

export interface VerifyOptions { keys: readonly string[]; allowUnsigned: boolean }

/** The same checks root/bootstrap makes before it starts a version (native/cmd/mycel-bootstrap). */
export async function verifyBundleDir(dir: string, o: VerifyOptions): Promise<BundleManifest> {
  const raw = await fsp.readFile(path.join(dir, 'manifest.json'))
  const m = BundleManifest.parse(JSON.parse(raw.toString('utf8')))
  const sigFile = path.join(dir, 'manifest.sig')
  if (fs.existsSync(sigFile)) {
    if (o.keys.length || !o.allowUnsigned) {
      if (!verifySignature(raw, await fsp.readFile(sigFile, 'utf8'), o.keys)) throw new UpdateError('release signature does not verify')
    }
  } else if (!o.allowUnsigned) {
    throw new UpdateError('bundle is not signed')
  }
  const seen = new Set<string>()
  async function walk(rel: string) {
    for (const d of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name
      if (r === 'manifest.json' || r === 'manifest.sig') continue
      if (d.isSymbolicLink()) throw new UpdateError(`symlink in bundle: ${r}`)
      if (d.isDirectory()) { await walk(r); continue }
      if (!d.isFile()) throw new UpdateError(`not a regular file: ${r}`)
      const want = m.files[r]
      if (!want) throw new UpdateError(`file not in manifest: ${r}`)
      const h = crypto.createHash('sha256')
      let n = 0
      for await (const c of readFileChunks(path.join(dir, r))) { h.update(c); n += c.byteLength }
      if (n !== want.size || h.digest('hex') !== want.sha256) throw new UpdateError(`file changed since release: ${r}`)
      seen.add(r)
    }
  }
  await walk('')
  for (const r of Object.keys(m.files)) if (!seen.has(r)) throw new UpdateError(`file missing: ${r}`)
  return m
}

/** Highest min_compatible_reader among a bundle's migrations (a roll-back below it needs the DB backup). */
export function bundleReaderLevel(dir: string): number {
  let lvl = 1
  try {
    for (const n of fs.readdirSync(path.join(dir, 'server', 'migrations'))) {
      if (!n.endsWith('.sql')) continue
      const head = fs.readFileSync(path.join(dir, 'server', 'migrations', n), 'utf8').slice(0, 400)
      const m = /--\s*min_compatible_reader:\s*(\d+)/.exec(head)
      if (m) lvl = Math.max(lvl, parseInt(m[1]!, 10))
    }
  } catch {}
  return lvl
}

export const ReleaseFeed = z.object({
  version: z.string(),
  minFrom: z.string().nullable().default(null),
  urgent: z.boolean().default(false),
  needsRoot: z.boolean().default(false),
  notes: z.string().default(''),
  publishedAt: z.string(),
  bundles: z.array(z.object({ os: z.string(), arch: z.string(), url: z.url(), sha256: z.string(), size: z.number().int() })),
})
export type ReleaseFeed = z.infer<typeof ReleaseFeed>

export interface UpdateManagerOptions {
  appDir: string | null
  dataDir: string
  version: string
  channel: 'stable' | 'beta'
  feedUrl: string | null
  log: Logger
  keys?: readonly string[]
  /** test installs and development bundles have no release signature */
  allowUnsigned?: boolean
  fetch?: typeof fetch
}

interface CheckRecord { at: string; feed: ReleaseFeed | null; error: string | null }

export class UpdateManager {
  constructor(private o: UpdateManagerOptions) {}

  get installed() { return this.o.appDir !== null }
  private get keys() { return this.o.keys ?? RELEASE_PUBLIC_KEYS }
  private get allowUnsigned() { return this.o.allowUnsigned ?? this.keys.length === 0 }
  private versionsDir() { return path.join(this.o.appDir!, 'versions') }
  private stateFile() { return path.join(this.o.appDir!, 'state.json') }
  private checkFile() { return path.join(this.o.dataDir, 'update-check.json') }

  readState(): AppState {
    if (!this.o.appDir) return emptyAppState()
    try { return AppState.parse(JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'))) } catch { return emptyAppState() }
  }

  private writeState(s: AppState) {
    const tmp = this.stateFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o640 })
    fs.renameSync(tmp, this.stateFile())
  }

  /** The version app/current points to (null in dev). */
  currentLinkTarget(): string | null {
    if (!this.o.appDir) return null
    try { return path.basename(fs.readlinkSync(path.join(this.o.appDir, 'current'))) } catch { return null }
  }

  stagedVersions(): string[] {
    if (!this.o.appDir) return []
    try { return fs.readdirSync(this.versionsDir()).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(this.versionsDir(), n, 'manifest.json'))) } catch { return [] }
  }

  private lastCheck(): CheckRecord | null {
    try { return JSON.parse(fs.readFileSync(this.checkFile(), 'utf8')) } catch { return null }
  }

  status(): UpdateStatus {
    const st = this.readState()
    let available: UpdateStatus['available'] = null
    const newer = this.stagedVersions().filter((v) => compareVersions(v, this.o.version) > 0).sort(compareVersions).at(-1)
    if (newer) {
      const dir = path.join(this.versionsDir(), newer)
      let notes = ''
      try { notes = fs.readFileSync(path.join(dir, 'RELEASE_NOTES.md'), 'utf8').slice(0, 20_000) } catch {}
      let publishedAt = new Date(0).toISOString()
      try { publishedAt = BundleManifest.parse(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).createdAt } catch {}
      available = { version: newer, notes, publishedAt, needsBackupRestoreToRollBack: bundleReaderLevel(dir) > SCHEMA_READER_LEVEL }
    }
    const chk = this.lastCheck()
    if (!available && chk?.feed && compareVersions(chk.feed.version, this.o.version) > 0) {
      available = { version: chk.feed.version, notes: chk.feed.notes, publishedAt: chk.feed.publishedAt, needsBackupRestoreToRollBack: false }
    }
    const prev = st.previous && st.previous !== this.o.version && this.stagedVersions().includes(st.previous) ? st.previous : null
    return { current: this.o.version, channel: this.o.channel, available, lastCheckedAt: chk?.at ?? null, previous: prev }
  }

  /** Unpack a bundle archive (.tar.zst) into app/versions/<version> after verifying it. */
  async stage(archive: string): Promise<BundleManifest> {
    if (!this.o.appDir) throw new UpdateError('updates are only possible on an installed server')
    const staging = path.join(this.versionsDir(), `.staging-${crypto.randomBytes(6).toString('hex')}`)
    await fsp.mkdir(staging, { recursive: true, mode: 0o755 })
    try {
      await extractTar(zstdDecompress(readFileChunks(archive)), staging)
      const m = await verifyBundleDir(staging, { keys: this.keys, allowUnsigned: this.allowUnsigned })
      const dest = path.join(this.versionsDir(), m.version)
      if (fs.existsSync(dest)) {
        await verifyBundleDir(dest, { keys: this.keys, allowUnsigned: this.allowUnsigned }) // already there and intact
        await fsp.rm(staging, { recursive: true, force: true })
        return m
      }
      // folders readable by the engine account? No: versions/ is the server's; only app/engines is shared.
      await fsp.rename(staging, dest)
      this.o.log.info('update staged', { version: m.version })
      return m
    } catch (e) {
      await fsp.rm(staging, { recursive: true, force: true })
      throw e
    }
  }

  /**
   * Point app/current at `version` and record it as pending; the caller restarts the server afterwards (the bootstrap
   * then health-checks the new version and rolls back if needed).
   */
  async switchTo(version: string): Promise<{ from: string; to: string }> {
    if (!this.o.appDir) throw new UpdateError('updates are only possible on an installed server')
    if (version === this.o.version) throw new UpdateError(`version ${version} is already running`)
    const dir = path.join(this.versionsDir(), version)
    if (!fs.existsSync(dir)) throw new UpdateError(`version ${version} is not staged`)
    await verifyBundleDir(dir, { keys: this.keys, allowUnsigned: this.allowUnsigned })
    const st = this.readState()
    const from = this.currentLinkTarget() ?? this.o.version
    st.previous = from
    st.current = from
    st.pending = version
    st.pendingSince = new Date().toISOString()
    st.attempts = 0
    this.writeState(st)
    const tmp = path.join(this.o.appDir, `.current-${process.pid}`)
    fs.rmSync(tmp, { force: true })
    fs.symlinkSync(path.join('versions', version), tmp)
    fs.renameSync(tmp, path.join(this.o.appDir, 'current'))
    this.o.log.info('update switched', { from, to: version })
    return { from, to: version }
  }

  /** Roll back to the version kept in state.previous. */
  async rollBack(): Promise<{ from: string; to: string }> {
    const prev = this.status().previous
    if (!prev) throw new UpdateError('there is no previous version to go back to')
    return this.switchTo(prev)
  }

  /** Fetch and verify the release feed; records the result for status(). */
  async checkFeed(): Promise<ReleaseFeed | null> {
    const rec: CheckRecord = { at: new Date().toISOString(), feed: null, error: null }
    try {
      if (!this.o.feedUrl) throw new UpdateError('no release feed configured')
      if (!this.keys.length) throw new UpdateError('no release signing key in this build; remote updates are disabled')
      const f = this.o.fetch ?? fetch
      const [body, sig] = await Promise.all([
        f(this.o.feedUrl, { redirect: 'error' }).then(async (r) => { if (!r.ok) throw new UpdateError(`feed: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()) }),
        f(this.o.feedUrl + '.sig', { redirect: 'error' }).then(async (r) => { if (!r.ok) throw new UpdateError(`feed signature: HTTP ${r.status}`); return r.text() }),
      ])
      if (!verifySignature(body, sig, this.keys)) throw new UpdateError('release feed signature does not verify')
      rec.feed = ReleaseFeed.parse(JSON.parse(Buffer.from(body).toString('utf8')))
    } catch (e) {
      rec.error = (e as Error).message
    }
    fs.mkdirSync(this.o.dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.checkFile(), JSON.stringify(rec), { mode: 0o600 })
    if (rec.error) this.o.log.warn('update check failed', { error: rec.error })
    return rec.feed
  }

  /** Download the bundle of a verified feed entry for this machine and stage it. */
  async download(feed: ReleaseFeed, progress: (f: number) => void = () => {}): Promise<BundleManifest> {
    const os = process.platform === 'darwin' ? 'darwin' : process.platform
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const b = feed.bundles.find((x) => x.os === os && x.arch === arch)
    if (!b) throw new UpdateError(`release ${feed.version} has no bundle for ${os}-${arch}`)
    if (!b.url.startsWith('https://')) throw new UpdateError('bundle URL must be https')
    const r = await (this.o.fetch ?? fetch)(b.url, { redirect: 'follow' })
    if (!r.ok || !r.body) throw new UpdateError(`download: HTTP ${r.status}`)
    const file = path.join(this.o.dataDir, 'updates', `${feed.version}.tar.zst`)
    let n = 0
    const body = r.body as unknown as AsyncIterable<Uint8Array>
    const w = await writeAtomic((async function* () { for await (const c of body) { n += c.byteLength; if (n > b.size) throw new UpdateError('download larger than announced'); progress(n / b.size); yield c } })(), file)
    if (w.sha256 !== b.sha256) { await fsp.rm(file, { force: true }); throw new UpdateError('download does not match the release hash') }
    try { return await this.stage(file) } finally { await fsp.rm(file, { force: true }) }
  }

  /** Last update outcomes recorded by the bootstrap (newest last). */
  history() { return this.readState().history }
}
