// make_zip and the attachments of an email in unzip_file through the tool path (the MCP handler, as an engine calls
// them), QA TC-4920 (docs/decisions/20261118-make-zip-and-mail-attachments.md): a folder with sub-folders, Korean names
// and an empty folder into a zip next to it that unzip_file opens again; only what the person can open goes in; the
// wider-audience rule; names never saved over; skills refused; the per-answer budget. An .eml's and an .msg's
// attachments (RFC 2231 and RFC 2047 names, an attached email, pictures inside the body) saved next to the email.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { MakeZipInput, stepLabel } from '@mycel/shared'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { planZip, inflateEntryToFile } from '../../server/src/files/unzip'
import { mailParts } from '../../server/src/files/mail-parts'
import { ROOM_FILE_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { MAKE_ZIP_ANSWER_MAX } from '../../server/src/tools/make-zip'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-make-zip') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const ls = (rel: string) => fs.readdirSync(file(rel)).sort()
let rpcId = 0
function turn(user: Person, o: { files?: TurnFiles; confirmWidening?: ToolCtx['confirmWidening'] } = {}) {
  const turnId = A.turn(user, A.chat(user))
  const h = makeHandler(A.ctx.files, A.ctx.db, { ...A.toolCtx(user, turnId), ...(o.files ? { files: o.files } : {}), ...(o.confirmWidening ? { confirmWidening: o.confirmWidening } : {}) })
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content.map((c: { text?: string }) => c.text ?? '').join('\n') as string, isError: !!r.result.isError }
  }
}
/** what a zip in the team folder holds: name -> text (folders end in "/") */
async function inside(rel: string): Promise<Record<string, string>> {
  const bytes = fs.readFileSync(file(rel))
  const plan = planZip(bytes, { unwrap: false })
  const out: Record<string, string> = {}
  for (const f of plan.folders) out[f.join('/') + '/'] = ''
  const tmp = path.join(A.data, 'zip-read')
  fs.mkdirSync(tmp, { recursive: true })
  for (const [i, f] of plan.files.entries()) {
    const dest = path.join(tmp, `${Date.now()}-${i}`)
    await inflateEntryToFile(bytes, f.entry, dest)
    out[f.segs.join('/')] = fs.readFileSync(dest, 'utf8')
    fs.rmSync(dest)
  }
  return out
}

const D = 'groups/marketing/zipme'

