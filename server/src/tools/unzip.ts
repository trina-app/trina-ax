// unzip_file (QA TC-4847, docs/decisions/20261118-unzip-file.md): the files of a .zip the person may read, saved into a
// folder they may write. Before it, the AI told a person who asked it to unzip a file they had put in a project to unzip
// it on their own computer and upload the files again.
// - What comes out and what is refused: files/unzip.ts planZip (names decoded, paths checked, junk left out, links and
//   devices skipped, the zip-guard limits). An absolute path or ".." refuses the whole zip before anything is written.
// - Where: by default a new folder next to the zip named after it (or after the one folder everything in the zip sits
//   in), " (2)" when that name is taken; `to_folder` puts the contents into another folder, keeping the zip's folders.
//   A file whose name is taken there gets " (2)": nothing is ever saved over.
// - Every file goes through make_file's save path (make-file.ts placeProduced: the person's write access checked again
//   for each file, never under skills/, a file event, the text index, the published change;
//   not counted against the turn's file count or write bytes one by one: the zip's limits are the cap, per answer too);
//   before anything is placed, the wider-audience check for the zip's bytes (confirmSources) at the target folder and
//   at every folder a file goes into (a rule or share above it may let more people read it). New folders are made under the same
//   checks as the move tools' (TeamFiles.ensureFolder) and recorded once something went in.
// - One entry at a time, in a server-wide unzip slot (files/unzip.ts unzipSlot): streamed through zlib into a work
//   file with its size counted and its CRC checked, then placed. The zip is read in the slot and let go before any card.
//   A file that fails (damaged, refused) is named in the answer with the files that were saved.
// - list_only: what is inside, nothing saved.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import type { UnzipFileInput } from '@mycel/shared'
import { fileShareUrl } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { ext } from '../files/extract'
import type { ToolCtx } from '../files/service'
import { readRegular } from '../files/store'
import { detachPlan, inflateEntryToFile, planZip, unzipSlot, UNZIP_ENTRIES_MAX, UNZIP_TOTAL_MAX, UNZIP_ZIP_MAX, UnsafeZip, type ZipPlan } from '../files/unzip'
import { isZip, ZipProblem } from '../files/zip-guard'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { inSkills } from '../skills/guard'
import { assertStorageRoomForAI } from '../system/storage'
import { componentC } from '../team-files/component'
import { readersOf } from '../rooms/ai-grants'
import { FileError } from '../team-files/errors'
import { checkRegular, freeName } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import { makeWorkDir } from './isolate'
import { confirmSources, placeProduced } from './make-file'

type UnzipIn = z.output<typeof UnzipFileInput>

export const UNZIP_FILE_DESCRIPTION = 'Unzip a .zip file in the team folder: its files and folders are saved into a folder, with their names kept ' +
  '(Korean names too, also from zips made on Windows). By default a new folder next to the zip, named after it (" (2)" is added when the name is ' +
  'taken); to_folder puts them into another folder instead (made when missing). Nothing is ever saved over an existing file: a taken name gets " (2)". ' +
  'list_only: true lists what is inside without saving anything. For a zip the user attached in a chat (their .attachments folder), give to_folder ' +
  '(where they want the files). Password-protected, damaged or very large zips, and zips with unsafe paths, are refused and nothing is saved; links ' +
  'and system junk (__MACOSX, .DS_Store) are left out. Other archive types (7z, rar, alz, egg, tar) cannot be opened here.'

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const clean = (p: string) => p.normalize('NFC').replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.').join('/')
/** files listed in the answer before "and N more" */
const LIST_MAX = 30

export interface UnzipResult {
  zip: string
  /** the folder the files went into ('' = the team root) */
  folder: string
  /** the folder was made by this call (not an existing to_folder) */
  newFolder: boolean
  saved: { path: string; size: number; renamedFrom?: string }[]
  folders: string[]
  failed: { name: string; why: string }[]
  plan: ZipPlan
  listOnly: boolean
}

