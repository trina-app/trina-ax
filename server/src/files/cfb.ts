// The compound file (OLE2, MS-CFB) of a .hwp, read and written again for edit_hwp (files/hwp-edit.ts), and read for
// the server's read-back of what it wrote (tools/edit-hwp.ts). hwp.ts reads .hwp text through SheetJS's CFB reader;
// SheetJS's writer is not used to write one: it orders the directory again, makes every entry black, drops the
// storages' times and adds a stream of its own ("\x01Sh33tJ5"), so the file would no longer have Hangul's storage tree.
//
// readCfb: version 3 only (512-byte sectors; Hangul writes no other), every chain walked once with bounds, no sector
// in two chains, a stream's chain exactly as long as its size, the directory a tree with no loops, no entry outside
// it and no two names alike in one storage. It expands nothing (a .hwp compresses inside its streams, not here).
//
// writeCfb: the same directory entries in the same order, byte for byte (names, types, colours, the tree, CLSIDs,
// state bits, times), only each stream's start sector and size written again; the same header fields (CLSID, minor
// version, transaction signature); the streams' bytes as given, the ones not replaced as they were. Sectors are laid
// out again (FAT, DIFAT, directory, mini FAT, mini stream, then the streams), freed space is not carried over, so the
// old bytes of a replaced stream are not left in the file.

export class CfbError extends Error {}
const bad = (why: string): never => { throw new CfbError(why) }

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const FREE = 0xffffffff, END = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc, MAXREG = 0xfffffffa
const SECTOR = 512
const MINI = 64
const CUTOFF = 4096
const ENTRY = 128
/** FAT sector numbers in the header; each DIFAT sector holds 127 more and the next DIFAT sector */
const HEADER_DIFAT = 109

export const CFB_LIMITS = { entries: 10_000, depth: 64 }

export const isCfb = (b: Uint8Array) => b.length >= 8 && SIGNATURE.every((x, i) => b[i] === x)

export interface CfbEntry {
  /** index in the directory */
  i: number
  /** 0 unused, 1 storage, 2 stream, 5 root */
  type: number
  name: string
  /** below the root, "/"-separated (BodyText/Section0), as hwp.ts names them; "" for the root */
  path: string
  /** the entry's 128 bytes as they are in the file */
  raw: Uint8Array
  /** a stream's bytes */
  data: Uint8Array
}
export interface Cfb {
  /** the 512-byte header */
  header: Uint8Array
  /** every directory entry, unused ones too, in directory order */
  entries: CfbEntry[]
  /** the streams by path */
  streams: Map<string, CfbEntry>
}

