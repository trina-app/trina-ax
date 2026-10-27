// admin.js commands the hosted service's root tool (mycel-ctl, running as root inside the tenant VM) hands to the
// server account (control-plane 3.5.3 / 3.14, SV-5). Every command prints one JSON object on stdout, the shapes of
// shared/src/cloud-protocol/tenant-commands.ts. Nothing here talks to the control plane: off-site backups go to the
// presigned R2 URLs mycel-ctl passes on stdin (the tenant holds no storage credentials, control-plane D26).
//
//   relay-key [--sign-register <slug> <ts>] [--sign-rotate <teamId>] [--sign-reattach <tenantId> <teamId> <ts>]
//   setup-status | setup-token-rotate
//   cloud-backup prepare --kind daily|manual|pre-update|final [--local-id <id>]
//   cloud-backup upload                      (stdin BackupUploadInput)
//   archive --passphrase-random --upload     (stdin ExportInput: the whole team, age with a random passphrase)
//   restore-artifacts --dir <downloaded, decrypted chain> --to <new folder>
//   restore-verify --dir <…> --expect '{"files":N,"bytes":N,"schemaVersion":N}'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { keyRotationString, registerSigningString, signB64 } from '@mycel/shared/relay-protocol'
import {
  BackupUploadInput, ExportInput, RestoreExpect, reattachSigningString,
  type BackupPrepareResult, type BackupUploadResult, type ExportResult, type UploadedPart,
} from '@mycel/shared/cloud-protocol'
import type { Logger } from '../log'
import { loadOrCreateKey } from '../relay-client/registration'
import { BackupError, BackupManager, BackupMeta, endSessions, inspectDbCopy, restoreTeamChain, vacuumInto } from './backup'
import type { InstallLayout } from './layout'
import { walkTree } from './manifest'
import { ageEncrypt, ageEncryptTo, readFileChunks, writeAtomic, zstdCompress, zstdDecompress, type Bytes } from './streams'
import { tarStream, type TarEntryInput } from './tar'

export class CloudAdminError extends Error { name = 'CloudAdminError' }

// ------------------------------------------------------------------ relay key (mycel-enroll, relay-key-proof)

/** The relay team key's public part, made on first use, and signatures that prove this server holds it. */
export function relayKeyCommand(dataDir: string, args: string[]): { publicKey: string; created: boolean; sig?: string } {
  const { key, publicKey, created } = loadOrCreateKey(dataDir)
  const at = (flag: string, n: number): string[] | null => {
    const i = args.indexOf(flag)
    if (i < 0) return null
    const v = args.slice(i + 1, i + 1 + n)
    if (v.length !== n || v.some((x) => !x || x.startsWith('--'))) throw new CloudAdminError(`${flag} needs ${n} value(s)`)
    return v
  }
  const reg = at('--sign-register', 2), rot = at('--sign-rotate', 1), re = at('--sign-reattach', 3)
  if ([reg, rot, re].filter(Boolean).length > 1) throw new CloudAdminError('one signature at a time')
  const num = (s: string) => { const n = Number(s); if (!Number.isInteger(n) || n < 0) throw new CloudAdminError(`not a millisecond timestamp: ${s}`); return n }
  if (reg) return { publicKey, created, sig: signB64(key, registerSigningString(reg[0]!, publicKey, num(reg[1]!))) }
  if (rot) return { publicKey, created, sig: signB64(key, keyRotationString(rot[0]!, publicKey)) }
  if (re) return { publicKey, created, sig: signB64(key, reattachSigningString(re[0]!, re[1]!, num(re[2]!))) }
  return { publicKey, created }
}

// ------------------------------------------------------------------ setup token (mycel-ctl setup-token-rotate)

const userCount = (db: Database) => (db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n

export function setupStatus(db: Database, dataDir: string): { needed: boolean; users: number; tokenFile: boolean } {
  const users = userCount(db)
  return { needed: users === 0, users, tokenFile: fs.existsSync(path.join(dataDir, 'setup-token')) }
}

/** A new first-run token, only while nobody has set the team up (the running server reads it at its next start). */
export function rotateSetupToken(db: Database, dataDir: string): { setupToken: string } {
  if (userCount(db) > 0) throw new CloudAdminError('the team is set up already: no setup token')
  const token = crypto.randomBytes(24).toString('base64url')
  const file = path.join(dataDir, 'setup-token')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return { setupToken: token }
}

// ------------------------------------------------------------------ off-site backup (backup-prepare, backup-upload)

const STAGING = 'cloud-staging'
const STATE_FILE = 'cloud-backup-state.json'
interface StagePlan { localId: string; files: Record<string, string> }

function stagingDir(dataDir: string, localId: string): string {
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-z-]+(-[0-9]+)?$/.test(localId)) throw new CloudAdminError(`bad local backup id ${localId}`)
  return path.join(dataDir, STAGING, localId)
}

