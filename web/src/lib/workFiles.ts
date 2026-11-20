// "Find work files on this computer" in the page (docs/DECISIONS.md "Find work files on this computer"). The desktop app
// looks through Documents, Desktop and Downloads after its own dialog and hands the page a list with an id per file
// (shared/src/desktop-bridge.ts workFiles); here that list becomes the step's documents (lib/teamFiles.ts LocalDoc), whose
// content is read only when the person adds them (`open` → workFiles.read). Also: which entry the page offers, the
// list's "Select all" (never a personal-looking file, at most 100) and Undo, which takes back only what the run made.
// No API calls here: the screens give them, so the tests need no server.
import { TEAM_FILES_LIMITS } from '@mycel/shared/api'
import { FROM_COMPUTER_DIR, WORK_FILES_BRIDGE_VERSION, WORK_FILES_WIDE_VERSION, type DesktopBridge, type WorkCloudProvider, type WorkFileMeta, type WorkFileRead, type WorkFolderId, type WorkRootResult } from '@mycel/shared'
import { autoNamed, considered, copyOf, neverListed, tooSmall, WORK_FILES_LIMITS } from '@mycel/shared/file-scan'
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
  constructor(
    readonly reason: Extract<WorkFileRead, { ok: false }>['reason'],
    /** cloudTimeout: the cloud it did not come from in time */
    readonly cloud?: WorkCloudProvider,
  ) {
    super(`work file not read: ${reason}`)
  }
}

/** Why a file of a run did not go, in words, when the desktop app said why (null: not the app's read). An app before
 * 'missing' says 'unreadable' for a deleted file: "Look again to add this file". */
export function workReadReason(e: unknown, t: (key: 'files.findWork.why.changed' | 'files.findWork.why.missing' | 'files.findWork.why.limit' | 'files.findWork.why.cloudTimeout' | 'files.findWork.why.lookAgain' | 'files.findWork.cloudGeneric', params?: Record<string, string | number>) => string): string | null {
  if (!(e instanceof WorkFileReadError)) return null
  if (e.reason === 'changed') return t('files.findWork.why.changed')
  if (e.reason === 'missing') return t('files.findWork.why.missing')
  if (e.reason === 'limit') return t('files.findWork.why.limit')
  if (e.reason === 'cloudTimeout') return t('files.findWork.why.cloudTimeout', { provider: cloudName(e.cloud ?? 'cloud', t) })
  return t('files.findWork.why.lookAgain')
}

/** A new look would help this file (changed, gone, the look too old or replaced): not a limit or a slow cloud. */
export const lookAgainHelps = (e: unknown) => e instanceof WorkFileReadError && e.reason !== 'limit' && e.reason !== 'cloudTimeout'

/** A list this old looks again before Add (TC-219): the app reads a look's files for an hour after it (sessionMs), and
 * the reads take a while too. */
export const STALE_MS = WORK_FILES_LIMITS.sessionMs - 10 * 60_000
export const isStale = (lookedAt: number, now = Date.now()) => lookedAt > 0 && now - lookedAt >= STALE_MS

/** Files the person ticked, carried into a new look ("Look again", or Add on a list over an hour old). `missing`: the
 * app said it is no longer on this computer (a read answered 'missing'); `chosen`: the folder the person chose for it
 * ("Choose a folder…", "Choose it yourself"), which a new look does not list by itself. */
export interface CarriedFile { key: string; name: string; size: number; modified: number; missing?: true; chosen?: string }
export const carried = (docs: readonly Pick<LocalDoc, 'key' | 'name' | 'size' | 'modified'>[], o: { missing?: ReadonlySet<string>; chosen?: ReadonlyMap<string, string> } = {}): CarriedFile[] =>
  docs.map((d) => ({ key: d.key, name: d.name, size: d.size, modified: d.modified, ...(o.missing?.has(d.key) ? { missing: true as const } : {}), ...(o.chosen?.has(d.key) ? { chosen: o.chosen.get(d.key)! } : {}) }))

/** The carried files in the new look (`found`: what it offers; `all`: what it listed, the files the target has by now
 * too). Still there: ticked again (`changed`: another size or date now, the new version is what goes), up to `max`
 * (`capped`: how many were left unticked by it). Not listed: `missing` (by name) only when the app said so; every other
 * one is `notListed` (a folder the person chose, a file now too big or too old for the look): said, never dropped
 * silently, and ticked once a pick lists it (pickUp). One the target has by now (`all` but not `found`) is neither. */
