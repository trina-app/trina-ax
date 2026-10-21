// The desktop app installers an installation offers under Settings → Apps (docs/OFFICE.md "데스크톱 앱"):
// <data>/downloads/<file> and <data>/downloads/index.json {items: [{platform, file, version, size, signed, signature,
// arch, sha256}]}, served to signed-in people by server/src/routes/downloads.ts (only the files index.json lists).
// `teamax desktop add|list|remove|add-from` (cli.ts) and office-install.sh (installers found next to the bundle) use
// this; unit-tested in tests/unit/office-desktop.test.ts.
//
// An installer is checked before it is offered: a Windows .exe must be a PE file with the NSIS installer header
// (what `bun run --cwd desktop dist:win` builds) and at least as long as that header says (a copy cut short by an
// interrupted transfer is refused), a Mac .dmg a UDIF disk image ("koly" trailer) whose data fork fits in the file.
// `signed` is true only when a real check passed (signature 'verified'): `osslsigncode verify` for the .exe, Gatekeeper
// (`spctl -a -t open --context context:primary-signature`) for the .dmg. A certificate table nobody verified, or an
// ad-hoc signature Gatekeeper still blocks, is 'unverified' and Settings → Apps keeps the SmartScreen / Gatekeeper
// steps. Files are copied (never linked) into the folder with mode 600 under a temporary dot-name (never served: only
// listed names are) and renamed into place; index.json is replaced the same way, so the server never sees half a file
// or half a list.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type DesktopPlatform = 'mac' | 'windows'
/** verified: a real check passed; unverified: a signature is there but nothing checked it (or the check failed) */
export type Signature = 'verified' | 'unverified' | 'none'
/** which Macs a .dmg runs on, from its name (electron-builder: -mac-universal, -mac-arm64, -mac-x64) */
export type MacArch = 'universal' | 'arm64' | 'x64'
export interface DownloadItem {
  platform: DesktopPlatform; file: string; version: string; size: number; signed: boolean
  signature?: Signature; arch?: MacArch; sha256?: string
}

/** file names the folder may hold (served as-is in /downloads/<file>) */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}\.(exe|dmg)$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,30})?$/
/** what office-install.sh looks for: the Windows installer and the Mac disk image the desktop build makes */
export const FOUND_PATTERNS: [RegExp, DesktopPlatform][] = [
  [/^Team-AX-Setup-.+-x64\.exe$/i, 'windows'],
  [/^Team-AX-.+-mac.*\.dmg$/i, 'mac'],
]
/** the list of installers a bundle built with --with-desktop carries (sha256 and name per line, like shasum -a 256) */
export const MANIFEST = 'desktop.sha256'

export const platformOf = (file: string): DesktopPlatform | null => {
  const e = path.extname(file).toLowerCase()
  return e === '.exe' ? 'windows' : e === '.dmg' ? 'mac' : null
}