/** The refusal of a zip that cannot be opened, in plain words (nothing was saved). */
function zipRefusal(e: unknown, zip: string): ToolError | null {
  if (e instanceof UnsafeZip) return new ToolError(`'${zip}' was not unzipped: it has a file whose path points outside its folder (${e.entry.slice(0, 200)}), which a normal zip never has, so nothing was saved. Tell the user the zip looks unsafe and was not opened`)
  if (!(e instanceof ZipProblem)) return null
  if (e.kind === 'busy') return new ToolError(`the server is unzipping other files right now, so '${zip}' was not unzipped and nothing was saved. Tell the user in plain words to try again in a moment`, 'busy')
  if (e.kind === 'encrypted') return new ToolError(`'${zip}' is password-protected, so it cannot be unzipped here and nothing was saved. Tell the user; they can unzip it on their computer with the password and upload the files`)
  if (e.kind === 'complex') return new ToolError(`'${zip}' is too large or too complex to unzip safely here (${e.why}; at most ${UNZIP_TOTAL_MAX / 1048576} MB unzipped and ${UNZIP_ENTRIES_MAX} entries), so nothing was saved. Tell the user in plain words`)
  return new ToolError(`'${zip}' could not be unzipped: the file is damaged (${e.why}), so nothing was saved. Tell the user; they can download it again`)
}

