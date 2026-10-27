// admin.js commands for the hosted service (control-plane SV-5): an off-site backup chain (full + incremental) goes to
// a fake S3 in parts with ETags, age-encrypted to two recipients; downloaded and decrypted it restores to the same DB
// (sign-ins ended) and team folder; restore-verify compares with the prepared totals; the export is the whole team
// under a random passphrase; relay-key proves the key; the setup token rotates only before setup; the CLI wiring.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { keyRotationString, registerSigningString, verifyB64 } from '@mycel/shared/relay-protocol'
import { BackupPrepareResult, BackupUploadResult, ExportResult, reattachSigningString } from '@mycel/shared/cloud-protocol'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { BackupManager } from '../../server/src/system/backup'
import {
  archiveUpload, cloudBackupPrepare, cloudBackupUpload, lastUploadedLocalId, relayKeyCommand, restoreArtifacts, restoreVerify,
  rotateSetupToken, setupStatus, uploadParts,
} from '../../server/src/system/cloud-admin'
import { resolveLayout } from '../../server/src/system/layout'
import { walkTree } from '../../server/src/system/manifest'
import { ageDecrypt, ageDecryptWith, newAgeIdentity, zstdDecompress } from '../../server/src/system/streams'
import { extractTar } from '../../server/src/system/tar'
import { WORK } from '../lib/env'

// VACUUM INTO in a child process, zstd and age over a whole team folder: seconds on a busy machine
setDefaultTimeout(60_000)
const W = path.join(WORK, `g-cloud-admin-${process.pid}`)
fs.rmSync(W, { recursive: true, force: true })
const MiB = 1024 * 1024

/** A fake S3: PUT stores the part, answers an ETag; `failFirst` 500s make the client retry; /deny answers 403. */
let s3: ReturnType<typeof Bun.serve>
const stored = new Map<string, Uint8Array>()
let failNext = 0
beforeAll(() => {
  s3 = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (req.method !== 'PUT') return new Response('no', { status: 405 })
      if (u.pathname.startsWith('/deny')) return new Response('expired', { status: 403 })
      if (failNext > 0) { failNext--; return new Response('busy', { status: 503 }) }
      const b = new Uint8Array(await req.arrayBuffer())
      stored.set(u.pathname + u.search, b)
      return new Response(null, { headers: { etag: `"${crypto.createHash('md5').update(b).digest('hex')}"` } })
    },
  })
})
afterAll(() => s3.stop(true))
const url = (p: string) => `http://127.0.0.1:${s3.port}${p}`
const urls = (key: string, n: number) => Array.from({ length: n }, (_, i) => url(`/teamax-backups/${key}?partNumber=${i + 1}`))
/** what S3 would assemble at CompleteMultipartUpload */
const assemble = (key: string, parts: { n: number }[]) => Buffer.concat(parts.map((p) => stored.get(`/teamax-backups/${key}?partNumber=${p.n}`)!))
async function* once(b: Uint8Array) { yield b }
async function collect(src: AsyncIterable<Uint8Array>) { const a: Uint8Array[] = []; for await (const c of src) a.push(c); return Buffer.concat(a) }

function team(name: string) {
  const base = path.join(W, name)
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  fs.mkdirSync(path.join(cfg.teamRoot, 'shared', 'empty-dir'), { recursive: true })
  fs.mkdirSync(path.join(cfg.teamRoot, 'users', 'olga'), { recursive: true })
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'plan.md'), '# 계획\n')
  fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'rand.bin'), crypto.randomBytes(400_000))
  fs.writeFileSync(path.join(cfg.teamRoot, 'users', 'olga', 'note.txt'), 'private')
  const dbFile = path.join(cfg.dataDir, 'app.db')
  const db = openDb(dbFile)
  db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
  db.query("INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at) VALUES ('s1', 'olga', 'h1', 'web', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2099-01-01T00:00:00Z')").run()
  let clock = new Date('2026-10-01T04:00:00Z')
  const layout = resolveLayout(cfg)
  const mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.2.1', now: () => clock })
  return { cfg, db, dbFile, layout, mgr, setClock: (d: Date) => { clock = d } }
}

