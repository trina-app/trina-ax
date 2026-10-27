// Pinned downloads of the Linux release bundle (linux-runtime spec 3.6.1, D10): the tools that ship inside
// app/<version>/bin/ of a Linux bundle, by version (versions.json) and SHA-256, cached in dist/cache/ so a rebuild works
// offline. Same rule as the office bundle (scripts/build-office.ts DOWNLOADS): the hash is checked on every use; a
// cached file with another hash is deleted and the build fails.
//
// Where the pins come from (`bun scripts/linux/downloads.ts --check` re-does this, prints a table and fails on any
// difference): bun — the release's SHASUMS256.txt; ripgrep — the release's <asset>.sha256; pandoc and typst publish no
// checksum file, so these are the hashes of the files fetched on 2026-10-22, also equal to GitHub's asset digests;
// whisper.cpp — the GitHub source archive of the tag (built in CI, .github build-whisper job), hash as fetched.
//
// amd64 ships bun's x64-baseline build: the plain x64 build needs AVX2 and the tenants' virtual CPUs are only
// guaranteed x86-64-v2 (SSE4.2, spec 6.3); baseline runs on both.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const REPO = path.resolve(import.meta.dir, '..', '..')

export type LinuxArch = 'amd64' | 'arm64'
export type LinuxTool = 'bun' | 'rg' | 'pandoc' | 'typst'
export interface PinnedDownload {
  url: string
  sha256: string
  /** 'source': not per architecture */
  arch: LinuxArch | 'source'
  tool: LinuxTool | 'whisper.cpp'
  /** the program inside the archive (path ending), copied to bin/<tool> */
  member?: string
  /** how the pin was checked against the publisher: its checksum file, or first fetch (+ GitHub's asset digest) */
  checksum: 'SHASUMS256.txt' | '.sha256' | 'first-fetch'
}

