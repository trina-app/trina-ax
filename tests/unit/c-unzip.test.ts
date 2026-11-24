// unzip_file through the tool path (the MCP handler, as an engine calls it), QA TC-4847: a zip with folders into a new
// folder next to it (named after the zip, or after the one folder everything sits in), Korean names (UTF-8 flag,
// decomposed, and CP949 from Windows without the flag), junk left out, a taken name gets " (2)" (nothing saved over),
// list_only; refused with nothing saved: "..", absolute paths, encryption, bombs, damaged zips, other archives; links
// skipped; the folder rules (read-only, no access, a wider folder without a card, skills); the per-turn file count; the
// file events and the tool lists.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { UnzipFileInput } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { crc32 } from '../../server/src/files/zip-write'
import { _unzipSlotsForTest, decodeName, inflateEntryToFile, planZip, unzipSlot, UNZIP_LIMITS } from '../../server/src/files/unzip'
import { ROOM_FILE_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS, namedPaths } from '../../server/src/rooms/ai-tools'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { stepLabel } from '@mycel/shared'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { confirmSources } from '../../server/src/tools/make-file'
import { componentC } from '../../server/src/team-files/component'
import { fileEvent } from '../../server/src/files/store'
import { docx, UNC } from '../lib/office-fixture'
import crypto from 'node:crypto'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-unzip') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const read = (rel: string) => fs.readFileSync(file(rel), 'utf8')
const ls = (rel: string) => fs.readdirSync(file(rel)).sort()
let rpcId = 0
function turn(user: Person, o: { files?: TurnFiles; confirmWidening?: ToolCtx['confirmWidening'] } = {}) {
  const turnId = A.turn(user, A.chat(user))
  const h = makeHandler(A.ctx.files, A.ctx.db, { ...A.toolCtx(user, turnId), ...(o.files ? { files: o.files } : {}), ...(o.confirmWidening ? { confirmWidening: o.confirmWidening } : {}) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content.map((c: { text?: string }) => c.text ?? '').join('\n') as string, isError: !!r.result.isError }
  }
  return Object.assign(call, { turnId })
}

// ---- a minimal zip writer with everything a crafted zip can set ----
interface Part {
  name: string | Uint8Array
  data?: string | Uint8Array
  /** general purpose flags (default: bit 11 when the name is a non-ASCII string) */
  flags?: number
  /** upper byte of "version made by" (3 = Unix) and the external attributes */
  madeBy?: number
  external?: number
  stored?: boolean
  /** lie about the sizes or the checksum */
  usize?: number
  crc?: number
  /** no data of its own: points at the local header and data of part number `shares` (an overlap bomb) */
  shares?: number
}
function zip(parts: Part[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  const offsets: number[] = []
  for (const p of parts) {
    const nameStr = typeof p.name === 'string'
    const name = nameStr ? Buffer.from(p.name as string, 'utf8') : Buffer.from(p.name as Uint8Array)
    const flags = p.flags ?? (nameStr && /[^\x00-\x7f]/.test(p.name as string) ? 0x800 : 0)
    const data = typeof p.data === 'string' ? Buffer.from(p.data) : Buffer.from(p.data ?? new Uint8Array())
    const body = p.stored ? data : zlib.deflateRawSync(data)
    const crc = p.crc ?? crc32(data)
    const usize = p.usize ?? data.length
    const method = p.stored ? 0 : 8
    if (p.shares !== undefined) {
      const c = Buffer.from(centrals[p.shares * 2]!)
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offsets[p.shares]!, 42)
      centrals.push(c, name); offsets.push(offsets[p.shares]!)
      continue
    }
    offsets.push(off)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(flags, 6); l.writeUInt16LE(method, 8)
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(usize, 22); l.writeUInt16LE(name.length, 26)
    locals.push(l, name, body)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt8(20, 4); c.writeUInt8(p.madeBy ?? 0, 5); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE((p.external ?? 0) >>> 0, 38); c.writeUInt32LE(off, 42)
    centrals.push(c, name)
    off += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(parts.length, 8); e.writeUInt16LE(parts.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, e])
}
/** CP949 bytes of a few Hangul words (what Korean Windows writes without the UTF-8 flag) */
const CP949: Record<string, number[]> = {
  '보고서': [0xba, 0xb8, 0xb0, 0xed, 0xbc, 0xad],
  '자료': [0xc0, 0xda, 0xb7, 0xe1],
}
const cp = (...xs: (string | number[])[]) => Uint8Array.from(xs.flatMap((x) => (typeof x === 'string' ? [...Buffer.from(x, 'latin1')] : x)))

const D = 'groups/marketing/zips'
/** a folder inside D that everyone can read (marketing writes it): wider than D, and alice may write there */
function openFolder() {
  const db = A.ctx.db
  if (db.query("SELECT 1 FROM folders WHERE path = ?").get(`${D}/open`)) return
  db.query('INSERT INTO folders (id, path) VALUES (?,?)').run('f_zips_open', `${D}/open`)
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,'everyone',NULL,'read')").run(crypto.randomUUID(), 'f_zips_open')
}
const events = (turnId: string) => A.ctx.db.query('SELECT path, action, detail FROM file_events WHERE turn_id = ? ORDER BY id').all(turnId) as { path: string; action: string; detail: string | null }[]

