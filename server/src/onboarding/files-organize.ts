// The setup's folder plan for 팀 파일 (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders"; contract
// shared/src/api/files-organize.ts). Once the step's upload run landed its files in shared/ (전사 공유), the page asks
// for a plan: the server reads the text of at most ORGANIZE_LIMITS.read of them as the caller (extract.ts, the text
// layer only, ORGANIZE_LIMITS.textChars each, within ORGANIZE_LIMITS.readMs), then makes ONE no-tools turn of the
// caller (file-rank.ts runFilesTurn: their AI access and budget, as the step's picks), which proposes the folders, each
// file's folder, its kind and whether it is a form, and at most one project group. Every other file, and every file when
// no AI answers, the turn fails or runs out of ORGANIZE_LIMITS.aiMs, goes by name rules (organizePlan). This reverses
// the W6 rule "no file content reaches these endpoints" for this step only: the page says so on the step.
//
// The plan is a job in memory: the start answers at once, the page polls its progress ("읽고 정리하는 중… n/N") and the
// plan; only the caller who started it reads it, and it is forgotten after JOB_MS. A plan holds only files the caller
// uploaded into shared/ lately (an 'upload' file event of theirs within UPLOAD_MS: the step's run), and applying is bound
// to that plan: only its files move, and a second apply of the same plan answers the first one's result.
//
// Applying an approved plan moves each file as the caller (the file service's move: rules, versions and events follow),
// making the folders that are missing, and sends folders the moves left empty to the trash. The team then has a record
// that a plan was applied (settings 'onboarding.filesOrganized'), which hides the admins' "팀 파일 정리하기" row
// (member-welcome.ts).
import fs from 'node:fs'
import { TEMPLATES_FOLDER } from '@mycel/shared'
import { BRAND_FOLDER, NOTES_FOLDER, ORGANIZE_LIMITS, cleanFolderName, organizePlan, type Locale, type OrganizeApplied, type OrganizePlan, type OrganizeStatus, type Role } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ChatRuntime } from '../chat/runtime'
import { newId } from '../db'
import { getSetting, setSetting, teamDefaultLocale } from '../admin/settings'
import { authorize } from '../policy/authorize'
import { extractText } from '../files/extract'
import { readRegular } from '../files/store'
import { fail } from '../http/errors'
import { componentC } from '../team-files/component'
import { companyLines, runFilesTurn, sweepFileRanks } from './file-rank'
import { parseOrganize, type OrganizeMaterial } from './files-organize-ai'

export const ORGANIZED_SETTING = 'onboarding.filesOrganized'
/** a job is forgotten this long after it started */
const JOB_MS = 60 * 60_000
/** a file the caller uploaded at most this long ago can be in a plan */
export const UPLOAD_MS = 24 * 60 * 60_000
/** a file bigger than this is not read (its name still sorts it) */
const READ_MAX_BYTES = 30 * 1024 * 1024

const TEXT = {
  title: { ko: '팀 파일 정리', en: 'Sorting team files', id: 'Merapikan file tim', ja: 'チームのファイルを整理', es: 'Ordenando archivos del equipo' },
  ask: {
    ko: '올린 파일을 전사 공유 안의 폴더로 정리해 주세요.', en: 'Sort the uploaded files into folders in the company-wide folder.',
    id: 'Rapikan file yang diunggah ke dalam folder di folder seluruh perusahaan.', ja: 'アップロードしたファイルを全社共有のフォルダーに整理してください。',
    es: 'Ordene los archivos subidos en carpetas dentro de la carpeta de toda la empresa.',
  },
} satisfies Record<string, Record<Locale, string>>

export interface OrganizeCaller { id: string; role: Role }
interface Job { id: string; userId: string; at: number; status: OrganizeStatus; applied?: OrganizeApplied }
const jobs = new Map<string, Job>()

