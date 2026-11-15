// Find work files, part 4 (docs/DECISIONS.md "Find work files, part 4: ask the computer's index"): the parsers of
// Spotlight's (mdfind, mdls) and Windows' (Windows Search's JSON, Office's recent list, Zone.Identifier) answers, the
// merge of several sources, recency, and the look: each folder asked first, then its index; the walk only when there is
// no index; index hits only inside the folder, never through a link, recent, a document, the right size. Made-up text
// and a made-up file system only: nothing of this computer is read.
import { describe, expect, test } from 'bun:test'
import { hostsOf, isRecent, macPath, mdfindArgs, mergeIndexed, parseMdfind, parseMdls, parseOfficeMru, parseWindowsSearch, parseZoneIdentifier, windowsSearchScript, type IndexedFile } from '../../desktop/src/common/work-index'
import { filesFromIndex, lookRoots, type WorkFs, type WorkRoot, type WorkStat } from '../../desktop/src/common/work-files'

const NOW = Date.UTC(2026, 10, 15, 12)
const DAY = 86_400_000

describe('Spotlight on a Mac', () => {
  test('the query asks one folder for files used or changed in the last 180 days', () => {
    const a = mdfindArgs('/Users/alex/Documents')
    expect(a.slice(0, 3)).toEqual(['-onlyin', '/Users/alex/Documents', '-0'])
    expect(a[3]).toContain('kMDItemLastUsedDate >= $time.today(-180)')
    expect(a[3]).toContain('kMDItemFSContentChangeDate >= $time.today(-180)')
    expect(parseMdfind('/Users/alex/Documents/a.pdf\0/Users/alex/Documents/b c.docx\0')).toEqual(['/Users/alex/Documents/a.pdf', '/Users/alex/Documents/b c.docx'])
    expect(macPath('/System/Volumes/Data/Users/alex/Documents/a.pdf')).toBe('/Users/alex/Documents/a.pdf')
  })

  test('mdls for several files: dates, counts, lists over several lines, addresses with commas, (null)', () => {
    const out = [
      'kMDItemAuthors             = (',
      '    "Alex Kim",',
      '    "Bo Lee"',
      ')',
      'kMDItemFSContentChangeDate = 2026-11-10 09:00:00 +0000',
      'kMDItemFSSize              = 48213',
      'kMDItemLastUsedDate        = 2026-11-12 08:30:00 +0000',
      'kMDItemOrganizations       = (',
      '    "Acme Inc."',
      ')',
      'kMDItemPath                = "/System/Volumes/Data/Users/alex/Downloads/Quote, final.pdf"',
      'kMDItemUseCount            = 6',
      'kMDItemWhereFroms          = (',
      '    "https://files.slack.com/files-pri/T01-F02/quote,final.pdf?token=SECRET",',
      '    "https://acme.slack.com/archives/C1"',
      ')',
      'kMDItemAuthors             = (null)',
      'kMDItemFSContentChangeDate = 2026-01-02 10:00:00 +0000',
      'kMDItemFSSize              = 1200',
      'kMDItemLastUsedDate        = (null)',
      'kMDItemOrganizations       = (null)',
      'kMDItemPath                = "/Users/alex/Documents/notes.txt"',
      'kMDItemUseCount            = (null)',
      'kMDItemWhereFroms          = (null)',
    ].join('\n')
    const [a, b] = parseMdls(out)
    expect(a).toEqual({ path: '/Users/alex/Downloads/Quote, final.pdf', used: Date.UTC(2026, 10, 12, 8, 30), modified: Date.UTC(2026, 10, 10, 9), useCount: 6, size: 48213, origins: ['files.slack.com', 'acme.slack.com'], authors: ['Alex Kim', 'Bo Lee'], org: 'Acme Inc.' })
    // only hosts: never the address (it can hold a token)
    expect(JSON.stringify(a)).not.toContain('SECRET')
    expect(b).toMatchObject({ path: '/Users/alex/Documents/notes.txt', used: null, useCount: null, origins: [], authors: [], org: null })
  })
})