describe('the input', () => {
  test('a path; to_folder and list_only optional; nothing else', () => {
    const ok = (v: unknown) => UnzipFileInput.safeParse(v).success
    expect(ok({ path: 'a.zip' })).toBe(true)
    expect(ok({ path: 'a.zip', to_folder: 'x', list_only: true })).toBe(true)
    expect(ok({})).toBe(false)
    expect(ok({ path: 'a.zip', overwrite: true })).toBe(false)
  })
})

describe('names', () => {
  test('UTF-8 with the flag, UTF-8 without it, decomposed Hangul, CP949 from Windows, an Info-ZIP Unicode path', () => {
    const e = (nameBytes: Uint8Array, flags = 0, extra = new Uint8Array()) => ({ nameBytes, flags, extra })
    expect(decodeName(e(Buffer.from('계약서.pdf'), 0x800))).toBe('계약서.pdf')
    expect(decodeName(e(Buffer.from('계약서.pdf')))).toBe('계약서.pdf')
    expect(decodeName(e(Buffer.from('계약서.pdf'.normalize('NFD'))))).toBe('계약서.pdf')
    expect(decodeName(e(cp(CP949['보고서']!, '/', CP949['자료']!, '.txt')))).toBe('보고서/자료.txt')
    // the Unicode path field (0x7075) wins over a CP437-looking raw name when its CRC matches
    const raw = Buffer.from('report.txt')
    const u = Buffer.from('보고서.txt')
    const x = Buffer.alloc(9 + u.length)
    x.writeUInt16LE(0x7075, 0); x.writeUInt16LE(5 + u.length, 2); x.writeUInt8(1, 4); x.writeUInt32LE(crc32(raw), 5); u.copy(x, 9)
    expect(decodeName(e(raw, 0, x))).toBe('보고서.txt')
  })

  test('the plan: one folder around everything is taken off; junk left out; backslashes are folders', () => {
    const p = planZip(zip([
      { name: 'pack/' }, { name: 'pack/a.txt', data: 'a' }, { name: 'pack\\sub\\b.txt', data: 'b' },
      { name: '__MACOSX/pack/._a.txt', data: 'x' }, { name: 'pack/.DS_Store', data: 'x' }, { name: 'pack/Thumbs.db', data: 'x' },
    ]))
    expect(p.top).toBe('pack')
    expect(p.files.map((f) => f.segs.join('/'))).toEqual(['a.txt', 'sub/b.txt'])
    expect(p.junk).toBe(3)
    expect(planZip(zip([{ name: 'pack/a.txt', data: 'a' }]), { unwrap: false }).files[0]!.segs).toEqual(['pack', 'a.txt'])
  })
})

