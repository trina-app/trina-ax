// The document index of the knowledge graph: the text of the documents in the team folders (Office, PDF, Hangul,
// spreadsheets, Markdown, text, HTML), cut into pieces that keep their page, slide, sheet or heading, in SQLite FTS5
// (<data>/knowledge-graph/documents/documents.db, never in the team folder). Built in: it needs no tool installed beyond
// the converters the file tools already use (files/extract.ts).
//
// - Search: two full-text indexes over the same pieces. A trigram index finds any part of a word, which Korean, Japanese
//   and Chinese need ("회의록" finds "회의록을"; the unicode61 tokenizer splits only at spaces). A unicode61 index ranks
//   whole words and prefixes, and finds words of one or two characters (trigram needs three). The pieces found are
//   ranked by how many of the question's words they hold.
// - Links between documents, each with its reason and nothing else (no AI): the same folder; one document links to
//   another (Markdown or HTML link) or names it (its file name or title); both mention the same team members; both
//   share distinctive words (TF-IDF over the folders asked).
// - Access is not decided here. The index holds whole folders; the caller passes the folders the person may search
//   (rootIds) and checks every file of an answer for that person before showing it. A reason's detail comes only from
//   the two documents' own text and names, never from a third file.
// - The index never opens a team path: the caller reads each file (no link followed, same file as listed) and passes its
//   bytes. Converters run as for the file tools (isolated, limited); a file that fails is recorded with a short reason.
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { SourceLoc } from '@mycel/shared/api'
import { chunkDoc, type Piece } from '../../files/locations'
import { ConverterStopped, extractText, TOO_BIG_IN_PROCESS } from '../../files/extract'
import { inBackground } from '../../tools/isolate'
import { rrf } from '../meaning/vectors'
import { Matcher } from './matcher'
import { acceptsName, docLinks, extOf, htmlText, mentionNames, nameIn, norm, queryTerms, snippetOf, stripKo, titleOf, topTerms, usableName } from './text'

/** why a document is not in the index */
export type DocFailure = 'too_big' | 'timeout' | 'unreadable' | 'unsupported' | 'empty' | 'no_converter'
/** a file's text from its bytes (default: files/extract.ts extractText with pandoc and pdftotext from the PATH) */
export type Extract = (rel: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string>

export interface DocLimits {
  /** a file larger than this is not read (too_big) */
  maxFileBytes: number
  /** text kept per file (the rest is not indexed) */
  maxTextChars: number
  /** pieces kept per file */
  maxChunks: number
  /** time for one file's converters, all parts together (timeout, tried again at the next update) */
  extractMs: number
}
export const DOC_LIMITS: DocLimits = { maxFileBytes: 64 * 1024 * 1024, maxTextChars: 2_000_000, maxChunks: 3000, extractMs: 5 * 60_000 }

export interface DocumentIndexOptions {
  extract?: Extract
  /** the team members' names, for "people" links */
  people?: () => readonly string[]
  limits?: Partial<DocLimits>
}

export interface IndexedFile { size: number; mtimeMs: number; failed: string | null }
export type UpdateResult = { ok: true; chunks: number } | { ok: false; reason: DocFailure | 'aborted' }
/** `snippet`: about 300 characters around the match, on one line. `passage` (when the search asked for one): up to
 * that many characters of the piece around the match, its line breaks kept (tables, lists), to answer from.
 * `byMeaning`: found by meaning only, not by the keyword search (combined search): its strength is at most weak. */
export interface DocHit { rootId: string; relPath: string; loc: SourceLoc | null; snippet: string; passage?: string; score: number; byMeaning?: true }
export interface SearchOptions {
  /** the folders the person may search (the caller still checks each file) */
  rootIds: readonly string[]
  limit?: number
  /** also a passage of up to this many characters per hit (0 or none: only the snippet) */
  passage?: number
  /** only files under this folder of the root (a path relative to it), when the folders asked are one */
  prefix?: string
  /** combined with search by meaning when vectors exist (the search worker does it, search-worker.ts; search() here
   * is the keyword search alone and ignores it) */
  meaning?: boolean
}
/** a piece found by meaning (meaning/search.ts), best first: its chunk id and closeness (about -1 to 1) */
export interface MeaningHit { id: number; score: number }
interface Scored { r: { id: number; loc: string | null; text: string; root_id: string; rel: string }; hit: string[]; score: number; byMeaning?: true }
/** the keyword search's pieces, best first, before the per-file limit (DocumentIndex.rankKeywords) */
export interface KeywordRanking { terms: string[]; scored: Scored[] }
/** the k of reciprocal rank fusion (meaning/vectors.ts rrf) */
const RRF_K = 60
/** fused scores are scaled so that a piece first in both lists gets 15, the top of the keyword score's range */
const FUSED_SCALE = 15 * (RRF_K + 1) / 2
export type RelatedKind = 'folder' | 'mention' | 'link' | 'terms' | 'people' | 'code'
export interface RelatedReason { kind: RelatedKind; detail: string }
export interface RelatedDoc { rootId: string; relPath: string; reason: RelatedReason; reasons: RelatedReason[] }
export interface DocStats { documents: number; chunks: number; failed: { relPath: string; reason: string }[]; failedCount: number; lastUpdatedAt: string | null }

const DB_FILE = 'documents.db'
/** the database layout; another one is removed and made again from the files */
const FORMAT = '1'
/** a piece of text in the index: the ~800-character pieces of files/locations.ts joined up to this size within one
 * page, slide or section */
const PIECE_MAX = 1600
/** failures that stay until the file changes; the others (timeout, no_converter) are tried again */
const PERMANENT = new Set(['too_big', 'unreadable', 'unsupported', 'empty'])
/** pieces taken per word of a question, and pieces holding every word, as the full-text index lists them (unranked:
 * ranking every match of a common word by bm25 took 130–250 ms on a 36,000-piece index, the first few hundred under 15) */
const PER_WORD = 300
const ALL_WORDS = 300
/** the particles and endings a short Korean word is looked up with as whole words ("환불" → "환불은", "환불을"): a
 * prefix query ("환불"*) gathers every word that starts so before it can stop, which for a common word took 20–250 ms */
const KO_FORMS = ['은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만', '에서', '으로', '에게', '까지', '부터', '이나', '이다',
  '이고', '처럼', '보다', '하고', '하는', '하기', '해서', '했다', '합니다', '입니다', '됩니다', '에서는', '으로는', '에서도', '이라는', '라는']
const HANGUL_WORD = /^[가-힣]+$/
/** one word of a question in the word index (unicode61): itself as a whole word, a Korean word also with its particles */
const wordForms = (t: string) => HANGUL_WORD.test(t) ? '(' + [t, ...KO_FORMS.map((f) => t + f)].map(phrase).join(' OR ') + ')' : phrase(t)
const FAILED_SHOWN = 100
const LINK_TEXT_EXT = new Set(['md', 'markdown', 'txt', 'text', 'html', 'htm'])
const MATCH_TEXT_MAX = 1024 * 1024
const PEOPLE_MAX = 2000
const MIN_SHARED_TERMS = 3
const WEIGHT: Record<RelatedKind, number> = { link: 100, mention: 60, code: 40, people: 20, terms: 10, folder: 3 }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY,
  root_id TEXT NOT NULL, rel TEXT NOT NULL, dir TEXT NOT NULL, name_lc TEXT NOT NULL,
  size INTEGER NOT NULL, mtime REAL NOT NULL, hash TEXT, failed TEXT, title TEXT,
  chunks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  UNIQUE(root_id, rel));