export function carryOver(carry: readonly CarriedFile[], all: readonly LocalDoc[], found: readonly LocalDoc[], max: number = TEAM_FILES_LIMITS.perUpload): { ticks: Set<string>; changed: Set<string>; missing: string[]; notListed: CarriedFile[]; capped: number } {
  const seen = new Set(all.map((d) => d.key))
  const r = pickUp(carry.filter((c) => !c.missing || seen.has(c.key)), found, new Set(), max)
  const missing = carry.filter((c) => c.missing && !seen.has(c.key)).map((c) => c.name)
  return { ticks: r.ticks, changed: r.changed, missing, notListed: r.left.filter((c) => !seen.has(c.key)), capped: r.capped }
}

/** Carried files that `docs` list now (a new look, or a folder the person picked after it): ticked with `ticks`, up to
 * `max`. `left`: the carried ones `docs` do not list. */
export function pickUp(carry: readonly CarriedFile[], docs: readonly LocalDoc[], ticks: ReadonlySet<string>, max: number = TEAM_FILES_LIMITS.perUpload): { ticks: Set<string>; changed: Set<string>; left: CarriedFile[]; capped: number } {
  const now = new Map(docs.map((d) => [d.key, d]))
  const next = new Set(ticks)
  const changed = new Set<string>()
  const left: CarriedFile[] = []
  let capped = 0
  for (const c of carry) {
    const d = now.get(c.key)
    if (!d) { left.push(c); continue }
    if (next.has(d.key)) continue
    if (next.size >= max) { capped++; continue }
    next.add(d.key)
    if (d.size !== c.size || d.modified !== c.modified) changed.add(d.key)
  }
  return { ticks: next, changed, left, capped }
}

/** A cloud's name as the person knows it ("the cloud" when the app could not tell which). */
export const CLOUD_NAMES: Record<Exclude<WorkCloudProvider, 'cloud'>, string> = { icloud: 'iCloud', onedrive: 'OneDrive', googleDrive: 'Google Drive', dropbox: 'Dropbox', box: 'Box' }
export const cloudName = (c: WorkCloudProvider, t: (key: 'files.findWork.cloudGeneric') => string) => (c === 'cloud' ? t('files.findWork.cloudGeneric') : CLOUD_NAMES[c])

/** The look's files as the step's documents: `pick` the root's folder name, `rel` the path inside it. Nothing is read:
 * `open` asks the app for the bytes, by id, when the file goes up. */