describe('unzipping into the team folder', () => {
  test('a zip with folders: a new folder next to it named after it, names and bytes kept, the zip unchanged; events and links', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 7)])
    const z = zip([
      { name: '견적서.pdf', data: pdf },
      { name: 'notes/' },
      { name: 'notes/회의록.md', data: '# 회의록\n' },
      { name: 'notes/deep/a.txt', data: 'deep' },
      { name: 'empty/' },
    ])
    put(`${D}/client-pack_20261118.zip`, z)
    const call = turn('alice')
    const r = await call('unzip_file', { path: `${D}/client-pack_20261118.zip` })
    expect(r.isError, r.text).toBe(false)
    const F = `${D}/client-pack_20261118`
    expect(ls(F)).toEqual(['empty', 'notes', '견적서.pdf'])
    expect(fs.readFileSync(file(`${F}/견적서.pdf`)).equals(pdf)).toBe(true)
    expect(read(`${F}/notes/회의록.md`)).toBe('# 회의록\n')
    expect(read(`${F}/notes/deep/a.txt`)).toBe('deep')
    expect(fs.readFileSync(file(`${D}/client-pack_20261118.zip`)).equals(z)).toBe(true)
    expect(r.text).toContain(`into the new folder ${F}: 3 files saved`)
    expect(r.text).toContain('notes/회의록.md')
    expect(r.text).toContain('/files/view?path=')
    // every file and every new folder is in the file history of this turn, by unzip_file
    const ev = events(call.turnId)
    expect(ev.filter((e) => e.action === 'create' && JSON.parse(e.detail ?? '{}').tool === 'unzip_file').map((e) => e.path).sort()).toEqual(
      [F, `${F}/empty`, `${F}/notes`, `${F}/notes/deep`, `${F}/notes/deep/a.txt`, `${F}/notes/회의록.md`, `${F}/견적서.pdf`].sort())
    expect(JSON.parse(ev.find((e) => e.path === `${F}/견적서.pdf`)!.detail!).from).toBe(`${D}/client-pack_20261118.zip`)
  })

  test('CP949 names from Windows, decomposed names, one folder around everything', async () => {
    put(`${D}/win.zip`, zip([
      { name: cp(CP949['보고서']!, '/'), flags: 0 },
      { name: cp(CP949['보고서']!, '/', CP949['자료']!, '.txt'), data: 'cp949', flags: 0 },
      { name: '보고서/사진.txt'.normalize('NFD'), data: 'nfd', flags: 0 },
    ]))
    const r = await turn('alice')('unzip_file', { path: `${D}/win.zip` })
    expect(r.isError, r.text).toBe(false)
    expect(ls(`${D}/보고서`)).toEqual(['사진.txt', '자료.txt'])
    expect(read(`${D}/보고서/자료.txt`)).toBe('cp949')
  })

  test('a taken folder name gets " (2)"; into an existing to_folder a taken file name gets " (2)" and the old file stays', async () => {
    put(`${D}/again.zip`, zip([{ name: 'a.txt', data: 'new' }, { name: 'b.txt', data: 'b' }]))
    expect((await turn('alice')('unzip_file', { path: `${D}/again.zip` })).isError).toBe(false)
    const r = await turn('alice')('unzip_file', { path: `${D}/again.zip` })
    expect(r.isError, r.text).toBe(false)
    expect(ls(`${D}/again (2)`)).toEqual(['a.txt', 'b.txt'])
    put(`${D}/target/a.txt`, 'old')
    const into = await turn('alice')('unzip_file', { path: `${D}/again.zip`, to_folder: `${D}/target` })
    expect(into.isError, into.text).toBe(false)
    expect(read(`${D}/target/a.txt`)).toBe('old')
    expect(read(`${D}/target/a (2).txt`)).toBe('new')
    expect(into.text).toContain('a.txt -> a (2).txt')
    expect(into.text).toContain('into the folder')
  })

  test('to_folder that already ends in the zip\'s one top folder does not double it (TC-4865); another name keeps it', async () => {
    put(`${D}/bundle.zip`, zip([{ name: '계약-묶음/' }, { name: '계약-묶음/계약서.txt', data: 'c' }, { name: '계약-묶음/부록/a.txt', data: 'a' }]))
    const r = await turn('alice')('unzip_file', { path: `${D}/bundle.zip`, to_folder: `${D}/hiring/계약-묶음` })
    expect(r.isError, r.text).toBe(false)
    expect(ls(`${D}/hiring/계약-묶음`)).toEqual(['계약서.txt', '부록'])
    // the name in another letter case / decomposed form is the same folder name
    put(`${D}/Pack.zip`, zip([{ name: 'Pack/b.txt', data: 'b' }]))
    expect((await turn('alice')('unzip_file', { path: `${D}/Pack.zip`, to_folder: `${D}/hiring/pack` })).isError).toBe(false)
    expect(ls(`${D}/hiring/pack`)).toEqual(['b.txt'])
    const nfd = await turn('alice')('unzip_file', { path: `${D}/bundle.zip`, to_folder: `${D}/hiring2/${'계약-묶음'.normalize('NFD')}` })
    expect(nfd.isError, nfd.text).toBe(false)
    expect(fs.readdirSync(file(`${D}/hiring2`)).map((n) => n.normalize('NFC'))).toEqual(['계약-묶음'])
    expect(fs.readdirSync(path.join(file(`${D}/hiring2`), fs.readdirSync(file(`${D}/hiring2`))[0]!)).sort()).toEqual(['계약서.txt', '부록'])
    // a different to_folder keeps the zip's folder inside it
    expect((await turn('alice')('unzip_file', { path: `${D}/bundle.zip`, to_folder: `${D}/hiring/other` })).isError).toBe(false)
    expect(ls(`${D}/hiring/other`)).toEqual(['계약-묶음'])
  })
  test('list_only lists and saves nothing', async () => {
    put(`${D}/peek.zip`, zip([{ name: 'x/one.txt', data: '1' }, { name: 'x/two.txt', data: '22' }]))
    const before = ls(D)
    const r = await turn('alice')('unzip_file', { path: `${D}/peek.zip`, list_only: true })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('x/one.txt')
    expect(r.text).toContain('Nothing was saved')
    expect(ls(D)).toEqual(before)
  })

  test('a link is skipped and named, the rest saved; no link is made', async () => {
    put(`${D}/links.zip`, zip([
      { name: 'ok.txt', data: 'fine' },
      { name: 'evil-link', data: '../../../../etc/passwd', madeBy: 3, external: (0o120777 << 16) >>> 0 },
      { name: 'dev', data: '', madeBy: 3, external: (0o020644 << 16) >>> 0 },
    ]))
    const r = await turn('alice')('unzip_file', { path: `${D}/links.zip` })
    expect(r.isError, r.text).toBe(false)
    expect(ls(`${D}/links`)).toEqual(['ok.txt'])
    expect(r.text).toMatch(/evil-link: a link/)
    expect(r.text).toMatch(/dev: not a regular file/)
  })
})

