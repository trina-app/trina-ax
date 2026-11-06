// The intro deck's files (docs/DECISIONS.md "D2"): the PowerPoint file and the PDF, built on demand from the checked
// document in intro_decks (never from the artifact's HTML), with the pictures read with the chat owner's permissions at
// build time (a picture they can no longer read turns that slide into its type-only version, never a broken file).
// The PPTX is our own writer (pptx.ts) and works everywhere; the PDF needs typst (every Linux bundle carries it; a Mac
// uses Homebrew's) and the bundled static Pretendard: where either is missing the PDF is not offered at all. A file
// once built is kept as <data>/intro-decks/<artifact id>.pptx|.pdf and given again; it goes when its chat is purged
// (chat/forget.ts → forgetIntroDecks). The files are built the same way every time (no clock inside), so their hashes
// recorded in intro_decks recognize a deck that is put back into the team folder (spec.ts refuses it as a source).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IntroDeckInfo } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { REPO_ROOT } from '../app-config'
import { bundledFontDir, which } from '../config'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { readRegular } from '../files/store'
import { makeWorkDir, readOutput, runIsolated } from '../tools/isolate'
import { typstJobs } from '../system/limits'
import { imageSize } from '../uploads/image'
import { layoutDeck, type DeckDoc, type DeckOut } from './layout'
import { layoutDeck2, type DeckDoc2 } from './layout2'
import { buildPptx, extOf, PRETENDARD_FILES } from './pptx'
import { buildTypst } from './typst'
import { rasterizeSvg } from './render'

/** A deck as stored: round 1's document, or round 2's (`v: 2`). */
export interface StoredDeck { title: string; sources: string[]; doc: DeckDoc | DeckDoc2 }
const layoutAny = (doc: DeckDoc | DeckDoc2): DeckOut => ('v' in doc && doc.v === 2 ? layoutDeck2(doc) : layoutDeck(doc as DeckDoc))
interface Row { artifact_id: string; chat_id: string; user_id: string; owner_id: string; spec: string; pptx_sha256: string | null; pdf_sha256: string | null; created_at: string }

/** The folder of the static Pretendard TTFs: the server bundle's fonts/ (next to Noto Sans CJK), else the repository's. */
export function pretendardDir(): string | null {
  for (const d of [bundledFontDir(), path.join(REPO_ROOT, 'resources', 'fonts', 'pretendard')]) {
    if (d && Object.values(PRETENDARD_FILES).every((f) => fs.existsSync(path.join(d, f)))) return d
  }
  return null
}
const typstBin = () => { const p = process.env.MYCEL_TYPST_BIN ?? which('typst'); return p && fs.existsSync(p) ? p : null }
/** Can this server make the PDF? (Read for every info answer: an install shows without a restart.) */
export const pdfAvailable = () => !!typstBin() && !!pretendardDir()

const deckDir = (ctx: AppContext) => path.join(ctx.engineConfig.dataDir, 'intro-decks')
const deckFile = (ctx: AppContext, id: string, ext: 'pptx' | 'pdf') => path.join(deckDir(ctx), `${id}.${ext}`)

/** The caller's own intro deck (by its artifact id), or 404. */
function ownRow(ctx: AppContext, userId: string, id: string): Row {
  const r = ctx.db.query(`SELECT d.artifact_id, d.chat_id, d.user_id, c.user_id AS owner_id, d.spec, d.pptx_sha256, d.pdf_sha256, d.created_at
    FROM intro_decks d JOIN chats c ON c.id = d.chat_id WHERE d.artifact_id = ? AND c.user_id = ? AND c.deleted_at IS NULL`).get(id, userId) as Row | null
  if (!r) throw new HttpError('not_found')
  return r
}

