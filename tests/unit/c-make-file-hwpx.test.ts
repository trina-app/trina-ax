// make_file hwpx through the tool path (the MCP handler, as an engine calls it): a Hangul document from Markdown or
// CSV, saved and readable by read/grep; unsupported content and untrusted templates refused with nothing saved; a
// team template only from skills/ and only a .hwpx. And the AI's plain write and edit still refuse .hwp and .hwpx:
// writing goes only through make_file.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../../server/src/config'
import { extractText } from '../../server/src/files/extract'
import { defaultHeaderXml } from '../../server/src/files/hwpx-template'
import { makeHandler } from '../../server/src/mcp/protocol'
import { hwpxParts, hwpxTemplate } from '../lib/hwpx'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const tools = { pandoc, pdftotext: null }

let A: CApp
beforeAll(async () => { A = await makeCApp('c-make-file-hwpx') })
afterAll(async () => { await A.close() })

let rpcId = 0
async function make(args: Record<string, unknown>) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'make_file', arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const MD = '# 3분기 보고서\n\n매출이 **12%** 늘었다.\n\n## 채널별\n\n| 채널 | 금액 |\n|---|---:|\n| 매장 | 3,200,000 |\n| 온라인 | 1,800,000 |\n\n- 다음 단계: *4분기* 계획\n\n\\newpage\n\n1. 첫째\n2. 둘째\n'

