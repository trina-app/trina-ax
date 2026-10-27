// Linux release bundle (linux-runtime spec 3.6.1, 3.6.2; task L19): the pure parts of scripts/build-bundle.ts --os linux,
// the pinned downloads (scripts/linux/downloads.ts), the engine pins (scripts/linux/engines.lock.json via
// lock-engines.ts), the locked Codex catalog and deps.txt. The bundle itself is built on a Linux runner (CI
// linux-bundle job); nothing here downloads.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { assertLinuxHost, elfArch, kitName, LINUX_ROOT_NATIVE, LINUX_ROOT_SCRIPTS, linuxBundleFiles, parseBundleArgs, SERVER_KIT, whisperFiles } from '../../scripts/build-bundle'
import { downloadFor, LINUX_DOWNLOADS, parseChecksums, unzipMember } from '../../scripts/linux/downloads'
import { catalogFromCache, checkEnginesLock, checkLockedCatalog, codexAsset, codexCatalogName, pinnedVersion } from '../../scripts/linux/lock-engines'
import { ortPlatformDir } from '../../scripts/vendor-semantic'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'versions.json'), 'utf8')) as Record<string, string>

describe('build-bundle.ts arguments', () => {
  test('--os defaults to this computer; darwin keeps its flags', () => {
    expect(parseBundleArgs([], 'darwin').os).toBe('darwin')
    expect(parseBundleArgs([], 'linux').os).toBe('linux')
    const d = parseBundleArgs(['--version', '0.2.1', '--out', 'x', '--arch', 'universal', '--sign-key', 'k.pem', '--notes', 'n.md'], 'darwin')
    expect(d).toEqual({ os: 'darwin', version: '0.2.1', out: 'x', arch: 'universal', signKey: 'k.pem', notes: 'n.md', whisperDir: null, noWhisper: false, strict: false })
    const l = parseBundleArgs(['--os', 'linux', '--whisper-dir', 'w', '--strict'], 'darwin')
    expect([l.os, l.whisperDir, l.strict, l.noWhisper]).toEqual(['linux', 'w', true, false])
  })
  test('bad combinations are refused', () => {
    expect(() => parseBundleArgs(['--os', 'windows'])).toThrow(/--os/)
    expect(() => parseBundleArgs(['--os', 'darwin', '--no-whisper'])).toThrow(/linux/)
    expect(() => parseBundleArgs(['--os', 'linux', '--no-whisper', '--whisper-dir', 'w'])).toThrow(/not both/)
    expect(() => parseBundleArgs(['--os', 'linux', '--version'])).toThrow(/needs a value/)
    expect(() => parseBundleArgs(['--os', 'linux', '--out', '--strict'])).toThrow(/needs a value/)
  })
  test('a Linux bundle only on Linux of the same arch', () => {
    expect(assertLinuxHost('arm64', 'linux', 'arm64')).toBe('arm64')
    expect(assertLinuxHost('amd64', 'linux', 'amd64')).toBe('amd64')
    expect(() => assertLinuxHost('arm64', 'darwin', 'arm64')).toThrow(/same architecture/)
    expect(() => assertLinuxHost('amd64', 'linux', 'arm64')).toThrow(/same architecture/)
    expect(() => assertLinuxHost('universal', 'linux', 'arm64')).toThrow(/amd64 or arm64/)
  })
  test('the version folder file list (spec 3.6.1)', () => {
    const files = linuxBundleFiles({ arch: 'amd64', codexVersion: '0.163.0', whisper: true, systemd: ['launcher.service.in'] })
    for (const f of ['bin/bun', 'bin/rg', 'bin/pandoc', 'bin/typst', 'bin/whisper-cli', 'bin/whisper-cli-v2', 'native/mycel-gate', 'native/mycel-bridge', 'native/mycel-ocr',
      'server/src/main.js', 'server/src/admin.js', 'server/src/account.js', 'root/mycel-bootstrap', 'root/mycel-launcher', 'root/mycel-sandbox', 'root/mycel-ctl',
      'root/mycel-account', 'root/set-claude-token', 'root/safe-fs.sh', 'root/apparmor-bwrap.in', 'root/systemd/launcher.service.in', 'engines.lock.json',
      'engines/codex-0.163.0.model_catalog.json', 'deps.txt']) expect(files).toContain(f)
    expect(linuxBundleFiles({ arch: 'arm64', codexVersion: '0.163.0', whisper: true, systemd: [] })).not.toContain('bin/whisper-cli-v2')
    expect(linuxBundleFiles({ arch: 'arm64', codexVersion: '0.163.0', whisper: false, systemd: [] }).some((f) => f.includes('whisper'))).toBe(false)
    expect(whisperFiles('amd64')).toEqual(['whisper-cli', 'whisper-cli-v2'])
    // the root programs are never in native/ (the server account must not get them from an update)
    for (const n of LINUX_ROOT_NATIVE) expect(files).not.toContain(`native/${n}`)
    expect(LINUX_ROOT_SCRIPTS.map(([s]) => s).every((s) => s.startsWith('scripts/'))).toBe(true)
  })
  test('the kit name comes from the product, not a literal', () => {
    expect(SERVER_KIT.endsWith('-server')).toBe(true)
    expect(kitName('0.3.0', 'arm64')).toBe(`${SERVER_KIT}-0.3.0-linux-arm64`)
  })
  test('ELF arch check', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-elf-'))
    const h = (machine: number) => { const b = Buffer.alloc(64); b.writeUInt32BE(0x7f454c46, 0); b[4] = 2; b[5] = 1; b.writeUInt16LE(machine, 18); return b }
    fs.writeFileSync(path.join(d, 'a'), h(0xb7)); fs.writeFileSync(path.join(d, 'x'), h(0x3e)); fs.writeFileSync(path.join(d, 's'), '#!/bin/sh\n')
    expect([elfArch(path.join(d, 'a')), elfArch(path.join(d, 'x')), elfArch(path.join(d, 's'))]).toEqual(['arm64', 'amd64', null])
    fs.rmSync(d, { recursive: true, force: true })
  })
  test('onnxruntime-node platform folder per target', () => {
    expect(ortPlatformDir({ os: 'darwin', arch: 'arm64' })).toEqual(['darwin', 'arm64'])
    expect(ortPlatformDir({ os: 'linux', arch: 'amd64' })).toEqual(['linux', 'x64'])
    expect(ortPlatformDir({ os: 'linux', arch: 'arm64' })).toEqual(['linux', 'arm64'])
  })
})

