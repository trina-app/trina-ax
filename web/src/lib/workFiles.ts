// "Find work files on this computer" in the page (docs/DECISIONS.md "Find work files on this computer"). The desktop app
// looks through Documents, Desktop and Downloads after its own dialog and hands the page a list with an id per file
// (shared/src/desktop-bridge.ts workFiles); here that list becomes the step's documents (lib/teamFiles.ts LocalDoc), whose
// content is read only when the person adds them (`open` → workFiles.read). Also: which entry the page offers, the
// list's "Select all" (never a personal-looking file, at most 100) and Undo, which takes back only what the run made.
// No API calls here: the screens give them, so the tests need no server.
import { TEAM_FILES_LIMITS } from '@mycel/shared/api'
import { FROM_COMPUTER_DIR, WORK_FILES_BRIDGE_VERSION, WORK_FILES_WIDE_VERSION, type DesktopBridge, type WorkFileMeta, type WorkFileRead, type WorkFolderId, type WorkRootResult } from '@mycel/shared'
import { WORK_FILES_LIMITS } from '@mycel/shared/file-scan'
import { hasPhrase, latinWords, personalPath, type LocalDoc } from './teamFiles'
import { joinPath } from './paths'

export type WorkFilesBridge = NonNullable<DesktopBridge['workFiles']>

/** the Mac guide (docs/site/use/find-work-files.md): Full Disk Access first, the app's question, macOS's question per
 * folder after "Not now", turning access on */
export const FIND_WORK_FILES_GUIDE = 'https://ax.trina.app/docs/use/find-work-files/'

/** The desktop app's workFiles, when it offers this page's version (an older app, the Mac App Store build, a browser and
 * a phone: null, so no entry is shown). */
export function workFilesBridge(bridge: DesktopBridge | null): WorkFilesBridge | null {
  const w = bridge?.workFiles
  if (!w || typeof w.scan !== 'function' || typeof w.read !== 'function') return null
  // version 2 asks the person again in the app before any read (add); version 1 (an older app) has no such step
  if (w.version === WORK_FILES_BRIDGE_VERSION) return typeof w.add === 'function' ? w : null
  return w.version === 1 ? w : null
}

/** The ticked files named to the desktop app (version 2) as the person presses Add, before any is read: the app takes
 * them only right after the person's own press (with VoiceOver or Voice Control on, after its own window) and reads
 * nothing else. 'refused' (the list is over an hour old, the
 * press did not reach it in time) asks for Add again or a new look. An app of version 1 has no such step ('added'). */
export async function confirmAdd(bridge: WorkFilesBridge, docs: readonly LocalDoc[]): Promise<'added' | 'refused' | 'cancelled'> {
  if (typeof bridge.add !== 'function') return 'added'
  const ids = docs.map((d) => d.workId)
  if (!ids.length || ids.some((id) => !id)) return 'refused'
  const r = (await bridge.add(ids as string[]).catch(() => ({ state: 'refused' as const }))).state
  // 'cancelled': VoiceOver or Voice Control on, the app asked in its own window and the person said no (nothing to say)
  return r === 'added' || r === 'cancelled' ? r : 'refused'
}

/** "Not now" on the Full Disk Access screen is kept this long for this team (this page's storage) and person: the next
 * looks go straight to the three folders, with a quiet "Look in more places" in the list's header. */
export const FULL_DISK_LATER_MS = 30 * 24 * 60 * 60 * 1000
const fullDiskLaterKey = (userId: string) => `mycel.findWork.fullDiskLater:${userId}`
type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const keyStore = (): KeyStore | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
/** "Not now" was said within 30 days (a time in the future, or anything else stored, counts as not said). */
export function fullDiskLater(userId: string, now = Date.now(), s: KeyStore | null = keyStore()): boolean {
  try {
    const at = Number(s?.getItem(fullDiskLaterKey(userId)) ?? NaN)
    return Number.isFinite(at) && at <= now && now - at < FULL_DISK_LATER_MS
  } catch {
    return false
  }
}
export function setFullDiskLater(userId: string, on: boolean, now = Date.now(), s: KeyStore | null = keyStore()) {
  try {
    if (on) s?.setItem(fullDiskLaterKey(userId), String(now))
    else s?.removeItem(fullDiskLaterKey(userId))
  } catch {
    /* a private window: the screen comes again next time */
  }
}