describe('Windows', () => {
  test('the Windows Search query: the folders, the date, quotes doubled', () => {
    const s = windowsSearchScript(["C:\\Users\\o'neil\\Documents", 'C:\\Users\\o\'neil\\Downloads'], 180, NOW)
    expect(s).toContain("SCOPE=''file:C:/Users/o''''neil/Documents''")
    expect(s).toContain('Search.CollatorDSO')
    expect(s).toContain("System.DateModified >= ''2026-05-19")
    expect(s).toContain('ConvertTo-Json')
  })
  test('its JSON: one row or many, dates as /Date()/ or text', () => {
    expect(parseWindowsSearch('{"p":"C:\\\\Users\\\\alex\\\\Documents\\\\Plan.docx","a":"/Date(1762992000000)/","m":"2026-11-01T10:00:00","s":2048,"au":["Alex"],"co":"Acme"}')).toEqual([
      { path: 'C:\\Users\\alex\\Documents\\Plan.docx', used: 1762992000000, modified: Date.parse('2026-11-01T10:00:00'), useCount: null, size: 2048, origins: [], authors: ['Alex'], org: 'Acme' },
    ])
    expect(parseWindowsSearch('')).toEqual([])
    expect(parseWindowsSearch('not json')).toEqual([])
    expect(parseWindowsSearch('[{"p":"a"},{"x":1}]')).toHaveLength(1)
  })
  test('Office\'s recent files (reg query lines or bare values) with their FILETIME', () => {
    const t = (BigInt(Date.UTC(2026, 10, 14)) + 11_644_473_600_000n) * 10_000n
    const hex = t.toString(16).toUpperCase().padStart(16, '0')
    const out = `    Item 1    REG_SZ    [F00000000][T${hex}][O00000000]*C:\\Users\\alex\\Documents\\Budget.xlsx\n[F00000000][T${hex}]*C:\\Users\\alex\\Desktop\\Deck.pptx\nnoise`
    expect(parseOfficeMru(out)).toEqual([{ path: 'C:\\Users\\alex\\Documents\\Budget.xlsx', used: Date.UTC(2026, 10, 14) }, { path: 'C:\\Users\\alex\\Desktop\\Deck.pptx', used: Date.UTC(2026, 10, 14) }])
  })
  test('a download\'s Zone.Identifier: the hosts only', () => {
    expect(parseZoneIdentifier('[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://acme.sharepoint.com/sites/x\r\nHostUrl=https://acme-my.sharepoint.com/personal/a/file.docx?download=1\r\n')).toEqual(['acme.sharepoint.com', 'acme-my.sharepoint.com'])
    expect(hostsOf(['not a url', 'https://Drive.Google.com/x'])).toEqual(['drive.google.com'])
  })
})

describe('several sources, recency', () => {
  const f = (path: string, o: Partial<IndexedFile> = {}): IndexedFile => ({ path, used: null, modified: null, useCount: null, size: null, origins: [], authors: [], org: null, ...o })
  test('the same file from the index, Recent and Office: one, the newest use, every hint; without case on Windows', () => {
    const m = mergeIndexed([[f('C:\\Users\\a\\Documents\\Plan.docx', { modified: 5, origins: ['x.com'] })], [f('c:\\users\\a\\documents\\plan.docx', { used: 9, origins: ['y.com'], org: 'Acme' })]], 'win32')
    expect(m).toEqual([f('C:\\Users\\a\\Documents\\Plan.docx', { used: 9, modified: 5, origins: ['x.com', 'y.com'], org: 'Acme' })])
  })
  test('recent: used or changed within 180 days', () => {
    expect(isRecent({ used: NOW - 10 * DAY, modified: null }, NOW)).toBe(true)
    expect(isRecent({ used: null, modified: NOW - 179 * DAY }, NOW)).toBe(true)
    expect(isRecent({ used: NOW - 200 * DAY, modified: NOW - 300 * DAY }, NOW)).toBe(false)
    expect(isRecent({ used: null, modified: null }, NOW)).toBe(false)
  })
})

// ---------------------------------------------------------------- the look