export function docsFromScan(files: readonly WorkFileMeta[], read: (id: string, o?: { onCloud?: (cloud: WorkCloudProvider) => void }) => Promise<WorkFileRead>): LocalDoc[] {
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
      ...(f.used || f.useCount || f.origins?.length || f.authors?.length || f.org || f.listed
        ? { hints: { ...(f.used ? { used: f.used } : {}), ...(f.useCount ? { useCount: f.useCount } : {}), ...(f.origins?.length ? { origins: f.origins } : {}), ...(f.authors?.length ? { authors: f.authors } : {}), ...(f.org ? { org: f.org } : {}), ...(f.listed ? { listed: true } : {}) } }
        : {}),
      open: async (o) => {
        const r = await (o?.onCloud ? read(f.id, { onCloud: o.onCloud }) : read(f.id))
        if (!r.ok) throw new WorkFileReadError(r.reason, r.reason === 'cloudTimeout' ? r.cloud : undefined)
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

/** Why a file is the company's: its name or folder says the company's name, it came from the company's address (or its
 * own workspace of a work app: acme.slack.com, acme.notion.site), or one of the team wrote it. */
export type CompanyMatch = { kind: 'name'; word: string } | { kind: 'from'; host: string } | { kind: 'by'; who: string }

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

/** A company name as a host label ("Acme Labs" → "acmelabs", "acme-labs"); Latin names only. */
const nameLabels = (n: string): string[] => {
  const ws = latinWords(fold(n))
  if (!ws.length || cjk(n)) return []
  const out = [ws.join(''), ws.join('-')]
  return out.filter((x) => x.length >= 3)
}

/** The company's labels a host may carry: its domains' names and its names as labels (never a word every host has). */
const HOST_WORDS = new Set([...NOT_A_NAME, 'files', 'file', 'docs', 'doc', 'drive', 'dl', 'cdn', 'download', 'downloads', 'share', 'static', 'media', 'api'])
const companyLabels = (w: CompanyWordsLike) => [...new Set([...w.domains.map(domainStem), ...w.names.flatMap(nameLabels)].filter((x) => x && !HOST_WORDS.has(x)))]

/** Work apps' shared hosts: a file from one says nothing of whose it is, unless the host carries the company's own label
 * left of the app's name (acme.slack.com, acme-my.sharepoint.com, acme.notion.site). */
const SHARED_HOSTS = /(^|\.)(slack\.com|slack-files\.com|slack-edge\.com|sharepoint\.com|google\.com|googleusercontent\.com|dropbox\.com|dropboxusercontent\.com|box\.com|notion\.so|notion\.site|notion-static\.com|amazonaws\.com|microsoft\.com|live\.com|office\.com|office365\.com|atlassian\.net|figma\.com|canva\.com|wetransfer\.com|kakao\.com|kakaocdn\.net|naver\.com|daum\.net|line\.me|zoom\.us|github\.com|githubusercontent\.com|cloudfront\.net)$/i

/** A host that is the company's: its own domain, a host of its own name (acme.com, files.acme.co.kr), or a work app's
 * shared host that carries the company's label ("acme.slack.com", "acme-my.sharepoint.com", "acme.notion.site").
 * docs.google.com, drive.google.com, www.notion.so, files.slack.com, dropbox.com and the like alone say nothing of whose
 * file it is: it is just "from the web". */
export function companyHost(host: string, w: CompanyWordsLike): boolean {
  const h = host.toLowerCase()
  if (w.domains.some((dom) => h === dom || h.endsWith(`.${dom}`))) return true
  const labels = companyLabels(w)
  if (!labels.length) return false
  const parts = h.split('.')
  const own = domainStem(h)
  const shared = SHARED_HOSTS.test(h)
  // a shared host: only a label left of the app's own name; any other host: its name too (acme.com, files.acme.co.kr)
  return parts.some((label) => (!shared || label !== own) && labels.some((c) => label === c || label === `${c}-my`))
}

/** Why this file is the company's, or null. Names and folders, download hosts, authors and organisation only: no file
 * is read. */
export function companyMatch(d: Pick<LocalDoc, 'pick' | 'folder' | 'name' | 'hints' | 'place'>, w: CompanyWordsLike): CompanyMatch | null {
  // a place's name counts as a folder ("OneDrive – Acme", "Google Drive – acme.com", a work folder "Acme")
  const text = [d.place?.label ?? '', d.folder, d.name.replace(/\.[a-z0-9]+$/i, '')].join(' ').replace(/[/_]/g, ' ')
  for (const name of w.names) if (holds(text, name)) return { kind: 'name', word: name }
  for (const dom of w.domains) { const stem = domainStem(dom); if (stem && holds(text, stem)) return { kind: 'name', word: stem } }
  for (const host of d.hints?.origins ?? []) if (companyHost(host, w)) return { kind: 'from', host: host.toLowerCase() }
  const who = [...(d.hints?.authors ?? []), ...(d.hints?.org ? [d.hints.org] : [])]
  for (const a of who) {
    const p = w.people.find((x) => fold(x) === fold(a.trim()))
    if (p) return { kind: 'by', who: p }
    const n = w.names.find((x) => holds(a, x))
    if (n) return { kind: 'by', who: n }
  }
  return null
}

/** When the file was last touched, and how: opened (the index or a recent list knows it) or changed. */
export const touched = (d: Pick<LocalDoc, 'modified' | 'hints'>): { at: number; opened: boolean } =>
  d.hints?.used && d.hints.used >= d.modified ? { at: d.hints.used, opened: true } : { at: d.modified, opened: false }

export const isRecentDoc = (d: Pick<LocalDoc, 'modified' | 'hints'>, now = Date.now()) => now - touched(d).at <= RECENT_DAYS * 86_400_000

/** Documents people work on (owner, 2026-11-15): office files, PDFs, Hangul, Apple's iWork; Markdown with a real name.
 * Plain text and CSV count only with a strong sign of the company. */
const SUBSTANTIVE = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'key', 'numbers', 'pages'])
const TYPE_WEIGHT: Record<string, number> = { pdf: 1, doc: 1, docx: 1, hwp: 1, hwpx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, key: 1, pages: 1, numbers: 1, md: 0.6, rtf: 0.6, csv: 0.3, txt: 0.3, png: 0.2, jpg: 0.2, jpeg: 0.2 }
const FOLDER_HINT: Record<string, number> = { Downloads: 0.7, Desktop: 1, Documents: 1.2 }
/** Part 5: a place's weight (a work folder and the company's cloud drive above Documents; a messenger's downloads as
 * Downloads; the home folder's and other drives' recent files as Desktop). */
