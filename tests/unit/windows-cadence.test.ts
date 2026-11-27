// The Windows installer only when the Windows app changed, at most about once a week; everything else every release
// (owner, 2026-11-26; docs/RELEASE-CI.md 11장, docs/decisions/20261126-windows-weekly.md,
// docs/decisions/20261126-windows-when-changed.md): the rule (scripts/release/windows-cadence.ts), what counts as the
// Windows app (scripts/release/windows-inputs.ts), the office feed that keeps the last Windows build on the other days
// (publish.ts --keep-windows) and what reads it, and release.yml's wiring.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileUrl, OFFICE_PRODUCT, publicKeyOf, signRelease, type OfficeRelease } from '../../server/src/office/release'
import { readIndex } from '../../server/src/office/update'
import { refreshWindowsApp } from '../../server/src/system/windows-app'
import { verifyInstaller } from '../../desktop/src/common/update-verify'
import { keptWindows, officeRelease, versionManifestAction } from '../../scripts/release/publish'
import {
  decideWindows, DEFAULT_MONTHLY_LIMIT, fetchSigned, main, peSigned, SIGNINGS_PER_RELEASE, SKIP_LINE_START, skipLine, windowsChange, windowsLineOf,
  type GhRelease, type WindowsContext,
} from '../../scripts/release/windows-cadence'
import { BRIDGE_FILES, bridgeVersions, changedBridges, changedParts, lockClosure, RAW_FILES, windowsFingerprint } from '../../scripts/release/windows-inputs'
import { BUNDLE_ENTRIES } from '../../desktop/build-entries'

const ROOT = path.resolve(import.meta.dir, '../..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-cadence-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')

/** a PE32 (or PE32+) header; `signed` sets the certificate table entry like signtool does */
function pe(o: { signed?: boolean; plus?: boolean; size?: number } = {}): Buffer {
  const b = Buffer.alloc(o.size ?? 4096)
  b.write('MZ', 0, 'latin1')
  const at = 0x80
  b.writeUInt32LE(at, 0x3c)
  b.write('PE\0\0', at, 'latin1')
  const opt = at + 24
  b.writeUInt16LE(o.plus ? 0x20b : 0x10b, opt)
  b.writeUInt32LE(16, opt + (o.plus ? 108 : 92))
  const dirs = opt + (o.plus ? 112 : 96)
  if (o.signed) { b.writeUInt32LE(0x1f000, dirs + 32); b.writeUInt32LE(0x2a00, dirs + 36) }
  return b
}

const DAY = 86_400_000
const NOW = new Date('2026-12-10T03:00:00Z') // 12:00 in Korea
const rel = (tag: string, daysAgo: number, o: { windows?: boolean; prerelease?: boolean; body?: string; draft?: boolean } = {}): GhRelease => ({
  tag_name: tag, prerelease: o.prerelease ?? tag.includes('-'), draft: o.draft ?? false, published_at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), body: o.body ?? '',
  assets: [
    { name: `TrinaAX-office-${tag.slice(1)}-mac.zip`, browser_download_url: `https://github.com/x/releases/download/${tag}/a.zip` },
    ...(o.windows === false ? [] : [{ name: `Trina-AX-Setup-${tag.slice(1)}-win-x64.exe`, browser_download_url: `https://github.com/x/releases/download/${tag}/Trina-AX-Setup-${tag.slice(1)}-win-x64.exe` }]),
  ],
})
const ctx = (releases: GhRelease[], over: Partial<WindowsContext> = {}): WindowsContext => ({ tag: 'v0.20.9', prerelease: false, line: null, releases, now: NOW, signing: false, ...over })

describe('the tag message line', () => {
  test('"Windows: yes" / "Windows: no" alone on a line (any case, CRLF) decides and leaves the notes', () => {
    expect(windowsLineOf('A fix.\n')).toEqual({ windows: null, notes: 'A fix.\n' })
    expect(windowsLineOf('Windows: yes\n\nA fix.\n')).toEqual({ windows: 'yes', notes: 'A fix.\n' })
    expect(windowsLineOf('A fix.\n\n  windows :  NO\r\n')).toEqual({ windows: 'no', notes: 'A fix.\n' })
    expect(windowsLineOf('Rollout: all\nWindows: yes\n\nA fix.')).toEqual({ windows: 'yes', notes: 'Rollout: all\n\nA fix.' })
  })
  test('anything else that mentions Windows is notes: release notes talk about Windows', () => {
    for (const n of ['- Windows: the tray icon is sharp again\n', 'Windows: yes please\n', '**Windows: yes**\n', '> Windows: no\n', '```\nWindows: yes\n```\n']) {
      expect(windowsLineOf(n), n).toEqual({ windows: null, notes: n })
    }
  })
  test('both lines stop the release', () => {
    expect(() => windowsLineOf('Windows: yes\nWindows: no\n')).toThrow(/both/)
  })
})