type Node = { dir: Record<string, Node> } | { size: number; mtimeMs: number; ino: bigint } | { link: string }
let ino = 1000n
const file = (size = 5000, mtimeMs = NOW - 5 * DAY): Node => ({ size, mtimeMs, ino: ino++ })
const dir = (c: Record<string, Node> = {}): Node => ({ dir: c })
function fakeFs(tree: Record<string, Node>, denied = new Set<string>()) {
  const root: Node = dir(tree)
  const calls: string[] = []
  const at = (p: string): Node | null => {
    let cur: Node = root
    for (const part of p.split('/').filter(Boolean)) {
      if (!('dir' in cur)) return null
      const next: Node | undefined = cur.dir[part]
      if (!next) return null
      cur = next
    }
    return cur
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const fs: WorkFs = {
    async readdir(p, max) {
      calls.push(`readdir ${p}`)
      if ([...denied].some((d) => p === d || p.startsWith(d + '/'))) throw err('EPERM')
      const n = at(p)
      if (!n || !('dir' in n)) throw err('ENOENT')
      return Object.entries(n.dir).slice(0, max).map(([name, c]) => ({ name, kind: 'dir' in c ? 'dir' : 'link' in c ? 'link' : 'file' }))
    },
    async lstat(p) {
      const n = at(p)
      if (!n) throw err('ENOENT')
      const st: WorkStat = 'size' in n ? { kind: 'file', size: n.size, mtimeMs: n.mtimeMs, dev: 1n, ino: n.ino } : { kind: 'dir' in n ? 'dir' : 'link', size: 0, mtimeMs: 0, dev: 1n, ino: 1n }
      return st
    },
    async realpath(p) {
      // a link part resolves somewhere else
      const parts = p.split('/').filter(Boolean)
      let cur: Node = root
      for (let i = 0; i < parts.length; i++) {
        if (!('dir' in cur)) throw err('ENOTDIR')
        const next: Node | undefined = cur.dir[parts[i]!]
        if (!next) throw err('ENOENT')
        if ('link' in next) return next.link + '/' + parts.slice(i + 1).join('/')
        cur = next
      }
      return '/' + parts.join('/')
    },
    async open() { calls.push('open'); throw err('EACCES') },
  }
  return { fs, calls }
}
const ROOTS: WorkRoot[] = [{ id: 'documents', path: '/Users/alex/Documents', oneDrive: false }, { id: 'desktop', path: '/Users/alex/Desktop', oneDrive: false }, { id: 'downloads', path: '/Users/alex/Downloads', oneDrive: false }]
let n = 0
const newId = () => `id${n++}`
const idx = (path: string, o: Partial<IndexedFile> = {}): IndexedFile => ({ path, used: NOW - 3 * DAY, modified: NOW - 20 * DAY, useCount: 2, size: 5000, origins: [], authors: [], org: null, ...o })

describe('the look with the index', () => {
  test('index hits: inside the folder, no link on the way, a document, recent, 1 KB to 50 MB; the hints kept; nothing opened', async () => {
    const { fs, calls } = fakeFs({ Users: dir({ alex: dir({
      Documents: dir({ Clients: dir({ 'Plan.docx': file() }), 'old.pdf': file(5000, NOW - 400 * DAY), 'tiny.txt': file(10), 'movie.mp4': file(), 'big.pdf': file(60 * 1024 * 1024), 'via-link': { link: '/Users/alex/.secret' }, node_modules: dir({ 'x.md': file() }) }),
      '.secret': dir({ 'key.pdf': file() }),
    }) }) })
    const r = await filesFromIndex(ROOTS[0]!, '/Users/alex/Documents', [
      idx('/Users/alex/Documents/Clients/Plan.docx', { origins: ['acme.slack.com'], authors: ['Bo'], org: 'Acme' }),
      idx('/Users/alex/Documents/old.pdf', { used: null, modified: NOW - 400 * DAY }),
      idx('/Users/alex/Documents/tiny.txt'),
      idx('/Users/alex/Documents/movie.mp4'),
      idx('/Users/alex/Documents/big.pdf'),
      idx('/Users/alex/Documents/via-link/key.pdf'),
      idx('/Users/alex/Documents/node_modules/x.md'),
      idx('/Users/alex/Desktop/elsewhere.pdf'),
      idx('/Users/alex/Documents'),
    ], fs, { platform: 'darwin', newId, now: () => NOW })
    expect(r.files.map((x) => `${x.folder}/${x.name}`)).toEqual(['Clients/Plan.docx'])
    expect(r.files[0]).toMatchObject({ used: NOW - 3 * DAY, useCount: 2, origins: ['acme.slack.com'], authors: ['Bo'], org: 'Acme', root: 'documents' })
    expect(r.tooBig).toBe(1)
    expect(JSON.stringify(r.files)).not.toContain('/Users/alex')
    expect(calls).not.toContain('open')
  })

  test('each folder is asked first (its first entry), then its index; a blocked folder is never queried; no index: the walk', async () => {
    const asked: string[] = []
    const { fs, calls } = fakeFs({ Users: dir({ alex: dir({ Documents: dir({ 'a.pdf': file() }), Desktop: dir({ 'b.docx': file() }), Downloads: dir({ 'c.xlsx': file() }) }) }) }, new Set(['/Users/alex/Desktop']))
    const progress: number[] = []
    const r = await lookRoots(ROOTS, fs, {
      platform: 'darwin', newId, now: () => NOW, onProgress: (p) => progress.push(p.done),
      index: async (real) => {
        asked.push(real)
        if (real.endsWith('Downloads')) return null
        return [idx(`${real}/a.pdf`)]
      },
    })
    expect(r.roots.map((x) => [x.id, x.state, x.how])).toEqual([['documents', 'ok', 'index'], ['desktop', 'blocked', undefined], ['downloads', 'ok', 'walk']])
    expect(asked).toEqual(['/Users/alex/Documents', '/Users/alex/Downloads'])
    // the folder's question (its first read) comes before its index
    expect(calls[0]).toBe('readdir /Users/alex/Documents')
    expect(r.files.map((x) => `${x.root}:${x.name}`)).toEqual(['documents:a.pdf', 'downloads:c.xlsx'])
    expect(progress.at(-1)).toBe(1)
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1]!)).toBe(true)
  })

  test('a Mac walks, then asks the index only about the newest documents: their use, origin and authors join the files', async () => {
    const { fs } = fakeFs({ Users: dir({ alex: dir({ Documents: dir({ 'Plan.docx': file(), 'Old.pdf': file(5000, NOW - 30 * DAY) }), Desktop: dir(), Downloads: dir() }) }) })
    const asked: string[][] = []
    const r = await lookRoots(ROOTS, fs, { platform: 'darwin', newId, now: () => NOW, index: async () => null,
      enrich: async (paths) => { asked.push(paths); return paths.filter((p) => p.endsWith('Plan.docx')).map((p) => idx(p, { used: NOW - DAY, useCount: 4, origins: ['acme.slack.com'], authors: ['Bo'] })) } })
    expect(asked[0]!.sort()).toEqual(['/Users/alex/Documents/Old.pdf', '/Users/alex/Documents/Plan.docx'])
    expect(r.files.find((f) => f.name === 'Plan.docx')).toMatchObject({ used: NOW - DAY, useCount: 4, origins: ['acme.slack.com'], authors: ['Bo'] })
    expect(r.files.find((f) => f.name === 'Old.pdf')!.used).toBeUndefined()
    expect(r.roots[0]!.how).toBe('walk')
  })

  test('Windows Search that knows nothing of a folder with entries (Documents moved to D:\\): that folder is walked', async () => {
    const { fs } = fakeFs({ Users: dir({ alex: dir({ Documents: dir({ 'a.pdf': file() }), Desktop: dir(), Downloads: dir({ 'b.pdf': file() }) }) }) })
    const r = await lookRoots(ROOTS, fs, { platform: 'darwin', newId, now: () => NOW, index: async () => [idx('/Users/alex/Downloads/b.pdf')] })
    expect(r.roots.map((x) => x.how)).toEqual(['walk', 'index', 'index'])
    expect(r.files.map((x) => x.name).sort()).toEqual(['a.pdf', 'b.pdf'])
  })
})

describe('PowerShell', () => {
  test('quotes, the curly ones too, are doubled; the script goes encoded, never through a command line', async () => {
    const { psQuote, powershellArgs } = await import('../../desktop/src/common/work-index')
    expect(psQuote("O'Brien \u2019x\u2018")).toBe("O''Brien \u2019\u2019x\u2018\u2018")
    const a = powershellArgs("Write-Output 'a'")
    expect(a.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(a[3]!, 'base64').toString('utf16le')).toBe("Write-Output 'a'")
    expect(windowsSearchScript(['C:\\Users\\a\\Documents'])).toContain('ORDER BY System.DateModified DESC')
  })
})
