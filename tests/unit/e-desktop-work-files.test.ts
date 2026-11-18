// "Find work files on this computer" in the desktop app (docs/DECISIONS.md "Find work files on this computer";
// desktop/src/common/work-files.ts): the look through Documents, Desktop and Downloads (names, sizes and dates only,
// never a link, one folder after the other, the limits) and the reads afterwards (only ids of the latest look of that
// origin, for an hour, at most 100 files and 1 GB, the same file found again without a link on the way). A made-up file
// system only: nothing of this computer is read.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inOneDrive, lookRoots, pickRefused, pickTarget, scanRoots, WorkFileSessions, type WorkDirent, type WorkFs, type WorkRoot, type WorkStat } from '../../desktop/src/common/work-files'
import { findDocs } from '../../web/src/lib/teamFiles'
import { docsFromScan, forAiRecent, personalList, workCandidates } from '../../web/src/lib/workFiles'

type Node = { kind: 'dir'; children: Record<string, Node>; mtimeMs?: number } | { kind: 'file'; size: number; mtimeMs: number; ino: bigint; bytes?: Uint8Array } | { kind: 'link'; to: string }
let ino = 100n
const file = (size = 1000, mtimeMs = Date.UTC(2026, 9, 3)): Node => ({ kind: 'file', size, mtimeMs, ino: ino++ })
const dir = (children: Record<string, Node> = {}, mtimeMs?: number): Node => ({ kind: 'dir', children, ...(mtimeMs !== undefined ? { mtimeMs } : {}) })
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
  const statOf = (n: Node): WorkStat => n.kind === 'file' ? { kind: 'file', size: n.size, mtimeMs: n.mtimeMs, dev: 1n, ino: n.ino } : { kind: n.kind === 'dir' ? 'dir' : 'link', size: 0, mtimeMs: n.kind === 'dir' ? (n.mtimeMs ?? 0) : 0, dev: 1n, ino: 1n }
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
    // more than one batch of 16 under a cut folder: every document found is listed (a cut ended only the first batch)
    const more = await scanRoots(ROOTS, many.fs, opts({ limits: { walkDocs: 25 } }))
    expect(more.files.length).toBe(25)
    expect(more.roots[0]!.cut).toBe(true)
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
    // these tests read: every file of the look was added in the app's window (e-desktop-work-consent.test.ts: only those)
    sessions.allow(TEAM, [...r.found.keys()])
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

  test('a read on a drive that stops answering gives up, gives its place back, and the next read goes', async () => {
    const { f, sessions, id } = await looked({}, { readFiles: 1, readMs: 50 })
    const open = f.fs.open
    f.fs.open = (p) => (p.endsWith('b.pdf') ? new Promise(() => {}) : open(p))
    const [stuck, next] = await Promise.all([sessions.read(TEAM, id('b.pdf')), sessions.read(TEAM, id('c.pdf'))])
    expect(stuck).toEqual({ ok: false, reason: 'unreadable' })
    expect(next.ok).toBe(true)
  })

  describe('a file whose content is in the cloud only', () => {
    test('a Mac\'s online-only file: the page hears "from iCloud" once, before the bytes; a file on the disk says nothing', async () => {
      const { f, sessions, id } = await looked()
      const asked: string[] = []
      f.fs.cloudOnly = async (p) => { asked.push(p); return p.endsWith('b.pdf') }
      const heard: string[] = []
      const r = await sessions.read(TEAM, id('b.pdf'), (c) => heard.push(`${c} ${f.calls.filter((x) => x.startsWith('open')).length}`))
      expect(r.ok && r.bytes.byteLength).toBe(20)
      // said before the file was opened (the open or the read downloads it)
      expect(heard).toEqual(['icloud 0'])
      const quiet: string[] = []
      expect((await sessions.read(TEAM, id('c.pdf'), (c) => quiet.push(c))).ok).toBe(true)
      expect(quiet).toEqual([])
      expect(asked).toEqual(['/Users/alex/Documents/b.pdf', '/Users/alex/Documents/c.pdf'])
    })

    test('the download takes longer than the read\'s minute: cloudTimeout names the cloud, and nothing is said after the answer', async () => {
      const { f, sessions, id } = await looked({}, { readMs: 40 })
      f.fs.cloudOnly = async (p) => p.endsWith('b.pdf')
      const open = f.fs.open
      let release = () => {}
      f.fs.open = (p) => (p.endsWith('b.pdf') ? new Promise((ok) => { release = () => ok(open(p)) }) : open(p))
      const heard: string[] = []
      expect(await sessions.read(TEAM, id('b.pdf'), (c) => heard.push(c))).toEqual({ ok: false, reason: 'cloudTimeout', cloud: 'icloud' })
      release()
      await new Promise((r) => setTimeout(r, 10))
      expect(heard).toEqual(['icloud'])
      // no retry by itself: added again once it has come down, the same file reads (the failed read was given back)
      f.fs.open = open
      expect((await sessions.read(TEAM, id('b.pdf'))).ok).toBe(true)
      // the file did not count against the look's limits; the next read goes
      expect((await sessions.read(TEAM, id('c.pdf'))).ok).toBe(true)
    })

    test('a stuck drive that is no cloud\'s stays "unreadable"', async () => {
      const { f, sessions, id } = await looked({}, { readMs: 30 })
      f.fs.cloudOnly = async () => false
      f.fs.open = () => new Promise(() => {})
      const heard: string[] = []
      expect(await sessions.read(TEAM, id('b.pdf'), (c) => heard.push(c))).toEqual({ ok: false, reason: 'unreadable' })
      expect(heard).toEqual([])
    })

    test('a check that fails is no cloud: the read goes on as for any file', async () => {
      const { f, sessions, id } = await looked()
      f.fs.cloudOnly = async () => { throw new Error('stat did not answer') }
      const heard: string[] = []
      expect((await sessions.read(TEAM, id('b.pdf'), (c) => heard.push(c))).ok).toBe(true)
      expect(heard).toEqual([])
    })

    test('in a cloud\'s folder, a read still going after a moment is taken for a download; a quick one says nothing', async () => {
      const icloud = '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs'
      const f = fakeFs({ Users: dir({ alex: dir({ Library: dir({ 'Mobile Documents': dir({ 'com~apple~CloudDocs': dir({ 'slow.pdf': file(10), 'quick.pdf': file(10) }) }) }) }) }) })
      const sessions = new WorkFileSessions(f.fs, 'darwin', undefined, { cloudHintMs: 10 })
      const r = await scanRoots([{ id: 'documents', path: icloud, oneDrive: false }], f.fs, opts())
      sessions.begin(TEAM, r.found)
      sessions.allow(TEAM, [...r.found.keys()])
      const id = (name: string) => r.files.find((x) => x.name === name)!.id
      const open = f.fs.open
      f.fs.open = async (p) => { if (p.endsWith('slow.pdf')) await new Promise((x) => setTimeout(x, 60)); return open(p) }
      const heard: string[] = []
      expect((await sessions.read(TEAM, id('quick.pdf'), (c) => heard.push(`quick ${c}`))).ok).toBe(true)
      expect((await sessions.read(TEAM, id('slow.pdf'), (c) => heard.push(`slow ${c}`))).ok).toBe(true)
      expect(heard).toEqual(['slow icloud'])
    })

    test('a listener that throws does not stop the read', async () => {
      const { f, sessions, id } = await looked()
      f.fs.cloudOnly = async () => true
      expect((await sessions.read(TEAM, id('b.pdf'), () => { throw new Error('page gone') })).ok).toBe(true)
    })
  })

  test('the documents\' lstat stops at the time left and at Stop (a slow drive): the folder is cut', async () => {
    const docs: Record<string, Node> = {}
    for (let i = 0; i < 40; i++) docs[`d${i}.pdf`] = file()
    const f = fakeFs(home({ Documents: dir(docs), Desktop: dir(), Downloads: dir() }))
    let clock = 0
    const fs: WorkFs = { ...f.fs, lstat: async (p) => { clock += 100; return f.fs.lstat(p) } }
    const r = await scanRoots(ROOTS, fs, opts({ now: () => clock, limits: { rootMs: 1000 } }))
    expect(r.roots[0]!.cut).toBe(true)
    expect(r.files.filter((x) => x.root === 'documents').length).toBe(16)
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
      s2.allow(TEAM, [...scanned.found.keys()])
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

describe('only the files added in the app\'s own window are read (TC-3300)', () => {
  const TEAM = 'https://acme.example'
  async function look(limits = {}) {
    const f = fakeFs(home({ Documents: dir({ 'a.pdf': file(10), 'b.pdf': file(20), 'c.pdf': file(30) }), Desktop: dir(), Downloads: dir() }))
    let clock = 1_000_000
    const sessions = new WorkFileSessions(f.fs, 'darwin', () => clock, limits)
    const r = await scanRoots(ROOTS, f.fs, opts())
    sessions.begin(TEAM, r.found)
    return { sessions, id: (name: string) => r.files.find((x) => x.name === name)!.id, tick: (ms: number) => { clock += ms } }
  }
  test('a file never ticked (never added) is refused, whatever the page asks', async () => {
    const { sessions, id } = await look()
    expect(await sessions.read(TEAM, id('a.pdf'))).toEqual({ ok: false, reason: 'unknown' })
    expect(sessions.allow(TEAM, [id('a.pdf')])).toBe(true)
    expect((await sessions.read(TEAM, id('a.pdf'))).ok).toBe(true)
    expect(await sessions.read(TEAM, id('b.pdf'))).toEqual({ ok: false, reason: 'unknown' })
  })
  test('ticked, then unticked before Add: only what was added is readable', async () => {
    const { sessions, id } = await look()
    // the person ticked a and b, unticked b, and said Add to the window that listed a only
    expect(sessions.toAdd(TEAM, [id('a.pdf')])).toEqual([{ name: 'a.pdf', size: 10 }])
    sessions.allow(TEAM, [id('a.pdf')])
    expect(await sessions.read(TEAM, id('b.pdf'))).toEqual({ ok: false, reason: 'unknown' })
  })
  test('the window lists only ids of this origin\'s latest look, each once, within the read limits', async () => {
    const { sessions, id, tick } = await look({ readFiles: 2, readBytes: 40 })
    expect(sessions.toAdd(TEAM, [id('a.pdf'), id('b.pdf')])).toEqual([{ name: 'a.pdf', size: 10 }, { name: 'b.pdf', size: 20 }])
    expect(sessions.toAdd(TEAM, [])).toBeNull()
    expect(sessions.toAdd(TEAM, ['made-up'])).toBeNull()
    expect(sessions.toAdd(TEAM, [id('a.pdf'), id('a.pdf')])).toBeNull()
    expect(sessions.toAdd('https://evil.example', [id('a.pdf')])).toBeNull()
    // 3 files (limit 2); then 50 bytes with what was added before (limit 40)
    expect(sessions.toAdd(TEAM, [id('a.pdf'), id('b.pdf'), id('c.pdf')])).toBeNull()
    sessions.allow(TEAM, [id('b.pdf')])
    expect(sessions.toAdd(TEAM, [id('c.pdf')])).toBeNull()
    expect(sessions.allow('https://evil.example', [id('a.pdf')])).toBe(false)
    tick(60 * 60_000 + 1)
    expect(sessions.toAdd(TEAM, [id('a.pdf')])).toBeNull()
  })
  test('a new look forgets what was added', async () => {
    const { sessions, id } = await look()
    sessions.allow(TEAM, [id('a.pdf')])
    const old = id('a.pdf')
    const again = await look()
    sessions.begin(TEAM, new Map())
    expect(await sessions.read(TEAM, old)).toEqual({ ok: false, reason: 'unknown' })
    expect(await again.sessions.read(TEAM, again.id('a.pdf'))).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('the wiring', () => {
  const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
  const ctl = readFileSync(join(import.meta.dir, '../../desktop/src/main/work-files.ts'), 'utf8')
  const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
  test('every call is the team page\'s top frame at its origin (fromApp), a read names an id, never a path', () => {
    for (const ch of ['bridge:work-files-scan', 'bridge:work-files-stop', 'bridge:work-files-add', 'bridge:work-files-read', 'bridge:work-files-settings']) {
      const line = main.split('\n').find((l) => l.includes(`'${ch}'`))!
      expect(line, ch).toContain('fromApp(e)')
    }
    for (const ch of ['bridge:work-files-full-disk', 'bridge:work-files-full-disk-settings', 'bridge:work-files-relaunch']) {
      const line = main.split('\n').find((l) => l.includes(`'${ch}'`))!
      expect(line, ch).toContain('fromApp(e)')
    }
    // part 5: the page may send only a flag and short names, cleaned again in the main process (scanAsk)
    expect(preload).toContain("ipcRenderer.invoke('bridge:work-files-scan', o && typeof o === 'object' ? { wide: o.wide === true, words: Array.isArray(o.words) ? o.words.slice(0, 20).map(String) : [] } : {})")
    expect(main).toContain('win!.workFiles.scan(e.senderFrame.origin, scanAsk(ask))')
  })
  test('the look waits for the app\'s own consent window (e-desktop-work-consent.test.ts); the Mac App Store build and Linux have none', () => {
    expect(ctl.indexOf('await this.consent(')).toBeLessThan(ctl.indexOf('await this.look(roots'))
    expect(ctl).toContain("if (p.platform === 'darwin' && p.mas !== true) return WORK_FILES_BRIDGE_VERSION")
    expect(ctl).not.toContain("'linux'")
  })
})

describe('owner 2026-11-15: "they\'re work files, but it only brought really useless ones"', () => {
  test('a saved page\'s folder, a tool\'s or a code project\'s folder and a program\'s names are never listed', async () => {
    const f = fakeFs(home({
      Documents: dir({ 'Plan.docx': file(), Tools: dir({ 'ffmpeg-7.1-darwin-arm64': dir({ 'README.md': file(5000) }), 'myapp': dir({ 'package.json': file(), 'Guide.pdf': file(5000) }), lib: dir({ 'x.pdf': file() }) }) }),
      Desktop: dir({ 'Untitled 2.docx': file(5000), 'f(3).txt': file(5000), 'image001.png': file(), 'LICENSE.txt': file(5000) }),
      Downloads: dir({ '261009 점검 _ 피드백_files': dir(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f(${i}).txt`, file(5000)]))), 'Bericht-Dateien': dir({ 'a.pdf': file() }), '261009 점검 _ 피드백.html': file(), 'Quote.pdf': file() }),
    }))
    const r = await scanRoots(ROOTS, f.fs, opts())
    // Bericht-Dateien has no page beside it: a folder of a person's, entered (its PDF listed)
    expect(r.files.map((x) => x.name).sort()).toEqual(['Plan.docx', 'Quote.pdf', 'a.pdf', 'x.pdf'])
    // never entered: no readdir of the saved page's or the tool's folders
    expect(f.calls.filter((c) => c.startsWith('readdir') && /_files|ffmpeg/.test(c))).toEqual([])
  })

  test('a recent file inside a code project\'s folder the walk skipped is not added back', async () => {
    const NOW = Date.UTC(2026, 10, 15)
    const f = fakeFs(home({ Documents: dir(), Desktop: dir({ repo: dir({ 'package.json': file(), docs: dir({ 'architecture.md': file(9000, NOW) }) }), 'Plan.docx': file(9000, NOW) }), Downloads: dir() }))
    const r = await lookRoots([ROOTS[1]!], f.fs, {
      platform: 'darwin', newId: () => `id${n++}`, now: () => NOW, index: async () => null,
      recentIn: async () => [{ path: '/Users/alex/Desktop/repo/docs/architecture.md', used: NOW, modified: null, useCount: 2, size: null, origins: [], authors: [], org: null }],
    })
    expect(r.files.map((x) => x.name)).toEqual(['Plan.docx'])
  })

  test('the walk goes newest first: a walk cut by its limits keeps the folder changed lately', async () => {
    const old = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Old ${i}`, dir({ [`Old doc ${i}.pdf`]: file(5000) }, Date.UTC(2024, 0, 1 + i))]))
    const f = fakeFs(home({ Documents: dir(), Desktop: dir({ ...old, 'This week': dir({ 'Board deck.pptx': file(5000) }, Date.UTC(2026, 10, 10)) }), Downloads: dir() }))
    const r = await scanRoots([ROOTS[1]!], f.fs, opts({ limits: { walkFiles: 40 } }))
    expect(r.roots[0]!.cut).toBe(true)
    expect(r.files.map((x) => x.name)).toContain('Board deck.pptx')
  })

  // Mac QA of the picked-folder look (2026-11-18): one sub-folder's lstat (its date, for the walk's order) never answered
  // while its 39 siblings answered in 15 ms; the look waited the whole folder time (10 s) and gave no files at all
  const hung = (o: { serial: boolean; listHangs: boolean }) => test(`a folder whose date never answers is skipped; its siblings' files come back (${o.serial ? 'one call at a time' : 'in parallel'}${o.listHangs ? ', its listing hangs too' : ''})`, async () => {
    const subs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Folder ${i}`, dir({ [`Doc ${i}.pdf`]: file(5000) }, Date.UTC(2026, 9, 1 + (i % 28)))]))
    const f = fakeFs(home({ Picked: dir(subs) }))
    const dateCalls: string[] = []
    const fs: WorkFs = {
      ...f.fs,
      lstat: (p) => {
        if (/\/Folder \d+$/.test(p)) dateCalls.push(p)
        return p.endsWith('/Folder 7') ? new Promise(() => {}) : new Promise((ok) => setTimeout(ok, 15)).then(() => f.fs.lstat(p))
      },
      readdir: (p, max) => (o.listHangs && p.endsWith('/Folder 7') ? new Promise(() => {}) : f.fs.readdir(p, max)),
    }
    const picked: WorkRoot = { id: 'documents', path: '/Users/alex/Picked', oneDrive: false }
    const t0 = Date.now()
    const r = await lookRoots([picked], fs, { platform: 'darwin', newId: () => `id${n++}`, index: async () => null, deadline: Date.now() + 10_000, ...(o.serial ? { serial: true } : {}) })
    expect(Date.now() - t0).toBeLessThan(6000)
    const siblings = Array.from({ length: 40 }, (_, i) => `Doc ${i}.pdf`).filter((x) => x !== 'Doc 7.pdf')
    const listed = f.calls.filter((c) => c.startsWith('readdir /Users/alex/Picked/'))
    if (o.serial) {
      // one call at a time: no more folder dates after the one that hung, and that folder is not asked again (cut)
      expect(dateCalls.at(-1)).toBe('/Users/alex/Picked/Folder 7')
      expect(listed).not.toContain('readdir /Users/alex/Picked/Folder 7')
      expect(r.roots[0]).toMatchObject({ state: 'ok', cut: true })
      expect(r.files.map((x) => x.name).sort()).toEqual(siblings.sort())
    } else if (o.listHangs) {
      // its listing waited only a moment, after all the others, and is skipped (cut)
      expect(r.roots[0]).toMatchObject({ state: 'ok', cut: true })
      expect(r.files.map((x) => x.name).sort()).toEqual(siblings.sort())
    } else {
      // only its date hung: it is walked after all the others, and its own file comes back too
      expect(listed.at(-1)).toBe('readdir /Users/alex/Picked/Folder 7')
      expect(r.files.map((x) => x.name).sort()).toEqual([...siblings, 'Doc 7.pdf'].sort())
    }
  }, 15_000)
  hung({ serial: false, listHangs: false })
  hung({ serial: false, listHangs: true })
  hung({ serial: true, listHangs: false })

  test('a walked folder\'s files opened lately (Spotlight, the recent lists) join the walk even when it was cut; a tiny note is listed for search', async () => {
    const NOW = Date.UTC(2026, 10, 15)
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`x${i}.mp4`, file()]))
    const f = fakeFs(home({ Documents: dir(), Desktop: dir({ ...many, Deep: dir({ Deeper: dir({ 'Opened plan.pdf': file(9000, NOW - 86_400_000) }) }), 'todo.txt': file(300, NOW) }), Downloads: dir() }))
    const r = await lookRoots([ROOTS[1]!], f.fs, {
      platform: 'darwin', newId: () => `id${n++}`, now: () => NOW, index: async () => null, limits: { depth: 1 },
      recentIn: async () => [{ path: '/Users/alex/Desktop/Deep/Deeper/Opened plan.pdf', used: NOW - 3600_000, modified: null, useCount: 3, size: null, origins: [], authors: [], org: null, listed: true }],
    })
    expect(r.roots[0]!.cut).toBe(true)
    // the page keeps todo.txt (300 bytes) out of its picks (web notWork); the app lists it so search by name finds it
    expect(r.files.map((x) => x.name).sort()).toEqual(['Opened plan.pdf', 'todo.txt'])
    expect(r.files.find((x) => x.name === 'Opened plan.pdf')).toMatchObject({ folder: 'Deep/Deeper', used: NOW - 3600_000, listed: true })
  })
})

describe('MAN-057 (2026-11-17, Windows 11): "quote" found nothing in Documents › QA desktop test › Quotes', () => {
  // the PC's Documents as the walk saw it: code projects (skipped by softwareFolder), a deep folder (cut at four folders
  // down before the second fix),
  // and three quotes of 27 to 53 bytes that the walk reached and then dropped as too small
  const NOW = Date.UTC(2026, 10, 17, 9)
  const NO_WORDS = { names: [], domains: [], people: [] }
  const tree = () => fakeFs(home({
    Documents: dir({
      project: dir({ app: dir({ 'package.json': file(), 'CLAUDE.md': file(9000, NOW) }) }, NOW - 4 * 86_400_000),
      Codex: dir({ a: dir({ b: dir({ c: dir({ d: dir({ 'deep.md': file(9000) }) }) }) }) }),
      'QA desktop test': dir({
        Quotes: dir({ 'Quote-Hanbit-Q1001.txt': file(53, NOW), 'Quote-Sora-Q1002.txt': file(47, NOW), 'Price-list-2026.txt': file(38, NOW), 'empty.txt': file(0, NOW) }, NOW),
        Other: dir({ 'lunch.txt': file(27, NOW) }, NOW),
      }, NOW),
    }),
    Desktop: dir(),
    Downloads: dir(),
  }))

  test('the walk lists the small quotes (an empty file stays out); the page finds them by name and keeps them out of the picks', async () => {
    const f = tree()
    const r = await lookRoots(ROOTS, f.fs, { platform: 'win32', newId: () => `id${n++}`, now: () => NOW, index: async () => null })
    // six folders down since the second MAN-057 fix: the Codex tree is reached, nothing is cut
    expect(r.roots[0]).toMatchObject({ how: 'walk', cut: false })
    const names = r.files.map((x) => x.name).sort()
    expect(names).toEqual(['Price-list-2026.txt', 'Quote-Hanbit-Q1001.txt', 'Quote-Sora-Q1002.txt', 'deep.md', 'lunch.txt'])
    const docs = docsFromScan(r.files, async () => ({ ok: false, reason: 'unknown' }))
    // the search matches the path inside the folder (Quotes/…): all three files of the Quotes folder
    expect(findDocs(docs, 'quote').map((d) => d.name).sort()).toEqual(['Price-list-2026.txt', 'Quote-Hanbit-Q1001.txt', 'Quote-Sora-Q1002.txt'])
    // never suggested and never sent to the AI: a text note of a few lines (tooSmall)
    const small = docs.filter((d) => d.name !== 'deep.md')
    expect(workCandidates(small, NOW)).toEqual([])
    expect(forAiRecent(small, NO_WORDS, NOW)).toEqual([])
    // nor in the "May be personal" fold: a small file with a personal-looking path is found by name only
    const mine = small.map((d) => ({ ...d, personal: true }))
    expect(personalList(mine, NOW)).toEqual([])
    expect(personalList([{ ...mine[0]!, size: 9000 }], NOW).map((d) => d.name)).toEqual([mine[0]!.name])
  })

  test('the index path lists them too (Windows Search answered in time)', async () => {
    const f = tree()
    const at = (p: string, size: number) => ({ path: `/Users/alex/Documents/QA desktop test/${p}`, used: null, modified: NOW, useCount: null, size, origins: [], authors: [], org: null })
    const r = await lookRoots([ROOTS[0]!], f.fs, { platform: 'darwin', newId: () => `id${n++}`, now: () => NOW, index: async () => [at('Quotes/Quote-Hanbit-Q1001.txt', 53), at('Quotes/empty.txt', 0)] })
    expect(r.roots[0]).toMatchObject({ how: 'index' })
    expect(r.files.map((x) => x.name)).toEqual(['Quote-Hanbit-Q1001.txt'])
  })
})

describe('MAN-057, second look (2026-11-17): a big Documents left the quotes out and there was no way to pick a folder', () => {
  const NOW = Date.UTC(2026, 10, 17, 9)
  const DAY = 86_400_000
  /** A Documents as a real office PC has it: thousands of loose junk files at the top, programs' folders, a fresh folder
   * of thousands of exported notes (newest of all), fresh deep trees, and three quotes two folders down. */
  function bigDocuments(): Record<string, Node> {
    const top: Record<string, Node> = {}
    for (let i = 0; i < 4000; i++) top[`log-${i}.tmp`] = file(500, NOW - DAY)
    for (let i = 0; i < 1500; i++) top[`IMG_${i}.jpg`] = file(90_000, NOW - DAY)
    for (let i = 0; i < 300; i++) top[`Folder ${String(i).padStart(3, '0')}`] = dir({ [`f${i}.bin`]: file() }, NOW - 400 * DAY)
    const notes: Record<string, Node> = {}
    for (let i = 0; i < 12_000; i++) notes[`note-${i}.txt`] = file(3000, NOW)
    const modules: Record<string, Node> = {}
    for (let i = 0; i < 3000; i++) modules[`m${i}.md`] = file(4000, NOW)
    // a fresh unzipped tree, deep and wide (each level newer than the Quotes folder)
    const fresh = (depth: number): Node => dir(depth ? Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`d${depth}-${i}`, fresh(depth - 1)])) : { 'part.pdf': file(5000, NOW) }, NOW)
    return {
      ...top,
      'Exported notes': dir(notes, NOW),
      'Unzipped dataset': fresh(5),
      node_modules: dir(modules, NOW),
      '.git': dir({ 'packed.md': file(9000, NOW) }, NOW),
      'My Games': dir(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`save${i}.txt`, file(3000, NOW)])), NOW),
      Cache: dir(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`c${i}.csv`, file(3000, NOW)])), NOW),
      'QA desktop test': dir({
        Quotes: dir({ 'Quote-Hanbit-Q1001.xlsx': file(18_000, NOW - 2 * DAY), 'Quote-Sora-Q1002.xlsx': file(21_000, NOW - 2 * DAY), 'Quote-Mirae-Q1003.xlsx': file(19_500, NOW - 2 * DAY) }, NOW - 2 * DAY),
      }, NOW - 2 * DAY),
    }
  }
  const QUOTES = ['Quote-Hanbit-Q1001.xlsx', 'Quote-Mirae-Q1003.xlsx', 'Quote-Sora-Q1002.xlsx']
  /** a clock that moves with the work: a folder's listing 1 ms per 100 entries, each lstat 0.2 ms (a slow laptop disk
   * with a virus scanner is slower; the limits are what count) */
  const timed = (fs: WorkFs) => {
    let clock = 0
    const timedFs: WorkFs = {
      ...fs,
      readdir: async (p, max) => { const out = await fs.readdir(p, max); clock += 1 + out.length / 100; return out },
      lstat: async (p) => { clock += 0.2; return fs.lstat(p) },
    }
    return { fs: timedFs, now: () => clock, spent: () => clock }
  }
  /** The fake's paths as Windows names them (C:\Users\alex\…): realpath answers in Windows form, everything else is
   * handed to the posix fake with its backslashes turned. */
  const windowsFs = (fs: WorkFs): WorkFs => {
    const toPosix = (p: string) => '/' + p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^C:\//i, '')
    const toWin = (p: string) => 'C:' + p.replace(/\//g, '\\')
    return { readdir: (p, m) => fs.readdir(toPosix(p), m), lstat: (p) => fs.lstat(toPosix(p)), realpath: async (p) => toWin(await fs.realpath(toPosix(p))), open: (p) => fs.open(toPosix(p)) }
  }
  const WIN_ROOTS: WorkRoot[] = [
    { id: 'documents', path: 'C:\\Users\\alex\\Documents', oneDrive: false },
    { id: 'desktop', path: 'C:\\Users\\alex\\Desktop', oneDrive: false },
    { id: 'downloads', path: 'C:\\Users\\alex\\Downloads', oneDrive: false },
  ]

  for (const platform of ['darwin', 'win32'] as const) {
    test(`${platform}: the quotes are found under thousands of junk files and fresh big folders, within the walk's time`, async () => {
      const f = fakeFs(home({ Documents: dir(bigDocuments()), Desktop: dir({ 'Plan.docx': file(9000, NOW) }), Downloads: dir() }))
      const base = platform === 'win32' ? windowsFs(f.fs) : f.fs
      const t = timed(base)
      const roots = platform === 'win32' ? WIN_ROOTS : ROOTS
      const r = await lookRoots(roots, t.fs, { platform, newId: () => `id${n++}`, now: t.now, index: async () => null })
      const docs = r.files.filter((x) => x.root === 'documents')
      expect(docs.filter((x) => QUOTES.includes(x.name)).map((x) => [x.name, x.folder]).sort()).toEqual(QUOTES.map((q) => [q, 'QA desktop test/Quotes']))
      // the junk is never listed: programs' folders, caches, games' saves, loose pictures
      expect(docs.some((x) => /^(m\d+\.md|packed\.md|save\d+\.txt|c\d+\.csv|IMG_\d+\.jpg)$/.test(x.name))).toBe(false)
      expect(f.calls.some((c) => /\/(node_modules|\.git|My Games|Cache)$/.test(c) && c.startsWith('readdir'))).toBe(false)
      // the big folder of notes gives at most its share; the look stays within its time and memory
      expect(docs.filter((x) => x.name.startsWith('note-')).length).toBeLessThanOrEqual(400)
      expect(docs.length).toBeLessThanOrEqual(5000)
      expect(t.spent()).toBeLessThan(20_000)
      expect(r.files.find((x) => x.name === 'Plan.docx')?.root).toBe('desktop')
      // the page finds them by name, and they are ordinary work files (not too small)
      const found = docsFromScan(r.files, async () => ({ ok: false, reason: 'unknown' }))
      expect(findDocs(found, 'quote').map((d) => d.name).sort()).toEqual(QUOTES)
      expect(workCandidates(found, NOW).filter((d) => QUOTES.includes(d.name)).length).toBe(3)
      // a picked file is read from the place it was found, never a path from the page
      const s = new WorkFileSessions(base, platform)
      s.begin('o', r.found)
      const id = docs.find((x) => x.name === QUOTES[0])!.id
      expect(s.allow('o', [id])).toBe(true)
      expect((await s.read('o', id)).ok).toBe(true)
    })
  }

  test('the walk is breadth first: a level is done before the next one down, whatever is newer deeper down', async () => {
    const deep = (d: number): Node => dir(d ? { [`x${d}`]: deep(d - 1), [`y${d}`]: deep(d - 1) } : { 'leaf.pdf': file(5000, NOW) }, NOW)
    const f = fakeFs(home({ Documents: dir({ Fresh: deep(6), Clients: dir({ Acme: dir({ 'Quote.xlsx': file(9000, NOW - 300 * DAY) }, NOW - 300 * DAY) }, NOW - 300 * DAY) }), Desktop: dir(), Downloads: dir() }))
    const r = await scanRoots([ROOTS[0]!], f.fs, opts({ limits: { walkFiles: 12 } }))
    expect(r.roots[0]!.cut).toBe(true)
    expect(r.files.map((x) => x.name)).toContain('Quote.xlsx')
  })

  test('one folder of thousands gives its share, office types first; its neighbours are still walked', async () => {
    const many: Record<string, Node> = {}
    for (let i = 0; i < 2000; i++) many[`note-${i}.txt`] = file(3000, NOW)
    many['Budget 2026.xlsx'] = file(9000, NOW)
    many['Contract.docx'] = file(9000, NOW)
    const f = fakeFs(home({ Documents: dir({ Inbox: dir(many, NOW), Quotes: dir({ 'Quote.xlsx': file(9000, NOW - DAY) }, NOW - DAY) }), Desktop: dir(), Downloads: dir() }))
    const r = await scanRoots([ROOTS[0]!], f.fs, opts({ limits: { folderDocs: 50 } }))
    const names = r.files.map((x) => x.name)
    expect(names).toContain('Budget 2026.xlsx')
    expect(names).toContain('Contract.docx')
    expect(names).toContain('Quote.xlsx')
    expect(names.filter((x) => x.startsWith('note-')).length).toBe(48)
    expect(r.roots[0]!.cut).toBe(true)
    // a folder of more entries than one folder gives: the rest is not read, the folders beside it are
    const wide: Record<string, Node> = {}
    for (let i = 0; i < 300; i++) wide[`junk-${i}.bin`] = file()
    const g = fakeFs(home({ Documents: dir({ Wide: dir(wide, NOW), Quotes: dir({ 'Quote.xlsx': file(9000, NOW - DAY) }, NOW - DAY) }), Desktop: dir(), Downloads: dir() }))
    const w = await scanRoots([ROOTS[0]!], g.fs, opts({ limits: { folderEntries: 100 } }))
    expect(w.files.map((x) => x.name)).toEqual(['Quote.xlsx'])
    expect(w.roots[0]!.cut).toBe(true)
  })

  test('Windows: a folder is walked even when Windows Search knows a few files in it, and does not wait for it', async () => {
    const f = fakeFs(home({ Documents: dir(bigDocuments()), Desktop: dir(), Downloads: dir() }))
    const fs = windowsFs(f.fs)
    const row = (p: string) => ({ path: `C:\\Users\\alex\\Documents\\${p}`, used: null, modified: NOW - DAY, useCount: null, size: 9000, origins: [], authors: ['Bo Kim'], org: 'Acme', listed: false })
    // the index knows two files (its 2,000 newest rows of the whole home folder held no more of Documents)
    const two = [row('QA desktop test\\Quotes\\Quote-Sora-Q1002.xlsx'), row('Old plan.docx')]
    let late: (v: unknown) => void = () => {}
    const slow = new Promise((ok) => { late = ok })
    const r = await lookRoots([WIN_ROOTS[0]!], fs, {
      platform: 'win32', newId: () => `id${n++}`, now: () => NOW, recentWaitMs: 200,
      index: async () => { await slow; return two },
      walkToo: (root) => root.id === 'documents',
    })
    late(null)
    expect(r.roots[0]).toMatchObject({ how: 'walk' })
    expect(r.files.filter((x) => QUOTES.includes(x.name)).length).toBe(3)
    // answered in time, its rows add what they know to the walked files (who wrote it, the company)
    const g = fakeFs(home({ Documents: dir(bigDocuments()), Desktop: dir(), Downloads: dir() }))
    const q = await lookRoots([WIN_ROOTS[0]!], windowsFs(g.fs), { platform: 'win32', newId: () => `id${n++}`, now: () => NOW, index: async () => two, walkToo: () => true })
    expect(q.files.filter((x) => QUOTES.includes(x.name)).length).toBe(3)
    expect(q.files.find((x) => x.name === 'Quote-Sora-Q1002.xlsx')).toMatchObject({ authors: ['Bo Kim'], org: 'Acme' })
    // without walkToo (another place): the index's files only, as before
    const h = fakeFs(home({ Documents: dir(bigDocuments()), Desktop: dir(), Downloads: dir() }))
    const only = await lookRoots([WIN_ROOTS[0]!], windowsFs(h.fs), { platform: 'win32', newId: () => `id${n++}`, now: () => NOW, index: async () => two })
    expect(only.roots[0]).toMatchObject({ how: 'index' })
    expect(only.files.map((x) => x.name)).toEqual(['Quote-Sora-Q1002.xlsx'])
  })

  test('"Choose a folder…" never looks through the apps\' data or a never-listed folder; a Mac\'s cloud drives are fine', () => {
    expect(pickRefused('/Users/alex/Documents/QA desktop test/Quotes', 'darwin')).toBe(false)
    expect(pickRefused('/Volumes/NAS/Sales', 'darwin')).toBe(false)
    expect(pickRefused('/Users/alex/Library/CloudStorage/OneDrive-Acme/Quotes', 'darwin')).toBe(false)
    expect(pickRefused('/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Work', 'darwin')).toBe(false)
    expect(pickRefused('/Users/alex/Library/CloudStorage', 'darwin')).toBe(true)
    expect(pickRefused('/Users/alex/Library/Application Support/Slack', 'darwin')).toBe(true)
    expect(pickRefused('/Users/alex/.ssh', 'darwin')).toBe(true)
    expect(pickRefused('/Users/alex/code/app/node_modules', 'darwin')).toBe(true)
    expect(pickRefused('C:\\Users\\alex\\Documents\\QA desktop test\\Quotes', 'win32')).toBe(false)
    expect(pickRefused('D:\\Work', 'win32')).toBe(false)
    expect(pickRefused('C:\\Users\\alex\\AppData\\Roaming\\Microsoft', 'win32')).toBe(true)
    expect(pickRefused('C:\\Users\\alex\\Documents\\My Games', 'win32')).toBe(true)
    // the system's folders and another person's (review of MAN-057)
    for (const x of ['C:\\Windows\\System32', 'C:\\Program Files\\Acme', 'C:\\Program Files (x86)', 'C:\\ProgramData\\x', 'C:\\Users\\bo\\Documents']) expect(pickRefused(x, 'win32', 'C:\\Users\\alex')).toBe(true)
    expect(pickRefused('C:\\Users\\Alex\\Documents', 'win32', 'C:\\Users\\alex')).toBe(false)
    expect(pickRefused('C:\\Users\\Public\\Documents', 'win32', 'C:\\Users\\alex')).toBe(false)
    for (const x of ['/System/Library', '/private/etc', '/usr/local', '/Applications/Numbers.app', '/Users/bo/Documents', '/Library/Preferences']) expect(pickRefused(x, 'darwin', '/Users/alex')).toBe(true)
    expect(pickRefused('/Users/Shared/Team', 'darwin', '/Users/alex')).toBe(false)
    // network shares (QA TC-4813): a share counts from below its name, as a drive from below its letter
    for (const x of ['\\\\nas\\company\\Sales', '\\\\localhost\\TrinaQAShare\\Team', '\\\\localhost\\TrinaQAShare', '\\\\nas\\Finance$\\2026', '\\\\localhost\\CDrive\\Users\\alex\\Documents', '\\\\localhost\\CDrive\\Users\\Public\\Documents']) expect(pickRefused(x, 'win32', 'C:\\Users\\alex')).toBe(false)
    for (const x of [
      // admin shares, device paths, WSL's, a path with no share
      '\\\\host\\C$\\Users\\alex\\Documents', '\\\\host\\c$', '\\\\host\\ADMIN$', '\\\\?\\C:\\Work', '\\\\.\\C:\\Work', '\\\\?\\UNC\\nas\\company\\Sales', '\\\\wsl$\\Ubuntu\\home\\alex', '\\\\nas',
      // the system's folders and another person's on a share of a drive's top
      '\\\\localhost\\CDrive\\Windows\\System32', '\\\\localhost\\CDrive\\Program Files\\Acme', '\\\\localhost\\CDrive\\ProgramData', '\\\\localhost\\CDrive\\Users\\bo\\Documents',
      // the apps' data and never-listed folders on a share
      '\\\\localhost\\CDrive\\Users\\alex\\AppData\\Roaming', '\\\\nas\\company\\.git', '\\\\nas\\company\\app\\node_modules',
    ]) expect(pickRefused(x, 'win32', 'C:\\Users\\alex')).toBe(true)
  })

  test('"Choose a folder…": inside one of the three folders (case, separators), or a folder of its own; never a whole path', () => {
    const win = ['C:\\Users\\alex\\Documents', 'C:\\Users\\alex\\Desktop', null]
    expect(pickTarget('C:\\Users\\Alex\\documents\\QA desktop test\\Quotes', win, 'win32')).toEqual({ root: 0, parts: ['QA desktop test', 'Quotes'], label: 'Quotes' })
    expect(pickTarget('C:\\Users\\alex\\Desktop\\', win, 'win32')).toEqual({ root: 1, parts: [], label: 'Desktop' })
    // a sibling whose name starts like a root's is not inside it
    expect(pickTarget('C:\\Users\\alex\\Documents2\\x', win, 'win32').root).toBe(-1)
    expect(pickTarget('C:\\Users\\alex\\..Documents', win, 'win32').root).toBe(-1)
    // a drive's top: its letter, never "D:\\"
    expect(pickTarget('D:\\', win, 'win32')).toEqual({ root: -1, parts: [], label: 'D' })
    // a folder named like a root folder keeps apart from it (its files would take the same names)
    expect(pickTarget('D:\\Archive\\Documents', win, 'win32').label).toBe('Documents (Archive)')
    const mac = ['/Users/alex/Documents', '/Users/alex/Desktop', '/Users/alex/Downloads']
    expect(pickTarget('/Users/alex/documents/Clients/Acme', mac, 'darwin')).toEqual({ root: 0, parts: ['Clients', 'Acme'], label: 'Acme' })
    expect(pickTarget('/Volumes/NAS/Sales', mac, 'darwin')).toEqual({ root: -1, parts: [], label: 'Sales' })
  })

  test('the time is shared: a slow first folder leaves the others their share; a cloud folder answered by the index still counts after the end', async () => {
    const big = () => dir(Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`sub${i}`, dir({ [`doc${i}.pdf`]: file(5000, NOW) }, NOW)])), NOW)
    const f = fakeFs(home({ Documents: big(), Desktop: big(), Downloads: big(), OneDrive: dir({ 'Plan.docx': file(9000, NOW) }) }))
    // every folder read takes 20 ms: Documents alone would need 2.4 s of the look's 3 s
    const slow: WorkFs = { ...f.fs, readdir: async (p, max) => { await new Promise((r) => setTimeout(r, 20)); return f.fs.readdir(p, max) } }
    const cloud: WorkRoot = { id: 'cloud', path: '/Users/alex/OneDrive', oneDrive: false, place: 'OneDrive' }
    let ready: (v: unknown) => void = () => {}
    const indexDone = new Promise((ok) => { ready = ok })
    setTimeout(() => ready(null), 3500)
    const t0 = Date.now()
    const r = await lookRoots([...ROOTS, cloud], slow, {
      platform: 'darwin', newId: () => `id${n++}`, now: () => Date.now(), deadline: Date.now() + 3000, recentWaitMs: 6000,
      walkToo: (root) => root.id !== 'cloud', noWalk: (root) => root.id === 'cloud',
      index: async () => { await indexDone; return [{ path: '/Users/alex/OneDrive/Plan.docx', used: null, modified: NOW, useCount: null, size: 9000, origins: [], authors: [], org: null }] },
    })
    const spent = Date.now() - t0
    // each of the three folders was walked (none skipped), each cut by its share
    expect(r.roots.slice(0, 3).map((x) => x.state)).toEqual(['ok', 'ok', 'ok'])
    expect(r.roots.slice(0, 3).every((x) => x.checked > 0)).toBe(true)
    // the cloud folder, never walked, gets its rows after the end
    expect(r.files.find((x) => x.name === 'Plan.docx')?.root).toBe('cloud')
    expect(spent).toBeLessThan(3000 + 2000 + 500)
  })

  test('the bridge: pickFolder is the page\'s only way to name a folder, and it names none (the system\'s window does)', () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toContain("ipcMain.handle('bridge:work-files-pick-folder', (e) => (fromApp(e) && e.senderFrame ? win!.workFiles.pickFolder(e.senderFrame.origin) : { state: 'unavailable' }))")
    const preload = readFileSync(join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
    expect(preload).toContain("pickFolder: () => ipcRenderer.invoke('bridge:work-files-pick-folder'),")
    const ctl = readFileSync(join(import.meta.dir, '../../desktop/src/main/work-files.ts'), 'utf8')
    // only after a look (the consent window's yes), never home or above, never the apps' data
    const pick = ctl.slice(ctl.indexOf('async pickFolder('), ctl.indexOf('private async consent('))
    expect(pick).toContain('if (!this.sessions.has(origin)) return { state: \'cancelled\' }')
    expect(pick).toContain('opensHome(realPicked, FOLDER_SYSTEM, process.platform, { shares: true })')
    // the picked folder's walk lets the same share through, and a share is looked at one call at a time
    expect(ctl).toContain('allowed: async (root) => !(await opensHome(root.path, FOLDER_SYSTEM, process.platform, { shares: true })),')
    expect(pick).toContain("realPicked.startsWith('\\\\\\\\')")
    // the other looks keep refusing every network path (the three folders' look and the wide look)
    expect(ctl).toContain('allowed: async (root) => !(await opensHome(root.path, FOLDER_SYSTEM, process.platform)),')
    expect(ctl).toContain('allowed: async (root: WorkRoot) => !(await opensHome(root.path, FOLDER_SYSTEM, process.platform)),')
    expect(pick).toContain('pickRefused(realPicked, process.platform, ')
    // a page script cannot open the window again and again: the person's own press, and a pause after each answer
    expect(pick).toContain('Date.now() - this.o.lastInput() > PERSON_INPUT_MS && !this.o.assistive()')
    expect(pick).toContain('this.quietUntil = Date.now() + COOLDOWN_MS')
    // a share one call at a time; a cloud drive's folder never walked into online-only folders
    expect(ctl).toContain("...(o.picked.serial ? { serial: true } : {}),")
    expect(ctl).toContain("placeholders: (paths: string[]) => macDatalessSet(paths)")
    expect(pick).toContain('this.sessions.extend(origin, res.found)')
  })
})