/** The folder in My files the files go to (shared/src/folder-labels.ts: its name on disk, said in the person's words). */
export const FROM_COMPUTER = FROM_COMPUTER_DIR
/** The root folders' names on disk under it, as the computer names them. */
export const ROOT_FOLDER: Record<WorkFolderId, string> = { documents: 'Documents', desktop: 'Desktop', downloads: 'Downloads' }
/** The home folder's recent files (part 5) land in this folder under From this computer. */
export const HOME_FOLDER = 'Home'

const isFolderId = (id: string): id is WorkFolderId => id === 'documents' || id === 'desktop' || id === 'downloads'

/** Part 5: the app offers the wide look (the places beyond the three folders) and, on a Mac, Full Disk Access. */
export const offersWide = (b: WorkFilesBridge) => b.wide === WORK_FILES_WIDE_VERSION && typeof b.scan === 'function'

/** A place's folder name under From this computer: its label without what a file name cannot hold ("D:" → "D"). */
export function placeFolder(f: Pick<WorkFileMeta, 'root' | 'place'>): string {
  if (isFolderId(f.root)) return ROOT_FOLDER[f.root]
  const n = (f.place ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  // no name of dots only, none that ends in a dot or a space (Windows drops them)
  const clean = n.replace(/^[.\s]+|[.\s]+$/g, '')
  return clean ? clean : HOME_FOLDER
}

/** Why a read gave nothing, as an Error the upload counts as "could not be read" (the file is not tried again). */
export class WorkFileReadError extends Error {
  constructor(readonly reason: Extract<WorkFileRead, { ok: false }>['reason']) {
    super(`work file not read: ${reason}`)
  }
}

/** The look's files as the step's documents: `pick` the root's folder name, `rel` the path inside it. Nothing is read:
 * `open` asks the app for the bytes, by id, when the file goes up. */
export function docsFromScan(files: readonly WorkFileMeta[], read: (id: string) => Promise<WorkFileRead>): LocalDoc[] {
  return files.map((f) => {
    const pick = placeFolder(f)
    const folder = f.folder.normalize('NFC')
    const name = f.name.normalize('NFC')
    const rel = joinPath(folder, name)
    return {
      key: `${pick}/${rel}`,
      workId: f.id,
      pick,
      rel,
      name,
      folder,
      ext: f.ext,
      size: f.size,
      modified: f.modified,
      personal: personalPath(joinPath(pick, rel)),
      ...(!isFolderId(f.root) ? { place: { kind: f.root, label: (f.place ?? '').normalize('NFC') } } : {}),
      ...(f.cloud ? { cloud: true } : {}),
      ...(f.used || f.useCount || f.origins?.length || f.authors?.length || f.org
        ? { hints: { ...(f.used ? { used: f.used } : {}), ...(f.useCount ? { useCount: f.useCount } : {}), ...(f.origins?.length ? { origins: f.origins } : {}), ...(f.authors?.length ? { authors: f.authors } : {}), ...(f.org ? { org: f.org } : {}) } }
        : {}),
      open: async () => {
        const r = await read(f.id)
        if (!r.ok) throw new WorkFileReadError(r.reason)
        return new File([r.bytes as BlobPart], name, { lastModified: f.modified })
      },
    }
  })
}

/** What the list says about the folders: macOS kept the app out (blocked), a folder cut (big), files over 50 MB, folders
 * left out (the home folder, a network path), none looked at at all. */
export function rootNotes(roots: readonly WorkRootResult[]) {
  const looked = roots.filter((r) => r.state === 'ok')
  return {
    blocked: roots.filter((r) => r.state === 'blocked'),
    cut: roots.filter((r) => r.cut),
    left: roots.filter((r) => r.state === 'home'),
    tooBig: roots.reduce((n, r) => n + r.tooBig, 0),
    none: looked.length === 0,
  }
}

/** "Select all": the ticks plus the shown work files in their order, never a personal-looking one, up to `max` (the cap
 * line says when it stopped there). */
export function selectAll(ticks: ReadonlySet<string>, docs: readonly LocalDoc[], max: number = TEAM_FILES_LIMITS.perUpload): { ticks: Set<string>; capped: boolean } {
  const next = new Set(ticks)
  let capped = false
  for (const d of docs) {
    if (d.personal || next.has(d.key)) continue
    if (next.size >= max) { capped = true; break }
    next.add(d.key)
  }
  return { ticks: next, capped }
}

/** The ticked files' bytes over the one-add limit (the app reads at most 1 GB of one look). */
export const overBytes = (docs: readonly LocalDoc[], ticks: ReadonlySet<string>, max: number = WORK_FILES_LIMITS.readBytes) =>
  docs.reduce((n, d) => (ticks.has(d.key) ? n + d.size : n), 0) > max

// ---------------------------------------------------------------- Undo

/** What a run made: the files that landed (their path now: a renamed "(1)" copy is the run's own), and the folders it
 * made (never one that was there). */
export interface RunMade {
  files: string[]
  folders: string[]
}

export interface UndoCalls {
  /** to the trash; its answer says until when the trash keeps it */
  remove(path: string): Promise<{ purgeAt: string }>
  /** the folder holds nothing (null: it cannot be read; left as it is) */
  isEmpty(path: string): Promise<boolean | null>
}

/**
 * Undo: only what this run made goes to the trash. Its files (never a file that was there before: the run never replaces
 * one, a same-named file got a new name), then its folders that hold nothing now, deepest first (a folder something
 * else was put in since stays). The computer's files are never touched. `purgeAt`: the latest trash end of what went,
 * for the team's trash period in words.
 */
export async function undoRun(made: RunMade, calls: UndoCalls): Promise<{ removed: string[]; failed: string[]; purgeAt: string | null }> {
  const removed: string[] = []
  const failed: string[] = []
  let purgeAt: string | null = null
  const note = (at: string) => { if (!purgeAt || at > purgeAt) purgeAt = at }
  for (const path of [...new Set(made.files)]) {
    try {
      note((await calls.remove(path)).purgeAt)
      removed.push(path)
    } catch {
      failed.push(path)
    }
  }
  const folders = [...new Set(made.folders)].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))
  for (const path of folders) {
    if ((await calls.isEmpty(path).catch(() => null)) !== true) continue
    try {
      note((await calls.remove(path)).purgeAt)
    } catch {
      // a folder that stays: nothing of the run's files is in it any more
    }
  }
  return { removed, failed, purgeAt }
}

