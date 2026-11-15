// QA TC-3082: files the AI saved before the saving tools hid stored keys (fix/files-hide-keys, TC-3041), and their
// search text (the text cache of docx, pdf, hwpx), can still hold the person's stored connection key. Once at a start
// (integrations/connections/file-scan.ts) they are found, nothing is rewritten, and the person whose key it is gets
// one notice that lists the ones they may open.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices } from '../lib/fake-services'
import { FILE_SCAN_KEY, FILE_SCAN_LIMITS, findKeysInOldFiles, storedKeyFilesOf } from '../../server/src/integrations/connections/file-scan'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(60_000)

// words and digits only, so the secret-shape detector (shared/src/secrets.ts) does not see it
const KEY = ['QA', 'OLD', 'FILE', '3082', 'NOT', 'REAL'].join('-')
const B64 = Buffer.from(KEY).toString('base64')

let h: Harness, svc: FakeServices

const at = () => new Date().toISOString()
function put(rel: string, body: string | Buffer) {
  const abs = path.join(h.ctx.config.teamRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}
function event(userId: string, rel: string, turnId: string | null, action = 'create') {
  h.ctx.db.query('INSERT INTO file_events (turn_id, user_id, path, action, size, sha256, at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(turnId, userId, rel, action, 'x', at())
}
const mark = () => h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(FILE_SCAN_KEY)
const notices = async (who = 'alice') => (await h.api(who).call(API.listNotifications, {})).items.filter((n) => n.code === 'files.stored_key')

describe('older AI-made files with a stored key (file-scan.ts)', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-integrations-secret-old-files' })
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
    svc = new FakeServices()
    integrationsOf(h.ctx, { net: svc.net() })
    const qa = await h.api('alice').call(API.createIntegration, { body: { kind: 'http', name: 'QA API', url: `${svc.base}/echo`, auth: 'bearer', secret: KEY, writePolicy: 'ask' } })
    expect(qa.status).toBe('connected')
    // the start's own run (5 s after start) is over before the tests run theirs
    await waitFor(() => mark(), { timeoutMs: 15_000, what: 'the start-up run' }).catch(() => {})
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(FILE_SCAN_KEY)

    // what alice's AI turns saved before the fix
    put('users/alice/notes.md', `API setup\nKEY=${KEY}\n`)
    event('alice', 'users/alice/notes.md', 'turn-1')
    put('users/alice/report.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]))
    event('alice', 'users/alice/report.docx', 'turn-2')
    // the docx's search text (the text cache) has the key in base64
    const cache = h.ctx.files.office.cachePath('users/alice/report.docx')
    fs.mkdirSync(path.dirname(cache), { recursive: true })
    fs.writeFileSync(cache, `Report\n\nToken: ${B64}\n`)
    // made by the AI, then updated by the AI without the key: not found
    put('users/alice/clean.md', 'nothing secret here')
    event('alice', 'users/alice/clean.md', 'turn-3')
    event('alice', 'users/alice/clean.md', 'turn-4', 'update')
    // alice's own upload with her key in it (no turn): hers, left alone
    put('users/alice/mine.md', `my own ${KEY}`)
    event('alice', 'users/alice/mine.md', null, 'upload')
    // bob's AI saved alice's key: not bob's key, nobody is told
    put('users/bob/copy.md', `found ${KEY}`)
    event('bob', 'users/bob/copy.md', 'turn-bob')
    // a file alice's turn saved in a folder she may not read now: not looked at, never listed for her
    put('users/bob/moved.md', `moved ${KEY}`)
    event('alice', 'users/bob/moved.md', 'turn-5')
    // made by the AI and deleted since
    event('alice', 'users/alice/gone.md', 'turn-6')
  })
  afterAll(async () => { svc?.stop(); await h?.close() })

  test('finds the files and their search text with the key, tells the person once, rewrites nothing', async () => {
    const r = await findKeysInOldFiles(h.ctx)
    expect(r).toEqual({ scanned: 3, found: 2, people: 1, done: true }) // notes, report, clean (bob has no keys; the rest cannot be read)
    expect(h.ctx.db.query('SELECT user_id, path FROM stored_key_files ORDER BY path').all()).toEqual([
      { user_id: 'alice', path: 'users/alice/notes.md' }, { user_id: 'alice', path: 'users/alice/report.docx' },
    ])
    // nothing is rewritten
    expect(fs.readFileSync(path.join(h.ctx.config.teamRoot, 'users/alice/notes.md'), 'utf8')).toContain(KEY)
    expect(fs.readFileSync(h.ctx.files.office.cachePath('users/alice/report.docx'), 'utf8')).toContain(B64)
    expect(mark()).toEqual({ value: '1' })

    const mine = await notices('alice')
    expect(mine).toHaveLength(1)
    expect(mine[0]!.keyFiles).toEqual({ n: 2, files: [{ path: 'users/alice/notes.md' }, { path: 'users/alice/report.docx' }] })
    expect(mine[0]!.link).toBeNull()
    // one notice per scan version: a later version may tell again
    expect(mine[0]!.sourceId).toBe('scan-v1')
    // never the key, in no form
    expect(JSON.stringify(mine)).not.toContain(KEY)
    expect(JSON.stringify(mine)).not.toContain(B64)
    expect(await notices('bob')).toEqual([])

    // once: the mark stops a second run, and no second notice comes
    expect(await findKeysInOldFiles(h.ctx)).toEqual({ scanned: 0, found: 0, people: 0, done: true })
    expect(await notices('alice')).toHaveLength(1)
  })

  test('the list is read when shown: a file that is gone or that the person may no longer open drops off', async () => {
    fs.rmSync(path.join(h.ctx.config.teamRoot, 'users/alice/notes.md'))
    expect(storedKeyFilesOf(h.ctx, 'alice')).toEqual({ n: 1, files: [{ path: 'users/alice/report.docx' }] })
    // a path the person may not read (another person's folder) is never listed, even if a row says so
    h.ctx.db.query('INSERT INTO stored_key_files (user_id, path, found_at) VALUES (?, ?, ?)').run('alice', 'users/bob/moved.md', at())
    expect(storedKeyFilesOf(h.ctx, 'alice').files.map((f) => f.path)).toEqual(['users/alice/report.docx'])
    fs.rmSync(path.join(h.ctx.config.teamRoot, 'users/alice/report.docx'))
    expect((await notices('alice'))[0]!.keyFiles).toEqual({ n: 0, files: [] })
    h.ctx.db.query("DELETE FROM stored_key_files WHERE user_id = 'alice'").run()
  })

  test('not marked done while a stored key cannot be read; the next start that reads every key finishes it', async () => {
    const db = h.ctx.db
    const own = db.query("SELECT id FROM integrations WHERE scope = 'personal' AND owner_user_id = 'alice' AND secret_enc IS NOT NULL LIMIT 1").get() as { id: string }
    db.run('CREATE TEMP TABLE broken AS SELECT * FROM integrations WHERE id = ?', [own.id])
    db.run("UPDATE broken SET id = 'int-broken', name = 'Broken API', slug = 'brokenapi', secret_enc = 'not-a-sealed-secret'")
    db.run('INSERT INTO integrations SELECT * FROM broken')
    db.run('DROP TABLE broken')
    try {
      put('users/alice/later.md', `again ${KEY}`)
      event('alice', 'users/alice/later.md', 'turn-7')
      db.query('DELETE FROM settings WHERE key = ?').run(FILE_SCAN_KEY)
      // the key that can be read is still looked for; the mark waits
      const r = await findKeysInOldFiles(h.ctx)
      expect(r.found).toBe(1)
      expect(r.done).toBe(false)
      expect(mark()).toBeNull()
      db.run("DELETE FROM integrations WHERE id = 'int-broken'")
      expect((await findKeysInOldFiles(h.ctx)).done).toBe(true)
      expect(mark()).toEqual({ value: '1' })
    } finally {
      db.run("DELETE FROM integrations WHERE id = 'int-broken'")
    }
  })

  test('bounded: at most the newest `files` files per run, a pause after `batch` files or `pauseBytes` read, and a stopping server writes nothing', async () => {
    const db = h.ctx.db
    db.query('DELETE FROM settings WHERE key = ?').run(FILE_SCAN_KEY)
    db.query("DELETE FROM stored_key_files WHERE user_id = 'alice'").run()
    for (let i = 0; i < 6; i++) { put(`users/alice/many-${i}.md`, `k ${KEY}`); event('alice', `users/alice/many-${i}.md`, `turn-m${i}`) }
    const limits = { ...FILE_SCAN_LIMITS, files: 3, batch: 2 }
    const stopped = await findKeysInOldFiles(h.ctx, { limits, stopped: () => true })
    expect(stopped.done).toBe(false)
    expect(db.query("SELECT COUNT(*) AS n FROM stored_key_files WHERE user_id = 'alice'").get()).toEqual({ n: 0 })
    expect(mark()).toBeNull()
    // big files: it pauses after the bytes, not only after `batch` files (a stopping server is seen at the first pause)
    const early = await findKeysInOldFiles(h.ctx, { limits: { ...limits, batch: 1000, pauseBytes: 1 }, stopped: () => true })
    expect(early).toEqual({ scanned: 1, found: 1, people: 0, done: false })
    expect(db.query("SELECT COUNT(*) AS n FROM stored_key_files WHERE user_id = 'alice'").get()).toEqual({ n: 0 })
    const r = await findKeysInOldFiles(h.ctx, { limits })
    expect(r).toEqual({ scanned: 3, found: 3, people: 1, done: true })
    expect((db.query("SELECT path FROM stored_key_files WHERE user_id = 'alice' ORDER BY path").all() as { path: string }[]).map((x) => x.path)).toEqual(['users/alice/many-3.md', 'users/alice/many-4.md', 'users/alice/many-5.md'])
  })

  test('a server without stored keys marks it done at once and reads no file', async () => {
    const db = h.ctx.db
    db.query('DELETE FROM settings WHERE key = ?').run(FILE_SCAN_KEY)
    db.run('CREATE TEMP TABLE kept AS SELECT id, secret_enc FROM integrations WHERE secret_enc IS NOT NULL')
    db.run('UPDATE integrations SET secret_enc = NULL WHERE id IN (SELECT id FROM kept)')
    try {
      expect(await findKeysInOldFiles(h.ctx)).toEqual({ scanned: 0, found: 0, people: 0, done: true })
    } finally {
      db.run('UPDATE integrations SET secret_enc = (SELECT secret_enc FROM kept WHERE kept.id = integrations.id) WHERE id IN (SELECT id FROM kept)')
      db.run('DROP TABLE kept')
    }
  })
})
