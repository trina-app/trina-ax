// "Find work files on this computer" in the desktop app (docs/DECISIONS.md "Find work files on this computer";
// desktop/src/common/work-files.ts): the look through Documents, Desktop and Downloads (names, sizes and dates only,
// never a link, one folder after the other, the limits) and the reads afterwards (only ids of the latest look of that
// origin, for an hour, at most 100 files and 1 GB, the same file found again without a link on the way). A made-up file
// system only: nothing of this computer is read.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inOneDrive, scanRoots, WorkFileSessions, type WorkDirent, type WorkFs, type WorkRoot, type WorkStat } from '../../desktop/src/common/work-files'

type Node = { kind: 'dir'; children: Record<string, Node> } | { kind: 'file'; size: number; mtimeMs: number; ino: bigint; bytes?: Uint8Array } | { kind: 'link'; to: string }
let ino = 100n
const file = (size = 1000, mtimeMs = Date.UTC(2026, 9, 3)): Node => ({ kind: 'file', size, mtimeMs, ino: ino++ })
const dir = (children: Record<string, Node> = {}): Node => ({ kind: 'dir', children })
const link = (to: string): Node => ({ kind: 'link', to })

/** A made-up posix file system rooted at `/`. `calls` records every call, so a test can tell nothing was opened. */
function fakeFs(tree: Record<string, Node>, o: { platform?: string; denied?: Set<string>; dirLinks?: boolean } = {}) {
  const root = dir(tree)
  const calls: string[] = []
  const parts = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean)
  const at = (p: string, follow: boolean, depth = 0): Node | null => {
    let cur: Node = root
    const ps = parts(p)
    for (let i = 0; i < ps.length; i++) {
      if (cur.kind === 'link') cur = at(cur.to, true, depth + 1) ?? dir()
      if (cur.kind !== 'dir') return null
      const next: Node | undefined = cur.children[ps[i]!]
      if (!next) return null
      cur = next
      if (cur.kind === 'link' && (follow || i < ps.length - 1)) {
        if (depth > 20) return null
        const target = at(cur.to, true, depth + 1)
        if (!target) return null
        cur = target
      }
    }
    return cur
  }
  const real = (p: string, depth = 0): string => {
    const ps = parts(p)
    let out = ''
    let cur: Node = root
    for (let i = 0; i < ps.length; i++) {
      if (cur.kind !== 'dir') throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
      const next: Node | undefined = cur.children[ps[i]!]
      if (!next) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (next.kind === 'link') {
        if (depth > 20) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
        out = real(next.to, depth + 1)
        cur = at(out, true) ?? dir()
      } else {
        out = `${out}/${ps[i]}`
        cur = next
      }
    }
    return out || '/'
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const statOf = (n: Node): WorkStat => n.kind === 'file' ? { kind: 'file', size: n.size, mtimeMs: n.mtimeMs, dev: 1n, ino: n.ino } : { kind: n.kind === 'dir' ? 'dir' : 'link', size: 0, mtimeMs: 0, dev: 1n, ino: 1n }
  const fs: WorkFs = {
    async readdir(p, max) {
      p = p.replace(/\\/g, '/')
      calls.push(`readdir ${p}`)
      if ([...(o.denied ?? [])].some((d) => p === d || p.startsWith(d + '/'))) throw err('EPERM')
      const n = at(p, true)
      if (!n) throw err('ENOENT')
      if (n.kind !== 'dir') throw err('ENOTDIR')
      return Object.entries(n.children).slice(0, max).map(([name, c]): WorkDirent => ({ name, kind: c.kind === 'link' ? 'link' : c.kind }))
    },
    async lstat(p) {
      calls.push(`lstat ${p}`)
      const n = at(p, false)
      if (!n) throw err('ENOENT')
      return statOf(n)
    },
    async realpath(p) {
      calls.push(`realpath ${p}`)
      return real(p)
    },
    async open(p) {
      calls.push(`open ${p}`)
      const n = at(p, false)
      if (!n) throw err('ENOENT')
      if (n.kind === 'link') throw err('ELOOP')
      if (n.kind !== 'file') throw err('EISDIR')
      return {
        stat: async () => statOf(n),
        read: async (size: number) => (n.bytes ?? new Uint8Array(n.size).fill(7)).subarray(0, size),
        close: async () => {},
      }
    },
  }
  return { fs, calls, root, at }
}