describe('pinned downloads (scripts/linux/downloads.ts)', () => {
  test('every entry is pinned, https, and one per tool and arch', () => {
    for (const [name, d] of Object.entries(LINUX_DOWNLOADS)) {
      expect(d.url).toMatch(/^https:\/\/github\.com\//)
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
      if (d.tool !== 'whisper.cpp') { expect(d.member).toBeTruthy(); expect(d.member!.endsWith(`/${d.tool}`)).toBe(true) }
      expect(name).not.toContain('/')
    }
    for (const arch of ['amd64', 'arm64'] as const) for (const t of ['bun', 'rg', 'pandoc', 'typst'] as const) expect(LINUX_DOWNLOADS[downloadFor(t, arch)]!.arch).toBe(arch)
  })
  test('the versions are the ones in versions.json', () => {
    const urls = Object.values(LINUX_DOWNLOADS).map((d) => d.url)
    const want: [string, string][] = [['bun', `bun-v${versions.bun}/`], ['ripgrep', `/${versions.ripgrep}/`], ['pandoc', `/${versions.pandoc}/`], ['typst', `/v${versions.typst}/`], ['whisper.cpp', `/v${versions['whisper.cpp']!.split(' ')[0]}.tar.gz`]]
    for (const [tool, part] of want) expect({ tool, found: urls.some((u) => u.includes(part)) }).toEqual({ tool, found: true })
  })
  test('amd64 bun is the baseline build (tenant CPUs are x86-64-v2, no AVX2 promise)', () => {
    expect(downloadFor('bun', 'amd64')).toBe('bun-linux-x64-baseline.zip')
  })
  test('checksum files', () => {
    const sums = 'aa'.repeat(32) + '  bun-linux-aarch64.zip\n' + 'bb'.repeat(32) + ' *other.zip\n'
    expect(parseChecksums(sums, 'bun-linux-aarch64.zip')).toBe('aa'.repeat(32))
    expect(parseChecksums(sums, 'other.zip')).toBe('bb'.repeat(32))
    expect(parseChecksums('cc'.repeat(32) + '  ripgrep.tar.gz\n', 'ripgrep.tar.gz')).toBe('cc'.repeat(32))
    expect(parseChecksums(sums, 'missing.zip')).toBe(null)
  })
  test('unzip (no unzip on a stock Debian): stored and deflated members', () => {
    const zip = makeZip([['bun-linux-aarch64/bun', Buffer.from('ELF-BUN'.repeat(100)), true], ['bun-linux-aarch64/README', Buffer.from('r'), false]])
    expect(Buffer.from(unzipMember(zip, 'bun-linux-aarch64/bun')).toString()).toBe('ELF-BUN'.repeat(100))
    expect(Buffer.from(unzipMember(zip, 'README')).toString()).toBe('r')
    expect(Buffer.from(unzipMember(zip, 'bun')).toString()).toBe('ELF-BUN'.repeat(100)) // a path ending, by whole components
    expect(() => unzipMember(zip, 'un')).toThrow(/not found/)
    expect(() => unzipMember(Buffer.from('not a zip at all, definitely'), 'x')).toThrow(/not a zip/)
  })
})

describe('engine pins (scripts/linux/engines.lock.json)', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'linux', 'engines.lock.json'), 'utf8'))
  const want = { claude: pinnedVersion(versions, 'claude-code'), codex: pinnedVersion(versions, 'codex-cli') }
  test('matches versions.json and has both Linux arches', () => {
    const l = checkEnginesLock(lock, want)
    expect(l.claude['linux-arm64'].url).toBe(`https://downloads.claude.ai/claude-code-releases/${want.claude}/linux-arm64/claude`)
    const a = codexAsset(want.codex, 'linux-amd64')
    expect(l.codex['linux-amd64']).toMatchObject({ url: a.url, member: a.member })
    expect(l.codex.modelCatalog).toBe(codexCatalogName(want.codex))
  })
  test('a lock for other versions or with a changed address is refused', () => {
    expect(() => checkEnginesLock(lock, { ...want, claude: '9.9.9' })).toThrow(/run bun scripts\/linux\/lock-engines/)
    const bad = structuredClone(lock); bad.claude['linux-amd64'].url = 'https://evil.example/claude'
    expect(() => checkEnginesLock(bad)).toThrow(/claude linux-amd64/)
    const bad2 = structuredClone(lock); bad2.codex['linux-arm64'].sha256 = 'x'
    expect(() => checkEnginesLock(bad2)).toThrow(/codex linux-arm64/)
    expect(() => checkEnginesLock({ format: 2 })).toThrow(/format-1/)
  })
  test('pinned versions are plain versions', () => {
    expect(pinnedVersion({ 'claude-code': '2.1.305' }, 'claude-code')).toBe('2.1.305')
    expect(pinnedVersion({ 'codex-cli': '0.163.0 (note)' }, 'codex-cli')).toBe('0.163.0')
    expect(() => pinnedVersion({ 'codex-cli': 'latest' }, 'codex-cli')).toThrow()
  })
})

