// The team export as a plain ZIP (docs/decisions/20261120-team-export-zip.md): the streaming zip writer
// (system/zip-out.ts), the layout people open (system/team-export-zip.ts), and archive --upload with `zip`, which
// encrypts the ZIP to the control plane's one-time key next to the restore archive.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ExportResult } from '@mycel/shared/cloud-protocol'
import { openDb } from '../../server/src/db'
import { readZip } from '../../server/src/files/zip-write'
import { exportPassphrase } from '../../server/src/system/cloud-admin'
import { ageDecrypt, ageDecryptWith, newAgeIdentity, type Bytes } from '../../server/src/system/streams'
import { safeSegment, teamExportEntries } from '../../server/src/system/team-export-zip'
import { ZIP_OUT_LIMITS, ZipSourceChanged, zipOut, type ZipOutEntry } from '../../server/src/system/zip-out'
import { WORK } from '../lib/env'

setDefaultTimeout(60_000)
const W = path.join(WORK, `g-team-export-zip-${process.pid}`)
fs.rmSync(W, { recursive: true, force: true })
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))

async function collect(src: Bytes): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of src) parts.push(c)
  return Buffer.concat(parts)
}
const bytes = (s: string | Uint8Array) => () => (async function* () { yield typeof s === 'string' ? Buffer.from(s) : s })()
const unzipBin = Bun.which('unzip')

describe('zipOut', () => {
  test('folders, deflated files with a data descriptor, Korean names: every reader agrees', async () => {
    const big = crypto.randomBytes(300_000)
    const entries: ZipOutEntry[] = [
      { name: 'files', dir: true, mtime: new Date('2026-11-20T03:00:00Z') },
      { name: 'files/회의록.txt', mtime: new Date('2026-11-20T03:00:00Z'), data: bytes('안녕하세요\n'.repeat(500)) },
      { name: 'files/photo.jpg', mtime: new Date('2026-11-20T03:00:00Z'), compressed: true, data: bytes(big) },
      { name: 'files/empty.txt', mtime: new Date('2026-11-20T03:00:00Z'), data: bytes('') },
    ]
    const zip = await collect(zipOut(entries))
    const r = readZip(zip)
    expect(r.map((e) => e.name)).toEqual(['files/', 'files/회의록.txt', 'files/photo.jpg', 'files/empty.txt'])
    expect(Buffer.from(r[1]!.data).toString()).toBe('안녕하세요\n'.repeat(500))
    expect(Buffer.from(r[2]!.data).equals(big)).toBe(true)
    expect(r[1]!.utf8).toBe(true)
    if (unzipBin) {
      const f = path.join(W, 'a.zip')
      fs.mkdirSync(W, { recursive: true })
      fs.writeFileSync(f, zip)
      const p = Bun.spawnSync([unzipBin, '-t', f])
      expect(p.exitCode).toBe(0)
    }
  })

  test('a big file is stored with its real CRC in the local header (no data descriptor); a file that changes fails the zip', async () => {
    const was = ZIP_OUT_LIMITS.storeFrom
    ZIP_OUT_LIMITS.storeFrom = 1000
    try {
      const data = crypto.randomBytes(5000)
      const zip = await collect(zipOut([{ name: 'big.bin', mtime: new Date(), size: data.length, data: bytes(data) }]))
      const v = new DataView(zip.buffer, zip.byteOffset)
      expect(v.getUint16(6, true) & 0x0008).toBe(0) // no data descriptor
      expect(v.getUint16(8, true)).toBe(0) // stored
      expect(v.getUint32(18, true)).toBe(5000)
      const r = readZip(zip)
      expect(Buffer.from(r[0]!.data).equals(data)).toBe(true)
      let n = 0
      const changing = () => (async function* () { yield n++ === 0 ? data : crypto.randomBytes(5000) })()
      await expect(collect(zipOut([{ name: 'big.bin', mtime: new Date(), size: 5000, data: changing }]))).rejects.toBeInstanceOf(ZipSourceChanged)
    } finally { ZIP_OUT_LIMITS.storeFrom = was }
  })

  test('65,535 entries or more: a zip64 end record with the real count', async () => {
    const n = 65_600
    const zip = await collect(zipOut((function* () { for (let i = 0; i < n; i++) yield { name: `d${i}`, dir: true, mtime: new Date() } as ZipOutEntry })()))
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const eocd = zip.byteLength - 22
    expect(v.getUint32(eocd, true)).toBe(0x06054b50)
    expect(v.getUint16(eocd + 10, true)).toBe(0xffff)
    const loc = eocd - 20
    expect(v.getUint32(loc, true)).toBe(0x07064b50)
    const rec = Number(v.getBigUint64(loc + 8, true))
    expect(v.getUint32(rec, true)).toBe(0x06064b50)
    expect(Number(v.getBigUint64(rec + 32, true))).toBe(n)
    if (unzipBin) {
      const f = path.join(W, 'many.zip')
      fs.mkdirSync(W, { recursive: true })
      fs.writeFileSync(f, zip)
      expect(Bun.spawnSync([unzipBin, '-qt', f]).exitCode).toBe(0)
    }
  })
})

