// The desktop app saves the team page's downloads straight into Downloads (desktop/src/common/downloads.ts, QA
// TC-4638): the name is not trusted, a file that is there is never replaced, the path stays inside the folder.
import { describe, expect, mock, test } from 'bun:test'
import { posix, win32 } from 'node:path'
import {
  DIRECT_SAVES_MAX,
  DIRECT_SAVES_WINDOW_MS,
  DOWNLOAD_FALLBACK_NAME,
  DOWNLOAD_NAME_MAX_BYTES,
  SaveBurst,
  downloadOutcome,
  pickDownloadPath,
  quarantineValue,
  runsCode,
  safeDownloadName,
  zoneIdentifierText,
} from '../../desktop/src/common/downloads'

describe('safeDownloadName', () => {
  test('an ordinary name is kept as it is', () => {
    expect(safeDownloadName('Q3 report.pdf')).toBe('Q3 report.pdf')
    expect(safeDownloadName('견적서 (최종).hwp')).toBe('견적서 (최종).hwp')
    expect(safeDownloadName('archive.tar.gz')).toBe('archive.tar.gz')
  })
  test('folder parts are dropped, with either slash', () => {
    expect(safeDownloadName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(safeDownloadName('..\\..\\Start Menu\\run.bat')).toBe('run.bat')
    expect(safeDownloadName('/etc/passwd')).toBe('passwd')
    expect(safeDownloadName('C:\\Windows\\system.ini')).toBe('system.ini')
  })
  test('no leading dots: no "..", no hidden file', () => {
    expect(safeDownloadName('..')).toBe(DOWNLOAD_FALLBACK_NAME)
    expect(safeDownloadName('.')).toBe(DOWNLOAD_FALLBACK_NAME)
    expect(safeDownloadName('.bashrc')).toBe('bashrc')
    expect(safeDownloadName(' . ..env')).toBe('env')
  })
  test('no trailing dots or spaces (Windows drops them)', () => {
    expect(safeDownloadName('report.pdf. ')).toBe('report.pdf')
  })
  test('characters Windows refuses, control characters and direction marks', () => {
    expect(safeDownloadName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt')
    expect(safeDownloadName('re\u0000po\nrt\u007f.pdf')).toBe('report.pdf')
    expect(safeDownloadName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
  })
  test('Windows device names', () => {
    expect(safeDownloadName('CON')).toBe('_CON')
    expect(safeDownloadName('nul.txt')).toBe('_nul.txt')
    expect(safeDownloadName('COM1.pdf')).toBe('_COM1.pdf')
    expect(safeDownloadName('console.log')).toBe('console.log')
    expect(safeDownloadName('CONIN$')).toBe('_CONIN$')
    expect(safeDownloadName('conout$.txt')).toBe('_conout$.txt')
    expect(safeDownloadName('nul .txt')).toBe('_nul .txt')
    expect(safeDownloadName('COM¹.pdf')).toBe('_COM¹.pdf')
    expect(safeDownloadName('lpt9')).toBe('_lpt9')
    expect(safeDownloadName('company.pdf')).toBe('company.pdf')
  })
  test('nothing usable: the fallback name', () => {
    for (const raw of ['', '   ', '///', '\\', undefined, null, 7, {}]) expect(safeDownloadName(raw)).toBe(DOWNLOAD_FALLBACK_NAME)
  })
  test('a long name is cut, the extension kept, no character split', () => {
    const long = safeDownloadName('가'.repeat(300) + '.pdf')
    expect(long.endsWith('.pdf')).toBe(true)
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(DOWNLOAD_NAME_MAX_BYTES)
    expect(long).not.toContain('\uFFFD')
    expect(Buffer.byteLength(safeDownloadName('x'.repeat(5000)), 'utf8')).toBe(DOWNLOAD_NAME_MAX_BYTES)
  })
})

describe('pickDownloadPath', () => {
  const dir = '/Users/someone/Downloads'
  const pick = (raw: unknown, there: string[] = []) => pickDownloadPath(dir, raw, (p) => there.includes(p), { path: posix })

  test('a free name is used as it is', () => {
    expect(pick('report.pdf')).toBe(`${dir}/report.pdf`)
  })
  test('a name that is there is never replaced: (1), (2) before the extension', () => {
    expect(pick('report.pdf', [`${dir}/report.pdf`])).toBe(`${dir}/report (1).pdf`)
    expect(pick('report.pdf', [`${dir}/report.pdf`, `${dir}/report (1).pdf`])).toBe(`${dir}/report (2).pdf`)
    expect(pick('notes', [`${dir}/notes`])).toBe(`${dir}/notes (1)`)
    expect(pick('archive.tar.gz', [`${dir}/archive.tar.gz`])).toBe(`${dir}/archive.tar (1).gz`)
  })
  test('the path stays directly inside the folder whatever the name says', () => {
    for (const raw of ['../../etc/passwd', '..', '../', '/abs/olute', '..\\..\\x.exe', 'a/b/c.txt', '.', '~/x', '\u0000', 'sub/../../../x']) {
      const got = pick(raw)!
      expect(got.startsWith(`${dir}/`)).toBe(true)
      expect(posix.dirname(got)).toBe(dir)
    }
  })
  test('Windows paths', () => {
    const w = 'C:\\Users\\someone\\Downloads'
    const got = pickDownloadPath(w, '..\\..\\Desktop\\x.exe', (p) => p === `${w}\\x.exe`, { path: win32 })
    expect(got).toBe(`${w}\\x (1).exe`)
    expect(pickDownloadPath(w, 'C:evil.txt', () => false, { path: win32 })).toBe(`${w}\\C_evil.txt`)
  })
  test('every numbered name taken: a name with the time, or nothing', () => {
    const all = (p: string) => !p.includes('(1700000000000)')
    expect(pickDownloadPath(dir, 'a.txt', all, { path: posix, now: () => 1700000000000 })).toBe(`${dir}/a (1700000000000).txt`)
    expect(pickDownloadPath(dir, 'a.txt', () => true, { path: posix })).toBeNull()
  })
  test('two downloads of the same file at once get two names', () => {
    const onTheWay = new Set<string>()
    const first = pickDownloadPath(dir, 'a.txt', (p) => onTheWay.has(p), { path: posix })!
    onTheWay.add(first)
    const second = pickDownloadPath(dir, 'a.txt', (p) => onTheWay.has(p), { path: posix })!
    expect([first, second]).toEqual([`${dir}/a.txt`, `${dir}/a (1).txt`])
  })
})

test('downloadOutcome: a cancel says nothing, anything else that is not complete failed', () => {
  expect(downloadOutcome('completed')).toBe('saved')
  expect(downloadOutcome('cancelled')).toBeNull()
  expect(downloadOutcome('interrupted')).toBe('failed')
})

describe('runsCode: these keep the save window', () => {
  test('Mac and Windows types that run code', () => {
    for (const n of ['x.app', 'run.command', 'a.tool', 'a.terminal', 'a.sh', 'a.zsh', 'a.bash', 'a.pkg', 'a.mpkg', 'a.dmg', 'a.jar', 'a.webloc', 'a.inetloc', 'a.fileloc', 'a.scpt', 'a.applescript', 'a.workflow', 'a.action'])
      expect(runsCode(n)).toBe(true)
    for (const n of ['a.iso', 'a.img', 'a.vhd', 'a.vhdx', 'a.chm', 'a.msp', 'a.mst', 'a.appref-ms', 'a.settingcontent-ms', 'a.xll', 'a.jnlp', 'a.vb', 'a.wsc', 'a.sct', 'a.library-ms', 'a.search-ms', 'a.diagcab', 'a.scptd'])
      expect(runsCode(n)).toBe(true)
    for (const n of ['a.exe', 'a.msi', 'a.msix', 'a.msixbundle', 'a.appx', 'a.appxbundle', 'a.bat', 'a.cmd', 'a.com', 'a.scr', 'a.ps1', 'a.psm1', 'a.vbs', 'a.vbe', 'a.js', 'a.jse', 'a.wsf', 'a.wsh', 'a.hta', 'a.lnk', 'a.url', 'a.scf', 'a.reg', 'a.cpl', 'a.inf', 'a.pif', 'a.application'])
      expect(runsCode(n)).toBe(true)
  })
  test('the last extension decides', () => {
    expect(runsCode('a.pdf.exe')).toBe(true)
    expect(runsCode('a.exe.pdf')).toBe(false)
  })
  test('any case, trailing dots and spaces, a path or marks in front', () => {
    expect(runsCode('SETUP.EXE')).toBe(true)
    expect(runsCode('setup.Exe. . ')).toBe(true)
    expect(runsCode('..\\..\\run.bat')).toBe(true)
    expect(runsCode('invoice\u202Efdp.exe')).toBe(true)
  })
  test('documents and names with no extension go straight in', () => {
    for (const n of ['report.pdf', 'sheet.xlsx', '견적서.hwp', 'photo.png', 'notes', 'archive.tar.gz', 'exe', 'app', 'a.json', '', undefined]) expect(runsCode(n)).toBe(false)
  })
})

describe('SaveBurst: three direct saves in ten seconds from one page', () => {
  test('the fourth within the window is refused, and allowed again once the window has passed', () => {
    let t = 1_000_000
    const b = new SaveBurst(() => t)
    for (let i = 0; i < DIRECT_SAVES_MAX; i++) expect(b.take()).toBe(true)
    expect(b.take()).toBe(false)
    t += DIRECT_SAVES_WINDOW_MS - 1
    expect(b.take()).toBe(false)
    t += 1
    expect(b.take()).toBe(true)
  })
  test('saves spread out are never refused', () => {
    let t = 0
    const b = new SaveBurst(() => t)
    for (let i = 0; i < 20; i++) {
      expect(b.take()).toBe(true)
      t += 4000
    }
  })
  test('refused tries do not count', () => {
    let t = 0
    const b = new SaveBurst(() => t)
    for (let i = 0; i < 3; i++) b.take()
    for (let i = 0; i < 5; i++) expect(b.take()).toBe(false)
    t = DIRECT_SAVES_WINDOW_MS
    expect(b.take()).toBe(true)
  })
})

describe('the downloaded-from-the-internet mark', () => {
  test('quarantine value: 0083, hex seconds, the app', () => {
    expect(quarantineValue(1_700_000_000_123)).toBe('0083;6553f100;Trina AX;')
    expect(quarantineValue(0, 'a;b')).toBe('0083;0;ab;')
  })
  test('zone text: zone 3, web addresses only, no user name or password', () => {
    expect(zoneIdentifierText()).toBe('[ZoneTransfer]\r\nZoneId=3\r\n')
    expect(zoneIdentifierText({ url: 'https://user:pw@team.example/api/files/1', referrer: 'https://team.example/rooms/2' })).toBe(
      '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://team.example/rooms/2\r\nHostUrl=https://team.example/api/files/1\r\n',
    )
    for (const url of ['blob:https://team.example/abc', 'data:text/plain,hi', 'file:///etc/passwd', 'javascript:x', 'not a url', 'https://a.example/\r\nZoneId=0', 7])
      expect(zoneIdentifierText({ url, referrer: url })).toBe('[ZoneTransfer]\r\nZoneId=3\r\n')
  })
})

describe('DirectDownloads: every finished download is marked, the save window\'s too', async () => {
  mock.module('electron', () => ({ shell: { showItemInFolder: () => {}, openPath: async () => '' } }))
  const { DirectDownloads } = await import('../../desktop/src/main/downloads')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  type Handler = (...a: any[]) => unknown
  function fakeItem(name: string, url = 'https://team.example/api/files/1') {
    const on: Record<string, Handler[]> = {}
    let savePath = ''
    return {
      getFilename: () => name,
      getURL: () => url,
      getSavePath: () => savePath,
      setSavePath: (p: string) => { savePath = p },
      canResume: () => false,
      on: (ev: string, h: Handler) => { (on[ev] ??= []).push(h) },
      once: (ev: string, h: Handler) => { (on[ev] ??= []).push(h) },
      /** the person chose this place in the save window */
      choose: (p: string) => { savePath = p },
      finish: async (state: string) => { for (const h of on.done ?? []) await h({}, state) },
    }
  }
  function fakePage() {
    const sent: unknown[] = []
    return { sent, isDestroyed: () => false, getURL: () => 'https://team.example/rooms/2', on: () => {}, send: (_ch: string, v: unknown) => sent.push(v) }
  }
  function setup(o: { mas?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dl-mark-'))
    const marked: { path: string; url?: string; referrer?: string }[] = []
    const dd = new DirectDownloads({ dir: () => dir, mas: o.mas ?? false, mark: async (path, m) => { marked.push({ path, url: m?.url, referrer: m?.referrer }) } })
    let listener: Handler = () => {}
    dd.attach({ on: (_ev: string, h: Handler) => { listener = h } } as any)
    return { dir, dd, marked, start: (item: ReturnType<typeof fakeItem>, wc: ReturnType<typeof fakePage>) => listener({}, item, wc), done: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('a direct save is marked once, before the notice', async () => {
    const t = setup()
    const wc = fakePage()
    t.dd.pageReady(wc as any)
    const item = fakeItem('report.pdf')
    t.start(item, wc)
    expect(item.getSavePath()).toBe(join(t.dir, 'report.pdf'))
    await item.finish('completed')
    expect(t.marked).toEqual([{ path: join(t.dir, 'report.pdf'), url: 'https://team.example/api/files/1', referrer: 'https://team.example/rooms/2' }])
    expect(wc.sent).toEqual([{ id: 1, name: 'report.pdf', ok: true }])
    t.done()
  })
  test('a runnable file goes through the save window and is marked too, with no notice', async () => {
    const t = setup()
    const wc = fakePage()
    t.dd.pageReady(wc as any)
    const item = fakeItem('setup.exe')
    t.start(item, wc)
    expect(item.getSavePath()).toBe('')
    item.choose('/chosen/setup.exe')
    await item.finish('completed')
    expect(t.marked.map((m) => m.path)).toEqual(['/chosen/setup.exe'])
    expect(wc.sent).toEqual([])
    t.done()
  })
  test('a page that is not ready, and the fourth save in a row, are marked through the save window', async () => {
    const t = setup()
    const notReady = fakePage()
    const a = fakeItem('a.pdf')
    t.start(a, notReady)
    a.choose('/chosen/a.pdf')
    await a.finish('completed')
    const wc = fakePage()
    t.dd.pageReady(wc as any)
    const items = ['1.pdf', '2.pdf', '3.pdf', '4.pdf'].map((n) => fakeItem(n))
    for (const it of items) t.start(it, wc)
    expect(items[3].getSavePath()).toBe('')
    items[3].choose('/chosen/4.pdf')
    for (const it of items) await it.finish('completed')
    expect(t.marked.map((m) => m.path)).toEqual(['/chosen/a.pdf', join(t.dir, '1.pdf'), join(t.dir, '2.pdf'), join(t.dir, '3.pdf'), '/chosen/4.pdf'])
    t.done()
  })
  test('cancelled or failed: nothing marked; the Mac App Store build: left to its sandbox', async () => {
    const t = setup()
    const wc = fakePage()
    t.dd.pageReady(wc as any)
    const c = fakeItem('c.pdf')
    t.start(c, wc)
    await c.finish('cancelled')
    const f = fakeItem('f.pdf')
    t.start(f, wc)
    await f.finish('interrupted')
    expect(t.marked).toEqual([])
    expect(wc.sent).toEqual([{ id: 2, name: 'f.pdf', ok: false }])
    t.done()
    const m = setup({ mas: true })
    const i = fakeItem('x.exe')
    m.start(i, fakePage())
    i.choose('/chosen/x.exe')
    await i.finish('completed')
    expect(m.marked).toEqual([])
    m.done()
  })
})