describe('is a Windows installer signed (its PE header only)', () => {
  test('the certificate table entry, PE32 and PE32+', () => {
    expect(peSigned(pe())).toBe(false)
    expect(peSigned(pe({ signed: true }))).toBe(true)
    expect(peSigned(pe({ plus: true }))).toBe(false)
    expect(peSigned(pe({ plus: true, signed: true }))).toBe(true)
  })
  test('not a PE file, or cut too short: null (cannot tell)', () => {
    expect(peSigned(Buffer.from('<html>504</html>'))).toBeNull()
    expect(peSigned(pe().subarray(0, 0x90))).toBeNull()
    expect(peSigned(Buffer.alloc(4096))).toBeNull()
  })
  test('from the release feed first (a Range request), then GitHub; a server that ignores Range is read only to 4 KiB', async () => {
    const seen: string[] = []
    const big = Buffer.concat([pe({ signed: true }), Buffer.alloc(1 << 20)])
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${new Headers(init?.headers).get('range')}`)
      if (url.startsWith('https://feed.test/')) return new Response('nf', { status: 404 })
      return new Response(new Uint8Array(big))
    }) as unknown as typeof fetch
    expect(await fetchSigned(rel('v0.20.1', 3), { fetch: f, feed: 'https://feed.test' })).toBe(true)
    expect(seen).toEqual([
      'https://feed.test/office/0.20.1/Trina-AX-Setup-0.20.1-win-x64.exe bytes=0-4095',
      'https://github.com/x/releases/download/v0.20.1/Trina-AX-Setup-0.20.1-win-x64.exe bytes=0-4095',
    ])
    const down = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchSigned(rel('v0.20.1', 3), { fetch: down, feed: 'https://feed.test' })).toBeNull()
    expect(await fetchSigned(rel('v0.20.1', 3, { windows: false }), { fetch: down })).toBeNull()
  })
})

describe('the rule', () => {
  test('7 calendar days (Korea) after the last release with the installer, not 7 x 24 hours', () => {
    const r = (d: number) => decideWindows(ctx([rel('v0.20.8', 1, { windows: false }), rel('v0.20.1', d)]))
    expect(r(6)).toMatchObject({ windows: false, last: 'v0.20.1' })
    expect(r(6).reason).toContain('6 day(s) old')
    expect(r(7)).toMatchObject({ windows: true, last: 'v0.20.1' })
    expect(r(12)).toMatchObject({ windows: true })
    // published at 23:00 in Korea seven days ago, tagged at 09:00 today: less than 7 x 24 hours, still the 7th day
    const late = rel('v0.20.1', 0)
    late.published_at = '2026-12-03T14:00:00Z'
    expect(decideWindows(ctx([late], { now: new Date('2026-12-10T00:00:00Z') })).windows).toBe(true)
  })
  test('no earlier release with the installer: ship it', () => {
    expect(decideWindows(ctx([]))).toMatchObject({ windows: true, last: null })
    expect(decideWindows(ctx([rel('v0.20.8', 1, { windows: false }), rel('v0.20.7', 1, { draft: true })]))).toMatchObject({ windows: true, last: null })
  })
  test('a stable tag counts stable releases only; a beta tag counts any (a stable release is also the beta channel\'s)', () => {
    const list = [rel('v0.21.0-beta.1', 1), rel('v0.20.1', 9)]
    expect(decideWindows(ctx(list))).toMatchObject({ windows: true, last: 'v0.20.1' })
    expect(decideWindows(ctx([rel('v0.20.5', 2), rel('v0.20.1', 9)], { tag: 'v0.21.0-beta.2', prerelease: true }))).toMatchObject({ windows: false, last: 'v0.20.5' })
    expect(decideWindows(ctx(list, { tag: 'v0.21.0-beta.2', prerelease: true }))).toMatchObject({ windows: false, last: 'v0.21.0-beta.1' })
  })
  test('"Windows: yes" ships it on any day, "Windows: no" skips it; the manual run\'s input wins over the tag message', () => {
    const list = [rel('v0.20.1', 2)]
    expect(decideWindows(ctx(list, { line: 'yes' }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx([rel('v0.20.1', 20)], { line: 'no' }))).toMatchObject({ windows: false, last: 'v0.20.1' })
    expect(decideWindows(ctx([], { line: 'no' }))).toMatchObject({ windows: false })
    expect(decideWindows(ctx(list, { line: 'no', input: 'yes' }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx(list, { line: 'yes', input: 'tag' }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx(list, { line: 'yes', input: '' }))).toMatchObject({ windows: true })
    expect(() => decideWindows(ctx(list, { input: 'maybe' }))).toThrow(/tag, yes or no/)
  })
  test('signing on: the first signed installer goes out at once when the last one is unsigned', () => {
    const list = [rel('v0.20.1', 2)]
    expect(decideWindows(ctx(list, { signing: true, signed: () => false }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx(list, { signing: true, signed: () => true }))).toMatchObject({ windows: false })
    expect(decideWindows(ctx(list, { signing: true, signed: () => null }))).toMatchObject({ windows: false })
    // signing off: the signature is never asked
    expect(decideWindows(ctx(list, { signed: () => { throw new Error('asked') } }))).toMatchObject({ windows: false })
  })
  test('the monthly signing plan: an automatic day skips with a warning, a forced one stops before anything is built', () => {
    expect(DEFAULT_MONTHLY_LIMIT).toBe(20)
    expect(SIGNINGS_PER_RELEASE).toBe(4)
    // four signed Windows releases in 30 days: 4 x 4 + 4 = 20, still inside
    const four = [rel('v0.20.4', 8), rel('v0.20.3', 15), rel('v0.20.2', 22), rel('v0.20.1', 29), rel('v0.19.0', 31)]
    expect(decideWindows(ctx(four, { signing: true, signed: () => true }))).toMatchObject({ windows: true })
    const five = [rel('v0.20.5', 7), ...four]
    const d = decideWindows(ctx(five, { signing: true, signed: () => true }))
    expect(d).toMatchObject({ windows: false, warn: true })
    expect(d.reason).toContain('24 times, over the plan\'s 20')
    expect(() => decideWindows(ctx(five, { signing: true, signed: () => true, line: 'yes' }))).toThrow(/Windows: yes.*over the plan's 20/)
    // unsigned ones (before signing) do not count; one we cannot read counts
    expect(decideWindows(ctx(five, { signing: true, signed: (r) => (r.tag_name === 'v0.20.5' ? false : true) }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx(five, { signing: true, signed: () => null }))).toMatchObject({ windows: false, warn: true })
    // a higher plan (WINDOWS_SIGNING_MONTHLY_LIMIT); signing off: no plan to count
    expect(decideWindows(ctx(five, { signing: true, signed: () => true, limit: 100 }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx(five))).toMatchObject({ windows: true })
    // "Windows: no" is never stopped by the plan
    expect(decideWindows(ctx(five, { signing: true, signed: () => true, line: 'no' }))).toMatchObject({ windows: false })
  })
  test('a run again of a published tag does what its first run did, and a forced choice against it stops', () => {
    const skipped = { ...rel('v0.20.9', 0, { windows: false }), body: `${skipLine('v0.20.1')}\n\nA fix.` }
    const list = [skipped, rel('v0.20.1', 20)]
    expect(decideWindows(ctx(list))).toMatchObject({ windows: false, last: 'v0.20.1' })
    expect(() => decideWindows(ctx(list, { input: 'yes' }))).toThrow(/first published without the Windows installer.*Tag a new version/)
    const shipped = [rel('v0.20.9', 0), rel('v0.20.1', 2)]
    expect(decideWindows(ctx(shipped))).toMatchObject({ windows: true })
    expect(() => decideWindows(ctx(shipped, { line: 'no' }))).toThrow(/first published with the Windows installer/)
    // its Windows build failed the first time ("not in this release yet"): it is built again
    const failed = [{ ...rel('v0.20.9', 0, { windows: false }), body: '**Downloads not in this release yet:** Windows (installer). …' }, rel('v0.20.1', 2)]
    expect(decideWindows(ctx(failed))).toMatchObject({ windows: true })
  })
  test('the same Windows app as the last Windows release: no installer, however old that one is', () => {
    const same = { parts: [], bridges: [] }
    for (const d of [1, 7, 40]) {
      const r = decideWindows(ctx([rel('v0.20.1', d)], { change: same }))
      expect(r, String(d)).toMatchObject({ windows: false, last: 'v0.20.1' })
      expect(r.reason).toContain('the same as v0.20.1')
      expect(r.warn).toBeUndefined()
    }
  })
  test('a changed Windows app ships from 7 days and names what changed; before that a later release sends it', () => {
    const changed = { parts: ['desktop/dist/main.cjs', 'desktop/package.json (without version)'], bridges: [] }
    const early = decideWindows(ctx([rel('v0.20.1', 3)], { change: changed }))
    expect(early).toMatchObject({ windows: false, last: 'v0.20.1' })
    expect(early.reason).toContain('changed since v0.20.1 (desktop/dist/main.cjs, desktop/package.json (without version)), but that installer is 3 day(s) old')
    const due = decideWindows(ctx([rel('v0.20.1', 7)], { change: changed }))
    expect(due).toMatchObject({ windows: true })
    expect(due.reason).toContain('and that installer is 7 days old')
    const many = decideWindows(ctx([rel('v0.20.1', 9)], { change: { parts: 'abcdefgh'.split(''), bridges: [] } }))
    expect(many.reason).toContain('a, b, c, d, e, f and 2 more')
  })
  test('a changed bridge version ships at once (old desks would be "too old" for the new server), within the plan', () => {
    const bridge = { parts: ['desktop/dist/main.cjs'], bridges: ['LOCAL_APPS_BRIDGE_VERSION 1 → 2'] }
    const r = decideWindows(ctx([rel('v0.20.1', 1)], { change: bridge }))
    expect(r).toMatchObject({ windows: true, last: 'v0.20.1' })
    expect(r.reason).toContain('LOCAL_APPS_BRIDGE_VERSION 1 → 2')
    // "Windows: no" and the monthly plan still win
    expect(decideWindows(ctx([rel('v0.20.1', 1)], { change: bridge, line: 'no' }))).toMatchObject({ windows: false })
    const five = [rel('v0.20.5', 1), rel('v0.20.4', 8), rel('v0.20.3', 15), rel('v0.20.2', 22), rel('v0.20.1', 29)]
    expect(decideWindows(ctx(five, { change: bridge, signing: true, signed: () => true }))).toMatchObject({ windows: false, warn: true })
  })
  test('"Windows: yes", no earlier installer, and an unsigned last one ship even when the app did not change', () => {
    const same = { parts: [], bridges: [] }
    expect(decideWindows(ctx([rel('v0.20.1', 1)], { change: same, line: 'yes' }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx([], { change: same }))).toMatchObject({ windows: true, last: null })
    expect(decideWindows(ctx([rel('v0.20.1', 1)], { change: same, signing: true, signed: () => false }))).toMatchObject({ windows: true })
    expect(decideWindows(ctx([rel('v0.20.1', 1)], { change: same, signing: true, signed: () => true }))).toMatchObject({ windows: false })
  })
  test('cannot tell whether it changed: the 7 days decide, with a warning', () => {
    const unknown = { unknown: 'no checkout of v0.20.1 to compare with' }
    expect(decideWindows(ctx([rel('v0.20.1', 3)], { change: unknown }))).toMatchObject({ windows: false, warn: true })
    const r = decideWindows(ctx([rel('v0.20.1', 8)], { change: unknown }))
    expect(r).toMatchObject({ windows: true, warn: true })
    expect(r.reason).toContain('(no checkout of v0.20.1 to compare with)')
  })
  test('a run again of a published tag ignores the comparison', () => {
    const skipped = { ...rel('v0.20.9', 0, { windows: false }), body: `${skipLine('v0.20.1')}\n\nA fix.` }
    expect(decideWindows(ctx([skipped, rel('v0.20.1', 20)], { change: { parts: ['x'], bridges: ['B 1 → 2'] } }))).toMatchObject({ windows: false })
    expect(decideWindows(ctx([rel('v0.20.9', 0), rel('v0.20.1', 2)], { change: { parts: [], bridges: [] } }))).toMatchObject({ windows: true })
  })
  test('the GitHub Release line is the one release.yml writes', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
    const bash = /winline="(.+)"$/m.exec(wf)?.[1]
    expect(bash).toBeDefined()
    const expand = (last: string) => bash!.replace(/\$\{WINDOWS_LAST:\+([^}]*)\}/, last ? '$1' : '').replace(/\$WINDOWS_LAST/g, last)
    expect(expand('v0.20.1')).toBe(skipLine('v0.20.1'))
    expect(expand('')).toBe(skipLine(null))
    expect(skipLine('v0.20.1').startsWith(SKIP_LINE_START)).toBe(true)
  })
})

describe('the command release.yml runs', () => {
  const files = (notes: string, releases: GhRelease[]) => {
    const dir = fs.mkdtempSync(path.join(T, 'cli-'))
    fs.writeFileSync(path.join(dir, 'notes.md'), notes)
    fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify(releases))
    return { dir, notes: path.join(dir, 'notes.md'), releases: path.join(dir, 'releases.json') }
  }
  const noFetch = (async () => { throw new Error('no network in this test') }) as unknown as typeof fetch
  test('prints the outputs, says why, takes the line out of the notes', async () => {
    const f = files('Windows: yes\n\nA fix.\n', [rel('v0.20.1', 2)])
    const out: string[] = [], err: string[] = []
    await main(['decide', '--tag', 'v0.20.9', '--notes', f.notes, '--releases', f.releases, '--input', '', '--signing', '', '--limit', ''], { out: (s) => out.push(s), err: (s) => err.push(s), fetch: noFetch, now: NOW })
    expect(out.join('')).toBe('windows=true\nwindows_last=v0.20.1\n')
    expect(err.join('')).toMatch(/^::notice::The Windows installer is in this release: the tag message says "Windows: yes"/)
    expect(fs.readFileSync(f.notes, 'utf8')).toBe('A fix.\n')
  })
  test('a skip day; the notes stay byte for byte without the line', async () => {
    const f = files('A fix.\r\n', [rel('v0.20.1', 2)])
    const out: string[] = [], err: string[] = []
    await main(['decide', '--tag', 'v0.20.9', '--notes', f.notes, '--releases', f.releases], { out: (s) => out.push(s), err: (s) => err.push(s), fetch: noFetch, now: NOW })
    expect(out.join('')).toBe('windows=false\nwindows_last=v0.20.1\n')
    // no checkout of v0.20.1 to compare with: the 7 days decide, with a warning
    expect(err.join('')).toStartWith('::warning::No Windows installer in this release: it cannot tell whether the Windows app changed since v0.20.1 (no checkout of v0.20.1')
    expect(fs.readFileSync(f.notes, 'utf8')).toBe('A fix.\r\n')
  })
  test('signing on: it reads the installers\' headers it needs (feed first) and a plan over the limit warns', async () => {
    const releases = [rel('v0.20.5', 7), rel('v0.20.4', 8), rel('v0.20.3', 15), rel('v0.20.2', 22), rel('v0.20.1', 29), rel('v0.10.0', 60)]
    const f = files('A fix.\n', releases)
    const asked: string[] = []
    const signedFetch = (async (url: string) => { asked.push(url); return new Response(new Uint8Array(pe({ signed: true }))) }) as unknown as typeof fetch
    const out: string[] = [], err: string[] = []
    await main(['decide', '--tag', 'v0.20.9', '--notes', f.notes, '--releases', f.releases, '--signing', 'sslcom', '--limit', '20'], { out: (s) => out.push(s), err: (s) => err.push(s), fetch: signedFetch, now: NOW })
    expect(out.join('')).toBe('windows=false\nwindows_last=v0.20.5\n')
    expect(err.join('')).toStartWith('::warning::No Windows installer in this release: 5 signed Windows release(s)')
    expect(asked.sort()).toEqual(['0.20.1', '0.20.2', '0.20.3', '0.20.4', '0.20.5'].map((v) => `https://updates.trina.app/office/${v}/Trina-AX-Setup-${v}-win-x64.exe`))
  })
  test('last: the tag release.yml checks out to compare with (empty when none or unreadable)', async () => {
    const f = files('x', [rel('v0.20.8', 1, { windows: false }), rel('v0.20.5', 4), rel('v0.21.0-beta.1', 1)])
    const run = async (tag: string, releases = f.releases) => { const out: string[] = []; await main(['last', '--tag', tag, '--releases', releases], { out: (s) => out.push(s) }); return out.join('') }
    expect(await run('v0.20.9')).toBe('tag=v0.20.5\n')
    expect(await run('v0.21.0-beta.2')).toBe('tag=v0.21.0-beta.1\n')
    expect(await run('v0.20.9', path.join(f.dir, 'none.json'))).toBe('tag=\n')
  })
  test('decide compares the checkout of exactly that tag; the same app is a skip day after 20 days', async () => {
    const f = files('A fix.\n', [rel('v0.20.1', 20)])
    const last = fs.mkdtempSync(path.join(T, 'last-'))
    fs.mkdirSync(path.join(last, 'desktop'))
    const seen: string[][] = []
    const compare = async (tree: string, lastTree: string) => { seen.push([tree, lastTree]); return { parts: [], bridges: [] } }
    const out: string[] = [], err: string[] = []
    await main(['decide', '--tag', 'v0.20.9', '--notes', f.notes, '--releases', f.releases, '--last-tree', last, '--last-tree-tag', 'v0.20.1'], { out: (s) => out.push(s), err: (s) => err.push(s), fetch: noFetch, now: NOW, compare })
    expect(out.join('')).toBe('windows=false\nwindows_last=v0.20.1\n')
    expect(err.join('')).toStartWith('::notice::No Windows installer in this release: the Windows app is the same as v0.20.1\'s')
    expect(seen).toEqual([[path.resolve('.'), last]])
    // a checkout of another tag is never compared: it cannot tell, the 7 days decide
    const out2: string[] = [], err2: string[] = []
    await main(['decide', '--tag', 'v0.20.9', '--notes', f.notes, '--releases', f.releases, '--last-tree', last, '--last-tree-tag', 'v0.19.0'], { out: (s) => out2.push(s), err: (s) => err2.push(s), fetch: noFetch, now: NOW, compare })
    expect(seen.length).toBe(1)
    expect(out2.join('')).toBe('windows=true\nwindows_last=v0.20.1\n')
    expect(err2.join('')).toContain('(no checkout of v0.20.1 to compare with (the one given is v0.19.0))')
  })
  test('bad arguments stop it', async () => {
    const f = files('x', [])
    await expect(main(['decide', '--tag', 'v1.0.0', '--notes', f.notes])).rejects.toThrow(/usage/)
    await expect(main(['decide', '--tag', 'v1.0.0', '--notes', f.notes, '--releases', f.releases, '--limit', 'lots'], { err: () => {}, out: () => {} })).rejects.toThrow(/--limit/)
  })
  test('releases that cannot be read (an API hiccup) leave Windows out with a warning, never stop the release', async () => {
    for (const body of ['{"message":"Bad credentials"}', '[{"tag_na', null]) {
      const f = files('Windows: yes\n\nA fix.\n', [])
      if (body === null) fs.rmSync(f.releases)
      else fs.writeFileSync(f.releases, body)
      const out: string[] = [], err: string[] = []
      const d = await main(['decide', '--tag', 'v1.0.0', '--notes', f.notes, '--releases', f.releases], { out: (s) => out.push(s), err: (s) => err.push(s), fetch: noFetch, now: NOW })
      expect(d.windows).toBe(false)
      expect(out.join('')).toBe('windows=false\nwindows_last=\n')
      expect(err.join('')).toStartWith('::warning::No Windows installer in this release: the GitHub Releases could not be read')
      expect(fs.readFileSync(f.notes, 'utf8')).toBe('A fix.\n')
    }
  })
})

