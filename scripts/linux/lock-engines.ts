// Pin the engine binaries a Linux install downloads (linux-runtime spec 3.6.2, D11): writes engines.lock.json, which
// the Linux bundle carries (signed with the bundle's manifest) and scripts/install-linux.sh checks every download
// against. The engines are never in the bundle (Claude Code is proprietary; we do not redistribute it).
//
//   bun scripts/linux/lock-engines.ts [--out scripts/linux/engines.lock.json] [--codex-models <models_cache.json>]
//
// The versions come from versions.json only ("claude-code", "codex-cli").
// - Claude Code: https://downloads.claude.ai/claude-code-releases/<v>/manifest.json is verified with gpg against its
//   manifest.json.sig and the release key kept in this repository (scripts/linux/keys/claude-code.asc, fingerprint
//   CLAUDE_KEY_FPR below, checked before use); the linux-x64 / linux-arm64 checksums and sizes are taken from it.
// - Codex: both codex-<cpu>-unknown-linux-musl.tar.gz of the GitHub release rust-v<v> are downloaded (dist/cache/),
//   hashed, and compared with GitHub's own asset digest.
// - The locked Codex model catalog (every model without a shell, scripts/macos/codex-catalog.mjs) is the bundle's
//   engines/codex-<v>.model_catalog.json, kept in scripts/linux/engines/. --codex-models makes it from a
//   models_cache.json that a Codex CLI of that version fetched (client_version must match); the account-bound fields
//   of the cache (identity, etag, fetched_at) are left out. Without --codex-models the file must already exist.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockCatalog } from '../macos/codex-catalog.mjs'

const REPO = path.resolve(import.meta.dir, '..', '..')
export const CLAUDE_KEY_FPR = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE'
export const CLAUDE_KEY_FILE = path.join(REPO, 'scripts', 'linux', 'keys', 'claude-code.asc')
export const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases'
export const DEFAULT_LOCK = path.join(REPO, 'scripts', 'linux', 'engines.lock.json')
export const ENGINES_DIR = path.join(REPO, 'scripts', 'linux', 'engines')

export type LinuxEngineArch = 'linux-amd64' | 'linux-arm64'
export interface EnginesLock {
  format: 1
  claude: { version: string } & Record<LinuxEngineArch, { url: string; sha256: string; size: number }>
  codex: { version: string; modelCatalog: string } & Record<LinuxEngineArch, { url: string; sha256: string; member: string; size: number }>
}

const SHA = /^[0-9a-f]{64}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/

/** "2.1.305" from versions.json's value (which may carry a note after the version). */
export function pinnedVersion(versions: Record<string, string>, key: 'claude-code' | 'codex-cli'): string {
  const v = (versions[key] ?? '').trim().split(/\s+/)[0] ?? ''
  if (!VERSION.test(v)) throw new Error(`versions.json "${key}" is not a plain version: ${versions[key]}`)
  return v
}

export const codexCatalogName = (v: string) => `engines/codex-${v}.model_catalog.json`
const CODEX_CPU: Record<LinuxEngineArch, string> = { 'linux-amd64': 'x86_64', 'linux-arm64': 'aarch64' }
const CLAUDE_PLATFORM: Record<LinuxEngineArch, string> = { 'linux-amd64': 'linux-x64', 'linux-arm64': 'linux-arm64' }

export function codexAsset(v: string, a: LinuxEngineArch): { url: string; file: string; member: string } {
  const file = `codex-${CODEX_CPU[a]}-unknown-linux-musl.tar.gz`
  return { url: `https://github.com/openai/codex/releases/download/rust-v${v}/${file}`, file, member: `codex-${CODEX_CPU[a]}-unknown-linux-musl` }
}