/** Reads a compound file; CfbError when it is not one this module can vouch for. */
export function readCfb(b: Uint8Array, limits = CFB_LIMITS): Cfb {
  if (!isCfb(b) || b.length < SECTOR) bad('not a compound file')
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const u16 = (o: number) => v.getUint16(o, true)
  const u32 = (o: number) => v.getUint32(o, true)
  if (u16(28) !== 0xfffe) bad('the byte order mark is wrong')
  if (u16(26) !== 3 || u16(30) !== 9) bad(`version ${u16(26)} with ${2 ** Math.min(u16(30), 30)}-byte sectors (only version 3 with 512-byte sectors, as Hangul writes)`)
  if (u16(32) !== 6 || u32(56) !== CUTOFF) bad('its mini sectors are not the standard ones')
  const nSec = Math.ceil((b.length - SECTOR) / SECTOR)
  /** the bytes of sector s (the last one may be cut short by the end of the file) */
  const sector = (s: number) => { const o = SECTOR + s * SECTOR; return b.subarray(o, Math.min(o + SECTOR, b.length)) }
  const word = (s: number, k: number) => { if (SECTOR + s * SECTOR + k * 4 + 4 > b.length) bad('it is cut short'); return u32(SECTOR + s * SECTOR + k * 4) }

  // the FAT's sectors: 109 in the header, the rest in the DIFAT chain
  const nFat = u32(44)
  if (nFat < 1 || nFat > nSec) bad('its sector table is damaged')
  const fatSecs: number[] = []
  for (let k = 0; k < HEADER_DIFAT && fatSecs.length < nFat; k++) fatSecs.push(u32(76 + k * 4))
  const difSecs: number[] = []
  for (let d = u32(68); fatSecs.length < nFat;) {
    if (d >= nSec || difSecs.includes(d) || difSecs.length > nSec) bad('its sector table is damaged (DIFAT)')
    difSecs.push(d)
    for (let k = 0; k < 127 && fatSecs.length < nFat; k++) fatSecs.push(word(d, k))
    d = word(d, 127)
  }
  if (new Set(fatSecs).size !== fatSecs.length || fatSecs.some((s) => s >= nSec)) bad('its sector table is damaged (FAT)')
  const fat = new Uint32Array(nFat * 128)
  fatSecs.forEach((s, n) => { for (let k = 0; k < 128; k++) fat[n * 128 + k] = word(s, k) })

  // every sector belongs to one chain at most
  const owner = new Int8Array(nSec)
  for (const s of [...fatSecs, ...difSecs]) owner[s] = 1
  const chain = (start: number, what: string, length?: number): number[] => {
    const out: number[] = []
    for (let s = start; s !== END; s = fat[s]!) {
      if (s >= nSec || s >= fat.length) bad(`${what} points outside the file`)
      if (owner[s]) bad(`${what} shares a sector with another part`)
      owner[s] = 1
      out.push(s)
    }
    if (length !== undefined && out.length !== length) bad(`${what} is not as long as its size`)
    return out
  }
  const bytesOf = (secs: number[], size: number, what: string) => {
    const out = new Uint8Array(size)
    let at = 0
    for (const s of secs) { const part = sector(s).subarray(0, size - at); out.set(part, at); at += part.length }
    if (at !== size) bad(`${what} is cut short`)
    return out
  }

  // the directory
  const dirSecs = chain(u32(48), 'the directory')
  const nEntries = dirSecs.length * (SECTOR / ENTRY)
  if (!nEntries) bad('it has no directory')
  if (nEntries > limits.entries) bad(`it has more than ${limits.entries} directory entries`)
  const dir = bytesOf(dirSecs, nEntries * ENTRY, 'the directory')
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const entries: CfbEntry[] = []
  for (let i = 0; i < nEntries; i++) {
    const o = i * ENTRY
    const type = dir[o + 66]!
    if (![0, 1, 2, 5].includes(type)) bad('a directory entry has an unknown type')
    const nl = dv.getUint16(o + 64, true)
    if (type && (nl < 2 || nl > 64 || nl % 2)) bad('a directory entry has a damaged name')
    const name = type ? Buffer.from(dir.subarray(o, o + nl - 2)).toString('utf16le') : ''
    entries.push({ i, type, name, path: '', raw: dir.slice(o, o + ENTRY), data: new Uint8Array(0) })
  }
  const root = entries[0]!
  if (root.type !== 5 || entries.some((e, i) => i && e.type === 5)) bad('its root entry is damaged')
  const ptr = (e: CfbEntry, at: number) => { const p = new DataView(e.raw.buffer, e.raw.byteOffset).getUint32(at, true); return p === FREE ? -1 : p }
  const size = (e: CfbEntry) => new DataView(e.raw.buffer, e.raw.byteOffset).getUint32(120, true)
  const start = (e: CfbEntry) => new DataView(e.raw.buffer, e.raw.byteOffset).getUint32(116, true)

  // the tree: each storage's children are a tree of left / right siblings under its child pointer
  const reached = new Set<number>([0])
  // (an explicit stack: a long chain of siblings is no deep recursion)
  const walk: { storage: CfbEntry; node: number }[] = [{ storage: root, node: ptr(root, 76) }]
  const names = new Map<CfbEntry, Set<string>>()
  while (walk.length) {
    const { storage, node } = walk.pop()!
    if (node < 0) continue
    if (node >= entries.length || reached.has(node)) bad('its directory tree is damaged')
    const e = entries[node]!
    if (e.type !== 1 && e.type !== 2) bad('its directory tree is damaged')
    reached.add(node)
    const seen = names.get(storage) ?? new Set<string>()
    names.set(storage, seen)
    if (seen.has(e.name.toUpperCase())) bad(`two entries are named ${JSON.stringify(e.name)}`)
    seen.add(e.name.toUpperCase())
    e.path = storage === root ? e.name : `${storage.path}/${e.name}`
    if (e.path.split('/').length > limits.depth) bad('its storages are nested too deep')
    walk.push({ storage, node: ptr(e, 68) }, { storage, node: ptr(e, 72) })
    if (e.type === 1) walk.push({ storage: e, node: ptr(e, 76) })
  }
  if (entries.some((e) => e.type && !reached.has(e.i))) bad('a directory entry is outside the tree')

  // the mini stream (the root's stream) and its table
  const rootSize = size(root)
  const miniStream = rootSize ? bytesOf(chain(start(root), 'the mini stream', Math.ceil(rootSize / SECTOR)), rootSize, 'the mini stream') : new Uint8Array(0)
  const nMiniFat = u32(64)
  const miniFatSecs = nMiniFat ? chain(u32(60), 'the mini sector table', nMiniFat) : []
  const miniFat = new Uint32Array(miniFatSecs.length * 128)
  miniFatSecs.forEach((s, n) => { for (let k = 0; k < 128; k++) miniFat[n * 128 + k] = word(s, k) })
  const nMini = Math.floor(rootSize / MINI)
  const miniOwner = new Int8Array(nMini)

  const streams = new Map<string, CfbEntry>()
  for (const e of entries) {
    if (e.type !== 2) continue
    const n = size(e)
    if (n >= CUTOFF) e.data = bytesOf(chain(start(e), e.path, Math.ceil(n / SECTOR)), n, e.path)
    else if (n > 0) {
      const out = new Uint8Array(n)
      let at = 0
      for (let s = start(e); s !== END; s = miniFat[s]!) {
        if (s >= nMini || s >= miniFat.length) bad(`${e.path} points outside the mini stream`)
        if (miniOwner[s]) bad(`${e.path} shares a mini sector with another stream`)
        miniOwner[s] = 1
        if (at >= n) bad(`${e.path} is not as long as its size`)
        const part = miniStream.subarray(s * MINI, s * MINI + Math.min(MINI, n - at))
        out.set(part, at)
        at += part.length
      }
      if (at !== n) bad(`${e.path} is cut short`)
      e.data = out
    }
    streams.set(e.path, e)
  }
  return { header: b.slice(0, SECTOR), entries, streams }
}