describe('a release without its own Windows build keeps the last one on the office feed', () => {
  const FEED = 'http://127.0.0.1:45997'
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
  const KEYS = [publicKeyOf(pem)]
  const exe = Buffer.concat([pe(), crypto.randomBytes(60 * 1024)])
  // the NSIS header `teamax desktop add` looks for, on a 512-byte boundary
  const at = 20 * 512
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0xef, 0xbe, 0xad, 0xde]).copy(exe, at)
  exe.write('NullsoftInst', at + 8, 'latin1')
  exe.writeUInt32LE(200, at + 20)
  exe.writeUInt32LE(exe.length - at, at + 24)
  const name = 'Team-AX-Setup-0.20.1-win-x64.exe'
  const s512 = crypto.createHash('sha512').update(exe).digest('base64')
  const yml = `version: 0.20.1\nfiles:\n  - url: ${name}\n    sha512: ${s512}\n    size: ${exe.length}\npath: ${name}\nsha512: ${s512}\nreleaseDate: '2026-12-01T00:00:00.000Z'\n`
  const windows: NonNullable<OfficeRelease['windows']> = {
    version: '0.20.1',
    installer: { file: name, url: fileUrl(FEED, '0.20.1', name), sha256: sha(exe), size: exe.length },
    latestYml: { file: 'latest.yml', url: fileUrl(FEED, '0.20.1', 'latest.yml'), sha256: sha(yml), size: Buffer.byteLength(yml) },
  }
  const office = (v: string) => ({ file: `TeamAX-office-${v}-mac.zip`, url: fileUrl(FEED, v, `TeamAX-office-${v}-mac.zip`), sha256: sha(v), size: 3 })
  const head1 = signRelease(officeRelease({ channel: 'stable', version: '0.20.1', minFrom: '0.2.0-0', notes: '', office: office('0.20.1'), windows, rollout: 'all' }), pem)
  const ctxOf = (version: string) => ({ keys: KEYS, channel: 'stable' as const, feed: FEED, version, log: () => {} })

  test('keptWindows: the head\'s Windows app (its own version folder); none to keep stops the publish', () => {
    expect(keptWindows(head1, ctxOf('0.20.2'))).toEqual(windows)
    expect(() => keptWindows(null, ctxOf('0.20.2'))).toThrow(/no stable head.*Windows: yes/)
    const bare = signRelease(officeRelease({ channel: 'stable', version: '0.20.1', minFrom: '0.2.0-0', notes: '', office: office('0.20.1'), windows: null, rollout: 'all' }), pem)
    expect(() => keptWindows(bare, ctxOf('0.20.2'))).toThrow(/names no Windows app/)
    // a channel that is ahead (beta --if-newer): its Windows app is newer than this version, so none
    expect(keptWindows(head1, ctxOf('0.20.0'))).toBeNull()
    // signed by another key: not trusted
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    expect(() => keptWindows(head1, { ...ctxOf('0.20.2'), keys: [publicKeyOf(other)] })).toThrow()
  })

  test('a server on 0.20.2 offers the 0.20.1 installer, and the desks\' Windows app accepts it', async () => {
    const r2 = officeRelease({ channel: 'stable', version: '0.20.2', minFrom: '0.2.0-0', notes: '', office: office('0.20.2'), windows: keptWindows(head1, ctxOf('0.20.2')), rollout: 'all' })
    const head2 = signRelease(r2, pem)
    const files = new Map<string, Uint8Array | string>([
      [`${FEED}/office/stable.json`, head2], [`${FEED}/office/0.20.2/stable.json`, head2],
      [fileUrl(FEED, '0.20.1', name), exe], [fileUrl(FEED, '0.20.1', 'latest.yml'), yml],
    ])
    const data = fs.mkdtempSync(path.join(T, 'server-'))
    const fetch = async (url: string) => { const b = files.get(url.split('?')[0]!); return b === undefined ? new Response('nf', { status: 404 }) : new Response(typeof b === 'string' ? b : new Uint8Array(b)) }
    const statfs = () => ({ bsize: 4096, blocks: 10_000_000, bfree: 5_000_000, bavail: 5_000_000 })
    const res = await refreshWindowsApp({ dataDir: data, version: '0.20.2', channel: 'stable', feed: FEED, keys: KEYS, fetch, statfs })
    expect(res).toEqual({ kind: 'offered', version: '0.20.1', message: null })
    const downloads = path.join(data, 'downloads')
    expect(readIndex(downloads).map((i) => `${i.platform} ${i.file} ${i.version}`)).toEqual([`windows ${name} 0.20.1`])
    expect(fs.readFileSync(path.join(downloads, 'latest.yml'), 'utf8')).toBe(yml)
    // the desk's Windows app (0.20.0) downloads 0.20.1 from the team and checks it against the signed manifest next to it
    const manifest = fs.readFileSync(path.join(downloads, 'stable.json'), 'utf8')
    expect(manifest).toBe(head2)
    expect(verifyInstaller({ manifest, installerSha256: sha(exe), channel: 'stable', version: '0.20.1', current: '0.20.0', keys: KEYS, product: OFFICE_PRODUCT })).toMatchObject({ ok: true })
    // and the next day's release keeps it again
    expect(keptWindows(head2, ctxOf('0.20.3'))).toEqual(windows)
  })

  test('a version first published with the kept Windows app is never given another one by a re-run', () => {
    const kept = officeRelease({ channel: 'stable', version: '0.20.2', minFrom: '0.2.0-0', notes: '', office: office('0.20.2'), windows, rollout: 'all' })
    const own = { ...windows, version: '0.20.2' }
    const rebuilt = officeRelease({ channel: 'stable', version: '0.20.2', minFrom: '0.2.0-0', notes: '', office: office('0.20.2'), windows: own, rollout: 'all' })
    expect(() => versionManifestAction(signRelease(kept, pem), rebuilt, { keys: KEYS, feed: FEED })).toThrow(/publish a new version/)
    expect(versionManifestAction(signRelease(kept, pem), kept, { keys: KEYS, feed: FEED })).toBe('keep')
  })
})

