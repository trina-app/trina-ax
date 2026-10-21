// Desktop app installers offered under Settings → Apps: `teamax desktop add|list|remove|add-from` (installer checks,
// copy with safe modes, index.json replaced atomically, newest per platform), office-install.sh finding installers
// next to the bundle, and /downloads/* (signed-in people only, Range / resume, types, no caching by Cloudflare).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { desktopCommand, downloadsDir } from '../../server/src/office/cli'
import {
  addInstaller, compareVersions, findInstallers, inspectInstaller, listInstallers, readIndex, removeInstaller, versionFromName,
} from '../../server/src/office/desktop'
import { serveDownload } from '../../server/src/routes/downloads'
import { desktopInstallers } from '../../scripts/build-office'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'office-desktop')
const REPO = path.resolve(import.meta.dir, '..', '..')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const mode = (f: string) => fs.statSync(f).mode & 0o777
const noSign = () => false

/** A minimal PE32 file with the NSIS first header on a 512-byte boundary (what electron-builder's NSIS makes), and
 * optionally an Authenticode certificate table. */
function fakeExe(o: { nsis?: boolean; signed?: boolean; size?: number } = {}): Buffer {
  const size = o.size ?? 64 * 1024
  const b = Buffer.alloc(size, 0x11)
  b.write('MZ', 0, 'latin1')
  const pe = 0x80
  b.writeUInt32LE(pe, 0x3c)
  b.write('PE\0\0', pe, 'latin1')
  b.writeUInt16LE(0x10b, pe + 24) // PE32 optional header
  const dirs = pe + 24 + 96
  for (let i = 0; i < 16 * 8; i++) b[dirs + i] = 0
  if (o.nsis !== false) {
    const at = 20 * 512
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0xef, 0xbe, 0xad, 0xde]).copy(b, at)
    b.write('NullsoftInst', at + 8, 'latin1')
  }
  if (o.signed) {
    const off = size - 1024
    b.writeUInt32LE(off, dirs + 4 * 8)
    b.writeUInt32LE(1024, dirs + 4 * 8 + 4)
    b.writeUInt32LE(1024, off) // dwLength
    b.writeUInt16LE(0x0200, off + 4) // wRevision
    b.writeUInt16LE(0x0002, off + 6) // WIN_CERT_TYPE_PKCS_SIGNED_DATA
  }
  return b
}
function fakeDmg(size = 48 * 1024): Buffer {
  const b = Buffer.alloc(size, 0x22)
  b.write('koly', size - 512, 'latin1')
  return b
}
function put(dir: string, name: string, data: Buffer | string): string {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, name)
  fs.writeFileSync(f, data)
  return f
}

