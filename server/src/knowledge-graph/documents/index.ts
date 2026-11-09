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
import { Matcher } from './matcher'
import { acceptsName, docLinks, extOf, htmlText, mentionNames, nameIn, norm, queryTerms, snippetOf, titleOf, topTerms, usableName } from './text'

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
export interface DocHit { rootId: string; relPath: string; loc: SourceLoc | null; snippet: string; score: number }
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
const CANDIDATES = 300
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

interface DocRow { id: number; root_id: string; rel: string; dir: string; name_lc: string; size: number; mtime: number; hash: string | null; failed: string | null; title: string | null; chunks: number; updated_at: number }

export class DocumentIndex {
  private closed = false
  /** changes since open: a cached name matcher of an older version is made again */
  private version = 0
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
   * of the question, 3 more for the whole phrase, up to 2 for the full-text rank.
   */
  search(query: string, o: { rootIds: readonly string[]; limit?: number }): DocHit[] {
    if (this.closed || !o.rootIds.length) return []
    const terms = queryTerms(query)
    if (!terms.length) return []
    const limit = clamp(o.limit ?? 20, 1, 100)
    const scope = JSON.stringify([...new Set(o.rootIds)])
    const cand = new Map<number, number>()
    const add = (rows: { id: number }[]) => rows.forEach((r, i) => { const b = 1 - i / rows.length; if ((cand.get(r.id) ?? -1) < b) cand.set(r.id, b) })
    const long = terms.filter((t) => chars(t) >= 3)
    if (long.length) add(this.match('fts_tri', long.map(phrase).join(' OR '), scope, CANDIDATES))
    add(this.match('fts_uni', terms.map((t) => phrase(t) + '*').join(' OR '), scope, CANDIDATES))
    const short = terms.filter((t) => chars(t) < 3)
    if (short.length && cand.size < limit * 3) {
      for (const t of short.slice(0, 3)) add(this.db.query(`SELECT c.id AS id FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE ${IN_SCOPE} AND c.text LIKE ? ESCAPE '\\' LIMIT ?`).all(scope, '%' + likeEscape(t) + '%', CANDIDATES) as { id: number }[])
    }
    if (!cand.size) return []
    const rows = this.db.query('SELECT c.id, c.loc, c.text, d.root_id, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...cand.keys()])) as { id: number; loc: string | null; text: string; root_id: string; rel: string }[]
    const whole = terms.length > 1 ? norm(query).replace(/\s+/g, ' ').trim() : ''
    const scored: { r: (typeof rows)[number]; hit: string[]; score: number }[] = []
    for (const r of rows) {
      const low = norm(r.text)
      const hit = terms.filter((t) => low.includes(t))
      if (!hit.length) continue
      const phraseHit = whole.length >= 3 && low.replace(/\s+/g, ' ').includes(whole) ? 1 : 0
      scored.push({ r, hit, score: Math.round(((hit.length / terms.length) * 10 + phraseHit * 3 + (cand.get(r.id) ?? 0) * 2) * 1000) / 1000 })
    }
    scored.sort((a, b) => b.score - a.score || a.r.rel.localeCompare(b.r.rel))
    const perFile = new Map<string, number>()
    const out: DocHit[] = []
    for (const { r, hit, score } of scored) {
      const k = r.root_id + '\0' + r.rel
      const n = perFile.get(k) ?? 0
      if (n >= 3) continue
      perFile.set(k, n + 1)
      let loc: SourceLoc | null = null
      try { loc = r.loc ? JSON.parse(r.loc) as SourceLoc : null } catch {}
      out.push({ rootId: r.root_id, relPath: r.rel, loc, snippet: snippetOf(r.text, hit), score })
      if (out.length >= limit) break
    }
    return out
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
    const key = `${this.version}\0${scope}`
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