describe('release.yml', () => {
  type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> }
  const text = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
  const wf = Bun.YAML.parse(text) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: unknown; options?: string[] }> } }
    jobs: Record<string, { if?: string; needs?: string[] | string; outputs?: Record<string, string>; env?: Record<string, string>; steps: Step[] }>
  }
  const step = (job: string, name: string) => wf.jobs[job]!.steps.find((s) => s.name === name)!

  test('prepare decides after the notes are made and before they are kept, from the releases and the signing variables', () => {
    expect(wf.on.workflow_dispatch.inputs.windows).toMatchObject({ type: 'choice', default: 'tag', options: ['tag', 'yes', 'no'] })
    const names = wf.jobs.prepare!.steps.map((s) => s.name ?? '')
    const decide = step('prepare', 'Does this release ship the Windows installer')
    expect(decide.id).toBe('windows')
    expect(names.indexOf('Does this release ship the Windows installer')).toBeGreaterThan(names.findIndex((n) => n.startsWith('Release notes')))
    expect(wf.jobs.prepare!.steps.findIndex((s) => s.name === 'Does this release ship the Windows installer')).toBeLessThan(wf.jobs.prepare!.steps.findIndex((s) => JSON.stringify(s).includes('release-notes')))
    expect(decide.env).toMatchObject({ INPUT_WINDOWS: '${{ inputs.windows }}', SIGNING: '${{ vars.WINDOWS_SIGNING_PROVIDER }}', LIMIT: '${{ vars.WINDOWS_SIGNING_MONTHLY_LIMIT }}' })
    expect(JSON.stringify(decide)).not.toContain('secrets.')
    expect(decide.run).toContain('bun scripts/release/windows-cadence.ts decide --tag "$TAG" --notes notes/notes.md')
    expect(decide.run).toContain('| tee -a "$GITHUB_OUTPUT"')
    expect(wf.jobs.prepare!.outputs).toMatchObject({ windows: '${{ steps.windows.outputs.windows }}', windows_last: '${{ steps.windows.outputs.windows_last }}' })
  })
  test('prepare checks out the last Windows release next to this one and compares the Windows apps', () => {
    const names = wf.jobs.prepare!.steps.map((s) => s.name ?? '')
    const prev = step('prepare', 'The last release with the Windows installer')
    const co = wf.jobs.prepare!.steps.find((s) => s.name === 'Check out the last Windows release') as Step & { uses?: string; with?: Record<string, unknown>; 'continue-on-error'?: boolean }
    const decide = step('prepare', 'Does this release ship the Windows installer')
    expect(names.indexOf(prev.name!)).toBeLessThan(names.indexOf(co.name!))
    expect(names.indexOf(co.name!)).toBeLessThan(names.indexOf(decide.name!))
    expect(prev.id).toBe('windows_prev')
    expect(prev.run).toContain('bun scripts/release/windows-cadence.ts last --tag "$TAG" --releases "$RUNNER_TEMP/releases.json" | tee -a "$GITHUB_OUTPUT"')
    expect(co.if).toBe("steps.windows_prev.outputs.tag != ''")
    expect(co['continue-on-error']).toBe(true)
    expect(co.uses).toStartWith('actions/checkout@')
    expect(co.with).toEqual({ ref: 'refs/tags/${{ steps.windows_prev.outputs.tag }}', path: '.windows-last', 'persist-credentials': false })
    expect(decide.env).toMatchObject({ LAST: '${{ steps.windows_prev.outputs.tag }}' })
    expect(decide.run).toContain('timeout 180 bun install --frozen-lockfile --ignore-scripts || echo')
    expect(decide.run).toContain('(cd .windows-last && timeout 180 bun install --frozen-lockfile --ignore-scripts)')
    expect(decide.run).toContain('tree=(--last-tree .windows-last --last-tree-tag "$LAST")')
    expect(decide.run).toContain('--limit "$LIMIT" "${tree[@]}" | tee -a "$GITHUB_OUTPUT"')
    expect(JSON.stringify([prev, co, decide])).not.toContain('secrets.')
  })
  test('build-windows runs only on a Windows day; the office feed then goes out with --keep-windows', () => {
    expect(wf.jobs['build-windows']!.if).toBe("${{ needs.prepare.outputs.windows == 'true' }}")
    const feed = step('publish', 'Office feed (zip + Windows installer)')
    expect(feed.if).toBe("needs.prepare.outputs.feed == 'true' && needs.build-office.result == 'success' && (needs.build-windows.result == 'success' || needs.prepare.outputs.windows != 'true')")
    expect(feed.run).toContain('if [ "$WINDOWS_PLANNED" = true ]; then win=(--windows "$(ls in/release-windows/*-Setup-*-win-x64.exe)"); else win=(--keep-windows); fi')
    const publishes = text.split('\n').filter((l) => /bun scripts\/release\/publish\.ts --channel/.test(l))
    expect(publishes.length).toBe(2)
    for (const l of publishes) { expect(l).toContain('"${win[@]}"'); expect(l).not.toContain('--windows') }
    expect(wf.jobs.publish!.env).toMatchObject({ WINDOWS_PLANNED: '${{ needs.prepare.outputs.windows }}' })
    // "not changed" is the exact opposite of the feed step's condition
    expect(step('publish', 'Office feed not changed').if).toBe(`needs.prepare.outputs.feed == 'true' && !(${feed.if!.replace("needs.prepare.outputs.feed == 'true' && ", '')})`)
    expect(step('publish', 'The published Linux files (office_only)').run).toContain('{ [ "$WINDOWS_PLANNED" = true ] && [ "$WINDOWS_OK" != true ]; }')
  })
  test('the GitHub Release: Windows is not a missing download on a skip day, and the skip line goes first in the notes', () => {
    const gh = step('github-release', 'Create the release (or add the files to it on a re-run)').run!
    expect(wf.jobs['github-release']!.env).toMatchObject({ WINDOWS_PLANNED: '${{ needs.prepare.outputs.windows }}', WINDOWS_LAST: '${{ needs.prepare.outputs.windows_last }}' })
    expect(gh).toContain('if [ "$WINDOWS_OK" != true ] && [ "$WINDOWS_PLANNED" = true ]; then missing+=("Windows (installer)"); fi')
    expect(gh).toContain('{ [ "$WINDOWS_OK" = true ] || [ "$WINDOWS_PLANNED" != true ]; }')
    expect(gh.indexOf('winline=')).toBeLessThan(gh.indexOf('missing[@]} -gt 0'))
    // GitHub's generated notes only when the tag message had none (not because of the line)
    expect(gh.indexOf('if [ ! -s notes/notes.md ]; then generate=true; fi')).toBeLessThan(gh.indexOf('winline='))
  })
})