/**
 * The compound file `c` again with the streams of `replace` (by path) holding new bytes; every other stream keeps its
 * bytes, every directory entry its bytes but a stream's start sector and size. Streams under 4096 bytes go into the
 * mini stream, larger ones into sectors of their own, whichever side of that line a replaced stream now falls.
 */
export function writeCfb(c: Cfb, replace: Map<string, Uint8Array> = new Map()): Uint8Array {
  for (const p of replace.keys()) if (!c.streams.has(p)) throw new CfbError(`no stream ${p} to replace`)
  const per = SECTOR / 4
  const data = (e: CfbEntry) => replace.get(e.path) ?? e.data
  const streams = c.entries.filter((e) => e.type === 2)
  // the mini stream and its table
  const miniFat: number[] = []
  const miniStart = new Map<CfbEntry, number>()
  for (const e of streams) {
    const n = data(e).length
    if (n === 0 || n >= CUTOFF) continue
    const k = Math.ceil(n / MINI)
    miniStart.set(e, miniFat.length)
    for (let j = 0; j < k; j++) miniFat.push(j < k - 1 ? miniFat.length + 1 : END)
  }
  const miniBytes = miniFat.length * MINI
  const big = streams.filter((e) => data(e).length >= CUTOFF)
  const dirSecs = Math.ceil(c.entries.length * ENTRY / SECTOR)
  const miniFatSecs = Math.ceil(miniFat.length * 4 / SECTOR)
  const miniSecs = Math.ceil(miniBytes / SECTOR)
  const bigSecs = big.reduce((n, e) => n + Math.ceil(data(e).length / SECTOR), 0)
  const used = dirSecs + miniFatSecs + miniSecs + bigSecs
  // FAT sectors F and DIFAT sectors X that can describe every sector, themselves included
  let F = 1, X = 0
  for (;;) {
    X = F > HEADER_DIFAT ? Math.ceil((F - HEADER_DIFAT) / (per - 1)) : 0
    if (used + F + X <= F * per) break
    F++
  }
  const total = used + F + X
  const fat = new Uint32Array(F * per).fill(FREE)
  let next = 0
  const run = (n: number, mark?: number) => {
    const s = next
    for (let k = 0; k < n; k++) fat[s + k] = mark ?? (k < n - 1 ? s + k + 1 : END)
    next += n
    return s
  }
  const fatStart = run(F, FATSECT)
  const difStart = run(X, DIFSECT)
  const dirStart = run(dirSecs)
  const miniFatStart = miniFatSecs ? run(miniFatSecs) : END
  const miniStreamStart = miniSecs ? run(miniSecs) : END
  const bigStart = new Map<CfbEntry, number>()
  for (const e of big) bigStart.set(e, run(Math.ceil(data(e).length / SECTOR)))
  if (next !== total) throw new CfbError('sector layout does not add up')

  const out = new Uint8Array(SECTOR + total * SECTOR)
  const ov = new DataView(out.buffer)
  const at = (s: number) => SECTOR + s * SECTOR
  // the header: the old one, with the new table positions
  out.set(c.header.subarray(0, 76), 0)
  ov.setUint32(40, 0, true)
  ov.setUint32(44, F, true)
  ov.setUint32(48, dirStart, true)
  ov.setUint32(60, miniFatStart, true)
  ov.setUint32(64, miniFatSecs, true)
  ov.setUint32(68, X ? difStart : END, true)
  ov.setUint32(72, X, true)
  for (let k = 0; k < HEADER_DIFAT; k++) ov.setUint32(76 + k * 4, k < F ? fatStart + k : FREE, true)
  // DIFAT sectors: 127 FAT sector numbers each, then the next one
  for (let d = 0; d < X; d++) {
    for (let k = 0; k < per - 1; k++) {
      const n = HEADER_DIFAT + d * (per - 1) + k
      ov.setUint32(at(difStart + d) + k * 4, n < F ? fatStart + n : FREE, true)
    }
    ov.setUint32(at(difStart + d) + (per - 1) * 4, d < X - 1 ? difStart + d + 1 : END, true)
  }
  for (let k = 0; k < fat.length; k++) ov.setUint32(at(fatStart) + k * 4, fat[k]!, true)
  // the directory: each entry as it was, a stream's (and the root's) start and size new
  c.entries.forEach((e, i) => {
    const o = at(dirStart) + i * ENTRY
    out.set(e.raw, o)
    if (e.type !== 2 && e.type !== 5) return
    const n = e.type === 5 ? miniBytes : data(e).length
    const s = e.type === 5 ? miniStreamStart : n === 0 ? END : n >= CUTOFF ? bigStart.get(e)! : miniStart.get(e)!
    ov.setUint32(o + 116, s, true)
    ov.setUint32(o + 120, n, true)
    ov.setUint32(o + 124, 0, true)
  })
  // pad the rest of the directory's last sector with unused entries (an unused entry's pointers are FREE)
  for (let i = c.entries.length; i < dirSecs * (SECTOR / ENTRY); i++) {
    const o = at(dirStart) + i * ENTRY
    for (const p of [68, 72, 76]) ov.setUint32(o + p, FREE, true)
  }
  if (miniFatSecs) for (let k = 0; k < miniFatSecs * per; k++) ov.setUint32(at(miniFatStart) + k * 4, k < miniFat.length ? miniFat[k]! : FREE, true)
  for (const [e, s] of miniStart) out.set(data(e), at(miniStreamStart) + s * MINI)
  for (const [e, s] of bigStart) out.set(data(e), at(s))
  return out
}

/**
 * Whether `b` is `a` with only the streams `changeable` allows changed: the same header fields, the same directory
 * entries in the same order (every byte but a stream's start and size, and the root's mini stream), and every other
 * stream the same bytes. Returns why not, or null. Nothing is expanded.
 */
export function cfbMismatch(a: Cfb, b: Cfb, changeable: (path: string) => boolean): string | null {
  const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && Buffer.from(x).equals(Buffer.from(y))
  if (!same(a.header.subarray(0, 40), b.header.subarray(0, 40)) || !same(a.header.subarray(52, 60), b.header.subarray(52, 60))) return 'the container header is not the same'
  if (a.entries.length !== b.entries.length) return 'the new file does not have the same directory as the old one'
  for (const [i, x] of a.entries.entries()) {
    const y = b.entries[i]!
    const keep = x.type === 2 || x.type === 5 ? 116 : ENTRY
    if (x.type !== y.type || x.path !== y.path || !same(x.raw.subarray(0, keep), y.raw.subarray(0, keep))) return `the directory entry ${JSON.stringify(x.path || x.name)} is not the same as before`
    if (x.type === 2 && !changeable(x.path) && !same(x.data, y.data)) return `${x.path} is not the same as before`
  }
  return null
}