const PLACE_HINT: Record<NonNullable<LocalDoc['place']>['kind'], number> = { folder: 1.3, cloud: 1.2, messenger: 0.8, home: 1, drive: 1 }

/** A name with words in it: at least three letters once the digits, marks and copy words are out ("2026-10-09.pdf",
 * "1.pdf", "f(3).txt" have none). */
const LETTERS = /\p{L}/gu
export const namedLikeAPerson = (name: string) => ((copyOf(name) ?? name).replace(/\.[a-z0-9]+$/i, '').match(LETTERS)?.length ?? 0) >= 3
const substantive = (d: Pick<LocalDoc, 'ext' | 'name'>) => SUBSTANTIVE.has(d.ext) || (d.ext === 'md' && namedLikeAPerson(d.name) && latinWordsOr(d.name) >= 2)
/** words in a name ("q3-sales-notes.md" → 3; Korean counts a word per run) */
const latinWordsOr = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').split(/[\s_\-.()[\]]+/).filter((x) => /\p{L}/u.test(x)).length

/**
 * Never a work file, whatever else is known (owner, 2026-11-15: "it only brought really useless ones"): inside a saved
 * page's folder ("…_files", "…-Dateien"), a program's or a code project's folder, a name a program gave (f(8).txt,
 * image001.png, Untitled, a hash, a chat export, README), an empty template or a text note of a few lines. The same rules
 * as the app's own look (shared/src/file-scan.ts), so a list from an older app is held to them too.
 */
export function notWork(d: Pick<LocalDoc, 'folder' | 'name' | 'ext' | 'size'>): boolean {
  const folders = d.folder ? d.folder.split('/').map((x) => x.normalize('NFC')) : []
  if (folders.some((x) => neverListed(x))) return true
  // the app's own rules for a name (a program's names, a saved page's pieces); a brand folder's pictures stay
  if (!considered(d.name, folders) && !['png', 'jpg', 'jpeg'].includes(d.ext)) return true
  return autoNamed(d.name) || tooSmall(d.ext, d.size)
}

/** The "May be personal" fold: recent personal-looking files, never one that is no work file (a text note of a few lines,
 * a program's name: notWork). Those are found by name only (MAN-057: the app lists small files for the search). */
export const personalList = <T extends LocalDoc>(docs: readonly T[], now = Date.now()): T[] => docs.filter((d) => d.personal && !notWork(d) && isRecentDoc(d, now))

/** Names that differ only in their numbers, in one folder, of one type: from this many on they are a series. */
const SERIES_MIN = 4

/** The files worth judging: not notWork, and of each copy ("Plan (1).pdf", "Copy of Plan.pdf") only the original when
 * it is there; of a series in one folder ("Invoice 01.pdf" … "Invoice 14.pdf", four or more) only the newest, and none
 * of a series whose names have no words. */
export function workCandidates<T extends LocalDoc>(docs: readonly T[], now = Date.now()): T[] {
  // recent first: a copy downloaded again lately stays when its original is old (and so not listed)
  const ok = docs.filter((d) => !notWork(d) && isRecentDoc(d, now))
  const keyOf = (d: LocalDoc, name: string) => `${d.pick}\u0000${d.folder}\u0000${fold(name)}`
  const names = new Set(ok.map((d) => keyOf(d, d.name)))
  const single = ok.filter((d) => { const base = copyOf(d.name); return !base || !names.has(keyOf(d, base)) })
  // a series: the same name with its numbers taken out, in the same folder, of the same type
  const series = new Map<string, T[]>()
  for (const d of single) {
    const k = `${d.pick}\u0000${d.folder}\u0000${d.ext}\u0000${fold(copyOf(d.name) ?? d.name).replace(/\.[a-z0-9]+$/, '').replace(/\d+/g, '#').replace(/[\s_\-.()]+/g, ' ').trim()}`
    const g = series.get(k) ?? []
    g.push(d)
    series.set(k, g)
  }
  const out: T[] = []
  for (const g of series.values()) {
    if (g.length < SERIES_MIN) { out.push(...g); continue }
    if (!namedLikeAPerson(g[0]!.name)) continue
    out.push(g.reduce((a, b) => (touched(b).at > touched(a).at ? b : a)))
  }
  const keep = new Set(out)
  return single.filter((d) => keep.has(d))
}