export function introDeckInfo(ctx: AppContext, userId: string, id: string): IntroDeckInfo {
  const r = ownRow(ctx, userId, id)
  const spec = JSON.parse(r.spec) as StoredDeck
  return { artifactId: r.artifact_id, chatId: r.chat_id, title: spec.title, theme: spec.doc.theme, slides: spec.doc.slides.length, pptx: true, pdf: pdfAvailable() }
}

/** Has this tool given out a file with this hash? (spec.ts: a deck is never its own source) */
export function isOwnOutput(ctx: Pick<AppContext, 'db'>, sha256: string): boolean {
  return !!ctx.db.query('SELECT 1 FROM intro_decks WHERE pptx_sha256 = ? OR pdf_sha256 = ? LIMIT 1').get(sha256, sha256)
}

/** The document laid out again with the pictures the chat's owner can read now. `webp: false` (the PowerPoint file):
 * a WebP picture or logo is left out, so its slide takes its type-only version (Apple's renderers show a WebP inside a
 * .pptx as an empty box; the preview and the PDF keep it). */
function relayout(ctx: AppContext, r: Row, o: { webp: boolean }): { out: DeckOut; read: (src: string) => Uint8Array | null; spec: StoredDeck } {
  const spec = JSON.parse(r.spec) as StoredDeck
  const user = ctx.files.principal(r.owner_id)
  const bytes = new Map<string, Uint8Array | null>()
  const read = (src: string): Uint8Array | null => {
    if (bytes.has(src)) return bytes.get(src)!
    let b: Uint8Array | null = null
    try {
      const a = authorize(ctx.files.fx, ctx.files.rules(), user, src, 'read', { mustExist: true })
      b = new Uint8Array(readRegular(a.abs, 20 * 1024 * 1024).bytes)
    } catch { b = null }
    bytes.set(src, b)
    return b
  }
  const pics: DeckDoc['pics'] = {}
  for (const [src, info] of Object.entries(spec.doc.pics)) {
    const b = read(src)
    if (b && !o.webp && extOf(b) === 'webp') continue
    const size = b ? imageSize(b) : null
    // the picture as it is now (replaced by one of another size: the crop follows it)
    if (b && size) pics[src] = { ...info, width: size.width, height: size.height }
  }
  const doc = { ...spec.doc, pics, logo: spec.doc.logo && pics[spec.doc.logo.src] ? { ...spec.doc.logo, ...pics[spec.doc.logo.src] } : null } as DeckDoc | DeckDoc2
  return { out: layoutAny(doc), read, spec }
}

const safeName = (title: string, ext: string) => `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'deck'}.${ext}`

/** The PowerPoint file of the caller's intro deck (built once, then kept). The AI's accents go in as pictures drawn by
 * typst (render.ts); without typst they are left out (the slide keeps its drawn pattern). */
export async function introDeckPptx(ctx: AppContext, userId: string, id: string): Promise<{ abs: string; name: string }> {
  const r = ownRow(ctx, userId, id)
  const file = deckFile(ctx, id, 'pptx')
  const spec = JSON.parse(r.spec) as StoredDeck
  if (!fs.existsSync(file)) {
    const started = Date.now()
    const { out, read } = relayout(ctx, r, { webp: false })
    const accents = new Map<string, Uint8Array | null>()
    for (const sl of out.slides) for (const it of sl.items) if (it.t === 'svg' && !accents.has(it.svg)) accents.set(it.svg, await rasterizeSvg(it.svg, 1200))
    const bytes = buildPptx(out, { title: spec.title, lang: spec.doc.lang, read, fonts: pretendardDir(), created: r.created_at, svgPng: (svg) => accents.get(svg) ?? null })
    fs.mkdirSync(deckDir(ctx), { recursive: true })
    fs.writeFileSync(`${file}.part`, bytes, { mode: 0o600 })
    fs.renameSync(`${file}.part`, file)
    ctx.db.query('UPDATE intro_decks SET pptx_sha256 = ? WHERE artifact_id = ?').run(crypto.createHash('sha256').update(bytes).digest('hex'), id)
    ctx.log.info('intro deck pptx built', { artifact: id, ms: Date.now() - started, bytes: bytes.length })
  }
  return { abs: file, name: safeName(spec.title, 'pptx') }
}