test('safeSegment: names Windows and macOS both accept', () => {
  expect(safeSegment('Q3: plan/draft?.txt')).toBe('Q3_ plan_draft_.txt')
  expect(safeSegment('notes. ')).toBe('notes')
  expect(safeSegment('CON')).toBe('_CON')
  expect(safeSegment('aux.txt')).toBe('_aux.txt')
  expect(safeSegment('')).toBe('_')
  expect(safeSegment('..')).toBe('_')
  expect(safeSegment('invoice\u202Efdp.exe')).toBe('invoicefdp.exe') // no right-to-left override to fake an extension
  expect([...safeSegment('가'.repeat(300) + '.docx')].length).toBe(120)
  expect(safeSegment('가'.repeat(300) + '.docx').endsWith('.docx')).toBe(true)
})

test('exportPassphrase: eight groups of five, nothing to mix up', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const p = exportPassphrase()
    expect(p).toMatch(/^[2-9a-hjkmnp-z]{5}(-[2-9a-hjkmnp-z]{5}){7}$/)
    seen.add(p)
  }
  expect(seen.size).toBe(200)
})

// ---- a small team: folders, a channel with a thread, a private AI answer and a file, a DM, AI chats
const base = path.join(W, 'team')
const teamRoot = path.join(base, 'team')
const dbFile = path.join(base, 'data', 'app.db')
const cfgFile = path.join(base, 'server.json')
beforeAll(() => {
  const mk = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(teamRoot, rel)), { recursive: true }); fs.writeFileSync(path.join(teamRoot, rel), body) }
  mk('shared/plan.md', '# plan\n')
  mk('shared/Q3: budget.txt', 'colon in the name\n')
  // two names that become one once made safe (and, on a case-sensitive disk, two that differ only in case)
  mk('shared/a:b.txt', 'colon\n')
  mk('shared/a_b.txt', 'underscore\n')
  mk('shared/Notes.txt', 'upper\n')
  mk('shared/notes.txt', 'lower\n')
  mk('users/u-olga1/diary.txt', 'olga only\n')
  mk('projects/Launch/node_modules/x/index.js', 'regenerable\n')
  mk('.system/trash/2026-11/x/old.txt', 'TRASHED FILE TEXT\n')
  mk('.system/history/2026-11/y/v1.txt', 'OLD VERSION TEXT\n')
  mk('.system/rooms/r-sales/f-1', 'QUOTE PDF BYTES')
  mk('.system/rooms/r-sales/f-2', 'UNSENT UPLOAD')
  fs.mkdirSync(path.join(teamRoot, 'groups', 'Sales'), { recursive: true })
  fs.mkdirSync(path.join(base, 'data'), { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot }))
  const db = openDb(dbFile)
  db.query(`INSERT INTO users (id, username, name, email, role) VALUES ('u-olga1', 'olga', 'Olga Kim', 'olga@example.com', 'owner'),
    ('u-mina2', 'mina', 'Mina Park', NULL, 'member'), ('u-gone3', 'gone', 'Old Hand', 'gone@example.com', 'member')`).run()
  db.query("UPDATE users SET deleted_at = '2026-11-01T00:00:00Z' WHERE id = 'u-gone3'").run()
  db.query(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamName', '"Acme"'), ('timeZone', '"Asia/Seoul"')`).run()
  db.query(`INSERT INTO rooms (id, kind, name, created_at, activity_at) VALUES ('r-sales', 'group', 'Sales talk', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z'),
    ('r-dm', 'dm', NULL, '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z')`).run()
  db.query("UPDATE rooms SET dm_key = 'u-mina2|u-olga1' WHERE id = 'r-dm'").run()
  db.query(`INSERT INTO room_members (room_id, user_id, joined_at) VALUES ('r-sales', 'u-olga1', '2026-11-18T00:00:00Z'), ('r-sales', 'u-mina2', '2026-11-18T00:00:00Z'),
    ('r-dm', 'u-olga1', '2026-11-18T00:00:00Z'), ('r-dm', 'u-mina2', '2026-11-18T00:00:00Z')`).run()
  const rm = db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, created_at, thread_root_id, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  rm.run('m1', 'r-sales', 1, 'user', 'u-olga1', null, 'room', null, 'Quote for Hanbit attached', '2026-11-18T01:00:00Z', null, null)
  rm.run('m2', 'r-sales', 2, 'user', 'u-mina2', null, 'room', null, 'Looks good', '2026-11-18T01:05:00Z', 'm1', null)
  rm.run('m3', 'r-sales', 3, 'ai', null, 'u-mina2', 'private', 'u-mina2', 'The quote totals 4,200 USD.', '2026-11-18T01:06:00Z', null, null)
  rm.run('m4', 'r-sales', 4, 'user', 'u-mina2', null, 'room', null, 'SECRET deleted line', '2026-11-18T01:07:00Z', null, '2026-11-18T01:08:00Z')
  rm.run('m5', 'r-dm', 1, 'user', 'u-mina2', null, 'room', null, 'lunch?', '2026-11-19T03:00:00Z', null, null)
  db.query(`INSERT INTO room_files (id, room_id, user_id, message_id, name, size, mime, kind, sha256, created_at)
    VALUES ('f-1', 'r-sales', 'u-olga1', 'm1', 'quote: Hanbit.pdf', 15, 'application/pdf', 'file', 'x', '2026-11-18T01:00:00Z'),
    ('f-2', 'r-sales', 'u-mina2', NULL, 'draft.txt', 13, 'text/plain', 'file', 'y', '2026-11-18T01:09:00Z')`).run()
  db.query(`INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES ('c1', 'u-mina2', 'Weekly report', '2026-11-19T00:00:00Z', '2026-11-19T00:10:00Z'),
    ('c2', 'u-mina2', 'Deleted chat', '2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z')`).run()
  db.query("UPDATE chats SET deleted_at = '2026-11-19T01:00:00Z' WHERE id = 'c2'").run()
  const cm = db.query('INSERT INTO messages (id, chat_id, role, content, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  cm.run('q1', 'c1', 'user', 'Draft the weekly report', null, '2026-11-19T00:00:00Z')
  cm.run('a1', 'c1', 'assistant', 'OLD BRANCH answer', 'q1', '2026-11-19T00:01:00Z')
  cm.run('a2', 'c1', 'assistant', 'Here is the weekly report.', 'q1', '2026-11-19T00:02:00Z')
  cm.run('x1', 'c2', 'user', 'DELETED CHAT TEXT', null, '2026-11-19T00:00:00Z')
  db.query("UPDATE chats SET active_leaf_id = 'a2' WHERE id = 'c1'").run()
  db.close()
})