describe('refused, nothing saved', () => {
  const nothing = async (name: string, z: Uint8Array, re: RegExp) => {
    put(`${D}/bad/${name}`, z)
    const before = ls(`${D}/bad`)
    const r = await turn('alice')('unzip_file', { path: `${D}/bad/${name}` })
    expect(r.isError, r.text).toBe(true)
    expect(r.text).toMatch(re)
    expect(ls(`${D}/bad`)).toEqual(before)
    expect(fs.existsSync(path.join(A.team, 'groups', 'evil.txt'))).toBe(false)
    return r
  }
  test('zip slip: ".." anywhere, an absolute path, a drive letter', async () => {
    await nothing('slip.zip', zip([{ name: 'ok.txt', data: 'x' }, { name: '../../evil.txt', data: 'x' }]), /outside its folder.*nothing was saved/)
    await nothing('slip2.zip', zip([{ name: 'a/../../../evil.txt', data: 'x' }]), /outside its folder/)
    await nothing('slip3.zip', zip([{ name: 'a\\..\\..\\evil.txt', data: 'x' }]), /outside its folder/)
    await nothing('abs.zip', zip([{ name: '/etc/evil.txt', data: 'x' }]), /outside its folder/)
    await nothing('drive.zip', zip([{ name: 'C:\\evil.txt', data: 'x' }]), /outside its folder/)
  })
  test('encrypted, damaged, a bomb, a lying header, too many bytes, not a zip', async () => {
    await nothing('locked.zip', zip([{ name: 'a.txt', data: 'x', flags: 1 }]), /password-protected/)
    const good = zip([{ name: 'a.txt', data: 'hello' }])
    await nothing('cut.zip', good.subarray(0, good.length - 10), /damaged/)
    await nothing('bomb.zip', zip([{ name: 'zeros.bin', data: Buffer.alloc(30 * 1024 * 1024) }]), /too large or too complex.*expands more than 100 times/)
    await nothing('huge.zip', zip([{ name: 'big.bin', data: 'x', usize: 300 * 1024 * 1024 }]), /too large or too complex/)
    await nothing('rar.rar', Buffer.from('Rar!\x1a\x07\x00 not really'), /only \.zip, \.tar, \.tar\.gz \/ \.tgz and \.gz files can be unzipped/)
    // the header says 5 bytes, the data inflates to more: that file is not saved
    const r = await turn('alice')('unzip_file', { path: (put(`${D}/bad/liar.zip`, zip([{ name: 'liar.txt', data: 'much more than five', usize: 5 }])), `${D}/bad/liar.zip`) })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/nothing from .* was saved[\s\S]*liar\.txt: damaged|larger than its header/)
    expect(fs.existsSync(file(`${D}/bad/liar`))).toBe(false)
    // a wrong checksum
    const c = await turn('alice')('unzip_file', { path: (put(`${D}/bad/crc.zip`, zip([{ name: 'c.txt', data: 'abc', crc: 1 }])), `${D}/bad/crc.zip`) })
    expect(c.isError).toBe(true)
    expect(c.text).toContain('checksum')
  })
  test('a partial failure says what was saved and what was not', async () => {
    put(`${D}/half.zip`, zip([{ name: 'good.txt', data: 'good' }, { name: 'bad.txt', data: 'abc', crc: 1 }]))
    const r = await turn('alice')('unzip_file', { path: `${D}/half.zip` })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('1 file saved')
    expect(r.text).toMatch(/NOT saved \(1\):\n- bad\.txt: damaged/)
    expect(ls(`${D}/half`)).toEqual(['good.txt'])
  })
})