export async function unzipFile(ctx: AppContext, files: TeamFiles, c: ToolCtx, a: UnzipIn): Promise<UnzipResult> {
  const fx = files.fx
  const rules = files.rules()
  // the zip: read access (a file the person cannot open answers like a missing one)
  const src = authorize(fx, rules, c.user, a.path, 'read')
  if (src.st!.isDirectory()) throw new ToolError(`'${src.rel}' is a folder, not a zip file`, 'is_folder')
  const zipName = src.segs.at(-1)!
  const st = checkRegular(src.abs)
  if (st.size > UNZIP_ZIP_MAX) throw new ToolError(`'${src.rel}' is larger than ${UNZIP_ZIP_MAX / 1048576} MB, too large to unzip here; nothing was saved`)
  const toFolder = a.to_folder?.trim() ? clean(a.to_folder) : null
  // the zip is read (into memory) only inside a server-wide slot, and let go before any card: read, check, plan
  const readZip = () => {
    const bytes = readRegular(src.abs, UNZIP_ZIP_MAX, checkRegular(src.abs)).bytes
    ctx.files.quarantine.assertBytes(bytes)
    if (!isZip(bytes)) {
      const kind = ext(zipName)
      throw new ToolError(['7z', 'rar', 'alz', 'egg', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(kind)
        ? `'${src.rel}' is a .${kind} archive; only .zip files can be unzipped here. Nothing was saved. Tell the user; they can unzip it on their computer or save it as a .zip`
        : `'${src.rel}' is not a zip file, so it cannot be unzipped`)
    }
    return bytes
  }
  const slot = async () => { try { return await unzipSlot(c.signal) } catch (e) { c.signal?.throwIfAborted(); throw zipRefusal(e, src.rel) ?? e } }
  let plan: ZipPlan
  let sha: string
  {
    const release = await slot()
    try {
      const bytes = readZip()
      sha = crypto.createHash('sha256').update(bytes).digest('hex')
      try { plan = detachPlan(planZip(bytes, { unwrap: toFolder === null })) } catch (e) { throw zipRefusal(e, src.rel) ?? e }
    } finally { release() }
  }
  // its names go to the model: the zip counts as read in this chat (also when nothing is saved)
  c.files.readPaths.add(src.rel)
  const base: UnzipResult = { zip: src.rel, folder: '', newFolder: false, saved: [], folders: [], failed: [], plan, listOnly: !!a.list_only }
  if (a.list_only) return base
  if (!plan.files.length && !plan.folders.length) throw new ToolError(`'${src.rel}' has no files to unzip${plan.skipped.length ? ` (left out: ${plan.skipped.slice(0, 5).map((s) => `${s.name}: ${s.why}`).join('; ')})` : ''}; nothing was saved`)

  assertStorageRoomForAI(plan.total)
  // what one answer may unzip in all: the zip's own limits (UNZIP_TOTAL_MAX bytes, UNZIP_ENTRIES_MAX files), across its
  // unzip calls. Its files do not count against the turn's write bytes or file count one by one (a project zip of 300
  // files is normal), but unzipping again and again must not write without bound
  // (TurnFiles' plain fields: the main AI and every sub-agent view share one budget). A guest keeps the turn's normal
  // limits (maxFilesWrittenPerTurn, maxWriteBytesPerTurn), checked here up front and again for each file
  const guest = rules.isGuest(c.user)
  if (guest) {
    const room = ctx.engineConfig.maxFilesWrittenPerTurn - c.files.filesWritten.size
    if (plan.files.length > room) throw new ToolError(`'${src.rel}' has ${plan.files.length} files, more than the ${room} files that can still be saved in this answer, so nothing was saved. Tell the user in plain words`)
    if (c.files.bytesWritten + plan.total > ctx.engineConfig.maxWriteBytesPerTurn) throw new ToolError(`'${src.rel}' unzips to ${human(plan.total)}, more than can still be saved in this answer, so nothing was saved. Tell the user in plain words`)
  } else {
    if (c.files.unzippedBytes + plan.total > UNZIP_TOTAL_MAX || c.files.unzippedFiles + plan.files.length > UNZIP_ENTRIES_MAX) {
      throw new ToolError(`unzipping '${src.rel}' would save more than ${UNZIP_TOTAL_MAX / 1048576} MB or ${UNZIP_ENTRIES_MAX} unzipped files in this answer, so nothing was saved. Tell the user; they can ask again in a new message`)
    }
    c.files.unzippedBytes += plan.total
    c.files.unzippedFiles += plan.files.length
  }

  // where: a new folder next to the zip (named after it, or after the one folder everything sits in), or to_folder
  let folder: string
  let newFolder: boolean
  if (toFolder !== null) {
    folder = toFolder
    if (inSkills(folder)) throw new ToolError('files cannot be unzipped into a skills folder (skills/, a group\'s or a project\'s: skills and rules people\'s AI follows); pick another folder')
    const t = authorize(fx, rules, c.user, folder, 'write', { mustExist: false, createDirs: true })
    if (t.exists && !t.st!.isDirectory()) throw new ToolError(`'${t.rel}' is a file, not a folder`, 'not_folder')
    folder = t.rel
    newFolder = !t.exists
  } else {
    const parent = src.segs.slice(0, -1)
    let name = (plan.top ?? zipName.replace(/\.zip$/i, '')).trim().replace(/[. ]+$/, '')
    if (!name || badSegment(name)) name = 'unzipped'
    name = freeName(path.join(fx.root, ...parent), name, true)
    folder = [...parent, name].join('/')
    newFolder = true
  }
  if (inSkills(folder)) throw new ToolError('files cannot be unzipped into a skills folder; pick another folder')
  const join = (segs: string[]) => [folder, ...segs].filter(Boolean).join('/')
  // nothing of the zip lands in a skills folder (a group's or a project's "skills/" inside the target): what people's AI
  // follows changes only through write / edit on the person's card
  const skills = (segs: string[]) => inSkills(join(segs))
  for (const f of plan.files.filter((x) => skills(x.segs))) plan.skipped.push({ name: f.segs.join('/'), why: 'it would land in a skills folder, where files change only through the skill tools' })
  plan.files = plan.files.filter((x) => !skills(x.segs))
  plan.folders = plan.folders.filter((x) => !skills(x))
  if (!plan.files.length && !plan.folders.length) throw new ToolError(`nothing from '${src.rel}' can be saved there: ${plan.skipped.slice(0, 5).map((x) => `${x.name}: ${x.why}`).join('; ')}`)
  // write access at the target now (a read-only place stops the call before any work); placeProduced checks each file again
  authorize(fx, rules, c.user, join([plan.files[0]?.segs.at(-1) ?? 'x']), 'write', { mustExist: false, createDirs: true })

  // the wider-audience check for the zip's bytes: at the target and at every folder a file goes into, before anything
  // is placed so a "no" leaves nothing behind
  // Every folder a file goes into and every (empty) folder of the zip, existing or not: who may read a place follows its
  // path (a rule or a share on a folder above it), not only folders already on disk. Asked once per distinct audience
  // (the people who can read there, as the file layer resolves the path), at its shallowest folder: a zip of 12 folders
  // into one place is one card, not 13; a folder that more or other people can read is a card of its own
  const dirs = new Map<string, string[]>([['', []]])
  for (const f of plan.files) dirs.set(f.segs.slice(0, -1).join('/'), f.segs.slice(0, -1))
  for (const segs of plan.folders) dirs.set(segs.join('/'), segs)
  const byAudience = new Map<string, string>()
  for (const [k, segs] of [...dirs].sort((x, y) => x[1].length - y[1].length)) {
    let key: string
    try {
      const at = authorize(fx, rules, c.user, join([...segs, 'x']), 'write', { mustExist: false, createDirs: true }).segs.slice(0, -1)
      key = readersOf(ctx.db, rules, at).sort().join(',')
    } catch { key = `!${k}` } // refused there: checked (and refused) on its own
    if (!byAudience.has(key)) byAudience.set(key, k)
  }
  for (const k of byAudience.values()) {
    const rel = join([...(k ? k.split('/') : []), plan.files.find((f) => f.segs.slice(0, -1).join('/') === k)?.segs.at(-1) ?? 'x'])
    await confirmSources(ctx, files, c, rel, rel.split('/'), [src.rel])
  }

  const svc = componentC(ctx).files
  const made: string[] = []
  const madeKeys = new Set<string>()
  const failed: UnzipResult['failed'] = []
  const saved: UnzipResult['saved'] = []
  const why = (e: unknown) => e instanceof Denied ? `not allowed (${e.message})` : e instanceof ToolError || e instanceof FileError ? e.message : e instanceof ZipProblem ? `damaged in the zip (${e.why})` : 'internal error'
  /** a folder (and its parents) made when missing: its path, or "!" and why it cannot be (a file has that name, no access) */
  const ensure = (segs: string[]): string => {
    const rel = join(segs)
    try {
      if (inSkills(rel)) return '!it would be a skills folder'
      const r = svc.ensureFolder(c.user.id, rel)
      if (inSkills(r.path)) return '!it would be a skills folder'
      for (const m of r.created) if (!madeKeys.has(m)) { madeKeys.add(m); made.push(m) }
      return r.path
    } catch (e) { return `!${why(e)}` }
  }
  // after a card the person may no longer read the zip: asked again, as the file layer resolves it now
  const again = authorize(fx, files.rules(), ctx.files.principal(c.user.id), a.path, 'read')
  if (again.rel !== src.rel) throw new ToolError(`'${src.rel}' changed while this call waited, so nothing was saved. Unzip it again`)
  // the zip again, in a slot, for the extraction; the same bytes as planned (it may have been saved over during the card)
  const work = makeWorkDir(path.join(ctx.config.dataDir, 'work'))
  let release: (() => void) | null = null
  let bytes: Buffer | null = null
  try {
    release = await slot()
    bytes = readZip()
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) throw new ToolError(`'${src.rel}' changed while this call waited, so nothing was saved. Unzip it again`)
    const target = ensure([])
    if (target.startsWith('!')) throw new ToolError(`the folder ${folder || 'the team root'} could not be made, so nothing was saved: ${target.slice(1)}`)
    folder = target
    for (const segs of plan.folders) {
      if (c.signal?.aborted) break
      const r = ensure(segs)
      if (r.startsWith('!')) failed.push({ name: segs.join('/') + '/', why: r.slice(1) })
    }
    for (const [i, f] of plan.files.entries()) {
      if (c.signal?.aborted) { failed.push({ name: f.segs.join('/'), why: 'stopped' }); continue }
      try {
        const dir = f.segs.length > 1 ? ensure(f.segs.slice(0, -1)) : folder
        if (dir.startsWith('!')) throw new ToolError(`its folder could not be made: ${dir.slice(1)}`)
        const dirSegs = dir.split('/').filter(Boolean)
        // never over an existing file: a taken name gets " (2)"
        const want = f.segs.at(-1)!
        const name = fs.existsSync(path.join(fx.root, ...dirSegs)) ? freeName(path.join(fx.root, ...dirSegs), want) : want
        const tmp = path.join(work, String(i))
        await inflateEntryToFile(bytes, f.entry, tmp, c.signal)
        const r = await placeProduced(ctx, files, c, [...dirSegs, name], tmp, 'unzip_file', undefined, { turnBytes: guest, turnFiles: guest, detail: { from: src.rel } })
        saved.push({ path: r.path, size: r.size, ...(name !== want || r.conflictCopyOf ? { renamedFrom: [...dirSegs, want].join('/') } : {}) })
      } catch (e) {
        if (!(e instanceof Error)) throw e
        failed.push({ name: f.segs.join('/'), why: why(e) })
      }
    }
  } finally {
    bytes = null
    release?.()
    fs.rmSync(work, { recursive: true, force: true })
    // new folders: recorded when something went in (or the zip named them), else taken away again
    if (saved.length || (!plan.files.length && plan.folders.length)) svc.recordFolders(c.user.id, made, { turnId: c.turnId, tool: 'unzip_file' })
    else svc.dropFolders(made)
  }
  const result: UnzipResult = { ...base, folder, newFolder, saved, folders: made, failed }
  if (!saved.length && plan.files.length) {
    throw new ToolError(`nothing from '${src.rel}' was saved:\n${failed.slice(0, 10).map((x) => `- ${x.name}: ${x.why}`).join('\n')}${failed.length > 10 ? `\n- and ${failed.length - 10} more` : ''}`)
  }
  return result
}