/** The folder a run's files land in: My files › From this computer. */
export const runFolder = (base: string) => joinPath(base, FROM_COMPUTER)

// ---------------------------------------------------------------- part 4: recent, the company's, best first

/** Recent: last opened or changed within this many days (owner, 2026-11-15: "only files used recently"). */
export const RECENT_DAYS = 180
/** "Looks like work" shows at most this many, best first; the rest are found by name. */
export const WORK_SHOWN = 50
/** The AI sees at most this many names (the best by the rules, never a personal-looking one): one turn of the smallest
 * model over 80 names answered in about 6 s here (2026-11-15), its start-up about 4.7 s of it. */
export const TO_AI = 80

/** The company's words (GET /api/onboarding/files/company). */
export interface CompanyWordsLike { names: readonly string[]; domains: readonly string[]; people: readonly string[] }

/** Why a file is the company's: its name or folder says the company's name, it came from the company's address or a work
 * app, or one of the team wrote it. */
export type CompanyMatch = { kind: 'name'; word: string } | { kind: 'from'; host: string } | { kind: 'by'; who: string }

/** Hosts where work files come from whatever the company (its own address is matched by its domain). */
const WORK_HOSTS = /(^|\.)(slack\.com|slack-files\.com|sharepoint\.com|drive\.google\.com|docs\.google\.com|dropbox\.com|box\.com|notion\.so|teams\.microsoft\.com|onedrive\.live\.com)$/i