export function macArchFromName(name: string): MacArch | undefined {
  const n = path.basename(name).toLowerCase()
  if (/universal/.test(n)) return 'universal'
  if (/(arm64|aarch64|apple-?silicon)/.test(n)) return 'arm64'
  if (/(x64|x86_64|amd64|intel)/.test(n)) return 'x64'
  return undefined
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
const NSIS_SIG = Buffer.concat([Buffer.from([0xef, 0xbe, 0xad, 0xde]), Buffer.from('NullsoftInst', 'latin1')])

export interface Inspection { platform: DesktopPlatform; signed: boolean; signature: Signature; kind: 'nsis' | 'udif' }
/** checks a signature for real (injected in tests). `present`: the .exe has an Authenticode certificate table. */
export type SignatureCheck = (file: string, platform: DesktopPlatform, present: boolean) => Signature

const cutShort = (file: string, want: number, has: number) =>
  new Error(`${path.basename(file)} is cut short (${has} of ${want} bytes: an interrupted download or copy?); copy it again`)

/** Check that a file is a whole installer of the kind its extension says; throws an Error that says why not. */
export function inspectInstaller(file: string, o: { signature?: SignatureCheck } = {}): Inspection {
  const platform = platformOf(file)
  if (!platform) throw new Error(`${path.basename(file)}: only Windows .exe and Mac .dmg installers can be offered`)
  const st = fs.statSync(file)
  if (!st.isFile()) throw new Error(`${file} is not a file`)
  if (st.size < 4096) throw new Error(`${path.basename(file)} is too small to be an installer (${st.size} bytes)`)
  const check = o.signature ?? checkSignature
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
      let certAt = 0, certLen = 0
      if (sec.length === 8) { certAt = sec.readUInt32LE(0); certLen = sec.readUInt32LE(4) }
      if (certAt > 0 && certAt + certLen > st.size) throw cutShort(file, certAt + certLen, st.size)
      const present = certAt > 0 && certLen >= 8 && readAt(fd, certAt + 6, 2).readUInt16LE(0) === 0x0002 // WIN_CERT_TYPE_PKCS_SIGNED_DATA
      // NSIS: the first header (flags, 0xDEADBEEF "NullsoftInst", header length, length of everything from the first
      // header on, CRC included) sits on a 512-byte boundary after the stub
      let first = -1
      const chunk = 1024 * 1024
      for (let pos = 0; pos < Math.min(st.size, NSIS_SCAN) && first < 0; pos += chunk - NSIS_SIG.length) {
        const buf = readAt(fd, pos, chunk)
        for (let i = buf.indexOf(NSIS_SIG); i >= 0; i = buf.indexOf(NSIS_SIG, i + 1)) {
          if ((pos + i - 4) % 512 === 0) { first = pos + i - 4; break }
        }
      }
      if (first < 0) throw new Error(`${path.basename(file)} is a Windows program but not an NSIS installer (the Team AX Windows installer is Team-AX-Setup-<version>-x64.exe)`)
      const fh = readAt(fd, first, 28)
      const total = fh.length === 28 ? fh.readUInt32LE(24) : 0
      if (total < 28) throw new Error(`${path.basename(file)}: the NSIS header is damaged`)
      if (first + total > st.size) throw cutShort(file, first + total, st.size)
      const signature = present ? check(file, platform, true) : 'none'
      return { platform, signed: signature === 'verified', signature, kind: 'nsis' }
    }
    const koly = readAt(fd, st.size - 512, 512)
    if (koly.length < 512 || koly.toString('latin1', 0, 4) !== 'koly') throw new Error(`${path.basename(file)} is not a whole Mac disk image (.dmg): no UDIF trailer at its end (cut short?)`)
    // the data fork (offset, length: big-endian 64-bit at 0x18 / 0x20) must lie inside the file
    const end = Number(koly.readBigUInt64BE(0x18) + koly.readBigUInt64BE(0x20))
    if (end > st.size - 512) throw cutShort(file, end + 512, st.size)
    const signature = check(file, platform, false)
    return { platform, signed: signature === 'verified', signature, kind: 'udif' }
  } finally {
    fs.closeSync(fd)
  }
}

const run = (argv: string[]) => {
  try { return Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0 } catch { return false }
}
const which = (bin: string) => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((d) => path.join(d, bin)).find((f) => fs.existsSync(f)) ?? null

/** The real checks: osslsigncode (if installed) for the .exe; Gatekeeper's own assessment for the .dmg (codesign
 * alone accepts ad-hoc signatures, which Gatekeeper still blocks). Anything not verified is never 'verified'. */