const ROOTS: WorkRoot[] = [
  { id: 'documents', path: '/Users/alex/Documents', oneDrive: false },
  { id: 'desktop', path: '/Users/alex/Desktop', oneDrive: false },
  { id: 'downloads', path: '/Users/alex/Downloads', oneDrive: false },
]
let n = 0
const opts = (over: Partial<Parameters<typeof scanRoots>[2]> = {}) => ({ platform: 'darwin', newId: () => `id${n++}`, ...over })
const home = (children: Record<string, Node>) => ({ Users: dir({ alex: dir(children) }) })

describe('the look through Documents, Desktop and Downloads', () => {
  test('documents only, by name, size and date; never listed names; nothing is opened', async () => {
    const f = fakeFs(home({
      Documents: dir({
        'Quote template.xlsx': file(2000),
        'notes.txt': file(10),
        'photo.png': file(),
        '.secret.md': file(),
        '~$Quote template.xlsx': file(),
        '.DS_Store': file(),
        node_modules: dir({ 'readme.md': file() }),
        Library: dir({ 'a.pdf': file() }),
        'Thing.app': dir({ 'b.pdf': file() }),
        Brand: dir({ 'logo.png': file(), 'Screenshot 2026-11-01.png': file() }),
        Clients: dir({ Northwind: dir({ 'proposal.pptx': file(5000) }) }),
      }),
      Desktop: dir({ 'Weekly report.docx': file() }),
      Downloads: dir({ 'setup.dmg': file(), 'invoice.pdf': file() }),
    }))
    const r = await scanRoots(ROOTS, f.fs, opts())
    const names = r.files.map((x) => `${x.root}:${x.folder ? x.folder + '/' : ''}${x.name}`).sort()
    expect(names).toEqual(['desktop:Weekly report.docx', 'documents:Brand/logo.png', 'documents:Clients/Northwind/proposal.pptx', 'documents:Quote template.xlsx', 'documents:notes.txt', 'downloads:invoice.pdf'])
    const quote = r.files.find((x) => x.name === 'Quote template.xlsx')!
    expect(quote).toMatchObject({ root: 'documents', folder: '', ext: 'xlsx', size: 2000 })
    // the page gets no path of the computer
    expect(JSON.stringify(r.files)).not.toContain('/Users/alex')
    expect(r.roots.map((x) => [x.id, x.state])).toEqual([['documents', 'ok'], ['desktop', 'ok'], ['downloads', 'ok']])
    expect(f.calls.filter((c) => c.startsWith('open'))).toEqual([])
  })

  test('one folder after the other: Desktop is read only after Documents is done (macOS asks for each in turn)', async () => {
    const f = fakeFs(home({ Documents: dir({ a: dir({ 'x.pdf': file() }) }), Desktop: dir({ 'y.pdf': file() }), Downloads: dir() }))
    await scanRoots(ROOTS, f.fs, opts())
    const reads = f.calls.filter((c) => c.startsWith('readdir')).map((c) => c.slice(8))
    expect(reads).toEqual(['/Users/alex/Documents', '/Users/alex/Documents/a', '/Users/alex/Desktop', '/Users/alex/Downloads'])
  })

  test('a link or junction is never entered or listed (a link to home, to a secret, to a document)', async () => {
    const f = fakeFs({
      ...home({ Documents: dir({ 'to-home': link('/Users/alex'), 'secret.pdf': link('/Users/alex/.aws/credentials.pdf'), 'real.pdf': file() }), Desktop: dir(), Downloads: dir() }),
    })
    ;(f.root as { children: Record<string, Node> }).children.Users!.kind === 'dir' && Object.assign((f.at('/Users/alex', true) as { children: Record<string, Node> }).children, { '.aws': dir({ 'credentials.pdf': file() }) })
    const r = await scanRoots(ROOTS, f.fs, opts())
    expect(r.files.map((x) => x.name)).toEqual(['real.pdf'])
    expect(f.calls.some((c) => c.includes('to-home'))).toBe(false)
  })

  test('Windows lists every reparse point as a link: lstat tells a OneDrive online-only file from a real link or junction', async () => {
    // Windows paths through the posix fake: what matters is which entries are asked about and listed
    const f = fakeFs(home({ Documents: dir({ 'cloud.docx': file(), 'junction': link('/Users/alex'), sub: dir({ 'b.pdf': file() }) }), Desktop: dir(), Downloads: dir() }))
    const fs: WorkFs = { ...f.fs, readdir: async (p, max) => (await f.fs.readdir(p, max)).map((d) => (d.name === 'cloud.docx' ? { ...d, kind: 'link' } : d)) }
    const r = await scanRoots(ROOTS, fs, opts({ platform: 'win32' }))
    expect(r.files.map((x) => x.name).sort()).toEqual(['b.pdf', 'cloud.docx'])
  })

  test('macOS privacy (EPERM) marks that folder blocked and the look goes on; a missing folder is missing', async () => {
    const f = fakeFs(home({ Documents: dir({ 'a.pdf': file() }), Desktop: dir({ 'b.pdf': file() }) }), { denied: new Set(['/Users/alex/Desktop']) })
    const r = await scanRoots(ROOTS, f.fs, opts())
    expect(r.roots.map((x) => [x.id, x.state])).toEqual([['documents', 'ok'], ['desktop', 'blocked'], ['downloads', 'missing']])
    expect(r.files.map((x) => x.name)).toEqual(['a.pdf'])
    // the same error on Windows is no macOS privacy: unreadable
    const w = await scanRoots(ROOTS, f.fs, opts({ platform: 'win32' }))
    expect(w.roots[1]!.state).toBe('unreadable')
  })

  test('every folder denied: three lines, no file', async () => {
    const f = fakeFs(home({ Documents: dir({ 'a.pdf': file() }), Desktop: dir(), Downloads: dir() }), { denied: new Set(['/Users/alex']) })
    const r = await scanRoots(ROOTS, f.fs, opts())
    expect(r.roots.map((x) => x.state)).toEqual(['blocked', 'blocked', 'blocked'])
    expect(r.files).toEqual([])
  })

  test('the home folder (or one holding it) is never looked at; a folder inside another or a link to it, once', async () => {
    const f = fakeFs(home({ Documents: dir({ Desktop: dir({ 'a.pdf': file() }) }), Desktop: link('/Users/alex/Documents/Desktop'), Downloads: dir() }))
    const r = await scanRoots(ROOTS, f.fs, opts({ allowed: async (root) => root.id !== 'downloads' }))
    expect(r.roots.map((x) => [x.id, x.state])).toEqual([['documents', 'ok'], ['desktop', 'same'], ['downloads', 'home']])
    expect(r.files.map((x) => x.name)).toEqual(['a.pdf'])
  })

  test('limits: 6 folders down, 5,000 documents, 50,000 entries, 15 s each and 30 s in all; over 50 MB counted, not listed', async () => {
    let deep: Node = dir({ 'deep.pdf': file() })
    for (let i = 7; i >= 1; i--) deep = dir({ [`l${i}`]: deep, [`f${i}.pdf`]: file() })
    const f = fakeFs(home({ Documents: deep, Desktop: dir({ 'big.pdf': file(60 * 1024 * 1024), 'ok.pdf': file() }), Downloads: dir() }))
    const r = await scanRoots(ROOTS, f.fs, opts())
    expect(r.files.filter((x) => x.root === 'documents').map((x) => x.name).sort()).toEqual(['f1.pdf', 'f2.pdf', 'f3.pdf', 'f4.pdf', 'f5.pdf', 'f6.pdf', 'f7.pdf'])
    expect(r.roots[0]!.cut).toBe(true)
    expect(r.roots[1]).toMatchObject({ state: 'ok', tooBig: 1, cut: false })
    const docs: Record<string, Node> = {}
    for (let i = 0; i < 30; i++) docs[`d${i}.pdf`] = file()
    const many = fakeFs(home({ Documents: dir(docs), Desktop: dir(), Downloads: dir() }))
    const capped = await scanRoots(ROOTS, many.fs, opts({ limits: { walkDocs: 10 } }))
    expect(capped.files.length).toBe(10)
    expect(capped.roots[0]!.cut).toBe(true)
    const entries = await scanRoots(ROOTS, many.fs, opts({ limits: { walkFiles: 5 } }))
    expect(entries.files.length).toBe(5)
    // time: a big Downloads is cut, and the time of all three ends the rest
    let clock = 0
    const big = fakeFs(home({ Documents: dir({ a: dir({ 'x.pdf': file() }), b: dir({ 'y.pdf': file() }) }), Desktop: dir({ c: dir({ 'z.pdf': file() }) }), Downloads: dir({ d: dir({ 'w.pdf': file() }) }) }))
    const timed = await scanRoots(ROOTS, { ...big.fs, readdir: async (p, max) => { const out = await big.fs.readdir(p, max); clock += 8000; return out } }, opts({ now: () => clock }))
    // Documents: 16 s of walking (cut at 15 s); Desktop: 8 s; Downloads: the 6 s left of the 30 s (cut). The time macOS's
    // question takes (each folder's first read) is not counted
    expect(timed.roots.map((x) => x.cut)).toEqual([true, false, true])
  })

  test('a file reached twice (two folders, a hard link) is listed once; Stop ends the look with what was found', async () => {
    const shared = file()
    const f = fakeFs(home({ Documents: dir({ 'a.pdf': shared }), Desktop: dir({ 'a copy.pdf': shared }), Downloads: dir({ 'c.pdf': file() }) }))
    const r = await scanRoots(ROOTS, f.fs, opts())
    expect(r.files.map((x) => x.name)).toEqual(['a.pdf', 'c.pdf'])
    let stop = false
    const s = await scanRoots(ROOTS, { ...f.fs, readdir: async (p, max) => { const out = await f.fs.readdir(p, max); if (p.endsWith('Documents')) stop = true; return out } }, opts({ stopped: () => stop }))
    expect(s.stopped).toBe(true)
    expect(s.roots.map((x) => x.state)).toEqual(['ok', 'skipped', 'skipped'])
  })

  test('a folder that never answers (an offline share) ends that folder\'s look in time; a root holding an earlier one skips it', async () => {
    const f = fakeFs(home({ Documents: dir({ 'a.pdf': file(), stuck: dir({ 'x.pdf': file() }) }), Desktop: dir({ Documents: dir({ 'dup.pdf': file() }), 'b.pdf': file() }), Downloads: dir({ 'c.pdf': file() }) }))
    const fs: WorkFs = { ...f.fs, readdir: (p, max) => (p.endsWith('/stuck') ? new Promise(() => {}) : f.fs.readdir(p, max)) }
    const roots: WorkRoot[] = [ROOTS[0]!, { id: 'desktop', path: '/Users/alex/Desktop', oneDrive: false }, ROOTS[2]!]
    // Documents here is /Users/alex/Desktop/Documents for the second test: a root that holds one looked at before
    let clock = 0
    const r = await scanRoots(roots, fs, opts({ now: () => clock, limits: { rootMs: 50 } }))
    expect(r.roots[0]).toMatchObject({ state: 'ok', cut: true })
    expect(r.files.map((x) => x.name)).toContain('c.pdf')
    const nested = fakeFs(home({ Desktop: dir({ Documents: dir({ 'dup.pdf': file() }), 'b.pdf': file() }), Downloads: dir() }))
    const n2 = await scanRoots([{ id: 'documents', path: '/Users/alex/Desktop/Documents', oneDrive: false }, ROOTS[1]!, ROOTS[2]!], nested.fs, opts())
    expect(n2.files.map((x) => `${x.root}:${x.name}`).sort()).toEqual(['desktop:b.pdf', 'documents:dup.pdf'])
    // Desktop's walk does not go into the Documents it holds again
    expect(nested.calls.filter((c) => c === 'readdir /Users/alex/Desktop/Documents')).toHaveLength(1)
  })

  test('OneDrive on Windows', () => {
    expect(inOneDrive('C:\\Users\\alex\\OneDrive - Acme\\Documents', 'win32')).toBe(true)
    expect(inOneDrive('C:\\Users\\alex\\OneDrive\\Desktop', 'win32')).toBe(true)
    expect(inOneDrive('C:\\Users\\alex\\Documents', 'win32')).toBe(false)
    expect(inOneDrive('/Users/alex/OneDrive/Documents', 'darwin')).toBe(false)
  })
})