/** The last local backup the control plane took off-site (status: lastUploadedLocalId). */
export function lastUploadedLocalId(dataDir: string): string | null {
  try { return (JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', STATE_FILE), 'utf8')) as { lastUploadedLocalId?: string }).lastUploadedLocalId ?? null } catch { return null }
}

/**
 * Pick (or make) the local backup to take off-site and stage what is not a plain file yet (the DB copy, zstd).
 * manual / final: a new full backup now. daily / pre-update: `localId` if given (the control plane walks a chain),
 * else the newest local backup. Files: db.sqlite.zst, meta.json and, when the backup has the team folder,
 * team.tar.zst, manifest.json, deleted.json, dirs.json.
 */
export async function cloudBackupPrepare(o: { db: Database; dbFile: string; layout: InstallLayout; dataDir: string; version: string; log: Logger }, kind: 'daily' | 'manual' | 'pre-update' | 'final', localId: string | null): Promise<BackupPrepareResult & { totals: { files: number; bytes: number; schemaVersion: number } | null }> {
  const mgr = new BackupManager({ db: o.db, dbFile: o.dbFile, layout: o.layout, log: o.log, version: o.version })
  let meta: BackupMeta
  if (kind === 'manual' || kind === 'final') meta = await mgr.run({ kind: 'manual', scope: 'full' })
  else {
    const metas = mgr.metas()
    const m = localId ? metas.find((x) => x.id === localId) : metas.at(-1)
    if (!m) throw new CloudAdminError(localId ? `no local backup ${localId}` : 'no local backup yet')
    meta = m
  }
  const stage = stagingDir(o.dataDir, meta.id)
  // one backup in flight at a time; anything older than a day is left over from a failed run
  try {
    for (const d of fs.readdirSync(path.join(o.dataDir, STAGING))) {
      const p = path.join(o.dataDir, STAGING, d)
      if (d !== meta.id && Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { recursive: true, force: true })
    }
  } catch {}
  await fsp.mkdir(stage, { recursive: true, mode: 0o700 })
  const dbCopy = mgr.dbFileOf(meta.id)
  if (!dbCopy) throw new CloudAdminError(`the database copy of ${meta.id} is gone`)
  const files: Record<string, string> = {}
  files['db.sqlite.zst'] = path.join(stage, 'db.sqlite.zst')
  if (!fs.existsSync(files['db.sqlite.zst'])) await writeAtomic(zstdCompress(readFileChunks(dbCopy), 9), files['db.sqlite.zst'])
  files['meta.json'] = path.join(o.layout.dbBackupsDir, `${meta.id}.json`)
  let totals: { files: number; bytes: number; schemaVersion: number } | null = null
  if (meta.team) {
    const dir = mgr.teamDir(meta.id)
    for (const n of ['team.tar.zst', 'manifest.json', 'deleted.json', 'dirs.json']) if (fs.existsSync(path.join(dir, n))) files[n] = path.join(dir, n)
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, { s: number }>
    totals = { files: Object.keys(manifest).length, bytes: Object.values(manifest).reduce((a, e) => a + Math.max(0, e.s), 0), schemaVersion: meta.schemaVersion }
  }
  const plan: StagePlan = { localId: meta.id, files }
  await fsp.writeFile(path.join(stage, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
  return {
    localId: meta.id, scope: meta.scope, base: meta.team?.base ?? null,
    files: Object.entries(files).map(([name, p]) => ({ name, plainSize: fs.statSync(p).size })),
    meta: meta as unknown as Record<string, unknown>, totals,
  }
}

export interface UploadOptions { fetch?: typeof fetch; retries?: number; backoffMs?: number }

/**
 * Cut a byte stream into parts of `partSize` and PUT each to its presigned URL (S3 / R2 multipart upload: part n to
 * partUrls[n-1]). One part is held in memory at a time. A part is retried on network errors, 5xx and 429; a 4xx
 * (expired or wrong URL) stops at once. Returns the size and sha256 of everything sent and each part's ETag.
 */
export async function uploadParts(src: Bytes, partSize: number, partUrls: readonly string[], o: UploadOptions = {}): Promise<{ size: number; sha256: string; parts: UploadedPart[] }> {
  const f = o.fetch ?? fetch
  const retries = o.retries ?? 4
  const h = crypto.createHash('sha256')
  const parts: UploadedPart[] = []
  let size = 0
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const put = async (body: Uint8Array) => {
    const n = parts.length + 1
    const url = partUrls[n - 1]
    if (!url) throw new CloudAdminError(`more parts than part URLs (${partUrls.length}): ask for more`)
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null
      let err: unknown = null
      try { res = await f(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, headers: { 'content-length': String(body.byteLength) } }) } catch (e) { err = e }
      if (res?.ok) {
        const etag = res.headers.get('etag')
        if (!etag) throw new CloudAdminError(`part ${n}: the storage answered without an ETag`)
        parts.push({ n, etag })
        return
      }
      const retryable = !res || res.status >= 500 || res.status === 429
      if (!retryable || attempt + 1 >= retries) throw new CloudAdminError(`part ${n}: ${res ? `storage answered ${res.status}` : `not reachable (${(err as Error)?.message ?? err})`}`)
      await Bun.sleep((o.backoffMs ?? 1000) * 2 ** attempt)
    }
  }
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const c = pending[0]!
      const k = Math.min(c.byteLength, n - off)
      out.set(c.subarray(0, k), off)
      off += k
      if (k === c.byteLength) pending.shift()
      else pending[0] = c.subarray(k)
    }
    pendingBytes -= n
    return out
  }
  for await (const c of src) {
    h.update(c)
    size += c.byteLength
    pending.push(c)
    pendingBytes += c.byteLength
    while (pendingBytes >= partSize) await put(take(partSize))
  }
  if (pendingBytes > 0 || parts.length === 0) await put(take(pendingBytes))
  pending = []
  return { size, sha256: h.digest('hex'), parts }
}