/** The PDF of the caller's intro deck: typst in its isolation, the pictures copied into its work folder. */
export async function introDeckPdf(ctx: AppContext, userId: string, id: string): Promise<{ abs: string; name: string }> {
  const r = ownRow(ctx, userId, id)
  const typst = typstBin(), fonts = pretendardDir()
  if (!typst || !fonts) throw new HttpError('not_found')
  const file = deckFile(ctx, id, 'pdf')
  const spec = JSON.parse(r.spec) as StoredDeck
  if (!fs.existsSync(file)) {
    const started = Date.now()
    const { out, read } = relayout(ctx, r, { webp: true })
    const t = buildTypst(out, { title: spec.title, lang: spec.doc.lang, read })
    const work = makeWorkDir()
    try {
      for (const [name, bytes] of t.files) fs.writeFileSync(path.join(work, name), bytes, { flag: 'wx', mode: 0o600 })
      fs.writeFileSync(path.join(work, 'deck.typ'), t.source, { flag: 'wx', mode: 0o600 })
      // the bundled fonts first (Pretendard; Noto Sans CJK in a Linux bundle), threads capped on Linux
      const extra = bundledFontDir()
      const fontArgs = ['--font-path', fonts, ...(extra && extra !== fonts ? ['--font-path', extra] : [])]
      const jobs = typstJobs()
      const res = await runIsolated({ cmd: typst, args: ['compile', ...(jobs ? ['--jobs', String(jobs)] : []), ...fontArgs, '--root', work, 'deck.typ', 'out.pdf'], workDir: work, readPaths: [fonts, ...(extra && extra !== fonts ? [extra] : [])], timeoutMs: 120_000 })
      if (res.code !== 0) { ctx.log.warn('intro deck pdf failed', { artifact: id, stderr: res.stderr.toString().slice(-1500) }); throw new HttpError('internal') }
      const pdf = readOutput(work, 'out.pdf', 200 * 1024 * 1024)
      if (!pdf.ok) throw new HttpError('internal')
      fs.mkdirSync(deckDir(ctx), { recursive: true })
      fs.writeFileSync(`${file}.part`, pdf.bytes, { mode: 0o600 })
      fs.renameSync(`${file}.part`, file)
      ctx.db.query('UPDATE intro_decks SET pdf_sha256 = ? WHERE artifact_id = ?').run(crypto.createHash('sha256').update(pdf.bytes).digest('hex'), id)
      ctx.log.info('intro deck pdf built', { artifact: id, ms: Date.now() - started, bytes: pdf.bytes.length })
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }
  return { abs: file, name: safeName(spec.title, 'pdf') }
}

/** What purged chats left of their intro decks (chat/forget.ts, after their rows are gone): every file whose row is
 * not there any more. */
export function forgetIntroDecks(ctx: AppContext): void {
  // round 2: the slide pictures of builds whose row went with its chat
  const builds = path.join(deckDir(ctx), 'builds')
  try {
    const knownBuild = ctx.db.query('SELECT 1 FROM intro_deck_builds WHERE id = ?')
    for (const name of fs.readdirSync(builds)) if (!knownBuild.get(name)) fs.rmSync(path.join(builds, name), { recursive: true, force: true })
  } catch { /* none yet */ }
  const dir = deckDir(ctx)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return }
  const known = ctx.db.query('SELECT 1 FROM intro_decks WHERE artifact_id = ?')
  for (const name of names) {
    if (name === 'builds') continue
    const id = /^(.+?)\.(?:pptx|pdf)(?:\.part)?$/.exec(name)?.[1]
    if (!id || known.get(id)) continue
    try { fs.rmSync(path.join(dir, name), { force: true }) } catch (err) { ctx.log.warn('intro deck file not removed', { name, err }) }
  }
}