/** versions.json: bun 1.3.12, ripgrep 15.2.0, pandoc 3.9.0.2, typst 0.15.1, whisper.cpp 1.9.5 */
export const LINUX_DOWNLOADS: Record<string, PinnedDownload> = {
  'bun-linux-aarch64.zip': { url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-linux-aarch64.zip', sha256: 'c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b', arch: 'arm64', tool: 'bun', member: 'bun-linux-aarch64/bun', checksum: 'SHASUMS256.txt' },
  'bun-linux-x64-baseline.zip': { url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-linux-x64-baseline.zip', sha256: 'f8bb377a9ae93d44697ff91a2611164d2aedc9263415d623b0c3af24a6f55dab', arch: 'amd64', tool: 'bun', member: 'bun-linux-x64-baseline/bun', checksum: 'SHASUMS256.txt' },
  'ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz': { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz', sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915', arch: 'arm64', tool: 'rg', member: 'ripgrep-15.2.0-aarch64-unknown-linux-musl/rg', checksum: '.sha256' },
  'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz': { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz', sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c', arch: 'amd64', tool: 'rg', member: 'ripgrep-15.2.0-x86_64-unknown-linux-musl/rg', checksum: '.sha256' },
  'pandoc-3.9.0.2-linux-arm64.tar.gz': { url: 'https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-linux-arm64.tar.gz', sha256: 'b6d21e8f9c3b15744f5a7ab40248019157ed7793875dbe0383d4c82ff572b528', arch: 'arm64', tool: 'pandoc', member: 'pandoc-3.9.0.2/bin/pandoc', checksum: 'first-fetch' },
  'pandoc-3.9.0.2-linux-amd64.tar.gz': { url: 'https://github.com/jgm/pandoc/releases/download/3.9.0.2/pandoc-3.9.0.2-linux-amd64.tar.gz', sha256: 'a69abfababda8a56969a254b09f9553a7be89ddec00d4e0fe9fd585d71a67508', arch: 'amd64', tool: 'pandoc', member: 'pandoc-3.9.0.2/bin/pandoc', checksum: 'first-fetch' },
  'typst-0.15.1-aarch64-unknown-linux-musl.tar.xz': { url: 'https://github.com/typst/typst/releases/download/v0.15.1/typst-aarch64-unknown-linux-musl.tar.xz', sha256: '5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee', arch: 'arm64', tool: 'typst', member: 'typst-aarch64-unknown-linux-musl/typst', checksum: 'first-fetch' },
  'typst-0.15.1-x86_64-unknown-linux-musl.tar.xz': { url: 'https://github.com/typst/typst/releases/download/v0.15.1/typst-x86_64-unknown-linux-musl.tar.xz', sha256: 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c', arch: 'amd64', tool: 'typst', member: 'typst-x86_64-unknown-linux-musl/typst', checksum: 'first-fetch' },
  'whisper.cpp-1.9.5.tar.gz': { url: 'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz', sha256: 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720', arch: 'source', tool: 'whisper.cpp', checksum: 'first-fetch' },
}

/** The pinned download of `tool` for `arch`. */
export function downloadFor(tool: LinuxTool, arch: LinuxArch): string {
  const hit = Object.entries(LINUX_DOWNLOADS).filter(([, d]) => d.tool === tool && d.arch === arch)
  if (hit.length !== 1) throw new Error(`no single pinned ${tool} download for linux-${arch}`)
  return hit[0]![0]
}

export const sha256File = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** A pinned download from dist/cache (fetched once). The hash is checked every time; a wrong file is removed. */
export async function cachedDownload(name: string, o: { table?: Record<string, PinnedDownload>; cacheDir?: string; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const d = (o.table ?? LINUX_DOWNLOADS)[name]
  if (!d) throw new Error(`${name} is not a pinned download`)
  if (!/^[0-9a-f]{64}$/.test(d.sha256)) throw new Error(`${name}: no SHA-256 pinned yet (run bun scripts/linux/downloads.ts --check)`)
  const dir = o.cacheDir ?? path.join(REPO, 'dist', 'cache')
  const f = path.join(dir, name)
  if (!fs.existsSync(f)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`downloading ${d.url}`)
    const res = await (o.fetchImpl ?? fetch)(d.url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`${d.url}: HTTP ${res.status}`)
    fs.writeFileSync(`${f}.part`, new Uint8Array(await res.arrayBuffer()))
    fs.renameSync(`${f}.part`, f)
  }
  const got = sha256File(f)
  if (got !== d.sha256) { fs.rmSync(f); throw new Error(`${name}: SHA-256 ${got}, expected ${d.sha256} (removed; run again to download it again)`) }
  return f
}

// ---------------- unpacking (no unzip on a stock Debian; tar.gz / tar.xz go to the system tar) ----------------

/** The bytes of the one member of a zip whose name ends with `/<member>` or equals it (stored or deflated). */
export function unzipMember(zip: Uint8Array, member: string): Uint8Array {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)')
  const count = b.readUInt16LE(eocd + 10)
  let p = b.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('zip central directory is damaged')
    const method = b.readUInt16LE(p + 10)
    const csize = b.readUInt32LE(p + 20)
    const usize = b.readUInt32LE(p + 24)
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32)
    const local = b.readUInt32LE(p + 42)
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    if (name !== member && !name.endsWith('/' + member)) continue
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('zip local header is damaged')
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28)
    const raw = b.subarray(start, start + csize)
    const out = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null
    if (!out) throw new Error(`zip member ${name}: compression method ${method} is not supported`)
    if (out.length !== usize) throw new Error(`zip member ${name}: size ${out.length}, expected ${usize}`)
    return out
  }
  throw new Error(`${member} not found in the zip`)
}

