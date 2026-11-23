// edit_office through a chat turn (tools/edit-office.ts; QA TC-4906): read first, a new version of the same file with
// the old one in its history, a new file with `output`, the wider-audience check for what the chat read and for a new
// picture, never skills/, Excel values read as make_file reads them; and the server's own check of the zip parts.
import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import * as XLSX from '../../server/node_modules/xlsx'
import ExcelJS from '../../server/node_modules/exceljs'
import { API } from '@mycel/shared/api'
import { which } from '../../server/src/config'
import { outsideContentTool } from '../../server/src/chat/team-content-tools'
import { EDIT_OFFICE_DESCRIPTION, editOffice, editOfficeOutput, editOfficeText, officePartsMismatch, PICTURES_TOTAL_MAX, countPictureBytes } from '../../server/src/tools/edit-office'
import type { ToolCtx } from '../../server/src/files/service'
import { sha256 } from '../../server/src/files/store'
import { makeCApp, type CApp } from '../lib/c-app'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(90_000)
const pandoc = which('pandoc')
const withPandoc = pandoc ? test : test.skip

function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
function png(w: number, h: number, rgb = [255, 0, 0]): Uint8Array {
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])))
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  // a text chunk the helper drops: the re-encoded picture cannot equal this one
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0hello')), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
async function workbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Budget')
  ws.addRow(['Item', 'Amount'])
  ws.addRow(['Rent', 1200])
  ws.getCell('B2').numFmt = '#,##0'
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

describe('edit_office: the tool', () => {
  test('told to the AI; a team-content tool; outputs keep the format', () => {
    expect(EDIT_OFFICE_DESCRIPTION).toContain('stays exactly as it was')
    expect(EDIT_OFFICE_DESCRIPTION).toContain('use make_file only for a new file')
    expect(EDIT_OFFICE_DESCRIPTION).toContain('When someone asks to sign or stamp a Word document, use insert_picture')
    expect(outsideContentTool('edit_office')).toBe(false)
    expect(editOfficeOutput('out/new', 'a/b.xlsx')).toBe('out/new.xlsx')
    expect(editOfficeOutput('out/new.pptx', 'a/b.pptx')).toBe('out/new.pptx')
  })

  withPandoc('the server\'s part check: a part outside the edit that changed, or one the report hides, is caught', () => {
    const a = docx('# T\n\nhello\n')
    const touch = (b: Uint8Array, name: string) => writeZip(readZip(b).map((e) => (e.name === name ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data) + ' ') } : e)))
    const doc = touch(a, 'word/document.xml')
    expect(officePartsMismatch('docx', a, doc, { changed: ['word/document.xml'], added: [], removed: [] })).toBeNull()
    expect(officePartsMismatch('docx', a, doc, { changed: [], added: [], removed: [] })).toContain('word/document.xml changed')
    const styles = touch(a, '[Content_Types].xml')
    expect(officePartsMismatch('docx', a, styles, { changed: ['[Content_Types].xml'], added: [], removed: [] })).toContain('not changed here')
    const extra = writeZip([...readZip(a), { name: 'word/evil.bin', data: new Uint8Array([1]) }])
    expect(officePartsMismatch('docx', a, extra, { changed: [], added: [], removed: [] })).toContain('a new part word/evil.bin')
  })
})