describe('what counts as the Windows app (scripts/release/windows-inputs.ts)', () => {
  /** a tiny repository: only what the fingerprint reads; entries left out count as "missing" */
  const tree = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(T, 'tree-'))
    const all: Record<string, string> = {
      'bun.lock': '{\n  "lockfileVersion": 1,\n  "packages": {\n    "electron": ["electron@44.7.2", "", { "dependencies": { "@electron/get": "^5.0.0" } }, "sha512-a"],\n    "@electron/get": ["@electron/get@5.0.0", "", {}, "sha512-b"],\n    "zod": ["zod@4.6.7", "", {}, "sha512-c"],\n  },\n}\n',
      'desktop/package.json': JSON.stringify({ name: '@mycel/desktop', version: '0.20.1', devDependencies: { electron: '44.7.2' } }),
      'desktop/src/main/main.ts': 'const greeting = "hello"\nconsole.log(greeting)\n',
      ...files,
    }
    for (const [f, text] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
    return dir
  }
  test('code: a change of what runs counts; a comment, a version bump or another lockfile entry does not', async () => {
    const base = await windowsFingerprint(tree({}))
    expect(base['desktop/dist/main.cjs']).not.toBe('missing')
    expect(base['desktop/dist/preload-app.cjs']).toBe('missing')
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/src/main/main.ts': '// a comment\nconst greeting = "hello"\n\nconsole.log(greeting)\n' })))).toEqual([])
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/package.json': JSON.stringify({ name: '@mycel/desktop', version: '0.20.2', devDependencies: { electron: '44.7.2' } }) })))).toEqual([])
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/src/main/main.ts': 'console.log("hi")\n' })))).toEqual(['desktop/dist/main.cjs'])
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/package.json': JSON.stringify({ name: '@mycel/desktop', version: '0.20.1', devDependencies: { electron: '44.7.3' } }) })))).toEqual(['desktop/package.json (without version)'])
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/build-resources/icon.ico': 'ico' })))).toEqual(['desktop/build-resources/icon.ico'])
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/build-resources/mac-infoplist/ko.strings': 'x', 'desktop/build-resources/background.png': 'x' })))).toEqual([])
    expect(changedParts(base, await windowsFingerprint(tree({ '.github/workflows/release.yml': 'env:\n  BUN_VERSION: 1.3.13\n' })))).toEqual(['Bun version (release.yml)'])
    expect(changedParts(base, await windowsFingerprint(tree({ 'desktop/build-resources/installer.nsh': '!macro customUnInstall\n!macroend\n' })))).toEqual(['desktop/build-resources/installer.nsh'])
  })
  test('bun.lock: only what Electron and electron-builder pull in', () => {
    const lock = { packages: {
      electron: ['electron@1', '', { dependencies: { a: '^1' } }, 's'], a: ['a@1', '', { dependencies: { b: '1' }, optionalDependencies: { c: '1' } }, 's'],
      b: ['b@1', '', {}, 's'], 'a/b': ['b@2', '', {}, 's'], c: ['c@1', '', {}, 's'], 'electron-builder': ['electron-builder@1', '', {}, 's'], zod: ['zod@4', '', {}, 's'],
    } }
    expect(Object.keys(lockClosure(lock, ['electron', 'electron-builder']))).toEqual(['a', 'a/b', 'c', 'electron', 'electron-builder'])
  })
  test('bridge versions: what the pages check against the app (the Mac-only voice input is not a Windows one)', () => {
    const now = bridgeVersions(ROOT)
    expect(Object.keys(now).sort()).toEqual(['BROWSER_BRIDGE_VERSION', 'DESKTOP_BRIDGE_VERSION', 'GOOGLE_SIGNIN_BRIDGE_VERSION', 'LOCAL_APPS_BRIDGE_VERSION', 'WORK_FILES_BRIDGE_VERSION', 'WORK_FILES_WIDE_VERSION'])
    expect(changedBridges(now, now)).toEqual([])
    expect(changedBridges({ ...now, LOCAL_APPS_BRIDGE_VERSION: 0 }, now)).toEqual([`LOCAL_APPS_BRIDGE_VERSION 0 → ${now.LOCAL_APPS_BRIDGE_VERSION}`])
    const { GOOGLE_SIGNIN_BRIDGE_VERSION: _, ...before } = now
    expect(changedBridges(before, now)).toEqual([`GOOGLE_SIGNIN_BRIDGE_VERSION none → ${now.GOOGLE_SIGNIN_BRIDGE_VERSION}`])
    // every bridge version shared/ exports is read: a new one in another file would be missed
    const exported = fs.readdirSync(path.join(ROOT, 'shared/src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /^export const [A-Z0-9_]+_(BRIDGE_VERSION|WIDE_VERSION) = \d/m.test(fs.readFileSync(path.join(ROOT, 'shared/src', f), 'utf8'))).map((f) => `shared/src/${f}`)
    expect(exported.sort()).toEqual([...BRIDGE_FILES].sort())
  })
  test('this repository: every part builds, and the same twice', () => {
    // its own process, as release.yml runs it (Bun 1.3's bundler cannot read files this test process has loaded)
    const run = () => {
      const p = Bun.spawnSync([process.execPath, path.join(ROOT, 'scripts/release/windows-inputs.ts'), ROOT], { stderr: 'pipe' })
      expect(p.exitCode, p.stderr.toString()).toBe(0)
      return JSON.parse(p.stdout.toString()) as { parts: Record<string, string>; bridges: Record<string, number> }
    }
    const a = run()
    expect(Object.entries(a.parts).filter(([, v]) => v === 'missing')).toEqual([])
    expect(Object.keys(a.parts)).toEqual(expect.arrayContaining([...BUNDLE_ENTRIES.map(([, out]) => `desktop/dist/${out}`), 'desktop/electron-builder.config.ts', ...RAW_FILES]))
    expect(a.bridges).toEqual(bridgeVersions(ROOT))
    expect(changedParts(a.parts, run().parts)).toEqual([])
  }, 60_000)
  test('a tree that cannot be built: it cannot tell', async () => {
    expect(await windowsChange(path.join(T, 'no-such-tree'), path.join(T, 'no-such-tree'))).toMatchObject({ unknown: expect.stringContaining('could not be built') })
  })
  test('desktop/build.ts builds from the same list, and electron-builder reads no Windows file the fingerprint leaves out', async () => {
    const build = fs.readFileSync(path.join(ROOT, 'desktop/build.ts'), 'utf8')
    expect(build).toContain("from './build-entries'")
    expect(build).toContain('BUNDLE_ENTRIES.map(')
    expect(build).not.toMatch(/one\('src\//)
    const config = (await import('../../desktop/electron-builder.config')).default as Record<string, unknown>
    // the keys a Windows build reads; the Mac's, the dmg's and Linux's are not in the Windows app
    const forWindows = Object.keys(config).filter((k) => !['mac', 'dmg', 'linux', 'deb', 'appImage', 'toolsets'].includes(k))
    expect(forWindows.sort()).toEqual(['appId', 'asar', 'copyright', 'directories', 'electronFuses', 'extraMetadata', 'files', 'nsis', 'productName', 'protocols', 'publish', 'win'].sort())
    // every file a Windows key names (under desktop/ or build-resources/) is fingerprinted
    const named: string[] = []
    const walk = (v: unknown) => {
      if (typeof v === 'string') {
        for (const f of [path.join('desktop', v), path.join('desktop/build-resources', v)]) if (fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile()) named.push(f)
      } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
    }
    for (const k of forWindows) walk(config[k])
    expect(named.filter((f) => f !== 'desktop/package.json' && !(RAW_FILES as readonly string[]).includes(f))).toEqual([])
    expect(named).toContain('desktop/build-resources/installer.nsh')
  })
})
