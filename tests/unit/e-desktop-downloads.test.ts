// The desktop app saves the team page's downloads straight into Downloads (desktop/src/common/downloads.ts, QA
// TC-4638): the name is not trusted, a file that is there is never replaced, the path stays inside the folder.
import { describe, expect, test } from 'bun:test'
import { posix, win32 } from 'node:path'
import { DOWNLOAD_FALLBACK_NAME, DOWNLOAD_NAME_MAX_BYTES, downloadOutcome, pickDownloadPath, safeDownloadName } from '../../desktop/src/common/downloads'

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