describe('locked Codex catalog', () => {
  test('the bundled catalog has the shell off for every model and no account fields', () => {
    const file = path.join(ROOT, 'scripts', 'linux', codexCatalogName(pinnedVersion(versions, 'codex-cli')))
    const slugs = checkLockedCatalog(JSON.parse(fs.readFileSync(file, 'utf8')))
    expect(slugs.length).toBeGreaterThan(0)
  })
  test('made from a models cache of the same Codex version only, without identity / etag / fetched_at', () => {
    const cache = { fetched_at: 'x', etag: 'W/"1"', identity: 'abc', client_version: '0.163.0', models: [{ slug: 'gpt-x', shell_type: 'unified_exec', tool_mode: 'code_mode_only' }] }
    const j = catalogFromCache(cache, '0.163.0')
    expect(Object.keys(j).sort()).toEqual(['client_version', 'models'])
    expect(checkLockedCatalog(j)).toEqual(['gpt-x'])
    expect(() => catalogFromCache(cache, '0.164.0')).toThrow(/not 0.164.0/)
    expect(() => checkLockedCatalog({ models: [{ slug: 'a', shell_type: 'unified_exec', tool_mode: 'direct' }] })).toThrow(/not locked/)
    expect(() => checkLockedCatalog({ identity: 'x', models: [{ slug: 'a', shell_type: 'disabled', tool_mode: 'direct' }] })).toThrow(/identity/)
  })
})

test('deps.txt: lines scripts/install-linux.sh can read ("package" or "package>=version")', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'linux', 'deps.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').replace(/\s+/g, '')).filter(Boolean)
  expect(lines.length).toBeGreaterThan(5)
  for (const l of lines) expect(l).toMatch(/^([a-z0-9][a-z0-9.+-]*)(>=([0-9][0-9A-Za-z.+:~-]*))?$/)
  for (const p of ['bubblewrap>=0.8.0', 'nftables>=1.0.6', 'tesseract-ocr-kor>=1:4.1.0']) expect(lines).toContain(p)
})

/** A minimal zip: [name, data, deflate?] entries. */
function makeZip(entries: [string, Buffer, boolean][]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let off = 0
  for (const [name, data, deflate] of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data
    const n = Buffer.from(name)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42)
    locals.push(lh, n, body); centrals.push(ch, n)
    off += 30 + n.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}