describe('installer checks and versions', () => {
  const D = path.join(BASE, 'inspect')
  test('a Windows NSIS installer and a Mac disk image pass; signatures are read, not assumed', () => {
    expect(inspectInstaller(put(D, 'a.exe', fakeExe()))).toEqual({ platform: 'windows', signed: false, kind: 'nsis' })
    expect(inspectInstaller(put(D, 'b.exe', fakeExe({ signed: true })))).toEqual({ platform: 'windows', signed: true, kind: 'nsis' })
    expect(inspectInstaller(put(D, 'c.dmg', fakeDmg()), { codesign: noSign })).toEqual({ platform: 'mac', signed: false, kind: 'udif' })
    expect(inspectInstaller(put(D, 'd.dmg', fakeDmg()), { codesign: () => true }).signed).toBe(true)
    // the real codesign on macOS: a made-up image is not signed
    expect(inspectInstaller(put(D, 'e.dmg', fakeDmg())).signed).toBe(false)
  })
  test('anything else is refused with the reason', () => {
    expect(() => inspectInstaller(put(D, 'x.exe', fakeExe({ nsis: false })))).toThrow(/not an NSIS installer/)
    expect(() => inspectInstaller(put(D, 'y.exe', Buffer.alloc(8192, 0x41)))).toThrow(/no MZ header/)
    const noPe = fakeExe(); noPe.write('XX', 0x80, 'latin1')
    expect(() => inspectInstaller(put(D, 'z.exe', noPe))).toThrow(/no PE header/)
    expect(() => inspectInstaller(put(D, 'w.dmg', Buffer.alloc(8192, 1)))).toThrow(/not a Mac disk image/)
    expect(() => inspectInstaller(put(D, 'v.zip', fakeDmg()))).toThrow(/only Windows .exe and Mac .dmg/)
    expect(() => inspectInstaller(put(D, 'tiny.exe', 'MZ'))).toThrow(/too small/)
  })
  test('version from the file name; semver order', () => {
    expect(versionFromName('Team-AX-Setup-0.1.0-x64.exe')).toBe('0.1.0')
    expect(versionFromName('Team-AX-Setup-0.1.0-win-x64.exe')).toBe('0.1.0')
    expect(versionFromName('Team-AX-1.2.10-mac-universal.dmg')).toBe('1.2.10')
    expect(versionFromName('Team-AX-1.3.0-beta.2-mac-universal.dmg')).toBe('1.3.0-beta.2')
    expect(versionFromName('/x/9.9.9/Team-AX-Setup.exe')).toBeNull()
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
})

describe('teamax desktop add / list / remove', () => {
  const home = path.join(BASE, 'home')
  const dir = downloadsDir(home)
  const src = path.join(BASE, 'src')

  test('add: copied with mode 600 into a 700 folder, listed in index.json (platform, version, size, signed, sha256)', () => {
    const exe = put(src, 'Team-AX-Setup-0.1.0-x64.exe', fakeExe())
    const r = addInstaller(dir, exe, { codesign: noSign })
    expect(r.unchanged).toBe(false)
    expect(r.item).toMatchObject({ platform: 'windows', file: 'Team-AX-Setup-0.1.0-x64.exe', version: '0.1.0', size: 64 * 1024, signed: false })
    expect(r.item.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mode(dir)).toBe(0o700)
    expect(mode(path.join(dir, 'Team-AX-Setup-0.1.0-x64.exe'))).toBe(0o600)
    expect(mode(path.join(dir, 'index.json'))).toBe(0o600)
    expect(readIndex(dir)).toEqual([r.item])
    // a copy, never a link to the owner's Downloads
    expect(fs.lstatSync(path.join(dir, 'Team-AX-Setup-0.1.0-x64.exe')).isSymbolicLink()).toBe(false)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([])
  })

  test('the same file again changes nothing; a newer version replaces the older one (file removed too)', () => {
    const again = addInstaller(dir, path.join(src, 'Team-AX-Setup-0.1.0-x64.exe'), { codesign: noSign })
    expect(again.unchanged).toBe(true)
    const newer = addInstaller(dir, put(src, 'Team-AX-Setup-0.2.0-x64.exe', fakeExe({ size: 70 * 1024 })), { codesign: noSign })
    expect(newer.removed).toEqual(['Team-AX-Setup-0.1.0-x64.exe'])
    expect(fs.existsSync(path.join(dir, 'Team-AX-Setup-0.1.0-x64.exe'))).toBe(false)
    expect(readIndex(dir).map((i) => i.file)).toEqual(['Team-AX-Setup-0.2.0-x64.exe'])
  })

  test('an older one is refused while a newer one is offered, unless --keep (then both are listed)', () => {
    const old = put(src, 'Team-AX-Setup-0.1.5-x64.exe', fakeExe())
    expect(() => addInstaller(dir, old, { codesign: noSign })).toThrow(/a newer Windows app is already offered/)
    addInstaller(dir, old, { keep: true, codesign: noSign })
    expect(readIndex(dir).map((i) => i.version)).toEqual(['0.2.0', '0.1.5'])
    expect(removeInstaller(dir, 'Team-AX-Setup-0.1.5-x64.exe')).toBe(true)
    expect(removeInstaller(dir, 'Team-AX-Setup-0.1.5-x64.exe')).toBe(false)
  })

  test('platforms are independent; Windows is listed first; --version and an unsafe name', () => {
    addInstaller(dir, put(src, 'Team-AX-0.2.0-mac-universal.dmg', fakeDmg()), { codesign: noSign })
    expect(readIndex(dir).map((i) => i.platform)).toEqual(['windows', 'mac'])
    expect(() => addInstaller(dir, put(src, 'installer.dmg', fakeDmg()), { codesign: noSign })).toThrow(/pass --version/)
    const odd = addInstaller(dir, put(src, '팀 AX 맥.dmg', fakeDmg()), { version: '0.3.0', codesign: noSign })
    expect(odd.item.file).toBe('Team-AX-0.3.0-mac.dmg')
    expect(() => addInstaller(dir, put(src, 'Team-AX-Setup-1.0-x64.exe', fakeExe()), { version: '1.0; rm', codesign: noSign })).toThrow(/is not like 1.2.3/)
    expect(() => removeInstaller(dir, '../app.db')).toThrow(/not a file name/)
  })

  test('list names stray files; the command prints a line per installer and refuses bad usage', () => {
    fs.writeFileSync(path.join(dir, 'Leftover-1.0.0.exe'), 'x')
    expect(listInstallers(dir).stray).toEqual(['Leftover-1.0.0.exe'])
    const lines: string[] = []
    expect(desktopCommand(home, ['--home', home, 'list'], (s) => lines.push(s))).toBe(0)
    expect(lines.join('\n')).toContain('Windows  0.2.0')
    expect(lines.join('\n')).toContain('Team-AX-0.3.0-mac.dmg')
    expect(lines.join('\n')).toContain('Leftover-1.0.0.exe')
    expect(desktopCommand(home, ['add'], () => {})).toBe(2)
    expect(desktopCommand(home, ['bogus'], () => {})).toBe(2)
    const out: string[] = []
    expect(desktopCommand(home, ['--home', home, 'remove', 'Team-AX-0.3.0-mac.dmg'], (s) => out.push(s))).toBe(0)
    expect(out[0]).toContain('removed: Team-AX-0.3.0-mac.dmg')
  })

  test('add-from: the newest Team AX installer per platform in the folders, other files ignored', () => {
    const a = path.join(BASE, 'from-a'), b = path.join(BASE, 'from-b')
    put(a, 'Team-AX-Setup-0.1.0-x64.exe', fakeExe())
    put(b, 'Team-AX-Setup-0.4.0-x64.exe', fakeExe())
    put(b, 'Team-AX-Setup-0.4.0-win-arm64.exe', fakeExe())
    put(a, 'Team-AX-0.4.0-mac-universal.dmg', fakeDmg())
    put(a, 'Team-AX-설치가이드.pdf', 'pdf')
    put(b, 'Other-Setup-9.0.0-x64.exe', fakeExe())
    const found = findInstallers([a, b, path.join(BASE, 'missing')])
    expect(found.map((f) => path.basename(f.file)).sort()).toEqual(['Team-AX-0.4.0-mac-universal.dmg', 'Team-AX-Setup-0.4.0-x64.exe'])
    const dry: string[] = []
    expect(desktopCommand(home, ['--home', home, 'add-from', '--dry-run', a, b], (s) => dry.push(s))).toBe(0)
    expect(dry.join('\n')).toContain('would add')
    expect(readIndex(dir).some((i) => i.version === '0.4.0')).toBe(false)
    const out: string[] = []
    expect(desktopCommand(home, ['--home', home, 'add-from', a, b], (s) => out.push(s))).toBe(0)
    expect(readIndex(dir).map((i) => `${i.platform} ${i.version}`)).toEqual(['windows 0.4.0', 'mac 0.4.0'])
    expect(out.join('\n')).toContain('Settings → Apps')
  })
})

describe('build-office.ts --desktop-prebuilt / --with-desktop', () => {
  test('the release files are checked and copied next to the zip under the names office-install.sh looks for', () => {
    const release = path.join(BASE, 'release'), out = path.join(BASE, 'dist-office')
    put(release, 'Team-AX-Setup-0.7.0-win-x64.exe', fakeExe())
    put(release, 'Team-AX-0.7.0-mac-universal.dmg', fakeDmg())
    const r = desktopInstallers({ out, build: false, release, version: '0.7.0' })
    expect(r.map((x) => path.basename(x.file))).toEqual(['Team-AX-Setup-0.7.0-x64.exe', 'Team-AX-0.7.0-mac-universal.dmg'])
    expect(findInstallers([out]).map((f) => f.version)).toEqual(['0.7.0', '0.7.0'])
    fs.writeFileSync(path.join(release, 'Team-AX-Setup-0.7.0-win-x64.exe'), Buffer.alloc(8192, 1))
    expect(() => desktopInstallers({ out, build: false, release, version: '0.7.0' })).toThrow(/no MZ header/)
    expect(() => desktopInstallers({ out, build: false, release, version: '0.8.0' })).toThrow(/missing/)
  })
})

describe('office-install.sh finds the installers next to the bundle', () => {
  test('check-only says which installer it would offer', () => {
    const top = path.join(BASE, 'unzipped')
    const B = path.join(top, 'TeamAX-office-9.9.9')
    fs.mkdirSync(path.join(B, 'app', 'bin', 'darwin-arm64'), { recursive: true })
    fs.mkdirSync(path.join(B, 'app', 'server', 'src'), { recursive: true })
    fs.writeFileSync(path.join(B, 'app', 'VERSION'), '9.9.9\n')
    fs.symlinkSync(process.execPath, path.join(B, 'app', 'bin', 'darwin-arm64', 'bun'))
    fs.writeFileSync(path.join(B, 'app', 'server', 'src', 'office.js'), `const { main } = await import(${JSON.stringify(path.join(REPO, 'server', 'src', 'office', 'cli.ts'))}); process.exit(await main(process.argv.slice(2)))\n`)
    fs.copyFileSync(path.join(REPO, 'scripts', 'office', 'office-install.sh'), path.join(B, 'office-install.sh'))
    put(top, 'Team-AX-Setup-0.1.0-x64.exe', fakeExe())
    const claude = path.join(BASE, 'claude')
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1 $2" = "auth status" ] && echo '{ "loggedIn": true }'\nexit 0\n`, { mode: 0o755 })
    const prefix = path.join(BASE, 'inst')
    const p = Bun.spawnSync(['bash', path.join(B, 'office-install.sh'), '--prefix', prefix, '--lan-port', '18453', '--app-port', '18440', '--run-dir', '/tmp/tx-od', '--check-only'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(BASE, 'fakehome'), TEAMAX_TEST_UNAME: 'Darwin', TEAMAX_TEST_OSVERSION: '15.1', TEAMAX_TEST_ARCH: 'arm64', TEAMAX_CLAUDE_BIN: claude },
    })
    const out = p.stdout.toString() + p.stderr.toString()
    expect(p.exitCode).toBe(0)
    expect(out).toContain(`would add: ${path.join(top, 'Team-AX-Setup-0.1.0-x64.exe')} (Windows 0.1.0)`)
    expect(fs.existsSync(prefix)).toBe(false)
    const skip = Bun.spawnSync(['bash', path.join(B, 'office-install.sh'), '--prefix', prefix, '--lan-port', '18453', '--app-port', '18440', '--run-dir', '/tmp/tx-od', '--check-only', '--no-desktop'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(BASE, 'fakehome'), TEAMAX_TEST_UNAME: 'Darwin', TEAMAX_TEST_OSVERSION: '15.1', TEAMAX_TEST_ARCH: 'arm64', TEAMAX_CLAUDE_BIN: claude },
    })
    expect(skip.stdout.toString()).not.toContain('would add')
  })
})