export const checkSignature: SignatureCheck = (file, platform, present) => {
  if (platform === 'windows') {
    if (!present) return 'none'
    const ossl = which('osslsigncode')
    return ossl && run([ossl, 'verify', '-in', file]) ? 'verified' : 'unverified'
  }
  if (process.platform !== 'darwin') return 'none'
  if (run(['/usr/sbin/spctl', '-a', '-t', 'open', '--context', 'context:primary-signature', file])) return 'verified'
  return run(['/usr/bin/codesign', '--verify', file]) ? 'unverified' : 'none'
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

export interface AddOptions { version?: string; keep?: boolean; name?: string; signature?: SignatureCheck }
/** What adding would do, decided without changing anything (dry runs and the real add use the same answer). */
export type AddPlan =
  | { action: 'add'; item: Omit<DownloadItem, 'sha256'>; real: string; replaces: string[] }
  | { action: 'unchanged'; item: DownloadItem; real: string }
  | { action: 'refused'; reason: string; item: Omit<DownloadItem, 'sha256'> }

/** Check `src` and decide (throws for a file that is no installer, a missing version or a bad --version). */
export function planAdd(dir: string, src: string, o: AddOptions = {}): AddPlan {
  let real: string
  try { real = fs.realpathSync(src) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no such file: ${src}`)
    throw e
  }
  const info = inspectInstaller(real, { signature: o.signature })
  const version = o.version ?? versionFromName(src)
  if (!version) throw new Error(`${path.basename(src)}: no version in the file name; pass --version <x.y.z>`)
  if (!VERSION.test(version)) throw new Error(`version ${version} is not like 1.2.3 or 1.2.3-beta.1`)
  const base = o.name ?? path.basename(src)
  const name = SAFE_NAME.test(base) && platformOf(base) === info.platform
    ? base
    : info.platform === 'windows' ? `Team-AX-Setup-${version}-x64.exe` : `Team-AX-${version}-mac.dmg`
  const arch = info.platform === 'mac' ? macArchFromName(base) ?? macArchFromName(src) : undefined
  const size = fs.statSync(real).size
  const item: Omit<DownloadItem, 'sha256'> = { platform: info.platform, file: name, version, size, signed: info.signed, signature: info.signature, ...(arch ? { arch } : {}) }
  const items = readIndex(dir)
  const newer = items.find((i) => i.platform === info.platform && i.file !== name && compareVersions(i.version, version) > 0)
  if (newer && !o.keep) return { action: 'refused', item, reason: `a newer ${platformWord(info.platform)} app is already offered (${newer.file}, ${newer.version}); remove it first or add --keep to offer both` }
  const dest = path.join(dir, name)
  const same = items.find((i) => i.file === name)
  if (same?.sha256 && same.size === size && same.version === version && fs.existsSync(dest) && fs.statSync(dest).size === size) {
    const sha = sha256File(real)
    const inPlace = fs.realpathSync(dest) === real
    if (sha === same.sha256 && (inPlace || sha256File(dest) === sha)) return { action: 'unchanged', item: same, real }
  }
  const replaces = o.keep ? [] : items.filter((i) => i.platform === info.platform && i.file !== name).map((i) => i.file)
  return { action: 'add', item, real, replaces }
}

export interface AddResult { item: DownloadItem; removed: string[]; unchanged: boolean }

/**
 * Offer an installer: checked, copied into `dir`, listed in index.json. Without `keep` it becomes the only one of its
 * platform (older ones and their files are removed); a newer one already offered is not replaced unless `keep`.
 */
export function addInstaller(dir: string, src: string, o: AddOptions = {}): AddResult {
  const plan = planAdd(dir, src, o)
  if (plan.action === 'refused') throw new Error(plan.reason)
  if (plan.action === 'unchanged') return { item: plan.item, removed: [], unchanged: true }
  ensureDir(dir)
  const { real } = plan
  const name = plan.item.file
  const dest = path.join(dir, name)
  let sha: string
  if (fs.existsSync(dest) && fs.realpathSync(dest) === real) {
    fs.chmodSync(dest, 0o600)
    sha = sha256File(dest)
  } else {
    const tmp = path.join(dir, `.${name}.tmp-${process.pid}`)
    fs.rmSync(tmp, { force: true })
    try {
      fs.copyFileSync(real, tmp, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(tmp, 0o600)
      sha = sha256File(tmp)
      if (sha !== sha256File(real) || fs.statSync(tmp).size !== plan.item.size) throw new Error(`${src} changed while it was copied; try again`)
      fs.renameSync(tmp, dest)
    } finally { fs.rmSync(tmp, { force: true }) }
  }
  const item: DownloadItem = { ...plan.item, sha256: sha }
  const items = readIndex(dir)
  const next = items.filter((i) => i.file !== name && !plan.replaces.includes(i.file))
  next.push(item)
  writeIndex(dir, next)
  for (const f of plan.replaces) if (SAFE_NAME.test(f) && !next.some((i) => i.file === f)) fs.rmSync(path.join(dir, f), { force: true })
  return { item, removed: plan.replaces, unchanged: false }
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

export interface Found { file: string; platform: DesktopPlatform; version: string }
/** universal before a one-architecture image of the same version */
function archRank(f: string): number {
  if (platformOf(f) !== 'mac') return 0
  const a = macArchFromName(f)
  return a === 'universal' ? 2 : a ? 0 : 1
}

/** The newest Team AX installer per platform in these folders (by the version in the name, a universal .dmg before a
 * one-architecture one, then the newest file). */
export function findInstallers(dirs: string[]): Found[] {
  const best = new Map<DesktopPlatform, Found & { mtime: number }>()
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
      const c = cur ? compareVersions(version, cur.version) || archRank(n) - archRank(cur.file) : 1
      if (!cur || c > 0 || (c === 0 && st.mtimeMs > cur.mtime)) best.set(hit[1], { file, platform: hit[1], version, mtime: st.mtimeMs })
    }
  }
  return [...best.values()].map(({ mtime: _m, ...r }) => r)
}

/** desktop.sha256 ("<sha256>  <name>" per line) → name → sha256; null when there is no such file */
export function readManifest(file: string): Map<string, string> | null {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const m = new Map<string, string>()
  for (const line of text.split('\n')) {
    const x = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line.trim())
    if (x && SAFE_NAME.test(path.basename(x[2]!))) m.set(path.basename(x[2]!), x[1]!)
  }
  return m
}

export const sizeText = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
export const platformWord = (p: DesktopPlatform) => (p === 'windows' ? 'Windows' : 'Mac')