export interface OrganizeOptions {
  /** tests: the turn's message instead of the fixed one (the fake engine follows directives in it) */
  ask?: string
  /** tests: shorter waits */
  aiMs?: number
  readMs?: number
  onAnswer?: (content: string) => void
}

const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const extOf = (n: string) => (/\.([^./]+)$/.exec(n)?.[1] ?? '').toLowerCase()
/** what the text reader can read (images and the rest go by name only) */
const READABLE = new Set(['docx', 'pptx', 'odt', 'xlsx', 'xls', 'ods', 'pdf', 'hwp', 'hwpx', 'txt', 'md', 'csv', 'rtf', 'json', 'html', 'htm'])

/** The caller's files among `paths`: in shared/, files they can read, each once, in the order given. */
function ownFiles(ctx: AppContext, userId: string, paths: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const user = ctx.files.principal(userId)
  const since = new Date(Date.now() - UPLOAD_MS).toISOString()
  const uploaded = (p: string) => !!ctx.db.query("SELECT 1 FROM file_events WHERE path = ? AND user_id = ? AND action = 'upload' AND at >= ? LIMIT 1").get(p, userId, since)
  for (const raw of paths) {
    const p = raw.normalize('NFC')
    if (!p.startsWith('shared/') || seen.has(p)) continue
    try {
      const r = authorize(ctx.files.fx, ctx.files.rules(), user, p, 'read', { mustExist: true })
      // a file of the caller's own upload (the step's run), not any file of shared/
      if (!r.st?.isFile() || !uploaded(r.rel)) continue
      seen.add(r.rel)
      out.push(r.rel)
    } catch { /* gone, or not theirs to read */ }
  }
  return out
}

/** The folders directly in shared/ the caller sees, without the ones that hold the files being sorted (the upload's own
 * folder: the plan replaces it). */
export function sharedFolders(ctx: AppContext, userId: string, holding: readonly string[] = []): string[] {
  const out: string[] = []
  const held = new Set(holding.map((p) => p.split('/')).filter((s) => s.length >= 3).map((s) => s[1]!.normalize('NFC').toLowerCase()))
  try {
    let cursor: string | undefined
    do {
      const r = componentC(ctx).files.tree(userId, 'shared', cursor, 200)
      for (const e of r.entries) if (e.type === 'folder' && !held.has(e.name.normalize('NFC').toLowerCase())) out.push(e.name)
      cursor = r.nextCursor ?? undefined
    } while (cursor && out.length < 500)
  } catch { /* no shared/ */ }
  return out
}

/** The start of a file's text for the AI ("" when it cannot be read: its name still tells something). */
async function textOf(ctx: AppContext, userId: string, p: string, signal: AbortSignal): Promise<string> {
  if (!READABLE.has(extOf(p))) return ''
  try {
    const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), p, 'read', { mustExist: true })
    if (!r.st?.isFile() || r.st.size > READ_MAX_BYTES) return ''
    const { bytes } = readRegular(r.abs, READ_MAX_BYTES)
    const c = ctx.engineConfig
    const text = await extractText(r.rel, bytes, { pandoc: c.pandoc ?? null, pdftotext: c.pdftotext ?? null, ocr: c.ocr ?? null, quarantine: ctx.files.quarantine, textLayerOnly: true }, signal)
    return text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, ORGANIZE_LIMITS.textChars)
  } catch { return '' }
}

/** Jobs older than JOB_MS are forgotten. */
function sweepJobs(now = Date.now()) { for (const [id, j] of jobs) if (now - j.at > JOB_MS) jobs.delete(id) }

/**
 * Start a plan for `paths` (the files the caller's upload run landed in shared/). Answers at once with the job's id and
 * how many files will be read; `done` settles with the plan (tests wait on it; the page polls organizeStatus).
 */