describe('uploadParts', () => {
  test('parts of the given size to their URLs, ETags kept, retries on 503, stops on 403, too few URLs is an error', async () => {
    const data = crypto.randomBytes(200_000)
    failNext = 2
    const r = await uploadParts(once(data), 64 * 1024, urls('t/x/obj', 5), { backoffMs: 5 })
    expect(r.parts.map((p) => p.n)).toEqual([1, 2, 3, 4])
    expect(r.parts[0]!.etag).toMatch(/^"[0-9a-f]{32}"$/)
    expect(r.size).toBe(200_000)
    expect(r.sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'))
    expect(assemble('t/x/obj', r.parts).equals(data)).toBe(true)
    await expect(uploadParts(once(data), 64 * 1024, urls('t/x/few', 2), { backoffMs: 1 })).rejects.toThrow(/more parts than part URLs/)
    await expect(uploadParts(once(data), 64 * 1024, [url('/deny/1')], { backoffMs: 1 })).rejects.toThrow(/403/)
  })
})

describe('off-site backup: prepare, upload, download, restore, verify', () => {
  test('a full and an incremental backup round-trip; either recipient decrypts; totals match the restore', async () => {
    const e = team('chain')
    const teamKey = await newAgeIdentity()
    const orgKey = await newAgeIdentity()
    const full = await e.mgr.run({ kind: 'daily', scope: 'full' })
    e.setClock(new Date('2026-10-02T04:00:00Z'))
    fs.writeFileSync(path.join(e.cfg.teamRoot, 'shared', 'new.md'), 'new file')
    fs.rmSync(path.join(e.cfg.teamRoot, 'users', 'olga', 'note.txt'))
    const inc = await e.mgr.run({ kind: 'daily', scope: 'full' })
    expect(inc.team?.base).toBe(full.id)

    const download = path.join(W, 'chain-download')
    fs.mkdirSync(download, { recursive: true })
    let lastTotals: { files: number; bytes: number; schemaVersion: number } | null = null
    for (const id of [full.id, inc.id]) {
      const prep = BackupPrepareResult.parse(await cloudBackupPrepare({ db: e.db, dbFile: e.dbFile, layout: e.layout, dataDir: e.cfg.dataDir, version: '0.2.1', log: silentLogger }, 'daily', id))
      expect(prep.localId).toBe(id)
      expect(prep.files.map((f) => f.name).sort()).toEqual(['db.sqlite.zst', 'deleted.json', 'dirs.json', 'manifest.json', 'meta.json', 'team.tar.zst'])
      lastTotals = prep.totals
      const plan = { localId: id, recipients: [teamKey.recipient, orgKey.recipient], files: prep.files.map((f) => ({ name: f.name, key: `t/team-1/${id}/${f.name}.age`, partSize: 5 * MiB, partUrls: urls(`t/team-1/${id}/${f.name}.age`, Math.ceil((f.plainSize * 1.001) / (5 * MiB)) + 1) })) }
      const up = BackupUploadResult.parse(await cloudBackupUpload(e.cfg.dataDir, plan))
      fs.mkdirSync(path.join(download, id), { recursive: true })
      for (const f of up.files) {
        const blob = assemble(`t/team-1/${id}/${f.name}.age`, f.parts)
        expect(blob.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1')
        expect(crypto.createHash('sha256').update(blob).digest('hex')).toBe(f.sha256)
        // the team's key opens it, so does the organisation's recovery key
        const plain = await collect(ageDecryptWith(once(blob), [id === full.id ? teamKey.identity : orgKey.identity]))
        fs.writeFileSync(path.join(download, id, f.name), plain)
      }
      expect(lastUploadedLocalId(e.cfg.dataDir)).toBe(id)
      expect(fs.existsSync(path.join(e.cfg.dataDir, 'cloud-staging', id))).toBe(false)
    }
    fs.writeFileSync(path.join(download, 'chain.json'), JSON.stringify([full.id, inc.id]))

    const to = path.join(W, 'restored')
    const r = await restoreArtifacts(download, to)
    expect(r.schemaVersion).toBe(inc.schemaVersion)
    const want = (await walkTree(e.cfg.teamRoot, { exclude: ['.system/backups'] }))
    const got = await walkTree(path.join(to, 'team'))
    expect(got.files.map((f) => f.rel).sort()).toEqual(want.files.map((f) => f.rel).sort())
    expect(got.dirs.map((d) => d.rel)).toContain('shared/empty-dir')
    expect(fs.readFileSync(path.join(to, 'team', 'shared', 'rand.bin')).equals(fs.readFileSync(path.join(e.cfg.teamRoot, 'shared', 'rand.bin')))).toBe(true)
    expect(fs.existsSync(path.join(to, 'team', 'users', 'olga', 'note.txt'))).toBe(false)
    const rdb = openDb(path.join(to, 'db', 'app.sqlite'))
    try {
      expect((rdb.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1)
      expect((rdb.query('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0) // every sign-in ended
    } finally { rdb.close() }
    expect([r.files, r.bytes]).toEqual([lastTotals!.files, lastTotals!.bytes])
    await expect(restoreArtifacts(download, to)).rejects.toThrow(/already exists/)

    const v = await restoreVerify(download, JSON.stringify(lastTotals), e.cfg.dataDir)
    expect(v).toMatchObject({ ok: true, files: lastTotals!.files, bytes: lastTotals!.bytes, problem: null })
    const bad = await restoreVerify(download, JSON.stringify({ ...lastTotals, files: lastTotals!.files + 1 }), e.cfg.dataDir)
    expect(bad.ok).toBe(false)
    expect(bad.problem).toMatch(/files/)
    expect(fs.readdirSync(e.cfg.dataDir).filter((n) => n.startsWith('.restore-verify'))).toEqual([])

    // a chain without its full archive is refused
    const broken = path.join(W, 'broken-download')
    fs.cpSync(path.join(download, inc.id), path.join(broken, inc.id), { recursive: true })
    await expect(restoreArtifacts(broken, path.join(W, 'restored-broken'))).rejects.toThrow(/full archive/)
    e.db.close()
  })
  test('upload refuses names that are not the prepared files, and unprepared backups', async () => {
    const e = team('refuse')
    const b = await e.mgr.run({ kind: 'manual', scope: 'full' })
    const k = await newAgeIdentity()
    await expect(cloudBackupUpload(e.cfg.dataDir, { localId: b.id, recipients: [k.recipient], files: [{ name: 'db.sqlite.zst', key: 'k', partSize: 5 * MiB, partUrls: [url('/x')] }] })).rejects.toThrow(/not prepared/)
    await cloudBackupPrepare({ db: e.db, dbFile: e.dbFile, layout: e.layout, dataDir: e.cfg.dataDir, version: '0.2.1', log: silentLogger }, 'daily', b.id)
    await expect(cloudBackupUpload(e.cfg.dataDir, { localId: b.id, recipients: [k.recipient], files: [{ name: 'passwd', key: 'k', partSize: 5 * MiB, partUrls: [url('/x')] }] })).rejects.toThrow(/not a file of/)
    await expect(cloudBackupUpload(e.cfg.dataDir, { localId: b.id, recipients: ['not-a-key'], files: [] })).rejects.toThrow()
    // manual / final: a new backup now
    const now = await cloudBackupPrepare({ db: e.db, dbFile: e.dbFile, layout: e.layout, dataDir: e.cfg.dataDir, version: '0.2.1', log: silentLogger }, 'final', null)
    expect(now.localId).not.toBe(b.id)
    e.db.close()
  })
})

describe('export, relay key, setup token', () => {
  test('export: the whole team under a random passphrase, in parts', async () => {
    const e = team('export')
    const out = ExportResult.parse(await archiveUpload({ dbFile: e.dbFile, teamRoot: e.cfg.teamRoot, dataDir: e.cfg.dataDir }, { partSize: 5 * MiB, partUrls: urls('x/team-1/exp.tar.zst.age', 3) }))
    expect(out.passphrase.length).toBeGreaterThanOrEqual(40)
    const blob = assemble('x/team-1/exp.tar.zst.age', out.parts)
    const dest = path.join(W, 'export-open')
    fs.mkdirSync(dest)
    await extractTar(zstdDecompress(ageDecrypt(once(blob), out.passphrase)), dest)
    expect(fs.existsSync(path.join(dest, 'db', 'app.sqlite'))).toBe(true)
    expect(fs.readFileSync(path.join(dest, 'team', 'users', 'olga', 'note.txt'), 'utf8')).toBe('private')
    e.db.close()
  })
  test('relay-key: made once, then the same; signatures for register, rotate and reattach verify', () => {
    const dir = path.join(W, 'relay-key')
    const a = relayKeyCommand(dir, [])
    expect(a.created).toBe(true)
    const r = relayKeyCommand(dir, ['--sign-register', 'acme', '1761100000000'])
    expect(r.created).toBe(false)
    expect(r.publicKey).toBe(a.publicKey)
    expect(verifyB64(r.publicKey, registerSigningString('acme', r.publicKey, 1761100000000), r.sig!)).toBe(true)
    expect(verifyB64(r.publicKey, keyRotationString('team-1', r.publicKey), relayKeyCommand(dir, ['--sign-rotate', 'team-1']).sig!)).toBe(true)
    expect(verifyB64(r.publicKey, reattachSigningString('tenant-0001', 'team-1', 5), relayKeyCommand(dir, ['--sign-reattach', 'tenant-0001', 'team-1', '5']).sig!)).toBe(true)
    expect(() => relayKeyCommand(dir, ['--sign-register', 'acme'])).toThrow()
    expect(() => relayKeyCommand(dir, ['--sign-register', 'acme', 'soon'])).toThrow()
    expect(fs.statSync(path.join(dir, 'relay', 'team-key.pem')).mode & 0o077).toBe(0)
  })
  test('setup token: a new one only while nobody has set the team up', () => {
    const dir = path.join(W, 'setup')
    fs.mkdirSync(dir, { recursive: true })
    const db = openDb(path.join(dir, 'app.db'))
    try {
      expect(setupStatus(db, dir)).toEqual({ needed: true, users: 0, tokenFile: false })
      const t = rotateSetupToken(db, dir)
      expect(t.setupToken).toMatch(/^[A-Za-z0-9_-]{32}$/)
      expect(fs.readFileSync(path.join(dir, 'setup-token'), 'utf8').trim()).toBe(t.setupToken)
      expect(fs.statSync(path.join(dir, 'setup-token')).mode & 0o077).toBe(0)
      expect(rotateSetupToken(db, dir).setupToken).not.toBe(t.setupToken)
      db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
      expect(() => rotateSetupToken(db, dir)).toThrow(/set up already/)
      expect(setupStatus(db, dir).needed).toBe(false)
    } finally { db.close() }
  })
})

describe('admin.js wiring', () => {
  test('setup-status, relay-key and cloud-backup prepare through the command line, JSON out', async () => {
    const base = path.join(W, 'cli')
    fs.mkdirSync(path.join(base, 'team'), { recursive: true })
    fs.writeFileSync(path.join(base, 'team', 'a.md'), 'x')
    const cfgFile = path.join(base, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team') }))
    const run = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), ...args], { env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' } })
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
    }
    fs.mkdirSync(path.join(base, 'data'), { recursive: true })
    openDb(path.join(base, 'data', 'app.db')).close()
    const s = run('setup-status')
    expect([s.code, JSON.parse(s.out)]).toEqual([0, { needed: true, users: 0, tokenFile: false }])
    const k = run('relay-key', '--sign-register', 'acme', '1')
    expect(k.code).toBe(0)
    expect(JSON.parse(k.out).sig).toBeString()
    const p = run('cloud-backup', 'prepare', '--kind', 'manual')
    expect(p.code).toBe(0)
    expect(BackupPrepareResult.parse(JSON.parse(p.out)).files.length).toBeGreaterThan(3)
    expect(run('cloud-backup', 'prepare', '--kind', 'weekly').code).toBe(1)
  }, 60_000)
})
