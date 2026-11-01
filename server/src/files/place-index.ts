// Grep's place labels for a large document without reading its whole cached text again (files/search.ts grepFiles).
// When the text cache writes a text of at least PLACE_INDEX_MIN bytes it also writes `<text>.places.json`: about every
// PLACE_INDEX_EVERY bytes, the byte offset and number of a line and the state of the walk before it (files/locations.ts
// WalkState). The labels of a grep then start the walk at the last such point before each matching line and read only
// from there to the line, a few tens of KB per match instead of the whole text (up to 50 MB). Without a usable index
// (a text cached before 0.2.19, a small text, a text moved or written again since) the walk starts at line 1 and reads
// in pieces up to the last matching line, never the whole text at once. Either way the places are those locsOfLines
// gives for the whole text.
import fs from 'node:fs'
import type { SourceLoc } from '@mycel/shared/api'
import { notePlace, walkLine, walkStart, type LineAt, type Structure, type WalkState } from './locations'

export const PLACE_INDEX_VERSION = 1
/** texts smaller than this get no index: reading them through is cheap */
export const PLACE_INDEX_MIN = 1024 * 1024
/** bytes of text between two points of an index (at line starts, so a point may come later after a long line) */
export const PLACE_INDEX_EVERY = 64 * 1024
/** the largest index that is written or read (a 50 MB text has about 800 points, some 100 KB) */
export const PLACE_INDEX_MAX_BYTES = 4 * 1024 * 1024
/** bytes read at a time */
const PIECE = 64 * 1024

/** a point of the text: the byte offset where a line starts, the line's 1-based number, the walk's state before it */
export type Checkpoint = [offset: number, line: number, state: WalkState]

export interface PlaceIndex {
  v: number
  kind: Structure
  /** sha256 of the text (an admitted copy of it is matched by this), and its size in bytes */
  text: string
  size: number
  /** the cache file when the index was made: a live search matches the open file by this */
  file: { dev: number; ino: number; mtimeMs: number; ctimeMs: number }
  at: Checkpoint[]
}

/**
 * The lines of a text file from a line start on, read in pieces; a piece grows only to hold a longer line. As
 * text.split('\n') gives them: the part after the last line feed is the last line, also when it is empty. A line is
 * looked at as bytes and decoded only when asked (text()).
 */
export class LineReader {
  private buf = Buffer.allocUnsafe(PIECE)
  private view = this.buf.subarray(0, 0)
  /** file offset of buf[0]; where the next line starts in buf */
  private bufAt = 0
  private start = 0
  private ended = false
  /** the current line: view[a, b) */
  private a = 0
  private b = 0
  /** number of the next line */
  line = 1
  constructor(private fd: number, private size: number) {}
  /** file offset of the next line */
  get offset() { return this.bufAt + this.start }
  /** go on from a line start */
  seek(offset: number, line: number) {
    this.bufAt = offset; this.start = 0; this.view = this.buf.subarray(0, 0); this.line = line; this.ended = false
  }
  /** move to the next line; false after the last */
  advance(): boolean {
    for (;;) {
      const nl = this.view.indexOf(10, this.start)
      if (nl >= 0) { this.a = this.start; this.b = nl; this.start = nl + 1; this.line++; return true }
      const len = this.view.length
      if (this.bufAt + len >= this.size) {
        if (this.ended) return false
        this.ended = true; this.a = this.start; this.b = len; this.start = len; this.line++
        return true
      }
      // keep the start of the line, then read on
      if (this.start > 0) { this.buf.copyWithin(0, this.start, len); this.bufAt += this.start }
      let have = len - this.start
      this.start = 0
      if (have === this.buf.length) { const b = Buffer.allocUnsafe(this.buf.length * 2); this.buf.copy(b, 0, 0, have); this.buf = b }
      const n = fs.readSync(this.fd, this.buf, have, Math.min(this.buf.length - have, this.size - this.bufAt - have), this.bufAt + have)
      if (n > 0) have += n
      else this.size = this.bufAt + have // the file is shorter than it was: its end is here
      this.view = this.buf.subarray(0, have)
    }
  }
  /** the current line's text */
  text(): string { return this.view.toString('utf8', this.a, this.b) }
  /** its first byte (-1: an empty line) */
  first(): number { return this.b > this.a ? this.view[this.a]! : -1 }
  /** how often an ASCII character is in it (UTF-8: such a byte is never part of another character) */
  count(byte: number): number {
    // a plain loop: indexOf would look past the line's end when the line has none
    let n = 0
    const v = this.view
    for (let i = this.a; i < this.b; i++) if (v[i] === byte) n++
    return n
  }
}

/**
 * Move the walk past the current line of `r` as walkLine does. Only a line that may be a mark (`# sheet: …`,
 * `# row N`, `=== Slide N ===`, a heading) or that is `wanted` is decoded and given to walkLine; for any other line
 * the state changes only by what the walk counts: form feeds (pages) and quotes (sheet rows that go on).
 */