export function startOrganize(ctx: AppContext, rt: ChatRuntime, who: OrganizeCaller, paths: readonly string[], locale: Locale, o: OrganizeOptions = {}): { id: string; total: number; done: Promise<OrganizePlan> } {
  sweepJobs()
  const files = ownFiles(ctx, who.id, paths).slice(0, ORGANIZE_LIMITS.files)
  const reading = files.slice(0, ORGANIZE_LIMITS.read)
  const job: Job = { id: newId(), userId: who.id, at: Date.now(), status: { state: 'reading', read: 0, total: reading.length, plan: null } }
  jobs.set(job.id, job)
  const done = (async (): Promise<OrganizePlan> => {
    const teamLocale = teamDefaultLocale(ctx.db)
    // every folder there counts as existing (the upload's own folder too: never "new"); the AI is not offered the
    // upload's own folder as a place
    const existing = sharedFolders(ctx, who.id)
    const offered = sharedFolders(ctx, who.id, files)
    const finish = (ai: OrganizePlan['ai'], parsed: Parameters<typeof organizePlan>[0]['ai']): OrganizePlan => {
      const plan: OrganizePlan = { ai, existing, ...organizePlan({ paths: files, existing, locale: teamLocale, ai: parsed }) }
      job.status = { state: 'done', read: job.status.read, total: job.status.total, plan }
      return plan
    }
    try {
      if (!files.length) return finish('done', null)
      // the text, within the reading time (what is not read by then goes with its name only)
      const stop = new AbortController()
      const timer = setTimeout(() => stop.abort(), Math.min(o.readMs ?? ORGANIZE_LIMITS.readMs, ORGANIZE_LIMITS.readMs))
      const material: OrganizeMaterial = { kind: 'organize', locale: teamLocale, company: companyLines(ctx, who.id), existing: offered, files: [] }
      const idToPath = new Map<string, string>()
      try {
        for (const [i, p] of reading.entries()) {
          const text = stop.signal.aborted ? '' : await textOf(ctx, who.id, p, stop.signal)
          const segs = p.split('/')
          material.files.push({ id: `f${i}`, folder: segs.slice(1, -1).join('/'), name: baseOf(p), type: extOf(p), text })
          idToPath.set(`f${i}`, p)
          job.status = { ...job.status, read: i + 1 }
        }
      } finally { clearTimeout(timer) }
      job.status = { ...job.status, state: 'thinking' }
      sweepFileRanks(ctx, rt)
      const r = await runFilesTurn(ctx, rt, who, material, locale, { ask: o.ask ?? TEXT.ask[rt.userLocale(who.id)], title: TEXT.title[rt.userLocale(who.id)], limitMs: Math.min(o.aiMs ?? ORGANIZE_LIMITS.aiMs, ORGANIZE_LIMITS.aiMs), ...(o.onAnswer ? { onAnswer: o.onAnswer } : {}) })
      if (r.ai !== 'done') return finish(r.ai, null)
      const parsed = parseOrganize(r.content, idToPath)
      return parsed ? finish('done', parsed) : finish('failed', null)
    } catch (e) {
      ctx.log.warn('team file plan failed', { err: e instanceof Error ? e.message : String(e) })
      return finish('failed', null)
    }
  })()
  return { id: job.id, total: job.status.total, done }
}

/** A plan's progress, for the caller who started it (anyone else: not found). */
export function organizeStatus(userId: string, id: string): OrganizeStatus {
  sweepJobs()
  const j = jobs.get(id)
  if (!j || j.userId !== userId) fail('not_found')
  return j!.status
}

/** Has an owner or admin applied a plan in this team? */
export function filesOrganized(ctx: Pick<AppContext, 'db'>): boolean {
  try { return !!getSetting<{ at: string }>(ctx.db, ORGANIZED_SETTING)?.at } catch { return false }
}

/**
 * Apply an approved plan as the caller: each file into shared/<folder>/ (a missing folder made first; a taken name gets
 * " (2)"; an existing folder is used whatever its letter case). At most ORGANIZE_LIMITS.folders folders. A move that
 * fails leaves its file where it was. Folders under shared/ the moves left empty go to the trash (never shared/ itself,
 * nor a plan's folder). Records that a plan was applied when anything moved.
 */
