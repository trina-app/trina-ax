// The document kit of an office Mac (docs/decisions/20261124-office-mac-doc-kit.md): office-install.sh fetches it per
// user into <prefix>/kit/<key> (scripts/office/doc-kit.sh, group doc-kit-mac of scripts/system/packages.json), and the
// office supervisor names <prefix>/kit/current in MYCEL_DOC_KIT. A run builds documents with its Python, node, srt and
// Node libraries (srt/system-office.ts); the page view draws Word, PowerPoint and Excel files with its LibreOffice and
// fonts (files/office-view.ts). Used only when nobody but the server's own account can change it: the AI's code and
// LibreOffice both run from it.
import fs from 'node:fs'
import path from 'node:path'

export interface DocKit {
  /** the kit's real folder (<prefix>/kit/<key>) */
  root: string
  /** LibreOffice.app, and its soffice */
  app: string
  soffice: string
  /** CPython with the document libraries: its bin/ (python3) */
  pythonBin: string
  /** node, and srt's CLI */
  node: string
  srtCli: string
  /** the Node libraries (pptxgenjs, docx): NODE_PATH */
  nodeLibs: string
  /** the Noto CJK fonts (MYCEL_KIT_FONTS_DIR: files/office-profile.ts links them into each render's profile) */
  fonts: string
}

/** The kit's parts below its root (doc-kit.sh writes them). */
export function kitPaths(root: string): DocKit {
  const app = path.join(root, 'LibreOffice.app')
  return {
    root, app, soffice: path.join(app, 'Contents', 'MacOS', 'soffice'),
    pythonBin: path.join(root, 'python', 'bin'),
    node: path.join(root, 'node', 'bin', 'node'),
    srtCli: path.join(root, 'srt', 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js'),
    nodeLibs: path.join(root, 'node-libs', 'node_modules'),
    fonts: path.join(root, 'fonts'),
  }
}

/** Is this path the server account's own, and can nobody else write it (nor the folders it is in, up to its kit's
 * parent)? A kit another account could change would run that account's code inside every build and render. */
export function ownedPath(p: string, uid: number = process.getuid?.() ?? -1): boolean {
  try {
    const st = fs.lstatSync(p)
    return st.uid === uid && (st.mode & 0o022) === 0
  } catch { return false }
}

let cache: { at: number; key: string; kit: DocKit | null } | null = null

/** The kit named by MYCEL_DOC_KIT, or null: not set, not on a Mac, a part missing, or a part (or a folder above it, up
 * to the kit folder) that another account could change. Cached for 30 s; `fresh` reads it again. */
export function docKit(env: Record<string, string | undefined> = process.env, o: { platform?: NodeJS.Platform; fresh?: boolean; uid?: number } = {}): DocKit | null {
  const named = env.MYCEL_DOC_KIT ?? ''
  if ((o.platform ?? process.platform) !== 'darwin' || !named || !path.isAbsolute(named)) return null
  if (!o.fresh && cache && cache.key === named && Date.now() - cache.at < 30_000) return cache.kit
  let kit: DocKit | null = null
  try {
    const root = fs.realpathSync(named)
    const k = kitPaths(root)
    const uid = o.uid ?? process.getuid?.() ?? -1
    // the kit folder and its parent (<prefix>/kit), every part, and the programs that run
    const checks = [path.dirname(root), root, k.app, k.soffice, path.dirname(k.pythonBin), k.pythonBin, path.join(k.pythonBin, 'python3'), path.dirname(path.dirname(k.node)), k.node, path.join(root, 'srt'), k.srtCli, path.join(root, 'node-libs'), k.nodeLibs, k.fonts]
    const ok = checks.every((p) => ownedPath(p, uid) || (fs.lstatSync(p).isSymbolicLink() && ownedPath(fs.realpathSync(p), uid)))
    if (ok && fs.statSync(k.soffice).isFile() && fs.existsSync(path.join(k.fonts, 'NotoSansCJK-VF.otf.ttc')) && fs.existsSync(path.join(root, '.key'))) kit = k
  } catch { kit = null }
  cache = { at: Date.now(), key: named, kit }
  return kit
}

/** tests */
export function resetDocKitCache() { cache = null }
