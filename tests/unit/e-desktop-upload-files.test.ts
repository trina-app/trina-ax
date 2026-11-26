// file_upload's files on the person's computer (desktop/src/common/upload-files.ts, component E): names that are safe
// everywhere, the temp layout and its cleanup, and the order the ways are tried in.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanUploadName, NAME_MAX, sha256Hex, uploadOrder, uploadRoot, UploadTemp } from '../../desktop/src/common/upload-files'

const made: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'up-test-')); made.push(d); return d }
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('upload file names', () => {
  test('NFC, no path parts or Windows-forbidden characters, no reserved names or trailing dots, never empty', () => {
    expect(cleanUploadName('견적서.pdf'.normalize('NFD'))).toBe('견적서.pdf')
    expect(cleanUploadName('../../etc/passwd')).toBe('___.._etc_passwd')
    expect(cleanUploadName('a\\b:c*d?e"f<g>h|i.txt')).toBe('a_b_c_d_e_f_g_h_i.txt')
    expect(cleanUploadName('report.  ')).toBe('report')
    expect(cleanUploadName('CON')).toBe('_CON')
    expect(cleanUploadName('nul.txt')).toBe('_nul.txt')
    expect(cleanUploadName('com1.pdf')).toBe('_com1.pdf')
    expect(cleanUploadName('console.pdf')).toBe('console.pdf')
    expect(cleanUploadName('')).toBe('file')
    expect(cleanUploadName('...')).toBe('file')
    expect(cleanUploadName('.env')).toBe('_env')
    expect(cleanUploadName('a\u0000b\nc.txt')).toBe('a_b_c.txt')
    expect(cleanUploadName('evil‮fdp.exe')).toBe('evilfdp.exe')
  })

  test('long names are cut to NAME_MAX characters with the extension kept (by characters, not bytes)', () => {
    const long = `${'가'.repeat(300)}.pdf`
    const c = cleanUploadName(long)
    expect(Array.from(c).length).toBe(NAME_MAX)
    expect(c.endsWith('.pdf')).toBe(true)
    const emoji = cleanUploadName(`${'😀'.repeat(200)}.docx`)
    expect(Array.from(emoji).length).toBe(NAME_MAX)
    expect(emoji.endsWith('.docx')).toBe(true)
    expect(emoji).not.toContain('�')
  })
})

describe('upload temp files', () => {
  test('<temp>/<product>-up/<callId>/<i>/<name>, folders 0700 and files 0600, the bytes as given', () => {
    const t = new UploadTemp(uploadRoot(tmp(), 'mycel'))
    const [a, b] = t.write('call-1', 'tab-1', [{ name: '사업자등록증.pdf', bytes: Buffer.from('one') }, { name: '사업자등록증.pdf', bytes: Buffer.from('two') }])
    expect(path.relative(t.root, a!).split(path.sep)).toEqual(['call-1', '0', '사업자등록증.pdf'])
    expect(path.relative(t.root, b!).split(path.sep)).toEqual(['call-1', '1', '사업자등록증.pdf'])
    expect(fs.readFileSync(b!, 'utf8')).toBe('two')
    expect(path.basename(t.root)).toBe('mycel-up')
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(a!)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(t.root, 'call-1')).mode & 0o777).toBe(0o700)
      expect(fs.statSync(a!).mode & 0o777).toBe(0o600)
    }
    expect(t.bytes).toBe(6)
    expect(sha256Hex(Buffer.from('one'))).toBe('7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed')
  })

  test('a bad call id stays inside the root', () => {
    const t = new UploadTemp(uploadRoot(tmp(), 'mycel'))
    const [p] = t.write('../../x', 'tab-1', [{ name: 'a.txt', bytes: Buffer.from('a') }])
    expect(p!.startsWith(t.root + path.sep)).toBe(true)
  })

  test('cleanup: the tab closes or changes site, one failed call, everything (person changes, quit), the start sweep', () => {
    const root = uploadRoot(tmp(), 'mycel')
    const t = new UploadTemp(root)
    const [a] = t.write('c1', 'tab-1', [{ name: 'a.txt', bytes: Buffer.from('a') }])
    const [b] = t.write('c2', 'tab-2', [{ name: 'b.txt', bytes: Buffer.from('b') }])
    const [c] = t.write('c3', 'tab-2', [{ name: 'c.txt', bytes: Buffer.from('c') }])
    t.dropTab('tab-1')
    expect(fs.existsSync(a!)).toBe(false)
    expect(fs.existsSync(b!)).toBe(true)
    t.dropCall('c3')
    expect(fs.existsSync(c!)).toBe(false)
    expect(fs.existsSync(b!)).toBe(true)
    t.dropAll()
    expect(fs.existsSync(b!)).toBe(false)
    expect(t.dirs).toEqual([])
    // an earlier run's files (a crash): gone at the next start
    fs.mkdirSync(path.join(root, 'old', '0'), { recursive: true })
    fs.writeFileSync(path.join(root, 'old', '0', 'x.pdf'), 'x')
    new UploadTemp(root).sweep()
    expect(fs.existsSync(root)).toBe(false)
  })

  test('over the limit the oldest calls go, never the one just written', () => {
    const t = new UploadTemp(uploadRoot(tmp(), 'mycel'), 10)
    const [a] = t.write('c1', 'tab-1', [{ name: 'a', bytes: Buffer.alloc(6) }])
    const [b] = t.write('c2', 'tab-1', [{ name: 'b', bytes: Buffer.alloc(6) }])
    expect(fs.existsSync(a!)).toBe(false)
    expect(fs.existsSync(b!)).toBe(true)
    const [c] = t.write('c3', 'tab-1', [{ name: 'c', bytes: Buffer.alloc(20) }])
    expect(fs.existsSync(b!)).toBe(false)
    expect(fs.existsSync(c!)).toBe(true)
  })
})

describe('upload target order', () => {
  test('auto: the file field, then the picker its click opens, then a drop; otherwise the one way asked for', () => {
    expect(uploadOrder(undefined)).toEqual(['input', 'chooser', 'drop'])
    expect(uploadOrder('auto')).toEqual(['input', 'chooser', 'drop'])
    expect(uploadOrder('chooser')).toEqual(['chooser'])
    expect(uploadOrder('drop')).toEqual(['drop'])
  })

  test('the pane tries them in that order, refuses a one-file field with many files, intercepts pickers only while the AI drives and cleans up', () => {
    const pane = fs.readFileSync(new URL('../../desktop/src/main/pane/pane.ts', import.meta.url), 'utf8')
    expect(pane).toContain('for (const way of uploadOrder(input.how))')
    expect(pane).toContain('if (!v.multiple && n > 1) throw oneFile()')
    expect(pane).toContain("if (c.mode === 'selectSingle' && n > 1) throw oneFile()")
    expect(pane).toContain('if (this.driving === 0) this.stopIntercepting()')
    expect(pane).toContain("if (tab && kind === 'mutates-tab') await this.intercept(tab)")
    for (const drop of ['this.uploads.dropTab(id)', 'this.uploads.dropAll()', 'this.uploads.sweep()']) expect(pane).toContain(drop)
    const script = fs.readFileSync(new URL('../../desktop/src/main/pane/page-script.js', import.meta.url), 'utf8')
    expect(script).toContain('uploadTarget, uploadTargetAt')
  })
})