describe('make_zip (QA TC-4920)', () => {
  test('the input: paths (1-50) and an optional output', () => {
    expect(MakeZipInput.safeParse({ paths: ['a'] }).success).toBe(true)
    expect(MakeZipInput.safeParse({ paths: [], output: 'a.zip' }).success).toBe(false)
    expect(MakeZipInput.safeParse({ paths: ['a'], password: 'x' }).success).toBe(false)
  })
  test('a folder with sub-folders, Korean names and an empty folder goes into a zip next to it, which unzip_file opens again', async () => {
    put(`${D}/계약서/2026/계약-A.txt`, 'contract A')
    put(`${D}/계약서/notes.md`, '# notes')
    put(`${D}/계약서/photo.jpg`, Buffer.from('ffd8ffe0', 'hex'))
    fs.mkdirSync(file(`${D}/계약서/비어 있음`), { recursive: true })
    const r = await turn('alice')('make_zip', { paths: [`${D}/계약서`] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved ${D}/계약서.zip: 3 files and 1 empty folder`)
    expect(await inside(`${D}/계약서.zip`)).toEqual({
      '계약서/비어 있음/': '', '계약서/2026/계약-A.txt': 'contract A', '계약서/notes.md': '# notes', '계약서/photo.jpg': Buffer.from('ffd8ffe0', 'hex').toString('utf8'),
    })
    // a second time: a new name, never over the first zip
    const again = await turn('alice')('make_zip', { paths: [`${D}/계약서`] })
    expect(again.text).toContain(`Saved ${D}/계약서 (2).zip`)
    // the zip opens with unzip_file (round trip)
    const u = await turn('alice')('unzip_file', { path: `${D}/계약서.zip`, to_folder: `${D}/back` })
    expect(u.isError, u.text).toBe(false)
    expect(fs.readFileSync(file(`${D}/back/계약서/2026/계약-A.txt`), 'utf8')).toBe('contract A')
    // the file event names the tool
    const ev = A.ctx.db.query("SELECT detail FROM file_events WHERE path = ?").get(`${D}/계약서.zip`) as { detail: string }
    expect(JSON.parse(ev.detail)).toMatchObject({ tool: 'make_zip', files: 3 })
  })
  test('several files and a folder into a named zip; two items of one name get " (2)" inside', async () => {
    put(`${D}/a/report.txt`, 'a report')
    put(`${D}/b/report.txt`, 'b report')
    put(`${D}/c/report.txt`, 'c report')
    const r = await turn('alice')('make_zip', { paths: [`${D}/a/report.txt`, `${D}/b/report.txt`, `${D}/c`], output: `${D}/out/bundle` })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved ${D}/out/bundle.zip`)
    const z = await inside(`${D}/out/bundle.zip`)
    expect(z['report.txt']).toBe('a report')
    expect(z['report (2).txt']).toBe('b report')
    expect(z['c/report.txt']).toBe('c report')
    // the same file given inside a folder that is zipped too
    const twice = await turn('alice')('make_zip', { paths: [`${D}/c`, `${D}/c/report.txt`] })
    expect(twice.isError).toBe(true)
    expect(twice.text).toContain('give each file or folder once')
  })
  test('only what the person can open goes in; a path they cannot open is not found; nothing lands in skills/', async () => {
    put('groups/finance/salaries.txt', 'secret')
    put('groups/marketing/plan.txt', 'plan')
    // alice reads marketing but not finance: zipping groups/ takes marketing only
    const r = await turn('alice')('make_zip', { paths: ['groups'], output: `${D}/groups.zip` })
    expect(r.isError, r.text).toBe(false)
    const z = await inside(`${D}/groups.zip`)
    expect(Object.keys(z).some((k) => k.startsWith('groups/finance'))).toBe(false)
    expect(z['groups/marketing/plan.txt']).toBe('plan')
    const hidden = await turn('alice')('make_zip', { paths: ['groups/finance/salaries.txt'], output: `${D}/s.zip` })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain('not found or no access')
    const skills = await turn('carol')('make_zip', { paths: ['shared'], output: 'skills/x/files.zip' })
    expect(skills.isError).toBe(true)
    expect(skills.text).toContain('skills folder')
  })
  test('a place more people can read than the files: refused without a chat card, asked once with one', async () => {
    put(`${D}/private/p.txt`, 'marketing only')
    const wide = await turn('alice')('make_zip', { paths: [`${D}/private`], output: 'shared/p.zip' })
    expect(wide.isError).toBe(true)
    expect(wide.text).toContain('more people can read')
    expect(fs.existsSync(file('shared/p.zip'))).toBe(false)
    const asked: string[] = []
    const ok = await turn('alice', { confirmWidening: async (target, sources) => { asked.push(`${target} <- ${sources.join(',')}`); return null } })('make_zip', { paths: [`${D}/private`], output: 'shared/p.zip' })
    expect(ok.isError, ok.text).toBe(false)
    expect(asked).toEqual([`shared/p.zip <- ${D}/private`])
  })
  test('the answer\'s budget: zips again and again stop at MAKE_ZIP_ANSWER_MAX', async () => {
    const files = new TurnFiles()
    files.zippedBytes = MAKE_ZIP_ANSWER_MAX - 3
    const r = await turn('alice', { files })('make_zip', { paths: [`${D}/a/report.txt`], output: `${D}/budget.zip` })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('in this answer')
    expect(fs.existsSync(file(`${D}/budget.zip`))).toBe(false)
  })
  test('the tool lists and the step label', () => {
    for (const set of [GUEST_TURN_TOOLS, ROOM_FILE_TOOLS, SHARED_TOOLS]) expect(set.has('make_zip')).toBe(true)
    expect(stepLabel('make_zip', { paths: ['a/b'], output: 'a/b.zip' }, 'en', new Set())).toBe('Make a zip · a/b.zip')
    expect(stepLabel('make_zip', { paths: ['a/b', 'a/c'] }, 'ko', new Set())).toBe('압축 파일 만들기 · a/b +1')
  })
})

// ---- email files ----
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n')
const PDF = Buffer.from('%PDF-1.4\n% quote\n%%EOF\n')
const EML = [
  'From: Kim <kim@example.com>', 'To: Lee <lee@example.com>', 'Subject: =?UTF-8?B?' + Buffer.from('견적서 보내드립니다').toString('base64') + '?=',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="outer"', '',
  'This is a multi-part message.', '--outer',
  'Content-Type: multipart/related; boundary="inner"', '',
  '--inner', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello <img src="cid:logo"></p>',
  '--inner', 'Content-Type: image/png; name="logo.png"', 'Content-Disposition: inline; filename="logo.png"', 'Content-ID: <logo>', 'Content-Transfer-Encoding: base64', '', b64('PNGDATA'),
  '--inner--', '',
  '--outer', 'Content-Type: application/pdf', "Content-Disposition: attachment; filename*=UTF-8''%EA%B2%AC%EC%A0%81%EC%84%9C.pdf", 'Content-Transfer-Encoding: base64', '', b64(PDF),
  '--outer', 'Content-Type: text/csv; name="=?ks_c_5601-1987?B?' + Buffer.from([0xb8, 0xf1, 0xb7, 0xcf]).toString('base64') + '?=.csv"', 'Content-Disposition: attachment', 'Content-Transfer-Encoding: quoted-printable', '', 'a,b=0D=0A1,2',
  '--outer', 'Content-Type: message/rfc822', 'Content-Disposition: attachment', '', 'Subject: earlier mail', '', 'the earlier mail body',
  '--outer--', '',
].join('\r\n')
const CFB = (XLSX as unknown as { CFB: any }).CFB
const MSG = (() => {
  const c = CFB.utils.cfb_new()
  const utf16 = (s: string) => Buffer.from(s + '\u0000', 'utf16le')
  CFB.utils.cfb_add(c, '/__properties_version1.0', Buffer.alloc(32))
  CFB.utils.cfb_add(c, '/__substg1.0_0037001F', utf16('Quote'))
  CFB.utils.cfb_add(c, '/__attach_version1.0_#00000000/__substg1.0_3707001F', utf16('계약서 초안.docx'))
  CFB.utils.cfb_add(c, '/__attach_version1.0_#00000000/__substg1.0_37010102', Buffer.from('PK docx bytes'))
  CFB.utils.cfb_add(c, '/__attach_version1.0_#00000001/__substg1.0_3001001F', utf16('Forwarded meeting'))
  CFB.utils.cfb_add(c, '/__attach_version1.0_#00000001/__substg1.0_3701000D/__substg1.0_0037001F', utf16('inner'))
  return Buffer.from(CFB.write(c, { type: 'buffer', fileType: 'cfb' }))
})()

describe('the attachments of an email file (QA TC-4920)', () => {
  test('the MIME reader: RFC 2231 and RFC 2047 names (UTF-8, Korean code page), quoted-printable, an attached email; body pictures counted', () => {
    const m = mailParts('mail.eml', Buffer.from(EML, 'latin1'))
    expect(m.attachments.map((a) => a.name)).toEqual(['견적서.pdf', '목록.csv', 'earlier mail.eml'])
    expect(m.attachments[0]!.data.equals(PDF)).toBe(true)
    expect(m.attachments[1]!.data.toString()).toBe('a,b\r\n1,2')
    expect(m.attachments[2]!.data.toString()).toContain('the earlier mail body')
    expect(m.inline).toBe(1)
  })
  test('unzip_file on an .eml saves its attachments next to it; list_only lists them; a taken name gets " (2)"', async () => {
    put(`${D}/mail/quote.eml`, Buffer.from(EML, 'latin1'))
    put(`${D}/mail/견적서.pdf`, 'an older file')
    const list = await turn('alice')('unzip_file', { path: `${D}/mail/quote.eml`, list_only: true })
    expect(list.text).toContain('has 3 attachments')
    expect(ls(`${D}/mail`)).toEqual(['quote.eml', '견적서.pdf'])
    const r = await turn('alice')('unzip_file', { path: `${D}/mail/quote.eml` })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved 3 attachments of the email '${D}/mail/quote.eml' into ${D}/mail`)
    expect(r.text).toContain('only shown inside the email')
    expect(ls(`${D}/mail`)).toEqual(['earlier mail.eml', 'quote.eml', '견적서 (2).pdf', '견적서.pdf', '목록.csv'])
    expect(fs.readFileSync(file(`${D}/mail/견적서 (2).pdf`)).equals(PDF)).toBe(true)
    expect(fs.readFileSync(file(`${D}/mail/견적서.pdf`), 'utf8')).toBe('an older file')
  })
  test('an Outlook .msg: its attachments by their long names; an email inside it is named, not saved', async () => {
    put(`${D}/msg/quote.msg`, MSG)
    const r = await turn('alice')('unzip_file', { path: `${D}/msg/quote.msg`, to_folder: `${D}/msg/files` })
    expect(r.isError, r.text).toBe(false)
    expect(ls(`${D}/msg/files`)).toEqual(['계약서 초안.docx'])
    expect(fs.readFileSync(file(`${D}/msg/files/계약서 초안.docx`), 'utf8')).toBe('PK docx bytes')
    expect(r.text).toContain('Forwarded meeting: an email or item inside the email')
    // an email without attachments, and a file that is not an Outlook file
    put(`${D}/msg/plain.eml`, 'Subject: hi\r\n\r\njust text')
    const none = await turn('alice')('unzip_file', { path: `${D}/msg/plain.eml` })
    expect(none.isError).toBe(true)
    expect(none.text).toContain('has no attachments to save')
    put(`${D}/msg/fake.msg`, 'not a compound file')
    const bad = await turn('alice')('unzip_file', { path: `${D}/msg/fake.msg` })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('could not be taken out')
  })
})
