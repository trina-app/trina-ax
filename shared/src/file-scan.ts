// What a look through a person's folders lists, without opening any file (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일
// recommendations" and "Find work files on this computer"). One set of rules for the page's own walk of a picked folder
// (web/src/lib/teamFiles.ts) and the desktop app's look through Documents, Desktop and Downloads, which runs in its main
// process (desktop/src/common/work-files.ts). No zod and no other import: the desktop's main process and the page both
// load it as it is.

/** Files and folders that an operating system makes (Finder, Windows Explorer): never a person's document. The folder
 * upload skips them (web/src/lib/folderUpload.ts) and a team folder's document count leaves them out
 * (server/src/skills/examples.ts). Other dot files are a project's own (.gitignore). */
const SYSTEM_NAMES = new Set(['.ds_store', '.apdisk', '.appledouble', '.fseventsd', '.spotlight-v100', '.temporaryitems', '.trashes', '__macosx', 'icon\r', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', '$recycle.bin', 'system volume information'])
export const isSystemName = (name: string) => name.startsWith('._') || SYSTEM_NAMES.has(name.toLowerCase())

/** The type of a file by its name, lower case, without the dot ('' when it has none). */
export const fileExt = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''

/** The document types considered (FLOW v6 §3.2). */
export const DOC_TYPES: readonly string[] = ['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'key', 'pages', 'numbers', 'txt', 'md', 'rtf']
const DOCS = new Set(DOC_TYPES)
const IMAGES = new Set(['png', 'jpg', 'jpeg'])
/** a folder whose pictures are brand material */
const brandFolder = (name: string) => /logo|brand|브랜드|로고/i.test(name)

/** Folders never entered (case does not matter). Library is the Mac's app data in a home folder; AppData Windows'. */
const NEVER = new Set(['node_modules', '.git', 'library', 'appdata'])
/** App bundles and packages: folders to the system, one thing to a person. */
const BUNDLE = /\.(app|appex|bundle|framework|plugin|kext|prefpane|qlgenerator|saver|pkg|mpkg|lproj|xcodeproj|xcworkspace|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle)$/i

/** A name a look through folders never lists: dot entries, Office's lock files (~$…), system names, node_modules, .git,
 * Library, AppData and app bundles. */
export const neverListed = (name: string) =>
  name.startsWith('.') || name.startsWith('~$') || isSystemName(name) || NEVER.has(name.toLowerCase()) || BUNDLE.test(name)

/** Screenshots are never work files by their name alone ("Screenshot 2026-…", "Screen Shot …", "스크린샷 …"). */
const SCREENSHOT = /^(screenshot|screen shot|스크린샷|스크린 샷|スクリーンショット|截屏|截图|屏幕截图|captura de pantalla|tangkapan layar)/i

/** A file the look considers, by its type and the folders it is in: a document, or a png or jpg in a brand folder (never a
 * screenshot). */
export function considered(name: string, folders: readonly string[]): boolean {
  const ext = fileExt(name)
  if (DOCS.has(ext)) return true
  return IMAGES.has(ext) && folders.some(brandFolder) && !SCREENSHOT.test(name.normalize('NFC'))
}

/** The limits of the desktop app's look through Documents, Desktop and Downloads (each folder: the page walk's limits,
 * TEAM_FILES_LIMITS; all three together: totalMs), and of what the page may read of it afterwards. */
export const WORK_FILES_LIMITS = {
  /** each folder: stop at this many documents … */
  walkDocs: 5000,
  /** … or at this many entries looked at … */
  walkFiles: 50_000,
  /** … or this many folders down … */
  depth: 6,
  /** … or after this long (the time macOS waits for the person's answer to its own question does not count) */
  rootMs: 15_000,
  /** all three folders together */
  totalMs: 30_000,
  /** a bigger file is not offered (the file screen takes it) */
  fileBytes: 50 * 1024 * 1024,
  /** the page reads at most this many files of one look … */
  readFiles: 100,
  /** … and at most this many bytes in all … */
  readBytes: 1024 * 1024 * 1024,
  /** … within this long after the look */
  sessionMs: 60 * 60_000,
} as const
