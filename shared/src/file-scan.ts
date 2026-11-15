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

/** Folders never entered (case does not matter). Library is the Mac's app data in a home folder; AppData Windows'. The
 * rest are a package manager's or a Python environment's trees. */
const NEVER = new Set(['node_modules', '.git', 'library', 'appdata', 'bower_components', '__pycache__', 'site-packages', 'dist-packages', 'deriveddata'])
/** A browser's "Save page as" folder name ("Report_files", "보고서_파일", "Bericht-Dateien"): Chrome, Edge, Firefox and
 * Safari in the app's languages and the common European ones. A name alone is not enough ("Client_files" is a person's):
 * savedPage below decides with what is beside it or in it. */
const SAVED_PAGE = /.(_files|_파일|-dateien|_fichiers|_archivos|_arquivos|-bestanden|_ファイル|_文件|_檔案|_pliki|_soubory|_tiedostot|_file_salvati|_berkas)$/i
const SAVED_PAGE_SUFFIX = /(_files|_파일|-dateien|_fichiers|_archivos|_arquivos|-bestanden|_ファイル|_文件|_檔案|_pliki|_soubory|_tiedostot|_file_salvati|_berkas)$/i
export const savedPageName = (name: string) => SAVED_PAGE.test(name.normalize('NFC'))
/** A saved page's folder, told by the page saved beside it ("Report_files" next to "Report.html", .htm, .mhtml, .xhtml,
 * .shtml). `siblings`: the names in the same folder. */
export function savedPage(name: string, siblings: readonly string[]): boolean {
  const n = name.normalize('NFC')
  if (!SAVED_PAGE.test(n)) return false
  const stem = n.replace(SAVED_PAGE_SUFFIX, '').toLowerCase()
  return siblings.some((x) => { const m = x.normalize('NFC').toLowerCase().match(/^(.*)\.(html?|mht|mhtml|xhtml|shtml)$/); return !!m && m[1] === stem })
}
/** A software or tool install's folder by its name: a platform build ("node-v26.13.0-win-x64", "ffmpeg-7.1-darwin-arm64")
 * or a runtime with a dotted version and nothing else ("python-3.12.1", "node-v20.11.0"; never "Go-2026 plan"). */
const INSTALL_DIR = /[-_](win|windows|darwin|mac|macos|osx|linux)[-_]?(x64|x86|x86_64|arm64|aarch64|amd64|ia32|universal)$|^(node|nodejs|python|jdk|jre|openjdk|go|ruby|php|git|ffmpeg|electron|chromium|cmake|gradle|maven)[-_]?v?\d+(\.\d+)+$/i
/** A software install's folder by its name (the walk never enters it, an index hit inside is dropped). */
export const installFolder = (name: string) => INSTALL_DIR.test(name.normalize('NFC'))
/** App bundles and packages: folders to the system, one thing to a person. */
const BUNDLE = /\.(app|appex|bundle|framework|plugin|kext|prefpane|qlgenerator|saver|pkg|mpkg|lproj|xcodeproj|xcworkspace|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle)$/i

/** A name a look through folders never lists: dot entries, Office's lock files (~$…), system names, node_modules, .git,
 * Library, AppData and app bundles. */
export const neverListed = (name: string) =>
  name.startsWith('.') || name.startsWith('~$') || isSystemName(name) || NEVER.has(name.toLowerCase()) || BUNDLE.test(name) || installFolder(name)

/** Screenshots are never work files by their name alone ("Screenshot 2026-…", "Screen Shot …", "스크린샷 …"). */
const SCREENSHOT = /^(screenshot|screen shot|스크린샷|스크린 샷|スクリーンショット|截屏|截图|屏幕截图|captura de pantalla|tangkapan layar)/i

/** Names a program gave, never a person: a saved page's pieces ("f(8).txt", "image001.png"), "Untitled" and "New Text
 * Document" with no more words, a hash or a UUID as the name, a messenger's chat export, a code project's own files
 * (README, CHANGELOG, LICENSE as text). */