async function plainZip(): Promise<Map<string, string>> {
  const zip = await collect(zipOut(teamExportEntries({ dbFile, teamRoot, now: new Date('2026-11-20T05:00:00Z') })))
  return new Map(readZip(zip).map((e) => [e.name, Buffer.from(e.data).toString('utf8')]))
}

describe('teamExportEntries', () => {
  test('the layout people open: README, files by person name, chats as text, data as JSON', async () => {
    const z = await plainZip()
    const names = [...z.keys()]
    expect(z.get('README.txt')).toContain('Acme: export of the whole team')
    expect(z.get('README.txt')).toContain('Made 2026-11-20 14:00 (Asia/Seoul)')
    expect(z.get('files/shared/plan.md')).toBe('# plan\n')
    expect(z.get('files/shared/Q3_ budget.txt')).toBe('colon in the name\n')
    // two names that would be one: both kept, the second one renamed
    expect([z.get('files/shared/a_b.txt'), z.get('files/shared/a_b (2).txt')].sort()).toEqual(['colon\n', 'underscore\n'])
    const caseSensitive = fs.readdirSync(path.join(teamRoot, 'shared')).filter((n) => n.toLowerCase() === 'notes.txt').length === 2
    if (caseSensitive) expect([z.get('files/shared/Notes.txt'), z.get('files/shared/notes (2).txt')].sort()).toEqual(['lower\n', 'upper\n'])
    expect(z.get('files/people/Olga Kim/diary.txt')).toBe('olga only\n')
    expect(names.some((n) => n.includes('node_modules') || n.includes('.system') || n.includes('trash') || n.includes('history'))).toBe(false)
    expect(names).toContain('files/groups/Sales/')

    const sales = z.get('chats/Channels/Sales talk.txt')!
    expect(sales).toContain('Group chat · 2 people: Mina Park, Olga Kim')
    expect(sales).toContain('---- 2026-11-18 ----')
    expect(sales).toContain('[10:00] Olga Kim: Quote for Hanbit attached')
    expect(sales).toContain('[files: quote_ Hanbit.pdf]')
    expect(sales).toContain('    ↳ [10:05] Mina Park: Looks good')
    expect(sales).toContain('AI (asked by Mina Park) [only Mina Park saw this]: The quote totals 4,200 USD.')
    expect(sales).not.toContain('SECRET deleted line')
    expect(z.get('chats/Channels/Sales talk - files/quote_ Hanbit.pdf')).toBe('QUOTE PDF BYTES')
    expect(z.get('chats/Direct messages/Mina Park, Olga Kim.txt')).toContain('Mina Park: lunch?')

    const chat = z.get('chats/AI chats/Mina Park/2026-11-19 Weekly report.txt')!
    expect(chat).toContain('[09:00] Mina Park: Draft the weekly report')
    expect(chat).toContain('[09:02] AI: Here is the weekly report.')
    expect(chat).not.toContain('OLD BRANCH')
    const all = [...z.values()].join('\n')
    expect(all).not.toContain('DELETED CHAT TEXT')
    expect(all).not.toContain('TRASHED FILE TEXT')
    expect(all).not.toContain('OLD VERSION TEXT')
    expect(all).not.toContain('UNSENT UPLOAD') // a file uploaded but never sent stays out

    const people = JSON.parse(z.get('data/people.json')!) as { id: string; status: string; folder: string }[]
    expect(people.find((p) => p.id === 'u-gone3')!.status).toBe('removed')
    expect((people.find((p) => p.id === 'u-gone3') as unknown as { email: string | null }).email).toBeNull()
    expect(people.find((p) => p.id === 'u-olga1')!.folder).toBe('files/people/Olga Kim')
    const conv = JSON.parse(z.get('data/conversations.json')!) as { id: string; kind: string; text: string; json: string }[]
    expect(conv.map((c) => c.kind).sort()).toEqual(['ai_chat', 'direct_message', 'group_chat'])
    for (const c of conv) { expect(z.has(c.text)).toBe(true); expect(z.has(c.json)).toBe(true) }
    const msgs = JSON.parse(z.get('data/messages/r-sales.json')!) as { id: string; threadOf: string | null; onlyFor: string | null; files: string[] }[]
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(msgs[1]!.threadOf).toBe('m1')
    expect(msgs[2]!.onlyFor).toBe('u-mina2')
    expect(msgs[0]!.files).toEqual(['quote_ Hanbit.pdf'])
  })
})

