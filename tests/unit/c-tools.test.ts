// Component C engine tools through the MCP handler: make_file, share_file, artifact (+ artifacts REST), the tool
// registry, and converter isolation.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { extractText } from '../../server/src/files/extract'
import { makeHandler } from '../../server/src/mcp/protocol'
import { isolation, runIsolated, sandboxProfile } from '../../server/src/tools/isolate'
import { cellValue, markdownTables, parseCsv } from '../../server/src/tools/make-file'
import { toolRegistry } from '../../server/src/tools/registry'
import { which } from '../../server/src/config'
import { makeCApp, type CApp, type Person } from '../lib/c-app'

let A: CApp
beforeAll(async () => { A = await makeCApp('c-tools') })
afterAll(async () => { await A.close() })

let rpcId = 0
async function call(user: Person, turnId: string | null, name: string, args: unknown, files?: ReturnType<CApp['toolCtx']>['files']) {
  const tc = A.toolCtx(user, turnId)
  if (files) tc.files = files
  const h = makeHandler(A.ctx.files, A.ctx.db, tc)
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}
const tools = { pandoc: which('pandoc'), pdftotext: which('pdftotext') }

describe('registry', () => {
  test('tools/list has the six file tools and then C\'s tools with JSON schemas', async () => {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice'))
    const r = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = r.result.tools.map((t: any) => t.name)
    expect(names).toEqual(['list', 'glob', 'grep', 'read', 'write', 'edit', 'make_file', 'share_file', 'artifact', 'web_fetch', 'search', 'schedule_create', 'schedule_list', 'schedule_delete'])
    const mf = r.result.tools.find((t: any) => t.name === 'make_file')
    expect(mf.inputSchema.properties.format.enum).toEqual(['docx', 'pptx', 'xlsx', 'pdf'])
    expect(() => toolRegistry(A.ctx.files).register({ name: 'make_file', description: '', input: mf as any, run: () => ({ text: '', summary: '' }) })).toThrow('registered twice')
  })
  test('invalid input and errors come back as tool errors and are audited', async () => {
    const r = await call('alice', null, 'share_file', { path: 'shared/glossary.md' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Invalid input')
    const d = await call('alice', null, 'share_file', { path: 'groups/finance/budget.md', mode: 'preview' })
    expect(d.isError).toBe(true)
    expect(d.text).toContain('not found or no access')
    const audit = A.ctx.db.query("SELECT summary, ok FROM tool_events WHERE tool = 'share_file' ORDER BY id DESC LIMIT 1").get() as any
    expect(audit).toMatchObject({ ok: 0 })
    expect(audit.summary).toContain('denied')
  })
})

describe('share_file', () => {
  test('relative links that are checked again with the viewer\'s session', async () => {
    const r = await call('alice', null, 'share_file', { path: 'groups/marketing/campaign-brief.md', mode: 'preview' })
    expect(r.text.split('\n')[0]).toBe('/files/view?path=groups%2Fmarketing%2Fcampaign-brief.md')
    const d = await call('alice', null, 'share_file', { path: 'shared/handbook.pdf', mode: 'download' })
    const url = d.text.split('\n')[0]!
    expect(url).toBe('/api/files/download?path=shared%2Fhandbook.pdf&disposition=attachment')
    expect((await A.req(url, { as: 'bob' })).status).toBe(200)
    const priv = (await call('alice', null, 'share_file', { path: 'groups/marketing/campaign-brief.md', mode: 'download' })).text.split('\n')[0]!
    expect((await A.req(priv, { as: 'bob' })).status).toBe(404) // the link gives bob nothing
    expect((await call('alice', null, 'share_file', { path: 'shared', mode: 'download' })).isError).toBe(true)
  })
})

describe('artifact', () => {
  test('create, update with edits, rewrite; versions; artifact.updated; REST', async () => {
    const chat = A.chat('alice')
    const turn = A.turn('alice', chat)
    A.hub.clear()
    const c1 = await call('alice', turn, 'artifact', { action: 'create', key: 'chart', type: 'html', title: '매출 차트', content: '<h1>Q3</h1><p>draft</p>' })
    expect(c1.isError).toBe(false)
    expect(c1.text).toContain('version 1')
    const u = await call('alice', turn, 'artifact', { action: 'update', key: 'chart', type: 'html', edits: [{ old: 'draft', new: 'final' }, { old: 'Q3', new: 'Q4' }] })
    expect(u.text).toContain('version 2')
    expect((await call('alice', turn, 'artifact', { action: 'update', key: 'chart', type: 'html', edits: [{ old: 'nope', new: 'x' }] })).text).toContain('not found')
    expect((await call('alice', turn, 'artifact', { action: 'update', key: 'missing', type: 'html', edits: [{ old: 'a', new: 'b' }] })).isError).toBe(true)
    await call('alice', turn, 'artifact', { action: 'rewrite', key: 'chart', type: 'html', content: '<h1>new</h1>' })
    await call('alice', turn, 'artifact', { action: 'create', key: 'flow', type: 'mermaid', content: 'graph TD; A-->B' })
    const ev = A.hub.of('artifact.updated', 'alice')
    expect(ev.length).toBe(4)
    expect(ev[1]!.data).toMatchObject({ chatId: chat, key: 'chart', status: 'done', artifact: { version: 2, title: '매출 차트' } })
    const list = await A.json(`/api/chats/${chat}/artifacts`, { as: 'alice' })
    expect(list.status).toBe(200)
    expect(list.body.items.map((g: any) => [g.key, g.versions.map((v: any) => v.version)])).toEqual([['chart', [3, 2, 1]], ['flow', [1]]])
    const v2 = list.body.items[0].versions[1]
    const one = await A.json(`/api/artifacts/${v2.id}`, { as: 'alice' })
    expect(one.body.content).toBe('<h1>Q4</h1><p>final</p>')
    expect((await A.json(`/api/artifacts/${v2.id}`, { as: 'bob' })).status).toBe(404)
    expect((await A.json(`/api/chats/${chat}/artifacts`, { as: 'carol' })).status).toBe(404)
  })
  test('needs the caller\'s own running turn', async () => {
    const chat = A.chat('alice')
    const turn = A.turn('alice', chat)
    expect((await call('alice', null, 'artifact', { action: 'create', key: 'k', type: 'markdown', content: 'x' })).isError).toBe(true)
    expect((await call('bob', turn, 'artifact', { action: 'create', key: 'k', type: 'markdown', content: 'x' })).isError).toBe(true)
  })
})

describe('make_file', () => {
  const md = '# 3분기 보고서\n\n요약: 매출이 **12%** 늘었습니다.\n\n## 채널별\n\n| 채널 | 금액 |\n|---|---|\n| Instagram | 3,200,000 |\n| Naver | 1,800,000 |\n\n- 다음 단계: 4분기 캠페인\n'
  test('docx / pptx / pdf / xlsx from Markdown, readable back as text', async () => {
    for (const format of ['docx', 'pptx', 'pdf', 'xlsx'] as const) {
      if (format === 'pdf' && !which('typst')) { console.log('typst missing: pdf part skipped'); continue }
      const r = await call('alice', null, 'make_file', { content: md, format, output: `users/alice/out/report.${format}` })
      expect(r.isError, `${format}: ${r.text}`).toBe(false)
      expect(r.text).toContain(`users/alice/out/report.${format}`)
      const bytes = fs.readFileSync(path.join(A.team, 'users/alice/out', `report.${format}`))
      const text = await extractText(`x.${format}`, bytes, tools)
      expect(text, format).toContain('Instagram')
      if (format !== 'xlsx') expect(text, format).toContain('보고서')
      const ev = A.ctx.db.query('SELECT action, detail FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1').get(`users/alice/out/report.${format}`) as any
      expect(ev.action).toBe('create')
      expect(JSON.parse(ev.detail).tool).toBe('make_file')
    }
  })
  test('xlsx: numbers stay numbers, leading zeros stay text, one sheet per table', async () => {
    const r = await call('alice', null, 'make_file', { content: '## Q3\n\n| item | amount | code |\n|---|---|---|\n| a | 1,234 | 007 |\n\n## Q4\n\n| x |\n|---|\n| 1 |\n', format: 'xlsx', output: 'users/alice/out/t.xlsx' })
    expect(r.isError).toBe(false)
    const wb = XLSX.read(fs.readFileSync(path.join(A.team, 'users/alice/out/t.xlsx')))
    expect(wb.SheetNames).toEqual(['Q3', 'Q4'])
    const ws = wb.Sheets.Q3!
    expect(ws.B2.v).toBe(1234)
    expect(ws.C2.v).toBe('007')
    const csv = await call('alice', null, 'make_file', { content: 'name,qty\n"Kim, J",3\n', format: 'xlsx', output: 'users/alice/out/c.xlsx' })
    expect(csv.isError).toBe(false)
    const w2 = XLSX.read(fs.readFileSync(path.join(A.team, 'users/alice/out/c.xlsx')))
    expect(w2.Sheets.Sheet1!.A2.v).toBe('Kim, J')
    expect(parseCsv('a,"b ""q""\nc",d\r\n1,2,3')).toEqual([['a', 'b "q"\nc', 'd'], ['1', '2', '3']])
    expect(markdownTables('| a | b |\n| --- | :-: |\n| 1 | x \\| y |')).toEqual([{ title: undefined, rows: [['a', 'b'], ['1', 'x | y']] }])
    expect([cellValue('1,234.5'), cellValue('010-1234'), cellValue('+82'), cellValue('12345678901234567')]).toEqual([1234.5, '010-1234', '+82', '12345678901234567'])
  })
  test('source file and team images (only readable ones) work; an existing file gets a conflict copy unless read this turn', async () => {
    const png = path.join(A.data, 'p.png')
    const ff = which('ffmpeg')
    if (ff) Bun.spawnSync([ff, '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=40x40', '-frames:v', '1', png])
    if (fs.existsSync(png)) fs.copyFileSync(png, path.join(A.team, 'shared/logo.png'))
    fs.writeFileSync(path.join(A.team, 'shared/src.md'), `# Source doc\n\n${fs.existsSync(png) ? '![logo](logo.png)\n\n' : ''}Body text.\n`)
    const r = await call('alice', null, 'make_file', { source: 'shared/src.md', format: 'docx', output: 'shared/src.docx' })
    expect(r.isError, r.text).toBe(false)
    const again = await call('erin', null, 'make_file', { source: 'shared/src.md', format: 'docx', output: 'shared/src.docx' })
    expect(again.isError).toBe(false)
    expect(again.text).toMatch(/already exists .* saved as 'shared\/src \(conflict copy - Erin Yoo .*\)\.docx'/)
    // after reading it in the same turn, the file is replaced and the old one kept as a version
    const t = A.toolCtx('erin', null)
    await A.ctx.files.call('read', { file_path: 'shared/src.docx' }, t)
    const replaced = await call('erin', null, 'make_file', { source: 'shared/src.md', format: 'docx', output: 'shared/src.docx' }, t.files)
    expect(replaced.text).toContain('Saved shared/src.docx')
    // one kept version, plus erin's earlier conflict copy recorded in the original's history (security review r2)
    expect(A.ctx.db.query("SELECT kind FROM file_versions WHERE path = 'shared/src.docx' ORDER BY version").all()).toEqual([{ kind: 'conflict_copy' }, { kind: 'edit' }])
  })
  test('absolute-path and remote images fail the conversion and nothing leaks into the file', async () => {
    const secret = path.join(A.data, 'secret.png')
    fs.writeFileSync(secret, 'CANARY-OUT-9150')
    const srv = Bun.serve({ port: 19133, hostname: '127.0.0.1', fetch: () => new Response('CANARY-OUT-9150', { headers: { 'content-type': 'image/png' } }) })
    try {
      for (const format of ['docx', 'pptx', 'pdf'] as const) {
        if (format === 'pdf' && !which('typst')) continue
        for (const img of [secret, 'http://127.0.0.1:19133/x.png', '../../../outside/secret.txt.png', 'groups/finance/budget.png']) {
          const out = `users/alice/leak-${format}-${Math.random().toString(36).slice(2)}.${format}`
          const r = await call('alice', null, 'make_file', { content: `# T\n\n![x](${img})\n`, format, output: out })
          if (!r.isError) {
            const bytes = fs.readFileSync(path.join(A.team, out))
            expect(Buffer.from(bytes).includes('CANARY'), `${format} ${img}`).toBe(false)
            const text = await extractText(out, bytes, tools)
            expect(text).not.toContain('CANARY')
          }
        }
        const abs = await call('alice', null, 'make_file', { content: `# T\n\n![x](${secret})\n`, format, output: `users/alice/abs.${format}` })
        expect(abs.isError, `${format} must refuse an absolute image path`).toBe(true)
        expect(abs.text).toContain('image')
      }
    } finally { srv.stop(true) }
  })
  test('policy: output needs write access, template must live under skills/', async () => {
    expect((await call('alice', null, 'make_file', { content: '# x', format: 'docx', output: 'skills/x.docx' })).text).toContain('read-only')
    expect((await call('alice', null, 'make_file', { content: '# x', format: 'docx', output: 'groups/finance/x.docx' })).text).toContain('not found or no access')
    expect((await call('alice', null, 'make_file', { content: '# x', format: 'docx', output: 'users/alice/t.docx', template: 'groups/marketing/brand-guidelines.docx' })).text).toContain('skills/')
    fs.copyFileSync(path.join(A.team, 'groups/marketing/brand-guidelines.docx'), path.join(A.team, 'skills/ref.docx'))
    expect((await call('alice', null, 'make_file', { content: '# x', format: 'docx', output: 'users/alice/t.docx', template: 'skills/ref.docx' })).isError).toBe(false)
    expect((await call('alice', null, 'make_file', { source: 'groups/finance/budget.md', format: 'docx', output: 'users/alice/b.docx' })).text).toContain('not found or no access')
  })
})

describe('isolation', () => {
  test('converters cannot read the team folder or server data, write outside their folder, or use the network', async () => {
    if (isolation() === 'none') { console.log('no sandbox on this machine: isolation test skipped'); return }
    const secret = path.join(A.team, 'groups/finance/budget.md')
    const cat = await runIsolated({ cmd: '/bin/cat', args: [secret], timeoutMs: 5000 })
    expect(cat.code).not.toBe(0)
    expect(cat.stdout.toString()).not.toContain('CANARY')
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'))
    fs.writeFileSync(path.join(work, 'in.txt'), 'ok-inside')
    const inside = await runIsolated({ cmd: '/bin/cat', args: ['in.txt'], workDir: work, timeoutMs: 5000 })
    expect(inside.stdout.toString()).toBe('ok-inside')
    const sh = await runIsolated({ cmd: '/bin/sh', args: ['-c', `echo x > ${path.join(A.data, 'pwned')}; /bin/cat ${secret}`], timeoutMs: 5000 })
    expect(fs.existsSync(path.join(A.data, 'pwned'))).toBe(false)
    expect(sh.stdout.toString()).not.toContain('CANARY')
    const srv = Bun.serve({ port: 19134, hostname: '127.0.0.1', fetch: () => new Response('reached') })
    try {
      const curl = await runIsolated({ cmd: '/usr/bin/curl', args: ['-s', '-m', '3', 'http://127.0.0.1:19134/'], timeoutMs: 8000 })
      expect(curl.stdout.toString()).not.toContain('reached')
    } finally { srv.stop(true) }
    expect(sandboxProfile({ cmd: '/bin/cat', workDir: work, readPaths: [], denyRead: [] })).toContain('(deny network*)')
    fs.rmSync(work, { recursive: true, force: true })
  })
  test('time limit kills a stuck converter', async () => {
    const r = await runIsolated({ cmd: '/bin/sleep', args: ['10'], timeoutMs: 300 })
    expect(r.killed).toBe('timeout')
  })
})
