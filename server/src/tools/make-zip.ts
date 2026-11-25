// make_zip (QA TC-4920, docs/decisions/20261118-make-zip-and-mail-attachments.md): files and folders the person may
// read, put into one .zip saved where they may write. Before it the AI said "I can open ZIP files, but I can't create a
// ZIP" and asked the person to download the folder and zip it on their own computer.
// - What goes in: each path the person may read (a file) or list (a folder, with every file and folder below it they
//   may read, as list and read show them: no links, no hard-linked files, nothing hidden). Inside the zip a folder keeps
//   its name and its tree; a name given twice gets " (2)". Empty folders the person may read are kept.
// - Limits: MAKE_ZIP_FILES_MAX files and MAKE_ZIP_TOTAL_MAX bytes per zip, MAKE_ZIP_ANSWER_MAX bytes per answer (zips
//   again and again must not write without bound; TurnFiles.zippedBytes, shared with sub-agents); refused up front with
//   nothing saved. A guest keeps the turn's normal write limits.
// - Written in the server-wide unzip slot (files/unzip.ts unzipSlot) into a work file one file at a time
//   (files/zip-stream.ts: deflated, or stored for already-compressed kinds), each file read through the descriptor its
//   permission check saw (store.ts readRegularPieces).
// - Saved through make_file's save path (make-file.ts placeProduced: write access again, never under skills/, a version
//   of a zip the AI read in this turn or a conflict copy, the per-turn file count, a file event, the change published),
//   after the wider-audience card for the zipped files (confirmSources with the folders they came from).
// - A .tar or .tar.gz / .tgz instead (QA TC-5057, docs/decisions/20261118-tar-archives.md): `format`, or the ending of
//   `output`; written by files/tar.ts TarStream the same way (same walk, same checks, same limits), the tool name stays.
import { authorizeOutput } from '../files/place-output'
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { MakeZipInput } from '@mycel/shared'
import { fileShareUrl } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { ext } from '../files/extract'
import type { ToolCtx } from '../files/service'
import { readRegularPieces } from '../files/store'
import { unzipSlot } from '../files/unzip'
import { ZipProblem } from '../files/zip-guard'
import { ZipStream, ZipTooLarge } from '../files/zip-stream'
import { TarChanged, TarStream } from '../files/tar'
import { atLeast } from '../policy/access'
import { authorize } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { badSegment, hiddenEntry } from '../policy/names'
import { inAnySkills } from '../skills/guard'
import { assertStorageRoomForAI } from '../system/storage'
import { freeName } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir } from './isolate'
import { confirmSources, placeProduced } from './make-file'

type MakeZipIn = z.output<typeof MakeZipInput>

/** files and folders together (a zip without zip64 holds at most 65,535 entries) */
export const MAKE_ZIP_FILES_MAX = 10_000
/** the limits in force (tests lower them) */
export const MAKE_ZIP_LIMITS = { entries: MAKE_ZIP_FILES_MAX }
export const MAKE_ZIP_TOTAL_MAX = 2 * 1024 ** 3
export const MAKE_ZIP_ANSWER_MAX = 4 * 1024 ** 3
/** files kept as they are in the zip: deflate would only cost time */
const STORED = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'hwpx', 'odt', 'ods', 'odp', 'epub'])

export const MAKE_ZIP_DESCRIPTION = 'Make a .zip of files and folders in the team folder (like `zip -r`): every file and sub-folder the user can open goes in, ' +
  'with folder names and Korean names kept. Use it for "zip this folder", "put these files in one zip", "send them as a zip". By default the zip is saved next to the first ' +
  'path, named after it; give output for another place or name. The originals are unchanged. For a whole folder give the folder, not each file. ' +
  'A .tar or .tar.gz when the user asks for one: format, or an output ending in .tar, .tar.gz or .tgz (default .zip). ' +
  `Up to ${MAKE_ZIP_FILES_MAX.toLocaleString('en')} files and folders and ${MAKE_ZIP_TOTAL_MAX / 1024 ** 3} GB per archive. No 7z, rar or passwords.`

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)
const LIST_MAX = 30

interface Item { rel: string; abs: string; st: fs.Stats; name: string }
export interface MakeZipResult {
  path: string
  size: number
  files: { inZip: string; from: string; size: number }[]
  folders: number
  /** total of the files' bytes (before compression) */
  total: number
  skipped: { path: string; why: string }[]
  renamed: { from: string; inZip: string }[]
  conflictCopyOf?: string
}