test('a file swapped for a link while the export runs is refused, never followed', async () => {
  const secret = path.join(base, 'data', 'outside-secret.txt')
  fs.writeFileSync(secret, 'OUTSIDE SECRET')
  const victim = path.join(teamRoot, 'shared', 'swap-me.txt')
  fs.writeFileSync(victim, 'harmless')
  try {
    let hit: ZipOutEntry | undefined
    for await (const e of teamExportEntries({ dbFile, teamRoot })) if (e.name === 'files/shared/swap-me.txt') hit = e
    expect(hit).toBeDefined()
    fs.rmSync(victim)
    fs.symlinkSync(secret, victim)
    await expect(collect(hit!.data!())).rejects.toThrow()
  } finally { fs.rmSync(victim, { force: true }); fs.rmSync(secret, { force: true }) }
})

describe('archive --upload with zip', () => {
  const stored = new Map<string, Uint8Array>()
  let s3: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    s3 = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        const b = new Uint8Array(await req.arrayBuffer())
        const u = new URL(req.url)
        stored.set(`${u.pathname}#${u.searchParams.get('partNumber')}`, b)
        return new Response(null, { headers: { etag: `"${crypto.createHash('md5').update(b).digest('hex')}"` } })
      },
    })
  })
  afterAll(() => s3.stop(true))
  const urls = (key: string, n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1:${s3.port}/b/${key}?partNumber=${i + 1}`)
  const object = (key: string, n: number) => Buffer.concat(Array.from({ length: n }, (_, i) => stored.get(`/b/${key}#${i + 1}`)!))
  const MiB = 1024 * 1024

  async function run(args: string[], stdin: unknown) {
    const p = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), ...args], {
      env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' }, stdin: new Blob([JSON.stringify(stdin)]), stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out, err }
  }

  test('both files: the restore archive with the passphrase, the plain ZIP only for the one-time key', async () => {
    const k = await newAgeIdentity()
    const r = await run(['archive', '--upload', '--passphrase-random'], {
      partSize: 5 * MiB, partUrls: urls('x.tar.zst.age', 3), zip: { recipient: k.recipient, partSize: 5 * MiB, partUrls: urls('x.zip.age', 3) },
    })
    expect(r.code).toBe(0)
    const res = ExportResult.parse(JSON.parse(r.out))
    expect(res.zip).toBeDefined()
    expect(res.passphrase).toMatch(/^[2-9a-hjkmnp-z]{5}(-[2-9a-hjkmnp-z]{5}){7}$/)
    const zipAge = object('x.zip.age', res.zip!.parts.length)
    expect(zipAge.length).toBe(res.zip!.size)
    expect(crypto.createHash('sha256').update(zipAge).digest('hex')).toBe(res.zip!.sha256)
    // the passphrase does not open the ZIP: only the control plane's key does
    await expect(collect(ageDecrypt((async function* () { yield zipAge })(), res.passphrase))).rejects.toThrow()
    const zip = await collect(ageDecryptWith((async function* () { yield zipAge })(), [k.identity]))
    const names = readZip(zip).map((e) => e.name)
    expect(names[0]).toBe('README.txt')
    expect(names).toContain('chats/Channels/Sales talk.txt')
    // the restore archive opens with the passphrase, as before
    const tarAge = object('x.tar.zst.age', res.parts.length)
    expect((await collect(ageDecrypt((async function* () { yield tarAge })(), res.passphrase))).length).toBeGreaterThan(0)
  })

  test('without zip (an older control plane): the answer has no zip, as before', async () => {
    const r = await run(['archive', '--upload', '--passphrase-random'], { partSize: 5 * MiB, partUrls: urls('y.tar.zst.age', 3) })
    expect(r.code).toBe(0)
    expect(ExportResult.parse(JSON.parse(r.out)).zip).toBeUndefined()
  })

  test('archive --zip --out: the plain ZIP on the own server, mode 600', async () => {
    const out = path.join(W, 'local.zip')
    const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), 'archive', '--zip', '--out', out], {
      env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' },
    })
    expect(p.exitCode).toBe(0)
    expect(fs.statSync(out).mode & 0o777).toBe(0o600)
    expect(readZip(new Uint8Array(fs.readFileSync(out))).some((e) => e.name === 'files/shared/plan.md')).toBe(true)
  })
})