function walk(d: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** Copy the program `member` out of a pinned archive to `dest` (0755). tar.xz needs xz on the build machine. */
export function extractMember(archive: string, member: string, dest: string, scratch: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (archive.endsWith('.zip')) {
    fs.writeFileSync(dest, unzipMember(fs.readFileSync(archive), member))
  } else {
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.mkdirSync(scratch, { recursive: true })
    const p = Bun.spawnSync(['tar', '-xf', archive, '-C', scratch], { stderr: 'pipe' })
    if (p.exitCode !== 0) {
      const err = p.stderr.toString().trim()
      throw new Error(`unpacking ${path.basename(archive)} failed: ${err}${/xz/i.test(err) ? ' (install xz-utils)' : ''}`)
    }
    const found = walk(scratch).find((f) => f === path.join(scratch, member) || f.endsWith('/' + member))
    if (!found) throw new Error(`${member} not found in ${path.basename(archive)}`)
    fs.copyFileSync(found, dest)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  fs.chmodSync(dest, 0o755)
}

// ---------------- re-checking the pins against the publishers ----------------

/** The publisher's checksum for a pinned download (SHASUMS256.txt or <asset>.sha256), null for first-fetch pins. */
export async function publishedSha256(name: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const d = LINUX_DOWNLOADS[name]!
  if (d.checksum === 'first-fetch') return null
  const file = d.url.slice(d.url.lastIndexOf('/') + 1)
  const sumsUrl = d.checksum === 'SHASUMS256.txt' ? d.url.slice(0, d.url.lastIndexOf('/') + 1) + 'SHASUMS256.txt' : d.url + '.sha256'
  const r = await fetchImpl(sumsUrl, { redirect: 'follow' })
  if (!r.ok) throw new Error(`${sumsUrl}: HTTP ${r.status}`)
  return parseChecksums(await r.text(), file)
}

/** The hash for `file` in a SHASUMS256.txt / sha256sum-style text ("<hex>  [*]<file>"; a lone hash counts too). */
export function parseChecksums(text: string, file: string): string | null {
  for (const l of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(l.trim())
    if (m && path.basename(m[2]!) === file) return m[1]!
  }
  const lone = /^([0-9a-f]{64})\s*$/.exec(text.trim())
  return lone ? lone[1]! : null
}

/** GitHub's own asset digests of a release (sha256), by asset name; {} when the API does not answer (rate limit). */
export async function githubDigests(url: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//.exec(url)
  if (!m) return {}
  const r = await fetchImpl(`https://api.github.com/repos/${m[1]}/releases/tags/${m[2]}`, { headers: { accept: 'application/vnd.github+json' } })
  if (!r.ok) return {}
  const j = (await r.json()) as { assets?: { name: string; digest?: string }[] }
  const out: Record<string, string> = {}
  for (const a of j.assets ?? []) if (a.digest?.startsWith('sha256:')) out[a.name] = a.digest.slice(7)
  return out
}

async function check(): Promise<boolean> {
  let ok = true
  const digestCache = new Map<string, Record<string, string>>()
  for (const [name, d] of Object.entries(LINUX_DOWNLOADS)) {
    const dir = path.join(REPO, 'dist', 'cache')
    const f = path.join(dir, name)
    if (!fs.existsSync(f)) {
      fs.mkdirSync(dir, { recursive: true })
      const res = await fetch(d.url, { redirect: 'follow' })
      if (!res.ok) { console.log(`FAIL ${name}: HTTP ${res.status}`); ok = false; continue }
      fs.writeFileSync(`${f}.part`, new Uint8Array(await res.arrayBuffer()))
      fs.renameSync(`${f}.part`, f)
    }
    const got = sha256File(f)
    const pub = await publishedSha256(name).catch((e) => `error: ${(e as Error).message}`)
    const rel = d.url.replace(/\/[^/]+$/, '/')
    if (!digestCache.has(rel)) digestCache.set(rel, await githubDigests(d.url).catch(() => ({})))
    const gh = digestCache.get(rel)![d.url.slice(d.url.lastIndexOf('/') + 1)] ?? null
    const pinned = d.sha256 === got
    const pubOk = pub === null || pub === got
    const ghOk = gh === null || gh === got
    if (!pinned || !pubOk || !ghOk) ok = false
    console.log(`${pinned && pubOk && ghOk ? 'ok  ' : 'FAIL'} ${name} ${got} pinned=${pinned} published=${pub ?? '(none)'} github=${gh ?? '(none)'}`)
  }
  return ok
}

if (import.meta.main) {
  if (!process.argv.includes('--check')) { console.error('usage: bun scripts/linux/downloads.ts --check   (fetch every pinned file, compare with the pins, the published checksums and GitHub digests)'); process.exit(2) }
  process.exit((await check()) ? 0 : 1)
}