/** A name inside the zip that no earlier entry of the same folder took (letter case ignored): " (2)", " (3)" … before the extension. */
function freeInZip(taken: Set<string>, dir: string, name: string): string {
  const key = (n: string) => `${dir}/${n}`.normalize('NFC').toLowerCase()
  if (!taken.has(key(name))) { taken.add(key(name)); return name }
  const dot = name.lastIndexOf('.')
  const [stem, tail] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${tail}`
    if (!taken.has(key(n))) { taken.add(key(n)); return n }
  }
}

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'tgz'
const ENDING = /\.(tar\.gz|tgz|tar|zip)$/i
/** The format an output name asks for by its ending, or null. */
export function formatOf(name: string): ArchiveFormat | null {
  const m = ENDING.exec(name)
  return m ? (m[1]!.toLowerCase() as ArchiveFormat) : null
}
const sameFormat = (x: ArchiveFormat, y: ArchiveFormat) => (x === 'tgz' ? 'tar.gz' : x) === (y === 'tgz' ? 'tar.gz' : y)

export async function makeZip(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: MakeZipIn): Promise<MakeZipResult> {
  const fx = files.fx
  const rules = files.rules()
  // each path: a file the person may read, or a folder they may list (a file they cannot open answers like a missing one)
  const roots = a.paths.map((p) => {
    try { return authorize(fx, rules, c.user, p, 'read') } catch (e) {
      // a folder the person may list but not read as a whole (the files inside decide, one by one)
      const r = (() => { try { return authorize(fx, rules, c.user, p, 'list') } catch { throw e } })()
      if (!r.st!.isDirectory()) throw e
      return r
    }
  })
  const seen = new Set<string>()
  for (const r of roots) {
    if (!r.rel) throw new ToolError('the whole team folder cannot be zipped; name the folders to zip')
    if (seen.has(r.rel)) throw new ToolError(`'${r.rel}' is given twice`)
    seen.add(r.rel)
  }
  for (const r of roots) for (const o of roots) if (r !== o && o.rel.startsWith(r.rel + '/')) throw new ToolError(`'${o.rel}' is inside '${r.rel}', which is zipped already; give each file or folder once`)

  // where: output, or next to the first path, named after it (a free name: never a copy next to an older zip)
  let out = a.output?.trim().normalize('NFC').replace(/^\/+/, '') ?? ''
  // the format: given, or the output's ending; both given must agree
  const named = out && !out.endsWith('/') ? formatOf(out) : null
  if (a.format && named && !sameFormat(a.format, named)) throw new ToolError(`output '${out}' ends in .${named} but format is ${a.format}; give one of them, or the same in both`)
  const format: ArchiveFormat = a.format ?? named ?? 'zip'
  const dotExt = `.${format}`
  if (out.endsWith('/')) out = `${out}${roots[0]!.segs.at(-1)!.replace(/\.[^.]+$/, '') || 'files'}${dotExt}`
  if (out && !named) out += dotExt
  if (!out) {
    const first = roots[0]!
    const parent = first.segs.slice(0, -1)
    const base = roots.length === 1 ? (first.st!.isDirectory() ? first.segs.at(-1)! : first.segs.at(-1)!.replace(/\.[^.]+$/, '')) : (parent.at(-1) ?? 'files')
    const name = badSegment(`${base}${dotExt}`) ? `files${dotExt}` : `${base}${dotExt}`
    out = [...parent, fs.existsSync(path.join(fx.root, ...parent)) ? freeName(path.join(fx.root, ...parent), name) : name].join('/')
  }
  if (inAnySkills(out)) throw new ToolError('a zip cannot be saved in a skills folder (skills/, a group\'s or a project\'s: skills and rules people\'s AI follows); pick another folder')
  const target = authorizeOutput(fx, rules, c, out, { mustExist: false, createDirs: true })
  if (target.exists && target.st!.isDirectory()) throw new ToolError(`'${target.rel}' is a folder; give a file name ending in ${dotExt}`)

  // what goes in, as list and read show it to this person
  const items: Item[] = []
  const folders: { name: string; mtime: Date; rel: string }[] = []
  const skipped: MakeZipResult['skipped'] = []
  const renamed: MakeZipResult['renamed'] = []
  const taken = new Set<string>()
  let total = 0
  const over = () => items.length + folders.length > MAKE_ZIP_LIMITS.entries || total > MAKE_ZIP_TOTAL_MAX
  const walk = (segs: string[], inZip: string): void => {
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(path.join(fx.root, ...segs), { withFileTypes: true }) } catch { return }
    ents.sort((x, y) => x.name.localeCompare(y.name))
    for (const e of ents) {
      if (over()) return
      if (hiddenEntry(e.name, segs.length) || badSegment(e.name)) continue
      const childSegs = [...segs, e.name]
      const rel = childSegs.join('/')
      if (e.isSymbolicLink()) { if (atLeast(rules.access(c.user, childSegs), 'read')) skipped.push({ path: rel, why: 'a link (shortcut), not a file' }); continue }
      if (e.isDirectory()) {
        if (!rules.canList(c.user, childSegs)) continue
        const before = items.length + folders.length
        walk(childSegs, `${inZip}/${e.name}`)
        // an empty folder the person may read is kept; one they may only pass through stays out when nothing went in
        if (items.length + folders.length === before && atLeast(rules.access(c.user, childSegs), 'read')) {
          try { folders.push({ name: `${inZip}/${e.name}`, mtime: fs.lstatSync(path.join(fx.root, ...childSegs)).mtime, rel }) } catch { /* gone */ }
        }
        continue
      }
      if (!e.isFile() || !atLeast(rules.access(c.user, childSegs), 'read')) continue
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(fx.root, ...childSegs)) } catch { continue }
      if (st.nlink > 1) { skipped.push({ path: rel, why: 'a hard-linked file, which is not read' }); continue }
      items.push({ rel, abs: path.join(fx.root, ...childSegs), st, name: `${inZip}/${e.name}` })
      total += st.size
    }
  }
  for (const r of roots) {
    const leaf = r.segs.at(-1)!
    const name = freeInZip(taken, '', leaf)
    if (name !== leaf) renamed.push({ from: r.rel, inZip: name })
    if (r.st!.isDirectory()) {
      const before = items.length + folders.length
      walk(r.segs, name)
      if (items.length + folders.length === before) folders.push({ name, mtime: r.st!.mtime, rel: r.rel })
    } else {
      items.push({ rel: r.rel, abs: r.abs, st: r.st!, name })
      total += r.st!.size
    }
    if (over()) break
  }
  if (items.length + folders.length > MAKE_ZIP_LIMITS.entries || total > MAKE_ZIP_TOTAL_MAX) {
    throw new ToolError(`this would put more than ${MAKE_ZIP_LIMITS.entries.toLocaleString('en')} files and folders or ${MAKE_ZIP_TOTAL_MAX / 1024 ** 3} GB into one zip, more than make_zip makes, so nothing was saved. Tell the user in plain words; zip fewer folders at a time (several zips)`)
  }
  if (!items.length && !folders.length) throw new ToolError('there is nothing the user can open in these paths to zip; nothing was saved')
  const guest = rules.isGuest(c.user)
  // a guest keeps the turn's normal limits, checked before any work (as unzip_file does): the zip is one more file, and
  // at most its files' bytes (stored or smaller) plus its headers
  if (guest) {
    if (c.files.filesWritten.size >= ctx.engineConfig.maxFilesWrittenPerTurn) throw new ToolError(`no more files can be saved in this answer (at most ${ctx.engineConfig.maxFilesWrittenPerTurn}), so nothing was saved. Tell the user in plain words`)
    if (c.files.bytesWritten + total > ctx.engineConfig.maxWriteBytesPerTurn) throw new ToolError(`these files are ${human(total)}, more than can still be saved in this answer, so nothing was saved. Tell the user in plain words`)
  }
  if (!guest && (c.files.zippedBytes ?? 0) + total > MAKE_ZIP_ANSWER_MAX) {
    throw new ToolError(`zipping this would put more than ${MAKE_ZIP_ANSWER_MAX / 1024 ** 3} GB into zips in this answer, so nothing was saved. Tell the user; they can ask again in a new message`)
  }
  assertStorageRoomForAI(total)

  // the wider-audience card for what goes in: the folders the files came from (a rule or share on a folder decides
  // who reads its files), and each file named directly; before the work, so a "no" costs nothing
  // (empty folders too: their names go into the zip)
  const sources = [...new Set([...roots.filter((r) => !r.st!.isDirectory()).map((r) => r.rel), ...items.map((i) => i.rel.split('/').slice(0, -1).join('/')).filter(Boolean), ...folders.map((f) => f.rel)])]
  await confirmSources(ctx, files, c, target.rel, target.segs, sources)
  if (!guest) c.files.zippedBytes = (c.files.zippedBytes ?? 0) + total

  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  const tmp = path.join(work, format === 'zip' ? 'out.zip' : 'out.tar')
  let release: (() => void) | null = null
  const done: MakeZipResult['files'] = []
  try {
    try { release = await unzipSlot(c.signal) } catch (e) {
      c.signal?.throwIfAborted()
      if (e instanceof ZipProblem && e.kind === 'busy') throw new ToolError('the server is busy with other zips right now, so nothing was saved. Tell the user in plain words to try again in a moment', 'busy')
      throw e
    }
    const zip = format === 'zip' ? new ZipStream(tmp) : null
    const tar = format === 'zip' ? null : new TarStream(tmp, format !== 'tar')
    try {
      for (const f of folders) { if (zip) zip.folder(f.name, f.mtime); else await tar!.folder(f.name, f.mtime) }
      // each folder checked once per zip, as the file layer resolves it now (a walk of its path lists every folder on
      // the way: once per file made 10,000 files take 80 s); then each file by the rules as they are now, its inode
      // against the walk's, and read through the descriptor of that very file (store.ts openToRead with `seen`)
      const dirOk = new Map<string, boolean>()
      let rulesNow = files.rules()
      for (const [n, it] of items.entries()) {
        c.signal?.throwIfAborted()
        if (n % 500 === 0) rulesNow = files.rules()
        const dir = it.rel.split('/').slice(0, -1).join('/')
        if (!dirOk.has(dir)) {
          let ok = false
          try { const d = authorize(fx, rulesNow, c.user, dir, 'list'); ok = d.exists && !!d.st?.isDirectory() && d.rel === dir } catch { ok = false }
          dirOk.set(dir, ok)
        }
        let st: fs.Stats | null = null
        if (dirOk.get(dir) && atLeast(rulesNow.access(c.user, it.rel.split('/')), 'read')) { try { st = fs.lstatSync(it.abs) } catch { st = null } }
        if (!st) { skipped.push({ path: it.rel, why: 'no longer there or no longer open to the user' }); continue }
        if (!st.isFile() || st.nlink > 1 || st.ino !== it.st.ino || st.dev !== it.st.dev) { skipped.push({ path: it.rel, why: 'it changed while the zip was made' }); continue }
        const feed = (push: (piece: Buffer) => Promise<void>) => readRegularPieces(it.abs, st!, push, c.signal).then(() => undefined)
        const r = zip ? await zip.file(it.name, st.mtime, STORED.has(ext(it.name)), feed) : await tar!.file(it.name, st.mtime, st.size, feed)
        done.push({ inZip: it.name, from: it.rel, size: r.usize })
      }
      if (zip) zip.finish(); else await tar!.finish()
    } catch (e) {
      if (e instanceof ZipTooLarge) throw new ToolError(`the zip would be 4 GB or larger or hold too many entries, so nothing was saved. Tell the user; zip fewer folders at a time`)
      if (e instanceof TarChanged) throw new ToolError('a file changed while the archive was made, so nothing was saved. Try again; tell the user if it happens again')
      throw e
    } finally { zip?.close(); tar?.close() }
    if (!done.length && !folders.length) throw new ToolError('none of the files could be read for the zip, so nothing was saved')
    const made = await placeProduced(ctx, files, c, target.segs, tmp, 'make_zip', undefined, { turnBytes: guest, thisAnswerOnly: true, detail: { files: done.length } })
    return { path: made.path, size: made.size, files: done, folders: folders.length, total, skipped, renamed, ...(made.conflictCopyOf ? { conflictCopyOf: made.conflictCopyOf } : {}) }
  } finally {
    release?.()
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** The tool result for the AI: where the zip is, what went in (a short list for many), and what did not and why. */
export function makeZipResultText(r: MakeZipResult): string {
  const link = `[${r.path.split('/').pop()}](${fileShareUrl(r.path, 'download')})`
  const rows = r.files.slice(0, LIST_MAX).map((f) => `- ${f.inZip} (${human(f.size)})`)
  return [
    `Saved ${r.path}: ${r.files.length} file${r.files.length === 1 ? '' : 's'}${r.folders ? ` and ${r.folders} empty folder${r.folders === 1 ? '' : 's'}` : ''}, ${human(r.total)} zipped to ${human(r.size)}. Link for the user: ${link}`,
    rows.join('\n') + (r.files.length > LIST_MAX ? `\n- … and ${r.files.length - LIST_MAX} more` : ''),
    r.conflictCopyOf ? `${r.conflictCopyOf} already existed and was not read in this turn, so the zip was saved as a copy next to it; the existing file is unchanged.` : '',
    r.renamed.length ? `Two items had the same name, so in the zip: ${r.renamed.map((x) => `${x.from} -> ${x.inZip}`).join('; ')}.` : '',
    r.skipped.length ? `Not in the zip (${r.skipped.length}):\n${r.skipped.slice(0, LIST_MAX).map((s) => `- ${s.path}: ${s.why}`).join('\n')}` : '',
    'The originals are unchanged. Tell the user in plain words where the zip is (link it by its name) and what is in it' + (r.files.length > 10 ? ' (a summary, not every name)' : '') + (r.skipped.length ? ', and plainly what was left out and why' : '') + '.',
  ].filter(Boolean).join('\n')
}

export function makeZipSummary(r: MakeZipResult): string {
  return `make_zip -> ${r.path} (${r.files.length} files, ${r.total} B -> ${r.size} B)${r.skipped.length ? `, ${r.skipped.length} left out` : ''}${r.conflictCopyOf ? ' (conflict copy)' : ''}`.slice(0, 1000)
}

// a zip without zip64 holds at most 65,535 entries; the limit stays below it
if (MAKE_ZIP_FILES_MAX > 65_534) throw new Error('MAKE_ZIP_FILES_MAX must stay below 65,535 zip entries')
