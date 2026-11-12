// QA TC-348: the hosting service's copies of what is the team's (admin.js credentials-escrow-out, archive --upload,
// cloud-backup upload) left nothing in the team's activity log and told nobody. Now each leaves one audit line (actor
// none = the hosting service), and the key copy and the full export also give each owner an Inbox notice (shown
// always). The daily offsite backup gives no notice: one line per upload run.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BackupPrepareResult } from '@mycel/shared/cloud-protocol'
import { createContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { loadAppConfig } from '../../server/src/app-config'
import { notificationsOf } from '../../server/src/notifications/service'
import { newAgeIdentity } from '../../server/src/system/streams'
import { WORK } from '../lib/env'

setDefaultTimeout(60_000)
const W = path.join(WORK, `g-hosting-copy-notices-${process.pid}`)
fs.rmSync(W, { recursive: true, force: true })
const MiB = 1024 * 1024

/** a fake S3: every PUT stored, answered with an ETag */
let s3: ReturnType<typeof Bun.serve>
beforeAll(() => {
  s3 = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const b = new Uint8Array(await req.arrayBuffer())
      return new Response(null, { headers: { etag: `"${crypto.createHash('md5').update(b).digest('hex')}"` } })
    },
  })
})
afterAll(() => s3.stop(true))
const urls = (key: string, n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1:${s3.port}/b/${key}?partNumber=${i + 1}`)

const base = path.join(W, 'team')
const cfgFile = path.join(base, 'server.json')
const dbFile = path.join(base, 'data', 'app.db')
beforeAll(() => {
  fs.mkdirSync(path.join(base, 'team', 'shared'), { recursive: true })
  fs.mkdirSync(path.join(base, 'data'), { recursive: true })
  fs.writeFileSync(path.join(base, 'team', 'shared', 'plan.md'), '# plan\n')
  fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team') }))
  const db = openDb(dbFile)
  db.query(`INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner'), ('adam', 'adam', 'Adam', 'admin'),
    ('mina', 'mina', 'Mina', 'member')`).run()
  db.close()
})

/** admin.js as mycel-ctl runs it (async: the fake S3 answers in this process) */
async function run(args: string[], stdin?: unknown) {
  const p = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), ...args], {
    env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' }, stdin: stdin === undefined ? 'ignore' : new Blob([JSON.stringify(stdin)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out, err }
}

const auditRows = (action: string) => {
  const db = openDb(dbFile)
  try { return db.query('SELECT id, actor_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { id: number; actor_id: string | null; detail: string }[] }
  finally { db.close() }
}
/** the Inbox as each person reads it */
async function inbox(userId: string) {
  const ctx = createContext({ config: loadAppConfig({ argv: ['--config', cfgFile], env: { MYCEL_MODE: 'dev' } }), db: openDb(dbFile), log: silentLogger })
  ctx.onClose(() => ctx.db.close())
  try { return notificationsOf(ctx).list(userId, {}).items.filter((n) => n.code.startsWith('hosting.')) }
  finally { await ctx.close() }
}

describe('hosting copies are in the activity log, and the owners are told', () => {
  test('credentials-escrow-out: no key = nothing copied, nothing logged; a key copy = one line and one notice per owner', async () => {
    const id = await newAgeIdentity()
    const none = await run(['credentials-escrow-out', '--recipient', id.recipient])
    expect([none.code, JSON.parse(none.out)]).toEqual([0, { absent: true }])
    expect(auditRows('hosting.key_escrow')).toEqual([])

    const secrets = path.join(base, 'secrets')
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(secrets, 'credentials.key'), Buffer.alloc(32, 7).toString('base64') + '\n', { mode: 0o600 })
    const r = await run(['credentials-escrow-out', '--recipient', id.recipient])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).keyVersion).toBe(1)
    const rows = auditRows('hosting.key_escrow')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_id).toBeNull()
    expect(JSON.parse(rows[0]!.detail)).toEqual({ keyVersion: 1 })
    // the owner only: an admin or a member did not hold the team
    const n = await inbox('olga')
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ code: 'hosting.key_copied', sourceId: 'credentials-key-v1', readAt: null, link: null, outcome: null })
    expect(await inbox('adam')).toEqual([])
    expect(await inbox('mina')).toEqual([])
    // never the key in the log line or the notice
    expect(JSON.stringify([rows, n])).not.toContain(Buffer.alloc(32, 7).toString('base64'))
    // the same key again (a retried job): a second line, still one notice; a new key after a rekey: told again
    expect((await run(['credentials-escrow-out', '--recipient', id.recipient])).code).toBe(0)
    expect(auditRows('hosting.key_escrow')).toHaveLength(2)
    expect(await inbox('olga')).toHaveLength(1)
    fs.writeFileSync(path.join(secrets, 'credentials.key.2'), Buffer.alloc(32, 8).toString('base64') + '\n', { mode: 0o600 })
    expect((await run(['credentials-escrow-out', '--recipient', id.recipient])).code).toBe(0)
    expect((await inbox('olga')).map((x) => x.sourceId).sort()).toEqual(['credentials-key-v1', 'credentials-key-v2'])
  })

  test('archive --upload: one line with size and hash, one notice to the owner; never the passphrase', async () => {
    const r = await run(['archive', '--upload', '--passphrase-random'], { partSize: 5 * MiB, partUrls: urls('exp.tar.zst.age', 3) })
    expect(r.code).toBe(0)
    const res = JSON.parse(r.out) as { passphrase: string; size: number; sha256: string }
    const rows = auditRows('hosting.export')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_id).toBeNull()
    expect(JSON.parse(rows[0]!.detail)).toEqual({ size: res.size, sha256: res.sha256 })
    expect(rows[0]!.detail).not.toContain(res.passphrase)
    const n = (await inbox('olga')).filter((x) => x.code === 'hosting.exported')
    expect(n).toHaveLength(1)
    expect(n[0]!.sourceId).toBe(String(rows[0]!.id))
    expect(await inbox('adam')).toEqual([])
  })

  test('cloud-backup upload: one line per upload run, no notice (the daily backup must not bury the Inbox)', async () => {
    const before = (await inbox('olga')).length
    for (let i = 0; i < 2; i++) {
      const p = await run(['cloud-backup', 'prepare', '--kind', 'manual'])
      expect(p.code).toBe(0)
      const prep = BackupPrepareResult.parse(JSON.parse(p.out))
      const k = await newAgeIdentity()
      const plan = { localId: prep.localId, recipients: [k.recipient], files: prep.files.map((f) => ({ name: f.name, key: `t/${prep.localId}/${f.name}.age`, partSize: 5 * MiB, partUrls: urls(`t/${prep.localId}/${f.name}`, Math.ceil((f.plainSize * 1.001) / (5 * MiB)) + 1) })) }
      const u = await run(['cloud-backup', 'upload'], plan)
      expect(u.code).toBe(0)
      const rows = auditRows('hosting.offsite_backup')
      expect(rows).toHaveLength(i + 1)
      expect(JSON.parse(rows[i]!.detail)).toEqual({ backup: prep.localId, files: prep.files.length })
    }
    expect((await inbox('olga')).length).toBe(before)
  })

  test('a failed copy leaves no line and no notice', async () => {
    const before = auditRows('hosting.export').length
    const r = await run(['archive', '--upload', '--passphrase-random'], { partSize: 5 * MiB, partUrls: ['http://127.0.0.1:1/closed?partNumber=1'] })
    expect(r.code).toBe(1)
    expect(auditRows('hosting.export').length).toBe(before)
  })
})
