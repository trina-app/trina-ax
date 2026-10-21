// The desktop app installers an installation offers under Settings → Apps (docs/OFFICE.md "데스크톱 앱"):
// <data>/downloads/<file> and <data>/downloads/index.json {items: [{platform, file, version, size, signed, sha256}]},
// served to signed-in people by server/src/routes/downloads.ts. `teamax desktop add|list|remove|add-from` (cli.ts)
// and office-install.sh (installers found next to the bundle) use this; unit-tested in tests/unit/office-desktop.test.ts.
//
// An installer is checked before it is offered: a Windows .exe must be a PE file with the NSIS installer header
// (what `bun run --cwd desktop dist:win` builds), a Mac .dmg a UDIF disk image ("koly" trailer). `signed` is true only
// when the file carries a signature: an Authenticode certificate table in the .exe, or a .dmg `codesign --verify`
// accepts. Files are copied (never linked) into the folder with mode 600 under a temporary dot-name (never served:
// safeFile refuses dotfiles) and renamed into place; index.json is replaced the same way, so the server never sees
// half a file or half a list.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type DesktopPlatform = 'mac' | 'windows'
export interface DownloadItem { platform: DesktopPlatform; file: string; version: string; size: number; signed: boolean; sha256?: string }

/** file names the folder may hold (served as-is in /downloads/<file>) */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}\.(exe|dmg)$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,30})?$/
/** what office-install.sh looks for: the Windows installer and the Mac disk image the desktop build makes */
export const FOUND_PATTERNS: [RegExp, DesktopPlatform][] = [
  [/^Team-AX-Setup-.+-x64\.exe$/i, 'windows'],
  [/^Team-AX-.+-mac.*\.dmg$/i, 'mac'],
]

export const platformOf = (file: string): DesktopPlatform | null => {
  const e = path.extname(file).toLowerCase()
  return e === '.exe' ? 'windows' : e === '.dmg' ? 'mac' : null
}

/** "Team-AX-Setup-0.1.0-x64.exe" → 0.1.0, "Team-AX-1.2.0-beta.2-mac-universal.dmg" → 1.2.0-beta.2 */
export function versionFromName(name: string): string | null {
  const m = /(?:^|[-_ v])(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-(?:alpha|beta|rc)(?:\.?\d+)?)?)(?=[-_. ]|$)/i.exec(path.basename(name))
  return m ? m[1]! : null
}

/** semver order (pre-releases before their release; numbers in pre-release parts compared as numbers) */
export function compareVersions(a: string, b: string): number {
  const [ac = '', ap] = a.split(/-(.*)/s)
  const [bc = '', bp] = b.split(/-(.*)/s)
  const an = ac.split('.').map(Number), bn = bc.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((an[i] ?? 0) !== (bn[i] ?? 0)) return (an[i] ?? 0) - (bn[i] ?? 0)
  if (!ap && !bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  const as = ap.split('.'), bs = bp.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i], y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null, ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) { if (nx !== ny) return nx - ny; continue }
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len)
  const n = fs.readSync(fd, b, 0, len, pos)
  return b.subarray(0, n)
}

const NSIS_SCAN = 32 * 1024 * 1024
const NSIS_MAGIC = Buffer.concat([Buffer.from([0xef, 0xbe, 0xad, 0xde]), Buffer.from('NullsoftInst', 'latin1')])

export interface Inspection { platform: DesktopPlatform; signed: boolean; kind: 'nsis' | 'udif' }