/** The fixed score (docs/DECISIONS.md part 4): recency (half-life 21 days) × use × type × the company × the folder. */
export function workScore(d: LocalDoc, m: CompanyMatch | null, now = Date.now()): number {
  const age = Math.max(0, now - touched(d).at) / 86_400_000
  const recency = Math.pow(0.5, age / 21)
  const use = 1 + Math.log(1 + (d.hints?.useCount ?? 0)) + (touched(d).opened || d.hints?.listed ? 0.5 : 0)
  const company = !m ? 1 : m.kind === 'from' ? 3 : m.kind === 'by' ? 2 : 1.5
  const where = d.place ? PLACE_HINT[d.place.kind] ?? 1 : (FOLDER_HINT[d.pick] ?? 1)
  const named = namedLikeAPerson(d.name) ? 1 : 0.5
  return recency * use * (TYPE_WEIGHT[d.ext] ?? 0.4) * company * where * named
}

/**
 * The fixed rules on their own (no AI, or a file the AI was not shown): a strong sign only. The company's (its name in
 * the name or folders, its own address or workspace, one of the team wrote it) for a document or, with that sign, a text
 * file; or a document with a real name that the person opened lately (the index or a recent list says so) or keeps in a
 * work folder or the company's cloud drive. A file only downloaded from a work app's shared host is not enough.
 */
export function strongWork(d: LocalDoc, m: CompanyMatch | null): boolean {
  if (m) return substantive(d) || ['txt', 'csv', 'md', 'rtf'].includes(d.ext) || (d.ext === 'png' || d.ext === 'jpg' || d.ext === 'jpeg')
  if (!substantive(d) || !namedLikeAPerson(d.name)) return false
  return touched(d).opened || !!d.hints?.listed || (d.hints?.useCount ?? 0) >= 2 || d.place?.kind === 'folder' || d.place?.kind === 'cloud'
}

/** Plain text and CSV (exports, lists, notes) count only with the company's sign, whatever the AI says. */
const PLAIN = new Set(['txt', 'csv'])
const plainWithoutSign = (d: LocalDoc, m: CompanyMatch | null) => PLAIN.has(d.ext) && !m

/** The AI's look: the best TO_AI recent candidates that look like no one's personal file, by the score. */
export function forAiRecent(docs: readonly LocalDoc[], w: CompanyWordsLike, now = Date.now()): LocalDoc[] {
  return workCandidates(docs.filter((d) => !d.personal), now)
    .map((d) => ({ d, m: companyMatch(d, w) }))
    .filter(({ d, m }) => !plainWithoutSign(d, m))
    .map(({ d, m }) => ({ d, s: workScore(d, m, now) }))
    .sort((a, b) => b.s - a.s).slice(0, TO_AI).map((x) => x.d)
}

/** "Looks like work": candidates (workCandidates) that are not personal-looking, and
 *  - the AI picked (`picks`, with `sent` the keys it was shown): of those it was shown, only its picks (its no is a
 *    no); of the rest, only the strong ones (strongWork);
 *  - no AI answer, or one with no pick at all: only the strong ones.
 * Best first, at most WORK_SHOWN. `more`: how many more would qualify (found by name). Without `sent`, an AI answer
 * counts for every file (an older caller). */
export function workList(docs: readonly LocalDoc[], w: CompanyWordsLike, picks: ReadonlyMap<string, unknown> | null, now = Date.now(), ticked: ReadonlySet<string> = new Set(), sent?: ReadonlySet<string>): { shown: LocalDoc[]; more: number } {
  const all = workCandidates(docs.filter((d) => !d.personal), now).flatMap((d) => {
    const m = companyMatch(d, w)
    if (plainWithoutSign(d, m)) return []
    const picked = !!picks?.has(d.key)
    // an answer with no pick at all is no judgement (a small model that said nothing): the rules decide
    const judged = !!picks && picks.size > 0 && (sent ? sent.has(d.key) : true)
    const ok = judged ? picked : strongWork(d, m)
    return ok ? [{ d, s: workScore(d, m, now) * (picked ? 1.5 : 1) }] : []
  }).sort((a, b) => b.s - a.s)
  // a ticked file stays in view (the AI's picks coming late never push it out of sight while it is ticked)
  const top = all.slice(0, WORK_SHOWN)
  const kept = all.slice(WORK_SHOWN).filter((x) => ticked.has(x.d.key))
  const shownKeys = new Set([...top, ...kept].map((x) => x.d.key))
  const tickedOut = docs.filter((d) => ticked.has(d.key) && !shownKeys.has(d.key) && !d.personal)
  return { shown: [...top, ...kept].map((x) => x.d).concat(tickedOut), more: Math.max(0, all.length - WORK_SHOWN - kept.length) }
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