/** age-encrypt each staged file to the recipients and upload it in parts (backup-upload). */
export async function cloudBackupUpload(dataDir: string, input: unknown, o: UploadOptions = {}): Promise<BackupUploadResult> {
  const req = BackupUploadInput.parse(input)
  const stage = stagingDir(dataDir, req.localId)
  let plan: StagePlan
  try { plan = JSON.parse(await fsp.readFile(path.join(stage, 'plan.json'), 'utf8')) as StagePlan } catch { throw new CloudAdminError(`${req.localId} is not prepared (run cloud-backup prepare first)`) }
  const out: BackupUploadResult = { files: [] }
  for (const f of req.files) {
    const src = plan.files[f.name]
    if (!src) throw new CloudAdminError(`${f.name} is not a file of ${req.localId}`)
    const r = await uploadParts(ageEncryptTo(readFileChunks(src), req.recipients), f.partSize, f.partUrls, o)
    out.files.push({ name: f.name, size: r.size, sha256: r.sha256, parts: r.parts })
  }
  // every file of the plan went up: remember it (status lastUploadedLocalId) and drop the staged copies
  if (Object.keys(plan.files).every((n) => req.files.some((f) => f.name === n))) {
    await fsp.mkdir(path.join(dataDir, 'backups'), { recursive: true, mode: 0o700 })
    await writeAtomic([Buffer.from(JSON.stringify({ lastUploadedLocalId: req.localId, at: new Date().toISOString() }))], path.join(dataDir, 'backups', STATE_FILE))
    await fsp.rm(stage, { recursive: true, force: true })
  }
  return out
}

// ------------------------------------------------------------------ export (the whole team, for the owner)

/** The `archive` stream of admin.js (DB + team folder, tar.zst), encrypted with a random passphrase and uploaded. */
export async function archiveUpload(o: { dbFile: string; teamRoot: string; dataDir: string }, input: unknown, up: UploadOptions = {}): Promise<ExportResult> {
  const req = ExportInput.parse(input)
  const passphrase = crypto.randomBytes(32).toString('base64url')
  const tmpDb = path.join(o.dataDir, `archive-${process.pid}.sqlite`)
  await vacuumInto(o.dbFile, tmpDb)
  try {
    const tree = await walkTree(o.teamRoot, { exclude: ['.system/backups'] })
    const entries: TarEntryInput[] = [
      { name: 'db', type: 'dir' }, { name: 'db/app.sqlite', type: 'file', source: tmpDb },
      { name: 'team', type: 'dir' },
      ...tree.dirs.map((d) => ({ name: `team/${d.rel}`, type: 'dir' as const, mode: d.mode, mtimeMs: d.mtimeMs })),
      ...tree.files.map((f) => ({ name: `team/${f.rel}`, type: 'file' as const, source: f.abs })),
    ]
    const r = await uploadParts(ageEncrypt(zstdCompress(tarStream(entries)), passphrase), req.partSize, req.partUrls, up)
    return { passphrase, size: r.size, sha256: r.sha256, parts: r.parts }
  } finally {
    await fsp.rm(tmpDb, { force: true })
  }
}