/** Check that a file is an installer of the kind its extension says; throws an Error that says why not. */
export function inspectInstaller(file: string, o: { codesign?: (file: string) => boolean } = {}): Inspection {
  const platform = platformOf(file)
  if (!platform) throw new Error(`${path.basename(file)}: only Windows .exe and Mac .dmg installers can be offered`)
  const st = fs.statSync(file)
  if (!st.isFile()) throw new Error(`${file} is not a file`)
  if (st.size < 4096) throw new Error(`${path.basename(file)} is too small to be an installer (${st.size} bytes)`)
  const fd = fs.openSync(file, 'r')
  try {
    if (platform === 'windows') {
      const dos = readAt(fd, 0, 64)
      if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${path.basename(file)} is not a Windows program (no MZ header)`)
      const pe = dos.readUInt32LE(0x3c)
      const hdr = readAt(fd, pe, 24 + 2)
      if (pe <= 0 || pe > 64 * 1024 || hdr.length < 26 || hdr.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error(`${path.basename(file)} is not a Windows program (no PE header)`)
      const magic = hdr.readUInt16LE(24)
      if (magic !== 0x10b && magic !== 0x20b) throw new Error(`${path.basename(file)}: unknown PE optional header`)
      // data directory 4 = the certificate table (Authenticode); its "address" is a file offset
      const dirs = pe + 24 + (magic === 0x20b ? 112 : 96)
      const sec = readAt(fd, dirs + 4 * 8, 8)
      let signed = false
      if (sec.length === 8) {
        const off = sec.readUInt32LE(0), len = sec.readUInt32LE(4)
        if (off > 0 && len >= 8 && off + len <= st.size) {
          const cert = readAt(fd, off, 8)
          signed = cert.length === 8 && cert.readUInt16LE(6) === 0x0002 // WIN_CERT_TYPE_PKCS_SIGNED_DATA
        }
      }
      // NSIS: the installer data starts on a 512-byte boundary after the stub with 0xDEADBEEF "NullsoftInst"
      let found = false
      const chunk = 1024 * 1024
      for (let pos = 0; pos < Math.min(st.size, NSIS_SCAN) && !found; pos += chunk - NSIS_MAGIC.length) {
        if (readAt(fd, pos, chunk).indexOf(NSIS_MAGIC) >= 0) found = true
      }
      if (!found) throw new Error(`${path.basename(file)} is a Windows program but not an NSIS installer (the Team AX Windows installer is Team-AX-Setup-<version>-x64.exe)`)
      return { platform, signed, kind: 'nsis' }
    }
    const koly = readAt(fd, st.size - 512, 4)
    if (koly.toString('latin1') !== 'koly') throw new Error(`${path.basename(file)} is not a Mac disk image (.dmg)`)
    const check = o.codesign ?? codesignOk
    return { platform, signed: check(file), kind: 'udif' }
  } finally {
    fs.closeSync(fd)
  }
}

/** `codesign --verify` accepts the disk image (macOS only; false elsewhere or without codesign) */
export function codesignOk(file: string): boolean {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/codesign')) return false
  return Bun.spawnSync(['/usr/bin/codesign', '--verify', '--strict', file], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
}

export function sha256File(file: string): string {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    for (let pos = 0; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      h.update(buf.subarray(0, n))
      pos += n
    }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

export function readIndex(dir: string): DownloadItem[] {
  let raw: unknown
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) } catch { return [] }
  const items = (raw as { items?: unknown })?.items
  if (!Array.isArray(items)) return []
  return items.filter((i): i is DownloadItem => !!i && typeof i === 'object' && (i.platform === 'mac' || i.platform === 'windows') && typeof i.file === 'string' && SAFE_NAME.test(i.file) && typeof i.version === 'string')
}

/** windows first, then mac; newest version first */
export const sortItems = (items: DownloadItem[]) =>
  [...items].sort((a, b) => (a.platform === b.platform ? compareVersions(b.version, a.version) : a.platform === 'windows' ? -1 : 1))

export function writeIndex(dir: string, items: DownloadItem[]) {
  ensureDir(dir)
  const f = path.join(dir, 'index.json')
  const tmp = path.join(dir, `.index.json.tmp-${process.pid}`)
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, JSON.stringify({ items: sortItems(items) }, null, 1) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, f)
}

export interface AddResult { item: DownloadItem; removed: string[]; unchanged: boolean }

/**
 * Offer an installer: checked, copied into `dir`, listed in index.json. Without `keep` it becomes the only one of its
 * platform (older ones and their files are removed); a newer one already offered is not replaced unless `keep`.
 */
export function addInstaller(dir: string, src: string, o: { version?: string; keep?: boolean; name?: string; codesign?: (f: string) => boolean } = {}): AddResult {
  const real = fs.realpathSync(src)
  const info = inspectInstaller(real, { codesign: o.codesign })
  const version = o.version ?? versionFromName(src)
  if (!version) throw new Error(`${path.basename(src)}: no version in the file name; pass --version <x.y.z>`)
  if (!VERSION.test(version)) throw new Error(`version ${version} is not like 1.2.3 or 1.2.3-beta.1`)
  const base = o.name ?? path.basename(src)
  const name = SAFE_NAME.test(base) && platformOf(base) === info.platform
    ? base
    : info.platform === 'windows' ? `Team-AX-Setup-${version}-x64.exe` : `Team-AX-${version}-mac.dmg`
  ensureDir(dir)
  const items = readIndex(dir)
  const newer = items.find((i) => i.platform === info.platform && i.file !== name && compareVersions(i.version, version) > 0)
  if (newer && !o.keep) throw new Error(`a newer ${info.platform === 'windows' ? 'Windows' : 'Mac'} app is already offered (${newer.file}, ${newer.version}); remove it first or add --keep to offer both`)

  const dest = path.join(dir, name)
  const size = fs.statSync(real).size
  const same = items.find((i) => i.file === name)
  const inPlace = fs.existsSync(dest) && fs.realpathSync(dest) === real
  let sha = ''
  let unchanged = false
  if (same && same.size === size && same.version === version && fs.existsSync(dest) && fs.statSync(dest).size === size) {
    sha = sha256File(real)
    unchanged = sha === same.sha256 && (inPlace || sha256File(dest) === sha)
  }
  if (unchanged) {
    // the same file is already offered: nothing to copy
  } else if (inPlace) {
    fs.chmodSync(dest, 0o600)
    sha = sha256File(dest)
  } else {
    const tmp = path.join(dir, `.${name}.tmp-${process.pid}`)
    fs.rmSync(tmp, { force: true })
    try {
      fs.copyFileSync(real, tmp, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(tmp, 0o600)
      sha = sha256File(tmp)
      if (sha !== sha256File(real)) throw new Error(`${src} changed while it was copied; try again`)
      fs.renameSync(tmp, dest)
    } finally { fs.rmSync(tmp, { force: true }) }
  }
  const item: DownloadItem = { platform: info.platform, file: name, version, size, signed: info.signed, sha256: sha }
  const removed: string[] = []
  let next = items.filter((i) => i.file !== name)
  if (!o.keep) {
    for (const i of next.filter((x) => x.platform === info.platform)) removed.push(i.file)
    next = next.filter((i) => i.platform !== info.platform)
  }
  next.push(item)
  writeIndex(dir, next)
  for (const f of removed) if (!next.some((i) => i.file === f)) fs.rmSync(path.join(dir, f), { force: true })
  return { item, removed, unchanged }
}

/** Stop offering a file (the list entry and the file). Returns false when neither existed. */
export function removeInstaller(dir: string, file: string): boolean {
  const name = path.basename(file)
  if (!SAFE_NAME.test(name)) throw new Error(`${file}: not a file name this folder holds`)
  const items = readIndex(dir)
  const had = items.some((i) => i.file === name)
  const p = path.join(dir, name)
  const exists = fs.existsSync(p)
  if (had) writeIndex(dir, items.filter((i) => i.file !== name))
  if (exists) fs.rmSync(p, { force: true })
  return had || exists
}

/** What the folder offers, and installer files in it that the list does not name (not shown to anyone). */
export function listInstallers(dir: string): { items: DownloadItem[]; stray: string[] } {
  const items = sortItems(readIndex(dir))
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter((f) => SAFE_NAME.test(f)) } catch {}
  return { items, stray: files.filter((f) => !items.some((i) => i.file === f)) }
}

/** The newest Team AX installer per platform in these folders (by the version in the name, then the newest file). */
export function findInstallers(dirs: string[]): { file: string; platform: DesktopPlatform; version: string }[] {
  const best = new Map<DesktopPlatform, { file: string; platform: DesktopPlatform; version: string; mtime: number }>()
  const seen = new Set<string>()
  for (const d of dirs) {
    let names: string[] = []
    try { names = fs.readdirSync(d) } catch { continue }
    for (const n of names) {
      const hit = FOUND_PATTERNS.find(([re]) => re.test(n))
      if (!hit) continue
      const file = path.join(d, n)
      let st: fs.Stats
      try { st = fs.statSync(file) } catch { continue }
      if (!st.isFile()) continue
      const real = fs.realpathSync(file)
      if (seen.has(real)) continue
      seen.add(real)
      const version = versionFromName(n)
      if (!version) continue
      const cur = best.get(hit[1])
      const c = cur ? compareVersions(version, cur.version) : 1
      if (!cur || c > 0 || (c === 0 && st.mtimeMs > cur.mtime)) best.set(hit[1], { file, platform: hit[1], version, mtime: st.mtimeMs })
    }
  }
  return [...best.values()].map(({ mtime: _m, ...r }) => r)
}

export const sizeText = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
export const platformWord = (p: DesktopPlatform) => (p === 'windows' ? 'Windows' : 'Mac')