let h: Harness
let bob: TestSocket
const put = (rel: string, data: string | Uint8Array) => { const p = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const read = (rel: string) => new Uint8Array(fs.readFileSync(path.join(h.team, ...rel.split('/'))))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

describe('edit_office: saved like edit_hwp and comment_docx', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-edit-office', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
    bob = await h.ws('bob', { windowId: 'win-edit-office-bob' })
    await bob.next('hello')
    if (pandoc) put('shared/contracts/supply.docx', docx('# Supply Contract\n\nPayment is due on the 25th.\n'))
    put('shared/finance/budget.xlsx', await workbook())
  })
  afterAll(async () => { bob?.close(); await h?.close() })

  async function turn(content: string) {
    const chat = await h.api('bob').call(API.createChat, { body: {} })
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const done = await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 75_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string }
  }
  const call = { tool: 'edit_office', args: { file_path: 'shared/contracts/supply.docx', changes: [{ find: '25th', replace: 'last day of the month' }] }, sayResult: true }

  withPandoc('not read in this turn: refused, the file unchanged', async () => {
    const before = read('shared/contracts/supply.docx')
    const r = await turn(fake(call))
    expect(r.content).toContain('first (with read) before changing it')
    expect(Buffer.from(read('shared/contracts/supply.docx')).equals(Buffer.from(before))).toBe(true)
  })

  withPandoc('read, then changed: a new version of the same file, the change in it, the old one in its history', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, call))
    expect(r.content).toContain('Saved a new version of shared/contracts/supply.docx')
    expect(r.content).toContain('"Payment is due on the 25th." -> "Payment is due on the last day of the month."')
    const doc = new TextDecoder().decode(readZip(read('shared/contracts/supply.docx')).find((e) => e.name === 'word/document.xml')!.data)
    expect(doc).toContain('last day of the month')
    const versions = h.ctx.db.query('SELECT count(*) AS n FROM file_versions WHERE path = ?').get('shared/contracts/supply.docx') as { n: number }
    expect(versions.n).toBeGreaterThan(0)
  })

  test('Excel: "1,500" is a number in the cell\'s style, a formula is checked, an outside formula refused', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/finance/budget.xlsx' } }, { tool: 'edit_office', args: { file_path: 'shared/finance/budget.xlsx', changes: [{ cell: { ref: 'B2', value: '1,500' } }, { cell: { ref: 'B3', value: '=sum(B2)' } }] }, sayResult: true }))
    expect(r.content).toContain('Saved a new version of shared/finance/budget.xlsx')
    expect(r.content).toContain('Formulas are calculated again')
    const ws = XLSX.read(read('shared/finance/budget.xlsx'), { type: 'array', cellFormula: true, cellNF: true, sheetStubs: true }).Sheets.Budget!
    expect(ws.B2!.v).toBe(1500)
    expect(ws.B2!.z).toBe('#,##0')
    expect(ws.B3!.f).toBe('SUM(B2)')
    const bad = await turn(fake({ tool: 'read', args: { file_path: 'shared/finance/budget.xlsx' } }, { tool: 'edit_office', args: { file_path: 'shared/finance/budget.xlsx', changes: [{ cell: { ref: 'C2', value: '=WEBSERVICE("http://x")' } }] }, sayResult: true }))
    expect(bad.content).toContain('WEBSERVICE is not allowed')
  })

  withPandoc('a change for another format is refused with words; a skills folder as output is refused', async () => {
    const r = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, { tool: 'edit_office', args: { file_path: 'shared/contracts/supply.docx', changes: [{ cell: { ref: 'A1', value: 1 } }] }, sayResult: true }))
    expect(r.content).toContain('cell and append_rows are for Excel workbooks')
    const s = await turn(fake({ tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, { ...call, args: { ...call.args, output: 'skills/x/supply.docx' } }))
    expect(s.content).toContain('cannot be saved in a skills folder')
  })

  withPandoc('what the chat read may not go where more people see it unasked: a private file read first, then a change asks (no answer: nothing saved)', async () => {
    put('users/bob/private.md', 'Private note: unit price 25,000')
    const before = read('shared/contracts/supply.docx')
    const r = await turn(fake({ tool: 'read', args: { file_path: 'users/bob/private.md' } }, { tool: 'read', args: { file_path: 'shared/contracts/supply.docx' } }, { ...call, args: { ...call.args, changes: [{ find: 'Payment', replace: 'Unit price 25,000. Payment' }] } }))
    expect(r.content).toContain('more people can see that folder')
    expect(Buffer.from(read('shared/contracts/supply.docx')).equals(Buffer.from(before))).toBe(true)
  })
})