describe('the folder rules', () => {
  test('a read-only place is refused; a zip the person cannot open is not found; no write access in to_folder', async () => {
    put('projects/falcon/files.zip', zip([{ name: 'a.txt', data: 'x' }]))
    const ro = await turn('bob')('unzip_file', { path: 'projects/falcon/files.zip' })
    expect(ro.isError).toBe(true)
    expect(ro.text).toContain('read-only')
    expect(ls('projects/falcon').filter((n) => n.startsWith('files'))).toEqual(['files.zip'])
    put(`${D}/theirs.zip`, zip([{ name: 'a.txt', data: 'x' }]))
    const hidden = await turn('bob')('unzip_file', { path: `${D}/theirs.zip` })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain('not found or no access')
    const finance = await turn('alice')('unzip_file', { path: `${D}/theirs.zip`, to_folder: 'groups/finance/in' })
    expect(finance.isError).toBe(true)
    expect(fs.existsSync(file('groups/finance/in'))).toBe(false)
  })
  test('more people can read the target than the zip: refused without a chat card; never into skills', async () => {
    put(`${D}/private.zip`, zip([{ name: 'p.txt', data: 'x' }]))
    const wide = await turn('alice')('unzip_file', { path: `${D}/private.zip`, to_folder: 'shared/from-zip' })
    expect(wide.isError).toBe(true)
    expect(wide.text).toContain('more people can read')
    expect(fs.existsSync(file('shared/from-zip'))).toBe(false)
    const skill = await turn('carol')('unzip_file', { path: `${D}/private.zip`, to_folder: 'skills/x' })
    expect(skill.isError).toBe(true)
    expect(skill.text).toContain('skills folder')
  })
  test('a subfolder of the zip that lands under a wider folder of the target is checked too (not only the target)', async () => {
    openFolder()
    put(`${D}/inbox/pack.zip`, zip([{ name: 'open/new/c.txt', data: 'marketing only' }]))
    const r = await turn('alice')('unzip_file', { path: `${D}/inbox/pack.zip`, to_folder: D })
    expect(r.isError, r.text).toBe(true)
    expect(r.text).toContain('more people can read')
    expect(fs.existsSync(file(`${D}/open/new`))).toBe(false)
  })
  test('nothing lands in a skills folder inside the target (a group\'s skills/)', async () => {
    put(`${D}/sk.zip`, zip([{ name: 'readme.txt', data: 'ok' }, { name: 'skills/evil/SKILL.md', data: '# do bad things' }]))
    const r = await turn('alice')('unzip_file', { path: `${D}/sk.zip`, to_folder: 'groups/marketing' })
    expect(r.isError, r.text).toBe(false)
    expect(read('groups/marketing/readme.txt')).toBe('ok')
    expect(fs.existsSync(file('groups/marketing/skills'))).toBe(false)
    expect(r.text).toMatch(/skills\/evil\/SKILL\.md: it would land in a skills folder/)
  })
  test('a zip of more files than the turn may write one by one is unzipped (the zip\'s own limits are the cap); the reply stays short', async () => {
    put(`${D}/big-project.zip`, zip(Array.from({ length: 300 }, (_, i) => ({ name: `${['docs', 'photos', 'sheets'][i % 3]}/f${i}.txt`, data: String(i) }))))
    const cfg = A.ctx.engineConfig as { maxFilesWrittenPerTurn: number }
    const was = cfg.maxFilesWrittenPerTurn
    cfg.maxFilesWrittenPerTurn = 3
    try {
      const call = turn('alice')
      const r = await call('unzip_file', { path: `${D}/big-project.zip` })
      expect(r.isError, r.text.slice(0, 500)).toBe(false)
      expect(r.text).toContain('300 files saved')
      expect(r.text).toContain('By folder:\n- docs/: 100 files')
      expect(r.text).not.toContain('f299.txt')
      expect(r.text.length).toBeLessThan(1500)
      expect(fs.readdirSync(file(`${D}/big-project/photos`)).length).toBe(100)
      // the turn's own file count is untouched: the AI can still save its files in this answer
      const w = await call('write', { file_path: `${D}/after-unzip.md`, content: 'ok' })
      expect(w.isError, w.text).toBe(false)
      // every file still went through the save checks: one file event each
      expect(events(call.turnId).filter((e) => e.path.startsWith(`${D}/big-project/`) && e.path.endsWith('.txt')).length).toBe(300)
    } finally { cfg.maxFilesWrittenPerTurn = was }
  })
  test('one answer may unzip at most the zip limits in all (here: 5,000 files), so unzipping again and again stops', async () => {
    put(`${D}/k3.zip`, zip(Array.from({ length: 3000 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', stored: true }))))
    const call = turn('alice')
    expect((await call('unzip_file', { path: `${D}/k3.zip` })).isError).toBe(false)
    const again = await call('unzip_file', { path: `${D}/k3.zip` })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('5000 unzipped files in this answer')
    expect(fs.existsSync(file(`${D}/k3 (2)`))).toBe(false)
    // a new answer starts again
    expect((await turn('alice')('unzip_file', { path: `${D}/k3.zip`, list_only: true })).isError).toBe(false)
  })
})

describe('the server holds at most a few zips at a time', () => {
  test('a busy server waits briefly, then says plainly to try again; a slot that frees up in time is used', async () => {
    put(`${D}/slot.zip`, zip([{ name: 's.txt', data: 's' }]))
    const was = { ...UNZIP_LIMITS }
    UNZIP_LIMITS.parallel = 1; UNZIP_LIMITS.waitMs = 300
    try {
      const held = await unzipSlot()
      const busy = await turn('alice')('unzip_file', { path: `${D}/slot.zip` })
      expect(busy.isError).toBe(true)
      expect(busy.text).toContain('unzipping other files right now')
      expect(busy.text).toContain('try again in a moment')
      expect(fs.existsSync(file(`${D}/slot`))).toBe(false)
      UNZIP_LIMITS.waitMs = 5000
      const waiting = turn('alice')('unzip_file', { path: `${D}/slot.zip` })
      await new Promise((r) => setTimeout(r, 100))
      expect(_unzipSlotsForTest().waiting).toBe(1)
      held()
      const r = await waiting
      expect(r.isError, r.text).toBe(false)
      expect(read(`${D}/slot/s.txt`)).toBe('s')
      expect(_unzipSlotsForTest()).toEqual({ running: 0, waiting: 0 })
    } finally { Object.assign(UNZIP_LIMITS, was) }
  })
  test('an entry is streamed to its file: a part larger than its header stops there and leaves no file', async () => {
    const z = zip([{ name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024, 1), usize: 1024 }])
    const plan = planZip(z)
    const dest = path.join(A.data, 'stream-test.bin')
    await expect(inflateEntryToFile(z, plan.files[0]!.entry, dest)).rejects.toThrow('larger than its header')
    expect(fs.existsSync(dest)).toBe(false)
    const ok = zip([{ name: 'ok.bin', data: Buffer.alloc(300_000, 2) }])
    expect(await inflateEntryToFile(ok, planZip(ok).files[0]!.entry, dest)).toBe(300_000)
    expect(fs.readFileSync(dest).equals(Buffer.alloc(300_000, 2))).toBe(true)
    fs.rmSync(dest)
  })
})

describe('review follow-ups (PR #1262)', () => {
  test('the per-answer budget is shared by the main AI and its sub-agents', async () => {
    put(`${D}/k26.zip`, zip(Array.from({ length: 2600 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', stored: true }))))
    const tf = new TurnFiles()
    expect((await turn('alice', { files: tf.forAgent('agent-1') })('unzip_file', { path: `${D}/k26.zip` })).isError).toBe(false)
    const second = await turn('alice', { files: tf.forAgent('agent-2') })('unzip_file', { path: `${D}/k26.zip` })
    expect(second.isError).toBe(true)
    expect(second.text).toContain('5000 unzipped files in this answer')
    expect(tf.unzippedFiles).toBe(2600)
  })
  test('one wider-audience question per distinct audience, not per folder', async () => {
    const asked: string[] = []
    const confirmWidening = async (target: string) => { asked.push(target); return null }
    put(`${D}/twelve.zip`, zip(Array.from({ length: 12 }, (_, i) => ({ name: `d${i}/f.txt`, data: String(i) }))))
    const r = await turn('alice', { confirmWidening })('unzip_file', { path: `${D}/twelve.zip`, to_folder: 'shared/many' })
    expect(r.isError, r.text).toBe(false)
    expect(asked).toEqual(['shared/many/x'])
    // a folder that other people can read is asked on its own
    asked.length = 0
    openFolder()
    put(`${D}/inbox/two.zip`, zip([{ name: 'a/x.txt', data: 'x' }, { name: 'b/z.txt', data: 'z' }, { name: 'open/y.txt', data: 'y' }]))
    const t = await turn('alice', { confirmWidening })('unzip_file', { path: `${D}/inbox/two.zip`, to_folder: D })
    expect(t.isError, t.text).toBe(false)
    expect(asked.sort()).toEqual([`${D}/open/y.txt`, `${D}/x`].sort())
  })
  test('after the cards every folder is checked again: one whose audience changed while a card was open gets its own question (TC-4854)', async () => {
    const asked: string[] = []
    const db = A.ctx.db
    const confirmWidening = async (target: string) => {
      asked.push(target)
      // while the first card is open, an admin lets everyone read one of the zip's folders
      if (asked.length === 1) {
        db.query('INSERT INTO folders (id, path) VALUES (?,?)').run('f_zips_late', `${D}/late`)
        db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,'everyone',NULL,'read')").run(crypto.randomUUID(), 'f_zips_late')
      }
      return null
    }
    put(`${D}/inbox/late.zip`, zip([{ name: 'a/x.txt', data: 'x' }, { name: 'late/y.txt', data: 'y' }]))
    const r = await turn('alice', { confirmWidening })('unzip_file', { path: `${D}/inbox/late.zip`, to_folder: D })
    expect(r.isError, r.text).toBe(false)
    expect(asked).toEqual([`${D}/x`, `${D}/late/y.txt`])
  })
  test('narrowing the zip\'s own folder while a card is open asks every folder again (TC-4854)', async () => {
    const asked: string[] = []
    const db = A.ctx.db
    put(`${D}/inbox2/narrow.zip`, zip([{ name: 'a/x.txt', data: 'x' }]))
    const confirmWidening = async (target: string) => {
      asked.push(target)
      // while the first card is open, the zip's folder is limited to alice alone
      if (asked.length === 1) {
        db.query('INSERT INTO folders (id, path, limited) VALUES (?,?,1)').run('f_zips_inbox2', `${D}/inbox2`)
        db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,'everyone',NULL,'none')").run(crypto.randomUUID(), 'f_zips_inbox2')
        db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,'user','alice','write')").run(crypto.randomUUID(), 'f_zips_inbox2')
      }
      return null
    }
    const r = await turn('alice', { confirmWidening })('unzip_file', { path: `${D}/inbox2/narrow.zip`, to_folder: `${D}/narrowed` })
    expect(r.isError, r.text).toBe(false)
    expect(asked).toEqual([`${D}/narrowed/x`, `${D}/narrowed/x`])
  })
  test('a change after the last card, while waiting for the unzip slot, refuses the call and saves nothing (TC-4854)', async () => {
    const db = A.ctx.db
    const was = { ...UNZIP_LIMITS }
    UNZIP_LIMITS.parallel = 1; UNZIP_LIMITS.waitMs = 5000
    const slot: { held: (() => void) | null } = { held: null }
    try {
      put(`${D}/inbox/slow.zip`, zip([{ name: 'a/x.txt', data: 'x' }, { name: 'late2/y.txt', data: 'y' }]))
      // the card says yes, then the server's only slot is taken until the rules have changed
      const confirmWidening = async () => { slot.held ??= await unzipSlot(); return null }
      const call = turn('alice', { confirmWidening })('unzip_file', { path: `${D}/inbox/slow.zip`, to_folder: `${D}/slow` })
      for (let i = 0; i < 100 && _unzipSlotsForTest().waiting === 0; i++) await new Promise((r) => setTimeout(r, 20))
      expect(_unzipSlotsForTest().waiting).toBe(1)
      db.query('INSERT INTO folders (id, path) VALUES (?,?)').run('f_zips_late2', `${D}/slow/late2`)
      db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,'everyone',NULL,'read')").run(crypto.randomUUID(), 'f_zips_late2')
      slot.held!(); slot.held = null
      const r = await call
      expect(r.isError).toBe(true)
      expect(r.text).toContain('folder access changed')
      expect(fs.existsSync(file(`${D}/slow`))).toBe(false)
    } finally { slot.held?.(); Object.assign(UNZIP_LIMITS, was) }
  })
  test('the unzip slot is given back when the work folder cannot be made', async () => {
    put(`${D}/leak.zip`, zip([{ name: 'l.txt', data: 'l' }]))
    const work = path.join(A.data, 'work')
    const aside = `${work}-aside-${Date.now()}`
    if (fs.existsSync(work)) fs.renameSync(work, aside)
    fs.writeFileSync(work, 'not a folder')
    try {
      const r = await turn('alice')('unzip_file', { path: `${D}/leak.zip` })
      expect(r.isError).toBe(true)
    } finally { fs.rmSync(work, { force: true }); if (fs.existsSync(aside)) fs.renameSync(aside, work) }
    expect(_unzipSlotsForTest()).toEqual({ running: 0, waiting: 0 })
  })
  test('outside a chat, the wider-audience check takes the target as the file layer resolves it (letter case)', async () => {
    // only where the team folder's disk ignores letter case ("OPEN" is the folder "open")
    if (!A.ctx.files.fx.caseInsensitive) return
    openFolder()
    put(`${D}/src.md`, 'marketing only')
    const c = A.toolCtx('alice')
    const target = `${D}/OPEN/c2.txt`
    await expect(confirmSources(A.ctx, componentC(A.ctx).files, c, target, target.split('/'), [`${D}/src.md`])).rejects.toThrow('more people can read')
  })
  test('an empty folder of the zip under a wider folder is checked too', async () => {
    openFolder()
    put(`${D}/inbox/empty.zip`, zip([{ name: 'e.txt', data: 'x' }, { name: 'open/newdir/' }]))
    const r = await turn('alice')('unzip_file', { path: `${D}/inbox/empty.zip`, to_folder: D })
    expect(r.isError, r.text).toBe(true)
    expect(r.text).toContain('more people can read')
    expect(fs.existsSync(file(`${D}/open/newdir`))).toBe(false)
  })
  test('parts that share their data, and a zip that expands too far in all, are refused', async () => {
    const block = crypto.getRandomValues(new Uint8Array(1024))
    put(`${D}/bad/overlap.zip`, zip([{ name: 'a.bin', data: block }, { name: 'b.bin', shares: 0 }, { name: 'c.bin', shares: 0 }]))
    const o = await turn('alice')('unzip_file', { path: `${D}/bad/overlap.zip` })
    expect(o.isError).toBe(true)
    expect(o.text).toContain('share their data')
    expect(fs.existsSync(file(`${D}/bad/overlap`))).toBe(false)
    put(`${D}/bad/many-small.zip`, zip(Array.from({ length: 4 }, (_, i) => ({ name: `z${i}.bin`, data: Buffer.alloc(4 * 1024 * 1024) }))))
    const m = await turn('alice')('unzip_file', { path: `${D}/bad/many-small.zip` })
    expect(m.isError).toBe(true)
    expect(m.text).toContain('the zip expands more than 100 times')
    expect(fs.existsSync(file(`${D}/bad/many-small`))).toBe(false)
  })
  test('guests keep the normal per-answer limits', async () => {
    // a guest with write access to one folder (person rule)
    const db = A.ctx.db
    db.query("INSERT INTO users (id, username, name, role, guest) VALUES ('gina','gina','Gina Guest','member',1)").run()
    db.query("INSERT INTO projects (id, name, folder_path, created_by) VALUES ('p-gbox', 'gbox', 'projects/gbox', 'alice')").run()
    db.query("INSERT INTO guests (user_id, place_kind, place_id, project_id, created_at) VALUES ('gina', 'project', 'p-gbox', 'p-gbox', '2026-11-18T00:00:00Z')").run()
    db.query('INSERT INTO folders (id, path) VALUES (?,?)').run('f_zips_guest', 'projects/gbox')
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?,?,'user','gina','write')").run(crypto.randomUUID(), 'f_zips_guest')
    const tc = A.toolCtx('gina' as Person, A.turn('gina' as Person, A.chat('gina' as Person)))
    put('projects/gbox/g.zip', zip(Array.from({ length: 5 }, (_, i) => ({ name: `g${i}.txt`, data: 'g' }))))
    // a guest's own pair (files/turn-write-limits.ts), not the members' 2,000 files
    const cfg = A.ctx.engineConfig as { guestMaxFilesWrittenPerTurn: number }
    const was = cfg.guestMaxFilesWrittenPerTurn
    cfg.guestMaxFilesWrittenPerTurn = 3
    try {
      const h = makeHandler(A.ctx.files, A.ctx.db, tc)
      const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'unzip_file', arguments: { path: 'projects/gbox/g.zip' } } })
      expect(!!r.result.isError).toBe(true)
      expect(r.result.content[0].text).toContain('has 5 files, more than the 3 files')
    } finally { cfg.guestMaxFilesWrittenPerTurn = was }
  })
  test('an abort before the slot wait stops at once', async () => {
    const was = { ...UNZIP_LIMITS }
    UNZIP_LIMITS.parallel = 1; UNZIP_LIMITS.waitMs = 10_000
    const held = await unzipSlot()
    try {
      const ac = new AbortController(); ac.abort()
      const t0 = Date.now()
      await expect(unzipSlot(ac.signal)).rejects.toThrow('stopped')
      expect(Date.now() - t0).toBeLessThan(500)
    } finally { held(); Object.assign(UNZIP_LIMITS, was) }
  })
})