describe.skipIf(!pandoc)('make_file hwpx', () => {
  test('Markdown -> .hwpx in the team folder: saved, read back, readable by read/grep, recorded', async () => {
    const r = await make({ content: MD, format: 'hwpx', output: 'users/alice/out/보고서' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('Saved users/alice/out/보고서.hwpx')
    expect(r.text).toContain('read back: its paragraphs and headings are the document\'s')
    const bytes = fs.readFileSync(file('users/alice/out/보고서.hwpx'))
    expect(bytes.subarray(30, 38).toString()).toBe('mimetype')
    const text = await extractText('x.hwpx', bytes, tools)
    expect(text).toContain('# 3분기 보고서')
    expect(text).toContain('## 채널별')
    expect(text).toContain('3,200,000')
    const ev = A.ctx.db.query('SELECT action, detail FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1').get('users/alice/out/보고서.hwpx') as any
    expect(ev.action).toBe('create')
    expect(JSON.parse(ev.detail).tool).toBe('make_file')
    const read = await A.ctx.files.call('read', { file_path: 'users/alice/out/보고서.hwpx' }, A.toolCtx('alice'))
    expect(read.isError ?? false).toBe(false)
    expect(read.text).toContain('온라인')
  })

  test('a CSV source becomes one table', async () => {
    fs.writeFileSync(file('users/alice/수량.csv'), '품목,수량\n사과,12\n"배, 국산",3\n')
    const r = await make({ source: 'users/alice/수량.csv', format: 'hwpx', output: 'users/alice/out/수량.hwpx' })
    expect(r.isError, r.text).toBe(false)
    const section = hwpxParts(fs.readFileSync(file('users/alice/out/수량.hwpx'))).get('Contents/section0.xml')!
    expect(section).toContain('rowCnt="3" colCnt="2"')
    expect(section).toContain('배, 국산')
  })

  test('what a .hwpx cannot hold yet is refused, all of it named, and nothing is saved', async () => {
    const r = await make({ content: '# 제목\n\n![로고](logo.png)\n\n[누리집](https://example.com)과 `코드`\n\n> 인용\n', format: 'hwpx', output: 'users/alice/out/안됨.hwpx' })
    expect(r.isError).toBe(true)
    for (const w of ['images', 'links', 'inline code', 'block quotes', 'Nothing was saved']) expect(r.text).toContain(w)
    expect(fs.existsSync(file('users/alice/out/안됨.hwpx'))).toBe(false)
  })

  test('a team template from skills/: its styles are used; other folders, other formats and unsafe templates are refused', async () => {
    fs.mkdirSync(file('skills/서식'), { recursive: true })
    fs.writeFileSync(file('skills/서식/공문.hwpx'), hwpxTemplate({ head: defaultHeaderXml().replace(/함초롬바탕/g, '나눔명조') }))
    const ok = await make({ content: MD, format: 'hwpx', output: 'users/alice/out/공문.hwpx', template: 'skills/서식/공문.hwpx' })
    expect(ok.isError, ok.text).toBe(false)
    expect(hwpxParts(fs.readFileSync(file('users/alice/out/공문.hwpx'))).get('Contents/header.xml')).toContain('face="나눔명조"')

    fs.writeFileSync(file('users/alice/개인.hwpx'), hwpxTemplate())
    expect((await make({ content: MD, format: 'hwpx', output: 'users/alice/out/a.hwpx', template: 'users/alice/개인.hwpx' })).text).toContain('skills/')
    fs.copyFileSync(path.join(A.team, 'groups/marketing/brand-guidelines.docx'), file('skills/ref.docx'))
    expect((await make({ content: MD, format: 'hwpx', output: 'users/alice/out/b.hwpx', template: 'skills/ref.docx' })).text).toContain('must be a .hwpx')

    fs.writeFileSync(file('skills/서식/매크로.hwpx'), hwpxTemplate({ extra: { 'Scripts/headerScripts.js': 'function OnDocument_Open() {}' } }))
    const bad = await make({ content: MD, format: 'hwpx', output: 'users/alice/out/c.hwpx', template: 'skills/서식/매크로.hwpx' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('the template cannot be used: it contains scripts')
    expect(fs.existsSync(file('users/alice/out/c.hwpx'))).toBe(false)
  })

  test('the tool lists hwpx and says what it holds', async () => {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })
    const mf = r.result.tools.find((t: any) => t.name === 'make_file')
    expect(mf.inputSchema.properties.format.enum).toContain('hwpx')
    expect(mf.description).toContain('Hangul (.hwpx)')
    expect(mf.description).toContain('\\newpage')
  })
})

describe('the AI\'s plain write and edit still refuse Hangul documents', () => {
  test('write refuses .hwp and .hwpx, whatever the case of the extension', async () => {
    const t = A.toolCtx('alice')
    for (const name of ['메모.hwp', '메모.hwpx', '메모.HWPX', '메모.Hwp']) {
      const w = await A.ctx.files.call('write', { file_path: `users/alice/${name}`, content: '# 평문\n\n한글 문서가 아닌 글' }, t)
      expect(w.isError, name).toBe(true)
      expect(w.text).toContain('cannot be written as text')
      expect(fs.existsSync(file(`users/alice/${name}`))).toBe(false)
    }
  })

  test('edit refuses an existing .hwp and .hwpx even after reading it, and the file is unchanged', async () => {
    const t = A.toolCtx('alice')
    fs.copyFileSync(path.join(import.meta.dir, '../fixtures/hwp/agreement.hwp'), file('users/alice/동의서.hwp'))
    fs.copyFileSync(path.join(import.meta.dir, '../fixtures/hwp/notice.hwpx'), file('users/alice/공지.hwpx'))
    for (const name of ['동의서.hwp', '공지.hwpx']) {
      const rel = `users/alice/${name}`
      const before = fs.readFileSync(file(rel))
      const read = await A.ctx.files.call('read', { file_path: rel }, t)
      expect(read.isError ?? false, read.text).toBe(false)
      const line = read.text.split('\n').map((l) => l.replace(/^\s*\d+\t/, '').trim()).find((l) => l.length > 3)!
      const e = await A.ctx.files.call('edit', { file_path: rel, old_string: line, new_string: '바꾼 글' }, t)
      expect(e.isError, name).toBe(true)
      expect(e.text).toContain('only text files can be edited')
      expect(fs.readFileSync(file(rel))).toEqual(before)
    }
  })
})