function step(s: WalkState, kind: Structure, r: LineReader, no: number, wanted: boolean, onLine: (l: LineAt, lineNo: number) => boolean | void): void {
  const first = r.first()
  const mark = kind === 'sheets' ? !s.inQuote && first === 0x23 : kind === 'slides' ? first === 0x3d : kind === 'headings' ? first === 0x23 || first === 0x3d : false
  if (wanted || mark) { walkLine(s, kind, r.text(), no, onLine); return }
  if (kind === 'pages') s.page += r.count(0x0c)
  else if (kind === 'sheets') {
    if (r.count(0x22) % 2 === 1) s.inQuote = !s.inQuote
    if (!s.inQuote) s.row++
  }
}

/** The points of the text open on `fd` (`size` bytes), about every `every` bytes. */
export function checkpoints(fd: number, size: number, kind: Structure, every = PLACE_INDEX_EVERY): Checkpoint[] {
  const r = new LineReader(fd, size)
  const s = walkStart()
  const at: Checkpoint[] = []
  let next = every
  const none = () => {}
  for (;;) {
    const off = r.offset
    if (off >= next && off < size) { at.push([off, r.line, { ...s }]); next = off + every }
    const no = r.line
    if (!r.advance()) return at
    step(s, kind, r, no, false, none)
  }
}

/** The index of the text just written on `fd` (its sha256 `text`); null for a text that needs none (plain text, or
 * smaller than `min`) or whose index would be too large. */
export function makePlaceIndex(fd: number, kind: Structure, text: string, o: { min?: number; every?: number } = {}): PlaceIndex | null {
  const st = fs.fstatSync(fd)
  if (!kind || st.size < (o.min ?? PLACE_INDEX_MIN)) return null
  const at = checkpoints(fd, st.size, kind, o.every)
  return { v: PLACE_INDEX_VERSION, kind, text, size: st.size, file: { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }, at }
}

/** Write the index next to its text, or remove an older one (no index for this text). Never throws: the index is only
 * a shortcut, and an older one does not fit the new text anyway (readPlaceIndex). */
export function writePlaceIndex(file: string, ix: PlaceIndex | null): void {
  try {
    const json = ix ? JSON.stringify(ix) : ''
    if (ix && Buffer.byteLength(json) <= PLACE_INDEX_MAX_BYTES) { fs.writeFileSync(file, json, { mode: 0o600 }); return }
  } catch {}
  try { fs.rmSync(file, { force: true }) } catch {}
}

/**
 * The points of the index at `file` when it was made for the text open now (`st`): the same cache file, unchanged
 * since (a live search reads the cache itself), or, given `admitted`, a text with that sha256 (an admitted copy of the
 * cache). Null when there is no such index; the walk then starts at line 1.
 */
export function readPlaceIndex(file: string, kind: Structure, st: fs.Stats, admitted?: string): Checkpoint[] | null {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const own = fs.fstatSync(fd)
    if (!own.isFile() || own.size > PLACE_INDEX_MAX_BYTES) return null
    const ix = JSON.parse(fs.readFileSync(fd, 'utf8')) as PlaceIndex
    if (ix.v !== PLACE_INDEX_VERSION || ix.kind !== kind || ix.size !== st.size || !Array.isArray(ix.at)) return null
    const same = admitted !== undefined ? ix.text === admitted
      : ix.file?.dev === st.dev && ix.file.ino === st.ino && ix.file.mtimeMs === st.mtimeMs && ix.file.ctimeMs === st.ctimeMs
    if (!same) return null
    // in order, inside the text (each point a line start the index itself found)
    for (let i = 0, off = -1, line = 0; i < ix.at.length; i++) {
      const c = ix.at[i]!
      if (!Array.isArray(c) || !Number.isInteger(c[0]) || !Number.isInteger(c[1]) || c[0] <= off || c[1] <= line || c[0] >= st.size || typeof c[2] !== 'object' || !c[2]) return null
      off = c[0]; line = c[1]
    }
    return ix.at
  } catch { return null } finally { fs.closeSync(fd) }
}

/** the last point at or before `line` */
function pointBefore(at: Checkpoint[], line: number): Checkpoint | null {
  let lo = 0, hi = at.length - 1, best: Checkpoint | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (at[mid]![1] <= line) { best = at[mid]!; lo = mid + 1 } else hi = mid - 1
  }
  return best
}

/**
 * The places of some lines (1-based, as grep numbers them) of the text open on `fd` (`size` bytes): those locsOfLines
 * gives for the whole text. With the points of an index, the walk to each line starts at the last point before it
 * when that is ahead of the walk; without, it goes from line 1 to the last line asked for.
 */
export function placesOfLines(fd: number, size: number, kind: Structure, lineNos: Iterable<number>, at: Checkpoint[] | null): Map<number, SourceLoc> {
  const want = new Set(lineNos)
  const out = new Map<number, SourceLoc>()
  if (!kind || !want.size) return out
  const r = new LineReader(fd, size)
  let s = walkStart()
  const note = (l: LineAt, no: number) => notePlace(out, want, l, no)
  for (const target of [...want].sort((a, b) => a - b)) {
    const c = at && pointBefore(at, target)
    if (c && c[1] > r.line) { r.seek(c[0], c[1]); s = { ...c[2] } }
    while (r.line <= target) {
      const no = r.line
      if (!r.advance()) return out
      step(s, kind, r, no, want.has(no), note)
    }
  }
  return out
}