describe('/downloads/*: signed-in people only, resumable, never cached by Cloudflare', () => {
  let h: Harness
  let owner: Client
  const exe = fakeExe({ size: 3 * 1024 * 1024 + 123 })
  beforeAll(async () => {
    h = await harness('office-desktop-dl')
    owner = await withOwner(h)
    const src = put(path.join(BASE, 'dl-src'), 'Team-AX-Setup-0.1.0-x64.exe', exe)
    addInstaller(path.join(h.ctx.config.dataDir, 'downloads'), src, { codesign: noSign })
    addInstaller(path.join(h.ctx.config.dataDir, 'downloads'), put(path.join(BASE, 'dl-src'), 'Team-AX-0.1.0-mac-universal.dmg', fakeDmg()), { codesign: noSign })
  })
  afterAll(() => h.close())

  test('without a session: 401 for the list and the installer (no data, nothing cacheable)', async () => {
    for (const p of ['/downloads/index.json', '/downloads/Team-AX-Setup-0.1.0-x64.exe']) {
      const r = await h.fetch(p)
      expect(r.status, p).toBe(401)
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.text()).not.toContain('Team-AX-Setup')
    }
    // a made-up or expired cookie is no better
    expect((await h.fetch('/downloads/index.json', { headers: { cookie: 'mycel-dev-sid=bogus' } })).status).toBe(401)
  })

  test('signed in: the list and the installer with type, attachment name, length; private so no shared cache keeps it', async () => {
    const idx = await owner.raw('GET', '/downloads/index.json')
    expect(idx.status).toBe(200)
    expect(idx.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const items = ((await idx.json()) as { items: { platform: string; file: string }[] }).items
    expect(items.map((i) => i.platform)).toEqual(['windows', 'mac'])
    const r = await owner.raw('GET', '/downloads/Team-AX-Setup-0.1.0-x64.exe')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/vnd.microsoft.portable-executable')
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="Team-AX-Setup-0.1.0-x64.exe"; filename*=UTF-8''Team-AX-Setup-0.1.0-x64.exe`)
    expect(r.headers.get('content-length')).toBe(String(exe.length))
    expect(r.headers.get('cache-control')).toBe('private, no-cache')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(Buffer.from(await r.arrayBuffer()).equals(exe)).toBe(true)
    const dmg = await owner.raw('GET', '/downloads/Team-AX-0.1.0-mac-universal.dmg')
    expect(dmg.headers.get('content-type')).toBe('application/x-apple-diskimage')
    await dmg.arrayBuffer()
  })

  test('resume: bytes=N- sends exactly the rest; a bounded range, If-Range, 416, HEAD', async () => {
    const f = '/downloads/Team-AX-Setup-0.1.0-x64.exe'
    const first = await owner.raw('GET', f)
    const etag = first.headers.get('etag')!
    await first.arrayBuffer()
    const start = 1_000_001
    const rest = await owner.raw('GET', f, undefined, { range: `bytes=${start}-`, 'if-range': etag })
    expect(rest.status).toBe(206)
    expect(rest.headers.get('content-range')).toBe(`bytes ${start}-${exe.length - 1}/${exe.length}`)
    expect(rest.headers.get('content-length')).toBe(String(exe.length - start))
    expect(Buffer.from(await rest.arrayBuffer()).equals(exe.subarray(start))).toBe(true)
    const mid = await owner.raw('GET', f, undefined, { range: 'bytes=100-199' })
    expect(mid.status).toBe(206)
    expect(Buffer.from(await mid.arrayBuffer()).equals(exe.subarray(100, 200))).toBe(true)
    const last = await owner.raw('GET', f, undefined, { range: 'bytes=-10' })
    expect(Buffer.from(await last.arrayBuffer()).equals(exe.subarray(exe.length - 10))).toBe(true)
    // the file changed since the partial copy: the whole new file
    const changed = await owner.raw('GET', f, undefined, { range: `bytes=${start}-`, 'if-range': '"other"' })
    expect(changed.status).toBe(200)
    expect((await changed.arrayBuffer()).byteLength).toBe(exe.length)
    const bad = await owner.raw('GET', f, undefined, { range: `bytes=${exe.length + 5}-` })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe(`bytes */${exe.length}`)
    const head = await owner.raw('HEAD', f)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(exe.length))
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  test('a member with a temporary password is asked to change it first; then it works; bearer apps too', async () => {
    const r = await owner.call('POST', '/api/admin/users', { username: 'tina', name: 'Tina', role: 'member', groupIds: [] })
    const fresh = h.client()
    await fresh.login('tina', r.temporaryPassword)
    expect((await fresh.raw('GET', '/downloads/index.json')).status).toBe(403)
    const m = await addMember(h, owner, { username: 'mona' })
    expect((await m.client.raw('GET', '/downloads/index.json')).status).toBe(200)
    const app = h.client()
    await app.login('mona', m.password, 'bearer')
    app.cookie = null
    expect((await app.raw('GET', '/downloads/index.json')).status).toBe(200)
  })

  test('no way out of the folder, no dotfiles (a copy in progress), nothing outside it', async () => {
    fs.writeFileSync(path.join(h.ctx.config.dataDir, 'downloads', '.Team-AX-Setup-0.2.0-x64.exe.tmp-1'), 'partial')
    for (const p of ['/downloads/..%2fapp.db', '/downloads/.Team-AX-Setup-0.2.0-x64.exe.tmp-1', '/downloads/missing.exe', '/downloads/', '/downloads/a/../../app.db']) {
      const res = await owner.raw('GET', p)
      expect(await res.text(), p).not.toContain('SQLite')
      if (!p.includes('/../')) expect(res.status, p).toBe(404)
    }
    // the URL parser folds %2e%2e away before routing: that is the app shell at /app.db, never the database
    expect(await (await owner.raw('GET', '/downloads/%2e%2e/app.db')).text()).not.toContain('SQLite')
    expect(serveDownload(new Request('http://x/downloads/a.exe'), '/a.exe', null).status).toBe(404)
  })

  test('through a real socket (the Cloudflare tunnel connects like this): whole file and resume end exactly', async () => {
    let port = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req): Response | Promise<Response> => h.app.fetch(req, { ip: '127.0.0.1', via: 'direct', port }) })
    port = server.port!
    try {
      const base = `http://127.0.0.1:${server.port}`
      const hdr = { cookie: owner.cookie!, host: `team.localhost` }
      // allowedHosts is empty in this config: any Host is answered
      const whole = await fetch(`${base}/downloads/Team-AX-Setup-0.1.0-x64.exe`, { headers: hdr })
      expect(Buffer.from(await whole.arrayBuffer()).equals(exe)).toBe(true)
      const rest = await fetch(`${base}/downloads/Team-AX-Setup-0.1.0-x64.exe`, { headers: { ...hdr, range: 'bytes=2000000-' } })
      expect(rest.status).toBe(206)
      expect(Buffer.from(await rest.arrayBuffer()).equals(exe.subarray(2_000_000))).toBe(true)
      expect((await fetch(`${base}/downloads/Team-AX-Setup-0.1.0-x64.exe`)).status).toBe(401)
    } finally { server.stop(true) }
  })
})