/** A word as names are compared: lower case, accents out. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase()
const cjk = (s: string) => /[\u3040-\u9fff\uac00-\ud7a3]/.test(s)
/** `text` holds `word`: Latin words as whole words (a name of several words as consecutive words), Korean, Japanese and
 * Chinese inside the text. */
function holds(text: string, word: string): boolean {
  const w = fold(word).trim()
  if (!w) return false
  if (cjk(w)) return fold(text).includes(w)
  const ws = latinWords(w)
  return ws.length > 0 && hasPhrase(latinWords(text), ws)
}

/** Second-level parts of a country's domain ("co" in acme.co.kr) and labels that are no company's name (app.acme.io). */
const SECOND_LEVEL = new Set(['co', 'com', 'or', 'ne', 'ac', 'go', 'net', 'org', 'gov', 'edu', 'mil', 'ltd', 'plc', 'biz', 'web', 'id', 'sch', 'my'])
const NOT_A_NAME = new Set(['www', 'app', 'apps', 'mail', 'corp', 'my', 'en', 'shop', 'portal', 'student', 'students', 'staff', 'web', 'home', 'login', 'm', 'mobile', 'intranet', 'office'])
/** The company's name in its domain, as people write it in file names: the label before the public suffix
 * ("www.app.acme.co.kr" → "acme", "acme.io" → "acme"); '' when too short or a common subdomain word. */
export function domainStem(d: string): string {
  const labels = d.toLowerCase().split('.').filter(Boolean)
  if (labels.length < 2) return ''
  let i = labels.length - 2
  if (labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!)) i = labels.length - 3
  const s = labels[i] ?? ''
  return s.length >= 3 && !NOT_A_NAME.has(s) ? s : ''
}

/** Why this file is the company's, or null. Names and folders, download hosts, authors and organisation only: no file
 * is read. */
export function companyMatch(d: Pick<LocalDoc, 'pick' | 'folder' | 'name' | 'hints' | 'place'>, w: CompanyWordsLike): CompanyMatch | null {
  // a place's name counts as a folder ("OneDrive – Acme", "Google Drive – acme.com", a work folder "Acme")
  const text = [d.place?.label ?? '', d.folder, d.name.replace(/\.[a-z0-9]+$/i, '')].join(' ').replace(/[/_]/g, ' ')
  for (const name of w.names) if (holds(text, name)) return { kind: 'name', word: name }
  for (const dom of w.domains) { const stem = domainStem(dom); if (stem && holds(text, stem)) return { kind: 'name', word: stem } }
  for (const host of d.hints?.origins ?? []) {
    const h = host.toLowerCase()
    if (w.domains.some((dom) => h === dom || h.endsWith(`.${dom}`) || (domainStem(dom) && h.split('.').some((label) => label === domainStem(dom) || label === `${domainStem(dom)}-my`)))) return { kind: 'from', host: h }
  }
  for (const host of d.hints?.origins ?? []) if (WORK_HOSTS.test(host)) return { kind: 'from', host: host.toLowerCase() }
  const who = [...(d.hints?.authors ?? []), ...(d.hints?.org ? [d.hints.org] : [])]
  for (const a of who) {
    const p = w.people.find((x) => fold(x) === fold(a.trim()))
    if (p) return { kind: 'by', who: p }
    const n = w.names.find((x) => holds(a, x))
    if (n) return { kind: 'by', who: n }
  }
  return null
}

/** When the file was last touched, and how: opened (the index knows it) or changed. */
export const touched = (d: Pick<LocalDoc, 'modified' | 'hints'>): { at: number; opened: boolean } =>
  d.hints?.used && d.hints.used >= d.modified ? { at: d.hints.used, opened: true } : { at: d.modified, opened: false }