export function applyOrganize(ctx: AppContext, who: OrganizeCaller, id: string, moves: readonly { from: string; folder: string }[]): OrganizeApplied {
  sweepJobs()
  const job = jobs.get(id)
  if (!job || job.userId !== who.id || !job.status.plan) fail('not_found')
  // the same plan applied again (a second tab, a retry after a lost answer): the first result
  if (job!.applied) return job!.applied
  const inPlan = new Set(job!.status.plan!.rows.map((r) => r.path))
  const r = applyMoves(ctx, who, moves.filter((m) => inPlan.has(m.from.normalize('NFC'))))
  const outside = moves.filter((m) => !inPlan.has(m.from.normalize('NFC'))).map((m) => m.from)
  job!.applied = { moved: r.moved, failed: [...r.failed, ...outside] }
  return job!.applied
}

/** Folders a new team has in shared/ (any language): never sent to the trash by a plan, even when emptied. */
const DEFAULT_FOLDERS = new Set([...Object.values(TEMPLATES_FOLDER), ...Object.values(NOTES_FOLDER), ...Object.values(BRAND_FOLDER)].map((n) => String(n).normalize('NFC').toLowerCase()))

function applyMoves(ctx: AppContext, who: OrganizeCaller, moves: readonly { from: string; folder: string }[]): OrganizeApplied {
  const svc = componentC(ctx).files
  const existing = new Map(sharedFolders(ctx, who.id).map((n) => [n.normalize('NFC').toLowerCase(), n]))
  const folderOf = (f: string) => { const c = cleanFolderName(f)!; return existing.get(c.toLowerCase()) ?? c }
  const folders = [...new Set(moves.map((m) => folderOf(m.folder)))]
  if (folders.length > ORGANIZE_LIMITS.folders) fail('validation', undefined, { fields: { 'body.moves': `at most ${ORGANIZE_LIMITS.folders} folders` } })
  const made = new Set<string>()
  const moved: OrganizeApplied['moved'] = []
  const failed: string[] = []
  const left = new Set<string>()
  for (const m of moves) {
    const folder = folderOf(m.folder)
    const from = m.from.normalize('NFC')
    if (!from.startsWith('shared/')) { failed.push(m.from); continue }
    try {
      const dir = `shared/${folder}`
      if (!existing.has(folder.toLowerCase()) && !made.has(folder.toLowerCase())) {
        try { svc.mkdir(who.id, dir) } catch (e) { if ((e as { code?: string })?.code !== 'conflict' && !/exist/i.test(String((e as Error)?.message))) throw e }
        made.add(folder.toLowerCase())
      }
      const r = svc.move(who.id, from, `${dir}/${baseOf(from)}`, 'rename', { tool: 'onboarding-organize' })
      moved.push({ from, to: r.entry.path })
      const segs = from.split('/')
      for (let i = segs.length - 1; i >= 2; i--) left.add(segs.slice(0, i).join('/'))
    } catch (e) {
      ctx.log.warn('team file not moved', { err: e instanceof Error ? e.message : String(e) })
      failed.push(m.from)
    }
  }
  // the folders the moves emptied (the upload's own folder), deepest first
  const keep = new Set(folders.map((f) => `shared/${f}`.toLowerCase()))
  for (const dir of [...left].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (keep.has(dir.toLowerCase()) || (dir.split('/').length === 2 && DEFAULT_FOLDERS.has(dir.split('/')[1]!.normalize('NFC').toLowerCase()))) continue
    // truly empty on disk (no hidden or temporary entry either), then to the trash
    try {
      const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(who.id), dir, 'write', { mustExist: true })
      if (r.st?.isDirectory() && fs.readdirSync(r.abs).length === 0) svc.remove(who.id, dir)
    } catch { /* gone, or not theirs */ }
  }
  if (moved.length) setSetting(ctx.db, ORGANIZED_SETTING, { at: new Date().toISOString(), by: who.id })
  return { moved, failed }
}