// security review of #1291: what a call may read and where it may write, checked through the tool on a plain test app
describe('edit_office: the security review\'s cases', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('c-edit-office-sec') })
  afterAll(async () => { await A.close() })
  const file = (rel: string) => path.join(A.team, ...rel.split('/'))
  const write = (rel: string, b: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), b) }
  /** a tool context that read `rel` in this turn (edit_office needs it), and an optional hook right before placing */
  function ctxRead(rel: string, beforePlace?: () => void): ToolCtx {
    const c = A.toolCtx('alice', null)
    c.files.readHashes.set(rel, sha256(fs.readFileSync(file(rel))))
    if (beforePlace) c.beforePlace = beforePlace
    return c
  }
  function deck(): Uint8Array {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-sec-'))
    try {
      fs.writeFileSync(path.join(dir, 'p.png'), png(30, 20))
      fs.writeFileSync(path.join(dir, 'd.md'), '# Logo\n\n![p](p.png)\n')
      const r = Bun.spawnSync([pandoc!, 'd.md', '-o', 'd.pptx'], { cwd: dir })
      if (r.exitCode !== 0) throw new Error(r.stderr.toString())
      return new Uint8Array(fs.readFileSync(path.join(dir, 'd.pptx')))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const pic = (image: string) => ({ file_path: 'users/alice/deck.pptx', changes: [{ replace_picture: { slide: 1, picture: 1, image } }] })

  withPandoc('someone saves the file while the worker runs: a conflict copy, the original left as it was', async () => {
    write('users/alice/c.docx', docx('# Note\n\nfirst version\n'))
    const theirs = docx('# Note\n\ntheir version\n')
    const r = await editOffice(A.ctx, ctxRead('users/alice/c.docx', () => write('users/alice/c.docx', theirs)), { file_path: 'users/alice/c.docx', changes: [{ find: 'first', replace: 'my' }] } as any)
    expect(r.conflictCopyOf).toBe('users/alice/c.docx')
    expect(r.path).not.toBe('users/alice/c.docx')
    expect(Buffer.from(fs.readFileSync(file('users/alice/c.docx'))).equals(Buffer.from(theirs))).toBe(true)
    expect(editOfficeText(r)).toContain('Tell the user about both')
  })

  withPandoc('a read-only target or a folder nobody gave: refused, nothing written', async () => {
    write('users/alice/r.docx', docx('# R\n\ntext\n'))
    await expect(editOffice(A.ctx, ctxRead('users/alice/r.docx'), { file_path: 'users/alice/r.docx', output: 'groups/finance/r.docx', changes: [{ find: 'text', replace: 'x' }] } as any)).rejects.toThrow(/not found or no access|read-only/)
    await expect(editOffice(A.ctx, ctxRead('users/alice/r.docx'), { file_path: 'users/alice/r.docx', output: 'skills/r.docx', changes: [{ find: 'text', replace: 'x' }] } as any)).rejects.toThrow(/skills folder/)
    expect(fs.existsSync(file('groups/finance/r.docx'))).toBe(false)
  })

  withPandoc('a picture: re-encoded by the image helper; one that is not readable, not a picture, or the wrong kind is refused', async () => {
    write('users/alice/deck.pptx', deck())
    write('users/alice/new.png', png(10, 40, [0, 0, 255]))
    const ok = await editOffice(A.ctx, ctxRead('users/alice/deck.pptx'), pic('users/alice/new.png') as any)
    const media = readZip(new Uint8Array(fs.readFileSync(file(ok.path)))).filter((e) => /^ppt\/media\/image\d+\.png$/.test(e.name))
    expect(media.length).toBe(2)
    // the helper's own bytes, not the file's: no ancillary chunks, a valid PNG
    expect(media.some((e) => Buffer.from(e.data).equals(Buffer.from(png(10, 40, [0, 0, 255]))))).toBe(false)
    write('users/alice/deck.pptx', deck())
    // a PNG header and then text
    write('users/alice/fake.png', Buffer.concat([Buffer.from(png(2, 2)).subarray(0, 33), Buffer.from('<script>x</script>')]))
    await expect(editOffice(A.ctx, ctxRead('users/alice/deck.pptx'), pic('users/alice/fake.png') as any)).rejects.toThrow(/could not be read as a picture/)
    write('users/alice/note.txt', 'hello')
    await expect(editOffice(A.ctx, ctxRead('users/alice/deck.pptx'), pic('users/alice/note.txt') as any)).rejects.toThrow(/not a PNG, JPEG or WebP/)
    await expect(editOffice(A.ctx, ctxRead('users/alice/deck.pptx'), pic('groups/finance/secret-chart.png') as any)).rejects.toThrow(/not found or no access/)
  })

  withPandoc('insert_picture into a Word form (QA TC-8170, TC-8173): the picture re-encoded by the helper, named once, a source of the result; not for a workbook', async () => {
    write('users/alice/form.docx', docx('# Form\n\nBuyer: Example Trading Co. (seal)\n'))
    write('users/alice/seal.png', png(30, 30, [200, 0, 0]))
    const r = await editOffice(A.ctx, ctxRead('users/alice/form.docx'), { file_path: 'users/alice/form.docx', changes: [{ insert_picture: { image: 'users/alice/seal.png', over: '(seal)', width_mm: 15 } }] } as any)
    const z = readZip(new Uint8Array(fs.readFileSync(file(r.path))))
    const media = z.filter((e) => /^word\/media\/image\d+\.png$/.test(e.name))
    expect(media.length).toBe(1)
    expect(Buffer.from(media[0]!.data).equals(Buffer.from(png(30, 30, [200, 0, 0])))).toBe(false)
    expect(editOfficeText(r)).toContain('picture over "(seal)", behind the text (15 x 15 mm)')
    expect(r.report.added).toEqual([media[0]!.name])
    await expect(editOffice(A.ctx, ctxRead('users/alice/form.docx'), { file_path: 'users/alice/form.docx', changes: [{ insert_picture: { image: 'groups/finance/secret-chart.png', over: '(seal)' } }] } as any)).rejects.toThrow(/not found or no access/)
    await expect(editOffice(A.ctx, ctxRead('users/alice/form.docx'), { file_path: 'users/alice/form.docx', changes: [{ insert_picture: { image: 'chat:work/seal.png', over: '(seal)' } }] } as any)).rejects.toThrow(/team file or a file of this chat/)
    // a picture outside the person's own folder (someone else's or the company's seal) needs their yes: no card here, refused
    write('shared/brand/ceo-seal.png', png(30, 30, [200, 0, 0]))
    await expect(editOffice(A.ctx, ctxRead('users/alice/form.docx'), { file_path: 'users/alice/form.docx', changes: [{ insert_picture: { image: 'shared/brand/ceo-seal.png', over: '(seal)' } }] } as any)).rejects.toThrow(/Nothing was saved[\s\S]*ceo-seal\.png|ceo-seal\.png[\s\S]*Nothing was saved/)
    const asked: string[] = []
    const yes = ctxRead('users/alice/form.docx'); yes.person = { locale: 'en', confirm: async (q: string) => { asked.push(q); return true }, turnUrls: () => [] } as any
    await editOffice(A.ctx, yes, { file_path: 'users/alice/form.docx', changes: [{ insert_picture: { image: 'shared/brand/ceo-seal.png', over: '(seal)' } }] } as any)
    expect(asked[0]).toContain("The AI wants to put 'ceo-seal.png' into 'form.docx'. It is not your own picture")
    write('users/alice/b.xlsx', await workbook())
    await expect(editOffice(A.ctx, ctxRead('users/alice/b.xlsx'), { file_path: 'users/alice/b.xlsx', changes: [{ insert_picture: { image: 'users/alice/seal.png', after: 'Rent' } }] } as any)).rejects.toThrow(/insert_picture is for Word documents \(a picture cannot be added to a workbook here\)/)
    // the server's part check lets the relationships and content types change only for a call that adds pictures
    const before = docx('# Form\n\nBuyer: Example Trading Co. (seal)\n')
    const rels = writeZip(readZip(before).map((e) => (e.name === 'word/_rels/document.xml.rels' ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data) + ' ') } : e)))
    const rep = { changed: ['word/_rels/document.xml.rels'], added: [], removed: [] }
    expect(officePartsMismatch('docx', before, rels, rep)).toContain('not changed here')
    expect(officePartsMismatch('docx', before, rels, rep, true)).toBeNull()
    expect(officePartsMismatch('docx', before, writeZip([...readZip(before), { name: 'word/media/image9.gif', data: new Uint8Array([1]) }]), { changed: [], added: ['word/media/image9.gif'], removed: [] }, true)).toContain('not added here')
  })

  withPandoc('the same picture named by many changes is read once; the pictures of one call are bounded together', async () => {
    write('users/alice/deck.pptx', deck())
    write('users/alice/new.png', png(10, 40))
    const twice = { file_path: 'users/alice/deck.pptx', changes: [{ replace_picture: { slide: 1, picture: 1, image: 'users/alice/new.png' } }, { find: 'Logo', replace: 'Brand' }] }
    expect((await editOffice(A.ctx, ctxRead('users/alice/deck.pptx'), twice as any)).report.added.filter((n) => /media/.test(n)).length).toBe(1)
    expect(PICTURES_TOTAL_MAX).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  test('the pictures of one call are counted as read and as re-encoded (a re-encoded picture can be larger; QA TC-4965)', () => {
    const t = { read: 0, made: 0 }
    countPictureBytes(t, 'read', 10, 0, 40)
    countPictureBytes(t, 'made', 30, 0, 40)
    countPictureBytes(t, 'read', 10, 1, 40)
    expect(() => countPictureBytes(t, 'made', 11, 1, 40)).toThrow(/once they are prepared for the deck/)
    expect(() => countPictureBytes({ read: 39, made: 0 }, 'read', 2, 2, 40)).toThrow(/change 3: the new pictures together/)
  })

  withPandoc('hostile zips: two entries with one name, a zip bomb, an encrypted entry; refused before any change', async () => {
    const base = docx('# Z\n\ntext\n')
    const dup = writeZip([...readZip(base), readZip(base).find((e) => e.name === 'word/document.xml')!])
    write('users/alice/dup.docx', dup)
    await expect(editOffice(A.ctx, ctxRead('users/alice/dup.docx'), { file_path: 'users/alice/dup.docx', changes: [{ find: 'text', replace: 'x' }] } as any)).rejects.toThrow(/is there twice|two parts named/)
    const bomb = writeZip([...readZip(base), { name: 'word/media/big.bin', data: new Uint8Array(250 * 1024 * 1024) }])
    write('users/alice/bomb.docx', bomb)
    await expect(editOffice(A.ctx, ctxRead('users/alice/bomb.docx'), { file_path: 'users/alice/bomb.docx', changes: [{ find: 'text', replace: 'x' }] } as any)).rejects.toThrow(/too large or too complex/)
    const enc = Buffer.from(writeZip(readZip(base)))
    // set the "encrypted" flag of the first central directory entry
    const cd = enc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const first = enc.readUInt32LE(cd + 16)
    enc.writeUInt16LE(enc.readUInt16LE(first + 8) | 1, first + 8)
    write('users/alice/enc.docx', enc)
    await expect(editOffice(A.ctx, ctxRead('users/alice/enc.docx'), { file_path: 'users/alice/enc.docx', changes: [{ find: 'text', replace: 'x' }] } as any)).rejects.toThrow(/encrypted/)
    expect(officePartsMismatch('docx', base, dup, { changed: [], added: [], removed: [] })).toContain('two parts with one name')
  })
})