export const isRecentDoc = (d: Pick<LocalDoc, 'modified' | 'hints'>, now = Date.now()) => now - touched(d).at <= RECENT_DAYS * 86_400_000

const TYPE_WEIGHT: Record<string, number> = { pdf: 1, doc: 1, docx: 1, hwp: 1, hwpx: 1, xls: 1, xlsx: 1, csv: 0.6, ppt: 1, pptx: 1, key: 1, pages: 1, numbers: 1, txt: 0.6, md: 0.6, rtf: 0.6, png: 0.2, jpg: 0.2, jpeg: 0.2 }
const FOLDER_HINT: Record<string, number> = { Downloads: 0.7, Desktop: 1, Documents: 1.2 }
/** Part 5: a place's weight (a work folder and the company's cloud drive above Documents; a messenger's downloads as
 * Downloads; the home folder's and other drives' recent files as Desktop). */
const PLACE_HINT: Record<NonNullable<LocalDoc['place']>['kind'], number> = { folder: 1.3, cloud: 1.2, messenger: 0.8, home: 1, drive: 1 }

/** The fixed score (docs/DECISIONS.md part 4): recency (half-life 21 days) × use × type × the company × the folder. */
export function workScore(d: LocalDoc, m: CompanyMatch | null, now = Date.now()): number {
  const age = Math.max(0, now - touched(d).at) / 86_400_000
  const recency = Math.pow(0.5, age / 21)
  const use = 1 + Math.log(1 + (d.hints?.useCount ?? 0))
  const company = !m ? 1 : m.kind === 'from' ? 3 : m.kind === 'by' ? 2 : 1.5
  const where = d.place ? PLACE_HINT[d.place.kind] ?? 1 : (FOLDER_HINT[d.pick] ?? 1)
  return recency * use * (TYPE_WEIGHT[d.ext] ?? 0.4) * company * where
}

/** The AI's look: the best TO_AI recent files that look like no one's personal file, by the score. */
export function forAiRecent(docs: readonly LocalDoc[], w: CompanyWordsLike, now = Date.now()): LocalDoc[] {
  return docs.filter((d) => !d.personal && isRecentDoc(d, now))
    .map((d) => ({ d, s: workScore(d, companyMatch(d, w), now) }))
    .sort((a, b) => b.s - a.s).slice(0, TO_AI).map((x) => x.d)
}

/** "Looks like work": recent, not personal-looking, and the company's or picked by the AI; best first, at most
 * WORK_SHOWN. `more`: how many more would qualify (found by name). */
export function workList(docs: readonly LocalDoc[], w: CompanyWordsLike, picks: ReadonlyMap<string, unknown> | null, now = Date.now(), ticked: ReadonlySet<string> = new Set()): { shown: LocalDoc[]; more: number } {
  const all = docs.filter((d) => !d.personal && isRecentDoc(d, now)).flatMap((d) => {
    const m = companyMatch(d, w)
    const picked = !!picks?.has(d.key)
    return m || picked ? [{ d, s: workScore(d, m, now) * (picked ? 1.5 : 1) }] : []
  }).sort((a, b) => b.s - a.s)
  // a ticked file stays in view (the AI's picks coming late never push it out of sight while it is ticked)
  const top = all.slice(0, WORK_SHOWN)
  const kept = all.slice(WORK_SHOWN).filter((x) => ticked.has(x.d.key))
  return { shown: [...top, ...kept].map((x) => x.d), more: Math.max(0, all.length - WORK_SHOWN - kept.length) }
}

/** Part 5: the company's words as the app's look takes them (the names, and the name in each domain): they name the home
 * folder's work folders. At most 20. */
export function lookWords(w: CompanyWordsLike): string[] {
  const out: string[] = []
  for (const n of [...w.names, ...w.domains.map(domainStem)]) {
    const x = n.trim()
    if (x.length >= 2 && x.length <= 60 && !out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x)
  }
  return out.slice(0, 20)
}