// ------------------------------------------------------------------ restore from off-site (mycel-enroll restore / verify)

/** The chain in a downloaded folder: chain.json (oldest first) when present, else every <id>/meta.json by time. */
async function chainOf(dir: string): Promise<{ id: string; dir: string; meta: BackupMeta }[]> {
  let ids: string[]
  try { ids = JSON.parse(await fsp.readFile(path.join(dir, 'chain.json'), 'utf8')) as string[] } catch {
    ids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'meta.json'))).map((d) => d.name)
  }
  const items = await Promise.all(ids.map(async (id) => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new CloudAdminError(`bad backup id in the chain: ${id}`)
    const d = path.join(dir, id)
    return { id, dir: d, meta: BackupMeta.parse(JSON.parse(await fsp.readFile(path.join(d, 'meta.json'), 'utf8'))) }
  }))
  items.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt))
  if (!items.length) throw new CloudAdminError(`no backups in ${dir}`)
  return items
}

/**
 * Rebuild `<to>/db/app.sqlite` and `<to>/team/` (the layout of restore-archive) from a downloaded, decrypted chain:
 * the DB of the newest backup (checked, every sign-in ended), the team folder from the full archive and every
 * incremental after it. `to` appears only when everything worked.
 */
export async function restoreArtifacts(dir: string, to: string): Promise<{ restoredTo: string; files: number; bytes: number; schemaVersion: number }> {
  const target = path.resolve(to)
  if (fs.existsSync(target)) throw new CloudAdminError(`${target} already exists`)
  const chain = await chainOf(dir)
  const teamItems = chain.filter((c) => c.meta.team)
  if (!teamItems.length) throw new CloudAdminError('the chain has no team folder archive')
  if (teamItems[0]!.meta.team!.base !== null) throw new CloudAdminError(`the chain does not start with a full archive (${teamItems[0]!.id} builds on ${teamItems[0]!.meta.team!.base})`)
  for (let i = 1; i < teamItems.length; i++) {
    const base = teamItems[i]!.meta.team!.base
    if (base !== teamItems[i - 1]!.id) throw new CloudAdminError(`${teamItems[i]!.id} builds on ${base}, not on ${teamItems[i - 1]!.id}`)
  }
  const newest = chain.at(-1)!
  const tmp = `${target}.partial-${process.pid}`
  await fsp.rm(tmp, { recursive: true, force: true })
  await fsp.mkdir(path.join(tmp, 'db'), { recursive: true, mode: 0o700 })
  try {
    const dbz = path.join(newest.dir, 'db.sqlite.zst')
    if (!fs.existsSync(dbz)) throw new CloudAdminError(`${newest.id} has no db.sqlite.zst`)
    const dbFile = path.join(tmp, 'db', 'app.sqlite')
    await writeAtomic(zstdDecompress(readFileChunks(dbz)), dbFile)
    const { schemaVersion } = inspectDbCopy(dbFile)
    endSessions(dbFile)
    await restoreTeamChain(teamItems.map((c) => c.dir), path.join(tmp, 'team'))
    const tree = await walkTree(path.join(tmp, 'team'))
    await fsp.rename(tmp, target)
    return { restoredTo: target, files: tree.files.length, bytes: tree.files.reduce((a, f) => a + f.size, 0), schemaVersion }
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true })
    throw e instanceof BackupError ? new CloudAdminError(e.message) : e
  }
}

/** The weekly restore test (verify VM): restore into a throwaway folder, compare with what the backup said, remove. */
export async function restoreVerify(dir: string, expectJson: string, scratch: string): Promise<{ ok: boolean; files: number; bytes: number; schemaVersion: number; seconds: number; problem: string | null }> {
  const want = RestoreExpect.parse(JSON.parse(expectJson))
  const t0 = Date.now()
  const to = path.join(scratch, `.restore-verify-${process.pid}-${Date.now()}`)
  try {
    const r = await restoreArtifacts(dir, to)
    const problem = r.files !== want.files ? `files ${r.files}, expected ${want.files}` : r.bytes !== want.bytes ? `bytes ${r.bytes}, expected ${want.bytes}` : r.schemaVersion !== want.schemaVersion ? `schema ${r.schemaVersion}, expected ${want.schemaVersion}` : null
    return { ok: problem === null, files: r.files, bytes: r.bytes, schemaVersion: r.schemaVersion, seconds: Math.round((Date.now() - t0) / 100) / 10, problem }
  } catch (e) {
    return { ok: false, files: 0, bytes: 0, schemaVersion: 0, seconds: Math.round((Date.now() - t0) / 100) / 10, problem: (e as Error).message }
  } finally {
    await fsp.rm(to, { recursive: true, force: true })
  }
}
