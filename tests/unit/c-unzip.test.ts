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
import { decodeName, planZip } from '../../server/src/files/unzip'
import { ROOM_FILE_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS, namedPaths } from '../../server/src/rooms/ai-tools'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { stepLabel } from '@mycel/shared'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-unzip') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const read = (rel: string) => fs.readFileSync(file(rel), 'utf8')
const ls = (rel: string) => fs.readdirSync(file(rel)).sort()
let rpcId = 0
function turn(user: Person) {
  const turnId = A.turn(user, A.chat(user))
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, turnId))
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
}
function zip(parts: Part[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const p of parts) {
    const nameStr = typeof p.name === 'string'
    const name = nameStr ? Buffer.from(p.name as string, 'utf8') : Buffer.from(p.name as Uint8Array)
    const flags = p.flags ?? (nameStr && /[^\x00-\x7f]/.test(p.name as string) ? 0x800 : 0)
    const data = typeof p.data === 'string' ? Buffer.from(p.data) : Buffer.from(p.data ?? new Uint8Array())
    const body = p.stored ? data : zlib.deflateRawSync(data)
    const crc = p.crc ?? crc32(data)
    const usize = p.usize ?? data.length
    const method = p.stored ? 0 : 8
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
    await nothing('rar.rar', Buffer.from('Rar!\x1a\x07\x00 not really'), /only \.zip files can be unzipped/)
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
  test('nothing lands in a skills folder inside the target (a group\'s skills/)', async () => {
    put(`${D}/sk.zip`, zip([{ name: 'readme.txt', data: 'ok' }, { name: 'skills/evil/SKILL.md', data: '# do bad things' }]))
    const r = await turn('alice')('unzip_file', { path: `${D}/sk.zip`, to_folder: 'groups/marketing' })
    expect(r.isError, r.text).toBe(false)
    expect(read('groups/marketing/readme.txt')).toBe('ok')
    expect(fs.existsSync(file('groups/marketing/skills'))).toBe(false)
    expect(r.text).toMatch(/skills\/evil\/SKILL\.md: it would land in a skills folder/)
  })
  test('the per-turn file count is checked before anything is written', async () => {
    put(`${D}/many.zip`, zip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: String(i) }))))
    const cfg = A.ctx.engineConfig as { maxFilesWrittenPerTurn: number }
    const was = cfg.maxFilesWrittenPerTurn
    cfg.maxFilesWrittenPerTurn = 3
    try {
      const r = await turn('alice')('unzip_file', { path: `${D}/many.zip` })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('has 5 files, more than the 3 files')
      expect(fs.existsSync(file(`${D}/many`))).toBe(false)
    } finally { cfg.maxFilesWrittenPerTurn = was }
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