/** many files: how many in each top folder (the 20 largest), not every name */
function byFolder(paths: string[]): string {
  const counts = new Map<string, number>()
  for (const p of paths) { const k = p.includes('/') ? p.split('/')[0] + '/' : ''; counts.set(k, (counts.get(k) ?? 0) + 1) }
  const rows = [...counts].sort((x, y) => y[1] - x[1])
  const shown = rows.slice(0, 20).map(([k, n]) => `- ${k || '(directly in the folder)'}: ${n} file${n === 1 ? '' : 's'}`)
  return `By folder:\n${shown.join('\n')}${rows.length > 20 ? `\n- … and ${rows.length - 20} more folders` : ''}`
}

const list = (rows: string[]) => rows.slice(0, LIST_MAX).join('\n') + (rows.length > LIST_MAX ? `\n- … and ${rows.length - LIST_MAX} more` : '')

/** The tool result for the AI: where the files went, what was saved (a short list for many), what was not and why. */
export function unzipResultText(r: UnzipResult): string {
  const rel = (p: string) => (r.folder && p.startsWith(r.folder + '/') ? p.slice(r.folder.length + 1) : p)
  const left = [
    ...r.plan.skipped.map((s) => `- ${s.name}: ${s.why}`),
  ]
  if (r.listOnly) {
    const rows = r.plan.files.map((f) => `- ${[r.plan.top, ...f.segs].filter(Boolean).join('/')} (${human(f.size)})`)
    return [
      `'${r.zip}' holds ${r.plan.files.length} file${r.plan.files.length === 1 ? '' : 's'} (${human(r.plan.total)} unzipped)${r.plan.folders.length ? ` in ${r.plan.folders.length + (r.plan.top ? 1 : 0)} folders` : r.plan.top ? ` in the folder ${r.plan.top}` : ''}. Nothing was saved (list only).`,
      list(rows),
      left.length ? `Would be left out:\n${list(left)}` : '',
      r.plan.junk ? `${r.plan.junk} system file${r.plan.junk === 1 ? '' : 's'} (like __MACOSX or .DS_Store) would be left out; no need to mention them.` : '',
      'Tell the user in plain words what is inside (a short summary when there are many files). To save the files, call unzip_file again without list_only.',
    ].filter(Boolean).join('\n')
  }
  const link = `[${r.folder.split('/').pop() || 'team folder'}](${fileShareUrl(r.folder, 'preview')})`
  const renamed = r.saved.filter((s) => s.renamedFrom)
  const failedRows = r.failed.map((f) => `- ${f.name}: ${f.why}`)
  const lines = [
    `Unzipped '${r.zip}' into ${r.newFolder ? 'the new folder' : 'the folder'} ${r.folder || 'the team root'}: ${r.saved.length} file${r.saved.length === 1 ? '' : 's'} saved (${human(r.saved.reduce((n, s) => n + s.size, 0))}). Link for the user: ${link}`,
    r.saved.length > LIST_MAX ? byFolder(r.saved.map((s) => rel(s.path))) : list(r.saved.map((s) => `- ${rel(s.path)} (${human(s.size)})`)),
    renamed.length ? `A file of the same name was already there, so ${renamed.length === 1 ? 'this was' : 'these were'} saved under a new name (the existing ${renamed.length === 1 ? 'file is' : 'files are'} unchanged):\n${list(renamed.map((s) => `- ${rel(s.renamedFrom!)} -> ${rel(s.path)}`))}` : '',
    failedRows.length ? `NOT saved (${r.failed.length}):\n${list(failedRows)}` : '',
    left.length ? `Left out of the zip:\n${list(left)}` : '',
    r.plan.junk ? `${r.plan.junk} system file${r.plan.junk === 1 ? '' : 's'} (like __MACOSX or .DS_Store) were left out; no need to mention them.` : '',
    'The zip itself is unchanged. Tell the user in plain words where the files are (link the folder by its name), how many were saved and a short list of them' +
      (r.saved.length > 10 ? ' (a summary by folder or kind, not every name)' : '') +
      (failedRows.length || left.length ? ', and plainly which were not saved and why' : '') + '.',
  ]
  return lines.filter(Boolean).join('\n')
}

export function unzipSummary(r: UnzipResult): string {
  if (r.listOnly) return `unzip_file ${r.zip} (list only: ${r.plan.files.length} files, ${r.plan.total} B)`
  return `unzip_file ${r.zip} -> ${r.folder}${r.newFolder ? ' (new folder)' : ''}: ${r.saved.length} saved, ${r.failed.length} not saved, ${r.plan.skipped.length} left out${r.saved.some((s) => s.renamedFrom) ? `, ${r.saved.filter((s) => s.renamedFrom).length} renamed` : ''}`.slice(0, 1000)
}