const PAGE_PIECE = /^[a-z]{1,2}\(\d+\)$/
const AUTO_NAME = /^((image|img|clip_image|picture|pic)[-_ ]?\d{1,4}|untitled( (document|spreadsheet|presentation))?( ?\(?\d{1,3}\)?)?|제목 ?없음( ?\(?\d{1,3}\)?)?|名称未設定( ?\d{1,3})?|无标题( ?\d{1,3})?|無題( ?\d{1,3})?|sin t[ií]tulo( ?\(?\d{1,3}\)?)?|tanpa judul( ?\(?\d{1,3}\)?)?|new (text |microsoft (word|excel|powerpoint) )?(document|worksheet|presentation)( ?\(\d{1,3}\))?|새 (텍스트 )?문서( ?\(\d{1,3}\))?)$/i
const PROJECT_FILE = /^(readme|changelog|changes|license|licence|copying|contributing|authors|third[-_ ]party[-_ ]notices|code_of_conduct)([-_.][a-z]{2,5})?$/i
const PROJECT_EXT = new Set(['', 'md', 'txt', 'rst', 'rtf'])
const CHAT_EXPORT = /^(kakaotalk_\d{8}_\d|kakaotalk_?chats?$|kakaotalkchats?$|카카오톡 ?대화|talk_\d{4}\.\d{1,2}\.\d{1,2}|whatsapp chat with |\[line\] ?chat|line_chat_|slack[-_ ]export|teams[-_ ]chat[-_ ]export)/i
const HASHLIKE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i
/** A program's name for a file, by its name alone (no file read). */
export function autoNamed(name: string): boolean {
  const n = name.normalize('NFC')
  const ext = fileExt(n)
  const stem = (ext ? n.slice(0, -(ext.length + 1)) : n).trim()
  if (!stem) return true
  if (PAGE_PIECE.test(stem) || AUTO_NAME.test(stem) || CHAT_EXPORT.test(stem) || HASHLIKE.test(stem)) return true
  // a random id ("a8Fk2Lq9Zx01Pm3Rt7Vb"): 16+ letters and digits with no separator and digits in four places or more
  // (a CamelCase name has them in one or two: "AnnualReport2024Summary", "Q3SalesReport2026Final")
  if (/^[A-Za-z0-9]{16,}$/.test(stem) && (stem.match(/\d+/g)?.length ?? 0) >= 4) return true
  return PROJECT_EXT.has(ext) && PROJECT_FILE.test(stem)
}

/** A folder whose own entries say it is a program or a code project, not a person's documents: a library of the system
 * (.dll, .so, .dylib), a package's manifest, a program's bin and lib side by side. Never asked of the three folders
 * themselves (Downloads holds installers). */
const MANIFEST = new Set(['package.json', 'cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'gemfile', 'composer.json', 'makefile', 'cmakelists.txt'])
export function softwareFolder(entries: readonly { name: string; kind: string }[]): boolean {
  let bin = false
  let lib = false
  for (const e of entries) {
    const n = e.name.toLowerCase()
    if (e.kind === 'dir' || e.kind === 'link') {
      if (n === 'node_modules' || n === 'site-packages') return true
      if (n === 'bin') bin = true
      if (n === 'lib' || n === 'lib64' || n === 'libexec') lib = true
      continue
    }
    if (MANIFEST.has(n) || /\.(dll|so|dylib|sys)$/.test(n)) return true
  }
  return bin && lib
}

/** Smaller files are no work document (an empty template, a stub); a text note under 2 KB is a few lines. */
export const MIN_DOC_BYTES = 1024
export const MIN_TEXT_BYTES = 2048
const TEXTS = new Set(['txt', 'md', 'csv', 'rtf'])
export const tooSmall = (ext: string, size: number) => size < (TEXTS.has(ext) ? MIN_TEXT_BYTES : MIN_DOC_BYTES)

/** "Report (1).pdf", "Copy of Report.pdf", "Report - 복사본.pdf", "Report copy 2.pdf" → "Report" (the name a copy was
 * made from), or null when the name says no copy. */
const COPY_MARK = /^(copy of |사본 ?- ?|복사본 ?- ?)|( ?\(\d{1,3}\)| - (copy|복사본|사본|コピー|副本|kopie|copie|copia|salinan)( \(\d{1,3}\))?| copy( \d{1,3})?|[_ ]copy\d{0,3}| 복사본( \(\d{1,3}\))?)$/i
export function copyOf(name: string): string | null {
  const n = name.normalize('NFC')
  const ext = n.match(/\.[a-z0-9]+$/i)?.[0] ?? ''
  const stem = n.slice(0, n.length - ext.length)
  if (!COPY_MARK.test(stem)) return null
  const base = stem.replace(COPY_MARK, '').trim()
  return base ? base + ext : null
}

/** A file the look considers, by its type and the folders it is in: a document, or a png or jpg in a brand folder (never a
 * screenshot). */
export function considered(name: string, folders: readonly string[]): boolean {
  const ext = fileExt(name)
  if (autoNamed(name)) return false
  // inside a folder named like a saved page's: its text pieces and pictures are the page's (a PDF there is kept)
  if (folders.some(savedPageName) && (TEXTS.has(ext) || IMAGES.has(ext))) return false
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