/** Checks the shape of an engines.lock.json (what the bundle carries and the installer trusts). */
export function checkEnginesLock(j: unknown, want?: { claude: string; codex: string }): EnginesLock {
  const l = j as EnginesLock
  if (!l || l.format !== 1 || !l.claude || !l.codex) throw new Error('engines.lock.json: not a format-1 lock')
  if (!VERSION.test(l.claude.version) || !VERSION.test(l.codex.version)) throw new Error('engines.lock.json: bad versions')
  if (want && (l.claude.version !== want.claude || l.codex.version !== want.codex)) {
    throw new Error(`engines.lock.json pins claude ${l.claude.version} / codex ${l.codex.version}, versions.json says ${want.claude} / ${want.codex}: run bun scripts/linux/lock-engines.ts`)
  }
  for (const a of ['linux-amd64', 'linux-arm64'] as const) {
    const c = l.claude[a], x = l.codex[a]
    if (!c || !SHA.test(c.sha256) || !(c.size > 0) || c.url !== `${CLAUDE_BASE}/${l.claude.version}/${CLAUDE_PLATFORM[a]}/claude`) throw new Error(`engines.lock.json: claude ${a} entry is wrong`)
    const want2 = codexAsset(l.codex.version, a)
    if (!x || !SHA.test(x.sha256) || x.url !== want2.url || x.member !== want2.member) throw new Error(`engines.lock.json: codex ${a} entry is wrong`)
  }
  if (l.codex.modelCatalog !== codexCatalogName(l.codex.version)) throw new Error('engines.lock.json: codex.modelCatalog is not the catalog of that version')
  return l
}

/** Every model of a locked catalog has the shell off (the same rule as server/src/engine/codex.ts catalogModels). */
export function checkLockedCatalog(j: any): string[] {
  if (!j || !Array.isArray(j.models) || !j.models.length) throw new Error('catalog: no models')
  for (const m of j.models) {
    if (m?.shell_type !== 'disabled' || m?.tool_mode !== 'direct' || (m?.apply_patch_tool_type ?? null) !== null) throw new Error(`catalog: model ${String(m?.slug)} is not locked`)
  }
  for (const k of ['identity', 'etag', 'fetched_at']) if (k in j) throw new Error(`catalog: account-bound field ${k} left in`)
  return j.models.map((m: any) => String(m.slug))
}

/** The locked catalog of a models_cache.json fetched by Codex `version`. */
export function catalogFromCache(cache: any, version: string): any {
  if (cache?.client_version !== version) throw new Error(`models cache is from Codex ${String(cache?.client_version)}, not ${version}`)
  return lockCatalog({ client_version: cache.client_version, models: cache.models })
}