describe('the lists', () => {
  test('shared chats, rooms and guests may use it; where it writes; the zip it names; its step line', () => {
    expect(SHARED_TOOLS.has('unzip_file')).toBe(true)
    expect(ROOM_FILE_TOOLS.has('unzip_file')).toBe(true)
    expect(GUEST_TURN_TOOLS.has('unzip_file')).toBe(true)
    expect(WRITE_TARGET_ARGS.unzip_file).toEqual(['to_folder'])
    expect(namedPaths('unzip_file', { path: 'a.zip', to_folder: 'x' }).map((x) => x.value)).toEqual(['a.zip', 'x'])
    expect(stepLabel('unzip_file', { path: 'groups/a.zip' }, 'en', new Set())).toBe('Unzip · groups/a.zip')
    expect(stepLabel('unzip_file', { path: 'groups/a.zip' }, 'ko', new Set())).toBe('압축 풀기 · groups/a.zip')
  })
})

describe('an unzipped entry is outside bytes only when its archive is (files/office-exit.ts cameFromOutside)', () => {
  const bad = () => zip([{ name: 'report.docx', data: docx({ link: UNC }) }, { name: 'notes.txt', data: 'hello' }])
  const record = (rel: string, b: Uint8Array, turnId: string | null, detail: Record<string, unknown>) =>
    fileEvent(A.ctx.db, { turnId, userId: 'alice', path: rel, action: 'create', size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), detail })
  test('a zip the AI built and copied out: its Office entries get the exit check (the round-trip bypass)', async () => {
    const b = bad(); put(`${D}/ai-built.zip`, b)
    record(`${D}/ai-built.zip`, b, 'turn-ai-1', { tool: 'save_work_file', from: 'work folder' })
    await turn('alice')('unzip_file', { path: `${D}/ai-built.zip` })
    expect(fs.existsSync(file(`${D}/ai-built/report.docx`))).toBe(false)
    expect(fs.existsSync(file(`${D}/ai-built/notes.txt`))).toBe(true)
  })
  test('a zip with no record of where it came from is checked the same way', async () => {
    put(`${D}/unknown.zip`, bad())
    await turn('alice')('unzip_file', { path: `${D}/unknown.zip` })
    expect(fs.existsSync(file(`${D}/unknown/report.docx`))).toBe(false)
  })
  test('a zip a person uploaded, unchanged since: its entries are saved as they came', async () => {
    const b = bad(); put(`${D}/from-person.zip`, b)
    record(`${D}/from-person.zip`, b, null, { tool: 'file-screen' })
    await turn('alice')('unzip_file', { path: `${D}/from-person.zip` })
    expect(fs.existsSync(file(`${D}/from-person/report.docx`))).toBe(true)
  })
  test('a zip saved as fetched (a download) keeps that; changed since, it does not', async () => {
    const b = bad(); put(`${D}/downloaded.zip`, b)
    record(`${D}/downloaded.zip`, b, 'turn-ai-2', { tool: 'save_url', fetched: true })
    await turn('alice')('unzip_file', { path: `${D}/downloaded.zip` })
    expect(fs.existsSync(file(`${D}/downloaded/report.docx`))).toBe(true)
    const changed = zip([{ name: 'report.docx', data: docx({ link: UNC, body: 'changed' }) }]); put(`${D}/downloaded2.zip`, changed)
    record(`${D}/downloaded2.zip`, b, 'turn-ai-3', { tool: 'save_url', fetched: true })
    await turn('alice')('unzip_file', { path: `${D}/downloaded2.zip` })
    expect(fs.existsSync(file(`${D}/downloaded2/report.docx`))).toBe(false)
  })
})