describe('reading a listed file afterwards', () => {
  const TEAM = 'https://acme.example'
  async function looked(over: Record<string, Node> = {}, limits = {}) {
    const f = fakeFs(home({ Documents: dir({ Clients: dir({ 'a.pdf': file(10) }), 'b.pdf': file(20), 'c.pdf': file(30), ...over }), Desktop: dir(), Downloads: dir() }))
    let clock = 1_000_000
    const sessions = new WorkFileSessions(f.fs, 'darwin', () => clock, limits)
    const r = await scanRoots(ROOTS, f.fs, opts())
    sessions.begin(TEAM, r.found)
    const id = (name: string) => r.files.find((x) => x.name === name)!.id
    return { f, sessions, r, id, tick: (ms: number) => { clock += ms } }
  }

  test('an id of the look gives that file\'s bytes; an id it never gave, or of another origin, gives nothing', async () => {
    const { sessions, id } = await looked()
    const ok = await sessions.read(TEAM, id('a.pdf'))
    expect(ok.ok && ok.bytes.byteLength).toBe(10)
    expect(await sessions.read(TEAM, 'made-up-id')).toEqual({ ok: false, reason: 'unknown' })
    expect(await sessions.read('https://evil.example', id('a.pdf'))).toEqual({ ok: false, reason: 'unknown' })
  })

  test('a new look replaces the old one: its ids read nothing; an hour later nothing either', async () => {
    const a = await looked()
    const old = a.id('a.pdf')
    a.sessions.begin(TEAM, new Map())
    expect(await a.sessions.read(TEAM, old)).toEqual({ ok: false, reason: 'unknown' })
    const b = await looked()
    b.tick(60 * 60_000 + 1)
    expect(await b.sessions.read(TEAM, b.id('a.pdf'))).toEqual({ ok: false, reason: 'expired' })
  })

  test('at most 100 files (here 2) and 1 GB (here 40 bytes) of one look; reading the same file again counts once', async () => {
    const { sessions, id } = await looked({}, { readFiles: 2 })
    expect((await sessions.read(TEAM, id('a.pdf'))).ok).toBe(true)
    expect((await sessions.read(TEAM, id('a.pdf'))).ok).toBe(true)
    expect((await sessions.read(TEAM, id('b.pdf'))).ok).toBe(true)
    expect(await sessions.read(TEAM, id('c.pdf'))).toEqual({ ok: false, reason: 'limit' })
    const bytes = await looked({}, { readBytes: 40 })
    expect((await bytes.sessions.read(TEAM, bytes.id('a.pdf'))).ok).toBe(true)
    expect((await bytes.sessions.read(TEAM, bytes.id('b.pdf'))).ok).toBe(true)
    expect(await bytes.sessions.read(TEAM, bytes.id('c.pdf'))).toEqual({ ok: false, reason: 'limit' })
  })

  test('reads sent all at once cannot pass the limits, and run one at a time (at most one file in memory)', async () => {
    const { f, sessions, r } = await looked({ 'd.pdf': file(40), 'e.pdf': file(50) }, { readFiles: 2 })
    let inFlight = 0
    let most = 0
    const open = f.fs.open
    f.fs.open = async (p) => { inFlight++; most = Math.max(most, inFlight); await new Promise((x) => setTimeout(x, 5)); try { return await open(p) } finally { inFlight-- } }
    const all = await Promise.all(r.files.map((x) => sessions.read(TEAM, x.id)))
    expect(all.filter((x) => x.ok).length).toBe(2)
    expect(all.filter((x) => !x.ok && x.reason === 'limit').length).toBe(r.files.length - 2)
    expect(most).toBe(1)
    // the same file over and over: limited too
    const again = await looked({}, { readFiles: 2 })
    const reads = await Promise.all(Array.from({ length: 10 }, () => again.sessions.read(TEAM, again.id('a.pdf'))))
    expect(reads.filter((x) => x.ok).length).toBe(6)
  })

  test('a failed read gives its place back; on Windows a file system with no identity is refused', async () => {
    const { f, sessions, id } = await looked({}, { readFiles: 1 })
    const docs = f.at('/Users/alex/Documents', true) as { children: Record<string, Node> }
    const b = docs.children['b.pdf'] as { size: number }
    b.size = 99
    expect(await sessions.read(TEAM, id('b.pdf'))).toEqual({ ok: false, reason: 'changed' })
    expect((await sessions.read(TEAM, id('c.pdf'))).ok).toBe(true)
    const w = fakeFs(home({ Documents: dir({ 'a.pdf': { kind: 'file', size: 5, mtimeMs: 1000, ino: 0n } }), Desktop: dir(), Downloads: dir() }))
    const scanned = await scanRoots(ROOTS, w.fs, opts())
    for (const [platform, ok] of [['win32', false], ['darwin', true]] as const) {
      const s2 = new WorkFileSessions(w.fs, platform)
      s2.begin(TEAM, scanned.found)
      expect((await s2.read(TEAM, scanned.files[0]!.id)).ok, platform).toBe(ok)
    }
  })

  test('a folder on the way swapped for a link (to home, out of the root) is refused; so is a file swapped for a link', async () => {
    const { f, sessions, id } = await looked()
    const docs = f.at('/Users/alex/Documents', true) as { children: Record<string, Node> }
    // Clients now points somewhere else with a file of the same name and size
    ;(f.at('/Users/alex', true) as { children: Record<string, Node> }).children.Elsewhere = dir({ 'a.pdf': file(10) })
    docs.children.Clients = link('/Users/alex/Elsewhere')
    expect(await sessions.read(TEAM, id('a.pdf'))).toEqual({ ok: false, reason: 'changed' })
    docs.children['b.pdf'] = link('/Users/alex/Elsewhere/a.pdf')
    expect(await sessions.read(TEAM, id('b.pdf'))).toEqual({ ok: false, reason: 'changed' })
    expect(f.calls.filter((c) => c.startsWith('open'))).toEqual([])
  })

  test('another size, date or file in its place is refused; a deleted one is unreadable', async () => {
    const { f, sessions, id } = await looked()
    const docs = f.at('/Users/alex/Documents', true) as { children: Record<string, Node> }
    ;(docs.children['b.pdf'] as { size: number }).size = 21
    expect(await sessions.read(TEAM, id('b.pdf'))).toEqual({ ok: false, reason: 'changed' })
    ;(docs.children['c.pdf'] as { mtimeMs: number }).mtimeMs += 5000
    expect(await sessions.read(TEAM, id('c.pdf'))).toEqual({ ok: false, reason: 'changed' })
    const clients = docs.children.Clients as { children: Record<string, Node> }
    clients.children['a.pdf'] = file(10, (clients.children['a.pdf'] as { mtimeMs: number }).mtimeMs)
    expect(await sessions.read(TEAM, id('a.pdf'))).toEqual({ ok: false, reason: 'changed' })
    delete clients.children['a.pdf']
    expect(await sessions.read(TEAM, id('a.pdf'))).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('a link that takes the file\'s place between the check and the open (ELOOP) is refused', async () => {
    const { f, sessions, id } = await looked()
    const fs = (f.fs as WorkFs)
    const open = fs.open
    const docs = f.at('/Users/alex/Documents', true) as { children: Record<string, Node> }
    fs.open = async (p) => { docs.children['b.pdf'] = link('/Users/alex/Documents/c.pdf'); return open(p) }
    expect(await sessions.read(TEAM, id('b.pdf'))).toEqual({ ok: false, reason: 'changed' })
  })

  test('a sign-out or another person forgets the look', async () => {
    const { sessions, id } = await looked()
    sessions.person({ signedIn: true, userId: 'u-alex' })
    expect((await sessions.read(TEAM, id('a.pdf'))).ok).toBe(true)
    expect(sessions.person({ signedIn: true, userId: 'u-bo' })).toBe(true)
    expect(await sessions.read(TEAM, id('a.pdf'))).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('the wiring', () => {
  const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
  const ctl = readFileSync(join(import.meta.dir, '../../desktop/src/main/work-files.ts'), 'utf8')
  const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
  test('every call is the team page\'s top frame at its origin (fromApp), a read names an id, never a path', () => {
    for (const ch of ['bridge:work-files-scan', 'bridge:work-files-stop', 'bridge:work-files-read', 'bridge:work-files-settings']) {
      const line = main.split('\n').find((l) => l.includes(`'${ch}'`))!
      expect(line, ch).toContain('fromApp(e)')
    }
    expect(preload).toContain("ipcRenderer.invoke('bridge:work-files-scan')")
    expect(preload).not.toMatch(/work-files-scan',\s*\w/)
  })
  test('the look waits for the app\'s own dialog (Cancel is its default); the Mac App Store build and Linux have none', () => {
    expect(ctl).toContain('dialog.showMessageBox(win')
    expect(ctl).toMatch(/defaultId: 1,\s*cancelId: 1,/)
    expect(ctl.indexOf('await this.consent(')).toBeLessThan(ctl.indexOf('await scanRoots('))
    expect(ctl).toContain("if (p.platform === 'darwin' && p.mas !== true) return WORK_FILES_BRIDGE_VERSION")
    expect(ctl).not.toContain("'linux'")
  })
})