async function mustFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, { redirect: 'follow', ...init })
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`)
  return r
}

function gpgVerify(manifest: Buffer, sig: Buffer): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-gpg-'))
  try {
    fs.chmodSync(home, 0o700)
    const gpg = (args: string[]) => Bun.spawnSync(['gpg', '--batch', '--no-tty', '--homedir', home, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const show = gpg(['--with-colons', '--show-keys', CLAUDE_KEY_FILE])
    if (show.exitCode !== 0) throw new Error(`gpg: ${show.stderr.toString().trim() || 'not installed?'}`)
    const fprs = show.stdout.toString().split('\n').filter((l) => l.startsWith('fpr:')).map((l) => l.split(':')[9])
    if (fprs[0] !== CLAUDE_KEY_FPR) throw new Error(`${CLAUDE_KEY_FILE} is not the pinned key ${CLAUDE_KEY_FPR} (it is ${fprs[0]})`)
    if (gpg(['--import', CLAUDE_KEY_FILE]).exitCode !== 0) throw new Error('gpg --import failed')
    fs.writeFileSync(path.join(home, 'manifest.json'), manifest)
    fs.writeFileSync(path.join(home, 'manifest.json.sig'), sig)
    const v = gpg(['--status-fd', '1', '--verify', path.join(home, 'manifest.json.sig'), path.join(home, 'manifest.json')])
    const valid = v.stdout.toString().split('\n').find((l) => l.startsWith('[GNUPG:] VALIDSIG '))
    const f = valid?.split(' ') ?? []
    // VALIDSIG <signing key fpr> ... <primary key fpr> (last field)
    if (v.exitCode !== 0 || !valid || (f[2] !== CLAUDE_KEY_FPR && f[f.length - 1] !== CLAUDE_KEY_FPR)) {
      throw new Error(`Claude Code manifest signature does not verify: ${v.stderr.toString().trim()}`)
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

export async function lockClaude(v: string): Promise<EnginesLock['claude']> {
  const base = `${CLAUDE_BASE}/${v}`
  const manifest = Buffer.from(await (await mustFetch(`${base}/manifest.json`)).arrayBuffer())
  const sig = Buffer.from(await (await mustFetch(`${base}/manifest.json.sig`)).arrayBuffer())
  gpgVerify(manifest, sig)
  const m = JSON.parse(manifest.toString('utf8')) as { version: string; platforms: Record<string, { binary: string; checksum: string; size: number }> }
  if (m.version !== v) throw new Error(`Claude Code manifest is for ${m.version}, not ${v}`)
  const out: any = { version: v }
  for (const a of ['linux-amd64', 'linux-arm64'] as const) {
    const p = m.platforms[CLAUDE_PLATFORM[a]]
    if (!p || p.binary !== 'claude' || !SHA.test(p.checksum) || !(p.size > 0)) throw new Error(`Claude Code manifest has no ${CLAUDE_PLATFORM[a]} entry`)
    out[a] = { url: `${base}/${CLAUDE_PLATFORM[a]}/claude`, sha256: p.checksum, size: p.size }
  }
  return out
}

export async function lockCodex(v: string): Promise<EnginesLock['codex']> {
  const rel = await (await mustFetch(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${v}`, { headers: { accept: 'application/vnd.github+json' } })).json() as { assets: { name: string; digest?: string; size: number }[] }
  const out: any = { version: v }
  for (const a of ['linux-amd64', 'linux-arm64'] as const) {
    const asset = codexAsset(v, a)
    const meta = rel.assets.find((x) => x.name === asset.file)
    const digest = meta?.digest?.startsWith('sha256:') ? meta.digest.slice(7) : null
    if (!meta || !digest) throw new Error(`GitHub release rust-v${v} has no digest for ${asset.file}`)
    const cache = path.join(REPO, 'dist', 'cache', `codex-${v}-${asset.file}`)
    if (!fs.existsSync(cache)) {
      fs.mkdirSync(path.dirname(cache), { recursive: true })
      console.log(`downloading ${asset.url}`)
      fs.writeFileSync(`${cache}.part`, new Uint8Array(await (await mustFetch(asset.url)).arrayBuffer()))
      fs.renameSync(`${cache}.part`, cache)
    }
    const got = crypto.createHash('sha256').update(fs.readFileSync(cache)).digest('hex')
    if (got !== digest) { fs.rmSync(cache); throw new Error(`${asset.file}: SHA-256 ${got}, GitHub says ${digest}`) }
    out[a] = { url: asset.url, sha256: got, member: asset.member, size: meta.size }
  }
  out.modelCatalog = codexCatalogName(v)
  return out
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

if (import.meta.main) {
  const versions = JSON.parse(fs.readFileSync(path.join(REPO, 'versions.json'), 'utf8'))
  const claudeV = pinnedVersion(versions, 'claude-code'), codexV = pinnedVersion(versions, 'codex-cli')
  const out = path.resolve(arg('--out') ?? DEFAULT_LOCK)
  const catalogFile = path.join(ENGINES_DIR, path.basename(codexCatalogName(codexV)))
  const modelsCache = arg('--codex-models')
  if (modelsCache) {
    const j = catalogFromCache(JSON.parse(fs.readFileSync(modelsCache, 'utf8')), codexV)
    fs.mkdirSync(ENGINES_DIR, { recursive: true })
    fs.writeFileSync(catalogFile, JSON.stringify(j, null, 1) + '\n')
    console.log(`wrote ${path.relative(REPO, catalogFile)}: ${checkLockedCatalog(j).join(', ')}`)
  }
  if (!fs.existsSync(catalogFile)) throw new Error(`${catalogFile} missing: pass --codex-models <models_cache.json of Codex ${codexV}>`)
  checkLockedCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')))
  const lock: EnginesLock = { format: 1, claude: await lockClaude(claudeV), codex: await lockCodex(codexV) }
  checkEnginesLock(lock, { claude: claudeV, codex: codexV })
  fs.writeFileSync(out, JSON.stringify(lock, null, 2) + '\n')
  console.log(`wrote ${path.relative(REPO, out)}: claude ${claudeV}, codex ${codexV}`)
}