CREATE INDEX IF NOT EXISTS docs_dir ON docs(root_id, dir);
CREATE INDEX IF NOT EXISTS docs_name ON docs(name_lc);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, ord INTEGER NOT NULL, loc TEXT, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_tri USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_uni USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO fts_tri(rowid, text) VALUES (new.id, new.text);
  INSERT INTO fts_uni(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO fts_tri(fts_tri, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO fts_uni(fts_uni, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS terms(doc_id INTEGER NOT NULL, term TEXT NOT NULL, tf REAL NOT NULL, PRIMARY KEY(doc_id, term)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS terms_term ON terms(term);
CREATE TABLE IF NOT EXISTS links(doc_id INTEGER NOT NULL, target TEXT NOT NULL, base TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(doc_id, target, base)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_target ON links(target);
CREATE INDEX IF NOT EXISTS links_base ON links(base);
`

function openDb(file: string): Database {
  const db = new Database(file, { create: true })
  try {
    db.run('PRAGMA journal_mode=WAL')
    db.run('PRAGMA synchronous=NORMAL')
    db.run('PRAGMA busy_timeout=5000')
    // a removed document's text does not stay readable in free pages
    db.run('PRAGMA secure_delete=FAST')
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
      const v = db.query("SELECT v FROM meta WHERE k = 'format'").get() as { v: string } | null
      if (v?.v !== FORMAT) throw new Error('document index: another format')
    }
    db.exec(SCHEMA)
    db.run("INSERT OR REPLACE INTO meta(k, v) VALUES ('format', ?)", [FORMAT])
    db.query('SELECT count(*) FROM docs').get()
  } catch (e) { db.close(); throw e }
  try { fs.chmodSync(file, 0o600) } catch {}
  return db
}

function removeDbFiles(dir: string) {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm', DB_FILE + '-journal']) fs.rmSync(path.join(dir, f), { force: true })
}

const defaultExtract: Extract = (rel, bytes, signal) =>
  extractText(rel, bytes, { pandoc: Bun.which('pandoc'), pdftotext: Bun.which('pdftotext'), stoppedPartFails: true }, signal)

function failureOf(e: unknown, timedOut: boolean): DocFailure {
  const name = (e as { name?: string } | null)?.name
  if (timedOut || e instanceof ConverterStopped || name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  const m = String((e as { message?: string } | null)?.message ?? e)
  if (/not installed/.test(m)) return 'no_converter'
  if (m === TOO_BIG_IN_PROCESS || /too large/i.test(m)) return 'too_big'
  if (/binary file/.test(m)) return 'unsupported'
  return 'unreadable'
}

const sameLoc = (a: SourceLoc | null, b: SourceLoc | null) => (a === null && b === null) || (!!a && !!b && a.kind !== 'sheet' && JSON.stringify(a) === JSON.stringify(b))
/** neighbouring pieces of one page, slide or section joined up to PIECE_MAX (sheet pieces keep their row ranges) */
function mergePieces(pieces: Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of pieces) {
    const last = out[out.length - 1]
    if (last && sameLoc(last.loc, p.loc) && last.text.length + p.text.length + 1 <= PIECE_MAX) last.text += '\n' + p.text
    else out.push({ text: p.text, loc: p.loc })
  }
  return out
}

function htmlTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]{1,300}?)<\/title\s*>/i.exec(html.slice(0, 50_000))
  const t = m ? htmlText(m[1]!).replace(/\s+/g, ' ').trim() : ''
  return t.length >= 4 ? t.slice(0, 120) : null
}

/** an FTS5 phrase: the words as written, double quotes doubled */
const phrase = (s: string) => '"' + s.replace(/"/g, '""') + '"'
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)))
const chars = (s: string) => [...s].length
const IN_SCOPE = 'd.root_id IN (SELECT value FROM json_each(?))'
/** a relative folder path: plain names, no empty, "." or ".." part */
export const plainPrefix = (p: string) => p.length <= 4096 && !p.split('/').some((s) => s === '' || s === '.' || s === '..')
/** only files under a folder of the root: its relative paths sort between "<prefix>/" and "<prefix>0" ('0' follows '/');
 * a prefix that is not a plain path narrows nothing */
const withinPrefix = (p: string | undefined) => p && plainPrefix(p) ? { sql: ' AND d.rel >= ? AND d.rel < ?', args: [p + '/', p + '0'] } : { sql: '', args: [] as string[] }

/** Cut `s` to at most `n` characters (UTF-16 units) without splitting a surrogate pair. */
export function cutText(s: string, n: number, mark = ' …'): string {
  if (s.length <= n) return s
  let to = Math.max(0, n - mark.length)
  if (to > 0 && /[\ud800-\udbff]/.test(s[to - 1]!)) to--
  return s.slice(0, to).trimEnd() + mark
}

/**
 * Up to `width` characters of a piece around the first place one of `terms` appears, for answering from: line breaks
 * kept (tables, lists, headings), spaces squeezed, cut at a line break or a space near the ends. Pieces are at most
 * PIECE_MAX characters, so a passage of LOOKUP_LONG_CHARS is most or all of its piece.
 */
export function passageOf(text: string, terms: readonly string[], width: number): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[^\S\n\t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= width) return clean
  const room = Math.max(1, width - 4) // the two "…" marks
  const low = clean.toLowerCase()
  let at = -1
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i }
  // the match about a quarter in: what leads up to it, and more of what follows
  let from = at < 0 ? 0 : Math.max(0, at - Math.floor(room / 4))
  let to = Math.min(clean.length, from + room)
  if (to === clean.length) from = Math.max(0, to - room)
  if (from > 0) {
    const nl = clean.indexOf('\n', from)
    const sp = clean.indexOf(' ', from)
    const before = at < 0 ? to : at
    if (nl >= 0 && nl - from < 200 && nl < before) from = nl + 1
    else if (sp >= 0 && sp - from < 20 && sp < before) from = sp + 1
  }
  if (to < clean.length) {
    const nl = clean.lastIndexOf('\n', to)
    const sp = clean.lastIndexOf(' ', to)
    if (nl > from + room * 0.75) to = nl
    else if (sp > from + room / 2) to = sp
  }
  if (from > 0 && /[\udc00-\udfff]/.test(clean[from]!)) from--
  if (to < clean.length && /[\ud800-\udbff]/.test(clean[to - 1]!)) to--
  return (from > 0 ? '… ' : '') + clean.slice(from, to).trim() + (to < clean.length ? ' …' : '')
}

interface DocRow { id: number; root_id: string; rel: string; dir: string; name_lc: string; size: number; mtime: number; hash: string | null; failed: string | null; title: string | null; chunks: number; updated_at: number }

export class DocumentIndex {
  private closed = false
  /** changes since open: a cached name matcher of an older version is made again */
  private version = 0
  /** a reader (openReader): changes come from the writer's connection, seen through PRAGMA data_version */
  private reader = false
  private names: { key: string; m: Matcher; owners: { id: number; shown: string }[][] } | null = null
  private peopleCache: { key: string; m: Matcher; names: string[] } | null = null

  private constructor(readonly dir: string, private db: Database, private extract: Extract, private people: (() => readonly string[]) | null, readonly limits: DocLimits) {}

  /** The index takes files of this name: Office (docx, pptx, odt, xlsx, xls, ods), PDF, Hangul (hwp, hwpx), Markdown,
   * text, CSV/TSV and HTML. */
  static accepts(name: string): boolean { return acceptsName(name) }

  /** Open (or make) the index in `dir`, a folder of the server's data. A damaged database or one of another format is
   * removed and made again: the files are its source. */
  static open(dir: string, o: DocumentIndexOptions = {}): DocumentIndex {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, DB_FILE)
    let db: Database
    try { db = openDb(file) } catch { removeDbFiles(dir); db = openDb(file) }
    return new DocumentIndex(dir, db, o.extract ?? defaultExtract, o.people ?? null, { ...DOC_LIMITS, ...o.limits })
  }

  /**
   * A second connection to an index another connection writes (open), for its searches only (search-worker.ts): never
   * makes, changes or removes anything. The writer keeps the database in WAL mode (openDb), so this connection reads
   * the last committed state while the writer writes, and the writer never waits for it. Opened read-write with
   * query_only on, not read-only: a read-only connection cannot open a WAL database whose -shm file is not there yet
   * (SQLITE_CANTOPEN).
   */
  static openReader(dir: string, o: { people?: () => readonly string[] } = {}): DocumentIndex {
    const db = new Database(path.join(dir, DB_FILE), { readwrite: true, create: false })
    try {
      db.run('PRAGMA query_only=ON')
      db.run('PRAGMA busy_timeout=5000')
      const v = db.query("SELECT v FROM meta WHERE k = 'format'").get() as { v: string } | null
      if (v?.v !== FORMAT) throw new Error('document index: another format')
    } catch (e) { db.close(); throw e }
    const idx = new DocumentIndex(dir, db, async () => { throw new Error('a reader does not index') }, o.people ?? null, DOC_LIMITS)
    idx.reader = true
    return idx
  }

  /** A reader's connection (openReader), for the vectors of search by meaning in the same worker (meaning/search.ts),
   * which only read. */
  readerDb(): Database {
    if (!this.reader || this.closed) throw new Error('document index: not an open reader')
    return this.db
  }

  /** what is indexed in one folder: each file's size and mtime as given to update (size -1: try again), and why it
   * failed (null: indexed) */
  files(rootId: string): Map<string, IndexedFile> {
    const out = new Map<string, IndexedFile>()
    if (this.closed) return out
    for (const r of this.db.query('SELECT rel, size, mtime, failed FROM docs WHERE root_id = ?').all(rootId) as { rel: string; size: number; mtime: number; failed: string | null }[]) {
      out.set(r.rel, { size: r.size, mtimeMs: r.mtime, failed: r.failed })
    }
    return out
  }

  /**
   * Index one file from its bytes, read by the caller (`bytes: null`: the caller did not read it, too large). Never
   * throws for a bad file: it is recorded as failed with a short reason. Bytes equal to the indexed ones (SHA-256) only
   * update the size and mtime. `background`: the converters run below people's work. A caller's abort records nothing
   * ('aborted').
   */
  async update(rootId: string, relPath: string, file: { bytes: Uint8Array | null; size: number; mtimeMs: number }, o: { signal?: AbortSignal; background?: boolean } = {}): Promise<UpdateResult> {
    const name = path.posix.basename(relPath)
    if (!acceptsName(name)) return this.fail(rootId, relPath, file, 'unsupported', null)
    const bytes = file.bytes
    if (!bytes || file.size > this.limits.maxFileBytes || bytes.byteLength > this.limits.maxFileBytes) return this.fail(rootId, relPath, file, 'too_big', null)
    const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const old = this.doc(rootId, relPath)
    if (old && old.hash === hash && (old.failed === null || PERMANENT.has(old.failed))) {
      this.db.run('UPDATE docs SET size = ?, mtime = ? WHERE id = ?', [file.size, file.mtimeMs, old.id])
      return old.failed === null ? { ok: true, chunks: old.chunks } : { ok: false, reason: old.failed as DocFailure }
    }
    const timer = AbortSignal.timeout(this.limits.extractMs)
    const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer
    let raw: string
    try {
      const run = () => this.extract(relPath, bytes, signal)
      raw = await (o.background ? inBackground(() => true, run) : run())
    } catch (e) {
      if (o.signal?.aborted || this.closed) return { ok: false, reason: 'aborted' }
      return this.fail(rootId, relPath, file, failureOf(e, timer.aborted), hash)
    }
    if (o.signal?.aborted || this.closed) return { ok: false, reason: 'aborted' }

    const e = extOf(name)
    const html = e === 'html' || e === 'htm'
    const links = LINK_TEXT_EXT.has(e) ? docLinks(relPath, raw.length > this.limits.maxTextChars ? raw.slice(0, this.limits.maxTextChars) : raw) : []
    let text = html ? htmlText(raw) : raw
    if (text.length > this.limits.maxTextChars) text = text.slice(0, this.limits.maxTextChars)
    const pieces = mergePieces(chunkDoc(text, name)).slice(0, this.limits.maxChunks)
    if (!pieces.length) return this.fail(rootId, relPath, file, 'empty', hash)
    const terms = topTerms(text)
    const title = titleOf(text) ?? (html ? htmlTitle(raw) : null)
    this.db.transaction(() => {
      const id = this.upsert(rootId, relPath, file.size, file.mtimeMs, hash, null, title, pieces.length)
      this.clearDoc(id)
      const insChunk = this.db.prepare('INSERT INTO chunks(doc_id, ord, loc, text) VALUES (?, ?, ?, ?)')
      pieces.forEach((p, i) => insChunk.run(id, i, p.loc ? JSON.stringify(p.loc) : null, p.text))
      const insTerm = this.db.prepare('INSERT OR IGNORE INTO terms(doc_id, term, tf) VALUES (?, ?, ?)')
      for (const t of terms) insTerm.run(id, t.term, t.tf)
      const insLink = this.db.prepare('INSERT OR IGNORE INTO links(doc_id, target, base, raw) VALUES (?, ?, ?, ?)')
      for (const l of links) insLink.run(id, l.target, l.base, l.raw)
    })()
    this.version++
    return { ok: true, chunks: pieces.length }
  }

  /** Take one file out (deleted, moved away, no longer readable). */
  remove(rootId: string, relPath: string): void {
    if (this.closed) return
    const d = this.doc(rootId, relPath)
    if (!d) return
    this.db.transaction(() => { this.clearDoc(d.id); this.db.run('DELETE FROM docs WHERE id = ?', [d.id]) })()
    this.version++
  }

  /** Take a whole folder out (no longer indexed, or made again). */
  dropRoot(rootId: string): void {
    if (this.closed) return
    const sub = 'SELECT id FROM docs WHERE root_id = ?'
    this.db.transaction(() => {
      this.db.run(`DELETE FROM chunks WHERE doc_id IN (${sub})`, [rootId])
      this.db.run(`DELETE FROM terms WHERE doc_id IN (${sub})`, [rootId])
      this.db.run(`DELETE FROM links WHERE doc_id IN (${sub})`, [rootId])
      this.db.run('DELETE FROM docs WHERE root_id = ?', [rootId])
    })()
    this.version++
  }

  /** Close and delete the whole index from the disk (the documents part turned off). */
  destroy(): void {
    this.close()
    fs.rmSync(this.dir, { recursive: true, force: true })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.names = null
    this.peopleCache = null
    this.db.close()
  }

  /** bytes the index uses on the disk */
  diskBytes(): number {
    let n = 0
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { n += fs.statSync(path.join(this.dir, f)).size } catch {} }
    return n
  }

  stats(rootId: string): DocStats {
    if (this.closed) return { documents: 0, chunks: 0, failed: [], failedCount: 0, lastUpdatedAt: null }
    const c = this.db.query('SELECT sum(failed IS NULL) AS ok, sum(failed IS NOT NULL) AS bad, sum(chunks) AS chunks, max(updated_at) AS at FROM docs WHERE root_id = ?').get(rootId) as { ok: number | null; bad: number | null; chunks: number | null; at: number | null }
    const failed = (this.db.query('SELECT rel, failed FROM docs WHERE root_id = ? AND failed IS NOT NULL ORDER BY rel LIMIT ?').all(rootId, FAILED_SHOWN) as { rel: string; failed: string }[])
      .map((r) => ({ relPath: r.rel, reason: r.failed }))
    return { documents: c.ok ?? 0, chunks: c.chunks ?? 0, failed, failedCount: c.bad ?? 0, lastUpdatedAt: c.at ? new Date(c.at).toISOString() : null }
  }

  /**
   * The pieces of documents that answer a question, best first, in the folders given (the ones the person may search;
   * the caller still checks each file). At most 3 pieces per file. `score` is about 0 to 15: 10 for holding every word
   * of the question, 3 more for the whole phrase, up to 2 for how often the words are in it. `passage`: each hit also
   * brings up to that many characters of its piece around the match. `prefix`: only files under that folder of the root.
   *
   * Bounded: the pieces looked at are the first PER_WORD the full-text index lists for each word and the first ALL_WORDS
   * holding every word, unranked, so a common word costs about what a rare one does (one that is in thousands of pieces
   * gives an arbitrary few hundred of them, which no single common word answers well anyway). A word of three characters
   * or more is found inside longer words (trigram); a shorter one only at the start of a word ("환불" in "환불은"), never
   * in the middle of one: that took a full scan of the text, which held the one search worker for 0.3–1.1 s (grep finds
   * exact text).
   */
  search(query: string, o: SearchOptions): DocHit[] {
    return this.hits(this.rankKeywords(query, o), o)
  }

  /** The keyword part of search(): every piece found, scored and best first, before the per-file limit. */
  rankKeywords(query: string, o: SearchOptions): KeywordRanking {
    const none: KeywordRanking = { terms: [], scored: [] }
    if (this.closed || !o.rootIds.length) return none
    const terms = queryTerms(query)
    if (!terms.length) return none
    const scope = JSON.stringify([...new Set(o.rootIds)])
    const within = withinPrefix(o.prefix)
    const cand = new Set<number>()
    const add = (rows: { id: number }[]) => { for (const r of rows) cand.add(r.id); return rows.length }
    const short = terms.filter((t) => chars(t) < 3)
    // pieces holding every word: in the trigram index when every word has three characters or more, else as whole words
    if (terms.length > 1) {
      add(short.length ? this.firstMatches('fts_uni', terms.map(wordForms).join(' AND '), scope, ALL_WORDS, within)
        : this.firstMatches('fts_tri', terms.map(phrase).join(' AND '), scope, ALL_WORDS, within))
    }
    for (const t of terms) {
      // three characters or more: anywhere, also inside longer words (trigram)
      if (chars(t) >= 3) { add(this.firstMatches('fts_tri', phrase(t), scope, PER_WORD, within)); continue }
      // shorter: as a whole word (with Korean particles); words that start with it ("회의록" for "회의") only when those
      // were few, so the prefix query stays small
      if (add(this.firstMatches('fts_uni', wordForms(t), scope, PER_WORD, within)) < PER_WORD / 3) add(this.firstMatches('fts_uni', phrase(t) + '*', scope, PER_WORD, within))
    }
    if (!cand.size) return { terms, scored: [] }
    const rows = this.db.query('SELECT c.id, c.loc, c.text, d.root_id, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...cand])) as Scored['r'][]
    const whole = terms.length > 1 ? norm(query).replace(/\s+/g, ' ').trim() : ''
    const scored: Scored[] = []
    for (const r of rows) {
      const low = norm(r.text)
      const hit = terms.filter((t) => low.includes(t))
      if (!hit.length) continue
      const phraseHit = whole.length >= 3 && low.replace(/\s+/g, ' ').includes(whole) ? 1 : 0
      // how often the words are in it (each counted up to 4 times): the tie-break the full-text rank used to be
      let often = 0
      for (const t of hit) for (let i = low.indexOf(t), n = 0; i >= 0 && n < 4; i = low.indexOf(t, i + t.length), n++) often++
      scored.push({ r, hit, score: Math.round(((hit.length / terms.length) * 10 + phraseHit * 3 + (often / (terms.length * 4)) * 2) * 1000) / 1000 })
    }
    scored.sort((a, b) => b.score - a.score || a.r.rel.localeCompare(b.r.rel))
    return { terms, scored }
  }

  /**
   * The hits of a keyword ranking (rankKeywords): at most 3 pieces per file, each with its snippet and passage. With
   * `meaning` (the closest pieces by meaning, best first, from the search worker's vectors), the two lists are fused by
   * rank (reciprocal rank fusion, meaning/vectors.ts rrf) first; without it, or when it is empty, the hits are exactly
   * search()'s. Fused scores keep search()'s range (0 to 15) and follow the fused order; on a tie the piece the keyword
   * search found comes first. A piece only meaning found is marked `byMeaning` and is read again here within the same
   * folders and prefix, so a vector held for a piece that was deleted or moved since gives nothing.
   */
  hits(k: KeywordRanking, o: SearchOptions, meaning?: readonly MeaningHit[] | null): DocHit[] {
    if (this.closed || !o.rootIds.length) return []
    const list = meaning?.length ? this.fuse(k, meaning, o) : k.scored
    const limit = clamp(o.limit ?? 20, 1, 100)
    const perFile = new Map<string, number>()
    const out: DocHit[] = []
    const width = clamp(o.passage ?? 0, 0, 20_000)
    for (const { r, hit, score, byMeaning } of list) {
      const key = r.root_id + '\0' + r.rel
      const n = perFile.get(key) ?? 0
      if (n >= 3) continue
      perFile.set(key, n + 1)
      let loc: SourceLoc | null = null
      try { loc = r.loc ? JSON.parse(r.loc) as SourceLoc : null } catch {}
      out.push({ rootId: r.root_id, relPath: r.rel, loc, snippet: snippetOf(r.text, hit), ...(width ? { passage: passageOf(r.text, hit, width) } : {}), score, ...(byMeaning ? { byMeaning } : {}) })
      if (out.length >= limit) break
    }
    return out
  }

  private fuse(k: KeywordRanking, meaning: readonly MeaningHit[], o: SearchOptions): Scored[] {
    const found = new Map(k.scored.map((s) => [s.r.id, s]))
    const only = [...new Set(meaning.map((m) => m.id))].filter((id) => !found.has(id))
    if (only.length) {
      const within = withinPrefix(o.prefix)
      const rows = this.db.query(`SELECT c.id, c.loc, c.text, d.root_id, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id IN (SELECT value FROM json_each(?)) AND d.failed IS NULL AND ${IN_SCOPE}${within.sql}`)
        .all(JSON.stringify(only), JSON.stringify([...new Set(o.rootIds)]), ...within.args) as Scored['r'][]
      for (const r of rows) {
        const low = norm(r.text)
        found.set(r.id, { r, hit: k.terms.filter((t) => low.includes(t)), score: 0, byMeaning: true })
      }
    }
    const out: Scored[] = []
    for (const [id, f] of rrf([k.scored.map((s) => s.r.id), meaning.map((m) => m.id)], RRF_K)) {
      const s = found.get(id)
      if (s) out.push({ ...s, score: Math.round(f * FUSED_SCALE * 1000) / 1000 })
    }
    return out.sort((a, b) => b.score - a.score || Number(!!a.byMeaning) - Number(!!b.byMeaning) || a.r.rel.localeCompare(b.r.rel) || a.r.id - b.r.id)
  }

  /**
   * Documents related to one document, in the folders given (the caller checks each one for the person), strongest
   * first. Each comes with its strongest reason and all its reasons: a link between the two (link), one names the other
   * (mention), the same team members in both (people), distinctive words in common (terms), the same folder (folder).
   * A reason's detail comes only from the two documents: the link as written, the name mentioned, the members' names
   * found in both, the shared words, the folder.
   */
  related(rootId: string, relPath: string, o: { rootIds: readonly string[]; limit?: number }): RelatedDoc[] {
    if (this.closed) return []
    const x = this.doc(rootId, relPath)
    const scopeIds = [...new Set(o.rootIds)]
    if (!x || x.failed !== null || !scopeIds.length) return []
    const scope = JSON.stringify(scopeIds)
    const limit = clamp(o.limit ?? 10, 1, 50)
    const found = new Map<number, RelatedReason[]>()
    const note = (id: number, r: RelatedReason) => {
      if (id === x.id) return
      const l = found.get(id) ?? []
      if (!l.some((q) => q.kind === r.kind)) l.push({ kind: r.kind, detail: r.detail.slice(0, 200) })
      found.set(id, l)
    }
    const ok = `d.failed IS NULL AND ${IN_SCOPE}`

    // links: this document's links to files in the folders asked, and theirs to this one
    for (const l of this.db.query('SELECT target, base, raw FROM links WHERE doc_id = ?').all(x.id) as { target: string; base: string; raw: string }[]) {
      const ys = l.target
        ? this.db.query(`SELECT d.id FROM docs d WHERE d.root_id = ? AND (d.rel = ? OR d.name_lc = ?) AND ${ok} ORDER BY d.rel = ? DESC LIMIT 1`).all(x.root_id, l.target, l.base, scope, l.target)
        : this.db.query(`SELECT d.id FROM docs d WHERE d.name_lc = ? AND ${ok} LIMIT 5`).all(l.base, scope)
      for (const y of ys as { id: number }[]) note(y.id, { kind: 'link', detail: l.raw })
    }
    for (const l of this.db.query(`SELECT l.doc_id AS id, l.raw FROM links l JOIN docs d ON d.id = l.doc_id WHERE ((l.target = ? AND d.root_id = ?) OR (l.target = '' AND l.base = ?)) AND ${ok} LIMIT 50`)
      .all(x.rel, x.root_id, x.name_lc, scope) as { id: number; raw: string }[]) note(l.id, { kind: 'link', detail: l.raw })

    // mentions: this document names another one, or another one names this one
    const xText = this.textOf(x.id)
    const names = this.nameMatcher(scope)
    if (names) for (const i of names.m.find(xText)) for (const w of names.owners[i]!) note(w.id, { kind: 'mention', detail: w.shown })
    for (const n of mentionNames(x.rel, x.title)) {
      if (chars(n.key) < 3) continue
      for (const r of this.match('fts_tri', phrase(n.key), scope, 50, 'c.doc_id AS id')) note(r.id, { kind: 'mention', detail: n.shown })
    }

    // people: team members named in this document and in another one
    const people = this.peopleMatcher()
    if (people) {
      const shared = new Map<number, string[]>()
      const inX = [...people.m.find(xText)].map((i) => people.names[i]!).filter((n) => nameIn(xText, norm(n))).slice(0, 20)
      for (const n of inX) {
        const key = norm(n)
        const rows = chars(key) >= 3
          ? this.match('fts_tri', phrase(key), scope, 100, 'c.doc_id AS id, c.text AS text')
          : this.db.query(`SELECT c.doc_id AS id, c.text AS text FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE ${ok} AND c.text LIKE ? ESCAPE '\\' LIMIT 100`).all(scope, '%' + likeEscape(key) + '%') as { id: number; text: string }[]
        for (const r of rows as { id: number; text: string }[]) {
          if (r.id === x.id || !nameIn(norm(r.text), key)) continue
          const l = shared.get(r.id) ?? []
          if (!l.includes(n)) l.push(n)
          shared.set(r.id, l)
        }
      }
      for (const [id, ns] of shared) note(id, { kind: 'people', detail: ns.slice(0, 3).join(', ') })
    }

    // terms: distinctive words in common (TF-IDF over the folders asked)
    const termWeight = new Map<number, number>()
    const xs = this.db.query('SELECT term, tf FROM terms WHERE doc_id = ?').all(x.id) as { term: string; tf: number }[]
    if (xs.length) {
      const n = (this.db.query(`SELECT count(*) AS n FROM docs d WHERE ${ok}`).get(scope) as { n: number }).n
      const df = new Map((this.db.query(`SELECT t.term, count(*) AS df FROM terms t JOIN docs d ON d.id = t.doc_id WHERE t.term IN (SELECT value FROM json_each(?)) AND ${ok} GROUP BY t.term`)
        .all(JSON.stringify(xs.map((t) => t.term)), scope) as { term: string; df: number }[]).map((r) => [r.term, r.df]))
      const maxDf = Math.max(2, Math.floor(n * 0.3))
      const idf = (t: string) => Math.log((n + 1) / (df.get(t) ?? 1))
      const q = xs.filter((t) => { const d = df.get(t.term) ?? 0; return d >= 2 && d <= maxDf })
        .sort((a, b) => b.tf * idf(b.term) - a.tf * idf(a.term)).slice(0, 20).map((t) => t.term)
      if (q.length >= MIN_SHARED_TERMS) {
        const per = new Map<number, string[]>()
        for (const r of this.db.query(`SELECT t.doc_id AS id, t.term FROM terms t JOIN docs d ON d.id = t.doc_id WHERE t.term IN (SELECT value FROM json_each(?)) AND t.doc_id != ? AND ${ok}`)
          .all(JSON.stringify(q), x.id, scope) as { id: number; term: string }[]) per.set(r.id, [...(per.get(r.id) ?? []), r.term])
        for (const [id, ts] of per) {
          if (ts.length < MIN_SHARED_TERMS) continue
          ts.sort((a, b) => idf(b) - idf(a))
          termWeight.set(id, Math.min(10, ts.reduce((s, t) => s + idf(t), 0)))
          note(id, { kind: 'terms', detail: ts.slice(0, 3).join(', ') })
        }
      }
    }

    // the same folder
    if (scopeIds.includes(x.root_id)) {
      for (const r of this.db.query('SELECT id FROM docs WHERE root_id = ? AND dir = ? AND id != ? AND failed IS NULL ORDER BY mtime DESC LIMIT 30').all(x.root_id, x.dir, x.id) as { id: number }[]) {
        note(r.id, { kind: 'folder', detail: x.dir || '.' })
      }
    }

    if (!found.size) return []
    const scoreOf = (id: number, rs: RelatedReason[]) => rs.reduce((s, r) => s + WEIGHT[r.kind] + (r.kind === 'terms' ? termWeight.get(id) ?? 0 : r.kind === 'people' ? 2 * r.detail.split(', ').length : 0), 0)
    const rows = new Map((this.db.query('SELECT id, root_id, rel FROM docs WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify([...found.keys()])) as { id: number; root_id: string; rel: string }[])
      .map((r) => [r.id, r]))
    return [...found.entries()]
      .filter(([id]) => rows.has(id))
      .map(([id, rs]) => ({ id, rs: [...rs].sort((a, b) => WEIGHT[b.kind] - WEIGHT[a.kind]), score: scoreOf(id, rs) }))
      .sort((a, b) => b.score - a.score || rows.get(a.id)!.rel.localeCompare(rows.get(b.id)!.rel))
      .slice(0, limit)
      .map(({ id, rs }) => ({ rootId: rows.get(id)!.root_id, relPath: rows.get(id)!.rel, reason: rs[0]!, reasons: rs }))
  }

  // ---- inside ----

  /** a number that changes whenever the index does (a reader sees the writer's commits through data_version) */
  private changes(): string {
    if (!this.reader) return String(this.version)
    return String((this.db.query('PRAGMA data_version').get() as { data_version: number }).data_version)
  }

  private doc(rootId: string, relPath: string): DocRow | null {
    return this.db.query('SELECT * FROM docs WHERE root_id = ? AND rel = ?').get(rootId, relPath) as DocRow | null
  }

  private upsert(rootId: string, relPath: string, size: number, mtimeMs: number, hash: string | null, failed: string | null, title: string | null, chunks: number): number {
    const dir = path.posix.dirname(relPath)
    const r = this.db.query(`INSERT INTO docs(root_id, rel, dir, name_lc, size, mtime, hash, failed, title, chunks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(root_id, rel) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash, failed = excluded.failed,
      title = excluded.title, chunks = excluded.chunks, updated_at = excluded.updated_at RETURNING id`)
      .get(rootId, relPath, dir === '.' ? '' : dir, norm(path.posix.basename(relPath)), size, mtimeMs, hash, failed, title, chunks, Date.now()) as { id: number }
    return r.id
  }

  private clearDoc(id: number) {
    this.db.run('DELETE FROM chunks WHERE doc_id = ?', [id])
    this.db.run('DELETE FROM terms WHERE doc_id = ?', [id])
    this.db.run('DELETE FROM links WHERE doc_id = ?', [id])
  }

  /** record a failed file: its old text goes (it is not this file's any more); a timeout is tried again (size -1) */
  private fail(rootId: string, relPath: string, file: { size: number; mtimeMs: number }, reason: DocFailure, hash: string | null): UpdateResult {
    if (this.closed) return { ok: false, reason: 'aborted' }
    const retry = reason === 'timeout'
    this.db.transaction(() => {
      const id = this.upsert(rootId, relPath, retry ? -1 : file.size, file.mtimeMs, retry ? null : hash, reason, null, 0)
      this.clearDoc(id)
    })()
    this.version++
    return { ok: false, reason }
  }

  private match(table: 'fts_tri' | 'fts_uni', expr: string, scope: string, n: number, cols = 'c.id AS id'): any[] {
    try {
      return this.db.query(`SELECT ${cols} FROM ${table} JOIN chunks c ON c.id = ${table}.rowid JOIN docs d ON d.id = c.doc_id WHERE ${table} MATCH ? AND d.failed IS NULL AND ${IN_SCOPE} ORDER BY bm25(${table}) LIMIT ?`).all(expr, scope, n)
    } catch { return [] }
  }

  /** the first `n` pieces in scope that match, as the full-text index lists them (no ranking: it stops after `n`) */
  private firstMatches(table: 'fts_tri' | 'fts_uni', expr: string, scope: string, n: number, within: { sql: string; args: string[] }): { id: number }[] {
    try {
      return this.db.query(`SELECT c.id AS id FROM ${table} JOIN chunks c ON c.id = ${table}.rowid JOIN docs d ON d.id = c.doc_id WHERE ${table} MATCH ? AND d.failed IS NULL AND ${IN_SCOPE}${within.sql} LIMIT ?`).all(expr, scope, ...within.args, n) as { id: number }[]
    } catch { return [] }
  }

  /** a document's text for matching names (lowercase, at most 1 MB) */
  private textOf(id: number): string {
    let s = ''
    for (const r of this.db.query('SELECT text FROM chunks WHERE doc_id = ? ORDER BY ord').all(id) as { text: string }[]) {
      s += r.text + '\n'
      if (s.length >= MATCH_TEXT_MAX) break
    }
    return norm(s.slice(0, MATCH_TEXT_MAX))
  }

  /** the names the documents in these folders can be mentioned by, as one matcher (made again after a change) */
  private nameMatcher(scope: string) {
    const key = `${this.changes()}\0${scope}`
    if (this.names?.key === key) return this.names
    const byKey = new Map<string, { id: number; shown: string }[]>()
    for (const d of this.db.query(`SELECT d.id, d.rel, d.title FROM docs d WHERE d.failed IS NULL AND ${IN_SCOPE} LIMIT 50000`).all(scope) as { id: number; rel: string; title: string | null }[]) {
      for (const n of mentionNames(d.rel, d.title)) byKey.set(n.key, [...(byKey.get(n.key) ?? []), { id: d.id, shown: n.shown }])
    }
    if (!byKey.size) return (this.names = null)
    const keys = [...byKey.keys()]
    this.names = { key, m: new Matcher(keys), owners: keys.map((k) => byKey.get(k)!) }
    return this.names
  }

  private peopleMatcher() {
    if (!this.people) return null
    let list: string[]
    try { list = [...new Set(this.people().filter((n) => typeof n === 'string' && usableName(n)).map((n) => n.trim()))].slice(0, PEOPLE_MAX) } catch { return null }
    if (!list.length) return null
    const key = list.join('\0')
    if (this.peopleCache?.key === key) return this.peopleCache
    this.peopleCache = { key, m: new Matcher(list.map(norm)), names: list }
    return this.peopleCache
  }
}

// ---- questions: which words of a question say what it is about, and how well a passage holds them ----------------
// (the lookup before the model starts, the AI's tool and the Files search: service.ts lookup). A chat message is not a
// search: "can you find where we wrote the refund policy?" is about two words. Greetings, thanks, requests ("find",
// "write", "알려줘", "정리해줘"), question words ("where", "어디", "며칠") and fillers ("about", "관련", "문서") are left
// out, in English and Korean, so an ordinary message has few or no words left and cannot match strongly.

const HANGUL_RE = /[가-힣]/
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/
/** English words that say what to do or how to ask, not what about */
const ASK_EN = new Set(('hi hello hey hiya thanks thank thx ty cheers ok okay yes yeah yep nope sure great good nice cool fine morning ' +
  'evening afternoon bye please pls plz sorry kindly ' +
  'you your yours yourself me mine myself our ours ourselves him his her hers she they them their theirs its this that these those ' +
  'something anything everything nothing someone anyone everyone somebody anybody ' +
  'are was were been being does did done doing have has had having can could will would shall should may might must lets ' +
  'don doesn didn isn aren wasn weren won wouldn couldn shouldn haven hasn hadn cannot ' +
  'tell show find give get got write wrote written make made create draft send sent help need needs want wants like know ' +
  'look looking search explain summarize summarise summary list check read open see say said says put keep use used using try ' +
  'ask asked answer reply mean think remember fetch pull bring share translate fix edit update review compare ' +
  'what which who whom whose where when why how whats ' +
  'the and but for from with into onto than then there here also just only very really some any all more most much many ' +
  'other again now today quick quickly short brief about regarding per via within without over under between ' +
  'out down off back away around through across along still even ever already yet maybe perhaps probably actually ' +
  'basically exactly somewhere anywhere everywhere ' +
  'document documents doc docs file files folder folders info information detail details thing things stuff ' +
  // in a team's own folders these are in almost every document
  'team teams work works working job jobs task tasks people person company member members staff ' +
  'trina claude codex assistant').split(' '))
/** two-letter English words that never say what a question is about ("HR", "QA", "Q4" do) */
const SHORT_EN = new Set('am an as at be by do go he hi if in is it me my no of oh ok on or so to up us we ya yo ah eh hm uh um re vs pl'.split(' '))
/** Korean words that say what to do or how to ask (after a particle is taken off), not what about */
// (greetings and thanks as whole phrases only: "감사" alone is also "audit", as in "감사 보고서")
const ASK_KO = new Set(('안녕 안녕하세요 안녕하십니까 감사합니다 감사해요 감사드립니다 감사드려요 고마워 고마워요 고맙습니다 수고하셨습니다 수고했어 수고하세요 ' +
  '네네 아니 아니요 좋아 좋아요 오케이 부탁 부탁해 부탁해요 부탁드립니다 부탁드려요 ' +
  '우리 저희 당신 이거 그거 저거 이것 그것 저것 여기 거기 저기 이번 저번 지난번 그냥 조금 혹시 아까 지금 오늘 내일 어제 이제 다시 먼저 ' +
  '빨리 간단히 간단하게 자세히 자세하게 모든 전부 한번 같이 ' +
  '뭐야 뭐지 뭐가 뭔가 무엇 무슨 어디 어디서 어딨어 어딨지 어디야 언제 누구 누가 어떻게 어떤 어느 얼마 얼마나 며칠 어때 어때요 어땠어 ' +
  '알려 찾아 찾아봐 보여 정리 요약 작성 만들어 보내 번역 고쳐 확인 검색 설명 검토 추천 도와 봐줘 써줘 해줘 해주세요 ' +
  '있어 있어요 있나 있니 있지 있음 없어 없나 없지 없음 ' +
  '관련 관련된 관련해서 관한 대해 대해서 대한 관해 관해서 내용 문서 파일 자료 폴더 정보 그리고 그런데 근데 하지만 또한 그래서 ' +
  '위해 통해 경우 때문 현재 이후 이전 그러나 있습니다 없습니다 있는 없는 같은 이런 그런 여러분 있다 없다 한다 하다 되다 트리나 ' +
  '회사 사람 팀원 모두 다들').split(' '))
/** a past-tense ending: "썼지", "했어", "작성했나요" (the stem before it, when two syllables or more, is the word) */
const KO_PAST = /(었|았|였|했|썼|됐|봤|왔|갔|겠|웠|셨|땠)(지|어|나|니|냐|죠|어요|나요|니까|던가|더라|는지|을까|지요|습니까|습니다|다)$/
/** a request or question ending: "알려줘", "정리해줘", "있나요", "정책이야" */
const KO_END = /(해줘요|해줘|해주세요|해줄래|줘요|줘|주세요|주실래요|줄래요|줄래|할까요|할까|할래|인가요|인가|일까|나요|까요|습니까|세요|어요|아요|지요|이야|이지|이죠|야|죠|냐)$/
/** of these endings, a one-syllable stem is still a noun ("분야"), not a verb */
const KO_END_NOUNISH = new Set(['야', '죠', '인가', '이야', '이지', '이죠', '일까'])

function koWord(w0: string): string | null {
  let w = stripKo(w0)
  if (ASK_KO.has(w0) || ASK_KO.has(w)) return null
  const past = KO_PAST.exec(w)
  if (past) {
    const stem = w.slice(0, past.index)
    if (stem.length < 2) return null
    w = stem
  } else {
    const end = KO_END.exec(w)
    if (end) {
      const stem = w.slice(0, end.index)
      if (stem.length >= 2) w = stem
      else if (!KO_END_NOUNISH.has(end[1]!)) return null
    }
  }
  w = stripKo(w)
  return w.length >= 2 && !ASK_KO.has(w) ? w : null
}

/**
 * The words of a question that say what it is about, lowercase, at most `max`, in order: split like queryTerms
 * (dots, dashes and underscores stay inside a word: "q3-plan.xlsx"), Korean particles and request endings off, and
 * greetings, thanks, requests, question words and fillers left out. Latin words of two letters count unless they are
 * common ones ("of", "to", "me"); one letter never does. Kana and Han: two characters or more.
 */
export function questionTerms(q: string, max = 8): string[] {
  const out: string[] = []
  for (const raw of norm(String(q ?? '').slice(0, 4000)).split(/[\s,;:!?()[\]{}"'“”‘’«»<>|/\\`*+=~^]+/)) {
    const w0 = raw.replace(/^[.\-_#@]+|[.\-_#@]+$/g, '')
    // letters alone ("ㅋㅋ", "ㅎㅎ"; NFKC turns them into the conjoining ones) are laughter, not words
    if (!w0 || w0.length > 64 || !/[\p{L}\p{N}]/u.test(w0) || /^[ㄱ-ㆎᄀ-ᇿ]+$/.test(w0)) continue
    let w: string | null
    if (HANGUL_RE.test(w0)) w = koWord(w0)
    else if (CJK_RE.test(w0)) w = w0.length >= 2 ? w0 : null
    else w = w0.length >= 2 && !ASK_EN.has(w0) && !(w0.length === 2 && SHORT_EN.has(w0)) ? w0 : null
    if (!w || out.includes(w)) continue
    out.push(w)
    if (out.length >= max) break
  }
  return out
}

/** how close together (characters) the words of a strong match must be: a sentence or two */
export const STRONG_NEAR = 300

/** Where `t` appears in `low` (lowercase text): Latin words and numbers only at the start of a word ("plan" in
 * "planning", not in "explanation"); Hangul, Kana and Han anywhere (particles and endings attach to words). */
function placesOf(low: string, t: string): number[] {
  const out: number[] = []
  const anywhere = HANGUL_RE.test(t[0]!) || CJK_RE.test(t[0]!)
  for (let i = low.indexOf(t); i >= 0 && out.length < 64; i = low.indexOf(t, i + 1)) {
    if (anywhere || i === 0 || !/[\p{Script=Latin}\p{N}]/u.test(low[i - 1]!)) out.push(i)
  }
  return out
}

/** the shortest stretch of text (from the first start to the last) that holds a place of every list */
function spanOf(lists: number[][]): number {
  if (!lists.length || lists.some((l) => !l.length)) return Infinity
  if (lists.length === 1) return 0
  const all = lists.flatMap((l, k) => l.map((p) => [p, k] as const)).sort((a, b) => a[0] - b[0])
  const count = new Array<number>(lists.length).fill(0)
  let have = 0, best = Infinity, lo = 0
  for (let hi = 0; hi < all.length; hi++) {
    if (count[all[hi]![1]]!++ === 0) have++
    while (have === lists.length) {
      best = Math.min(best, all[hi]![0] - all[lo]![0])
      if (--count[all[lo]![1]]! === 0) have--
      lo++
    }
  }
  return best
}

/** a single word specific enough to answer from alone: a code, an id, a date or a version (letters or separators with
 * digits, four characters or more: "canary-fin-7731", "2026-11-03", "q3-plan.xlsx"), or a file name ("pricing.md") */
const specificWord = (t: string) => (t.length >= 4 && /\d/.test(t) && /[\p{L}.\-_:]/u.test(t)) || /^[^.]{2,}\.[a-z0-9]{2,5}$/.test(t)

/**
 * How well one passage answers a question's words (questionTerms):
 * - strong: it holds every word, all within STRONG_NEAR characters of each other (the phrase as written always is);
 *   with four words or more, all but one is enough (a longer message carries a word or two that documents need not
 *   hold); a question of one word only when that word is specific (specificWord), since one ordinary word ("email",
 *   "회의") is in too many documents to answer from
 * - weak: it holds some of them
 * - none: it holds none (or only inside longer Latin words)
 */
export function matchStrength(terms: readonly string[], text: string): 'strong' | 'weak' | 'none' {
  if (!terms.length || !text) return 'none'
  const low = norm(text)
  const places = terms.map((t) => placesOf(low, t))
  const held = places.filter((p) => p.length)
  if (!held.length) return 'none'
  const n = terms.length
  if (n === 1) return specificWord(terms[0]!) ? 'strong' : 'weak'
  if (held.length === n && spanOf(held) <= STRONG_NEAR) return 'strong'
  if (n >= 4 && held.length === n - 1 && spanOf(held) <= STRONG_NEAR) return 'strong'
  if (n >= 4 && held.length === n) for (let skip = 0; skip < n; skip++) if (spanOf(held.filter((_, i) => i !== skip)) <= STRONG_NEAR) return 'strong'
  return 'weak'
}
