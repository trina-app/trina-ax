// Writing and filling Hangul documents come with the HWP plugin (docs/DECISIONS.md "Hangul writing and filling come
// with the HWP plugin"): edit_hwp is offered, and make_file shows and takes .hwpx, only while the plugin is installed and
// on for the company, whether or not its renderer can run here. Off, edit_hwp is left out of the tool list (as
// hwp_render is), make_file shows no .hwpx and refuses one with nothing written, and reading Hangul documents, search
// and the refusal of plaintext writes work as before. A change takes effect at the next listing or call, without a
// restart. The plugin rows come from tests/lib/hwp-plugin.ts (a stand-in renderer, never run); the real package's
// lifecycle with rhwp is in plugins-hwp.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../../server/src/config'
import { makeHandler } from '../../server/src/mcp/protocol'
import { defaultCatalogDir } from '../../server/src/plugins/catalog'
import { HWP_PLUGIN_ID } from '../../server/src/plugins/drivers'
import { pluginsOf } from '../../server/src/plugins/manager'
import { employmentForm, hwpxTemplate } from '../lib/hwpx'
import { installHwpPlugin, removeHwpPlugin, setHwpPlugin } from '../lib/hwp-plugin'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const REQUIRED = ['files.read.selected', 'preview.render', 'runtime.native.isolated']
const FORM = 'users/alice/forms/재직증명서.hwpx'
const HWP = 'users/alice/forms/동의서.hwp'
const TEMPLATE = 'skills/서식/보고서.hwpx'
const MD = '# 3분기 보고서\n\n매출이 **12%** 늘었다.\n'

let A: CApp
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
const versions = (rel: string) => (A.ctx.db.query('SELECT version FROM file_versions WHERE path = ? ORDER BY version').all(rel) as { version: number }[]).map((v) => v.version)

beforeAll(async () => {
  A = await makeCApp('plugins-hwp-writing')
  put(FORM, employmentForm())
  put(HWP, fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/agreement.hwp')))
  put(TEMPLATE, hwpxTemplate())
  A.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
})
afterAll(async () => { await A.close() })

let rpcId = 0
/** one AI turn of alice, as an engine calls the tools (the MCP handler): its calls share what it read */
function turn() {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', A.turn('alice', A.chat('alice'))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content.map((c: { text?: string }) => c.text ?? '').join('\n') as string, isError: !!r.result.isError }
  }
}

/** What the AI is shown: the MCP list, and the chat turns' entries (read when a turn starts), which must agree. */
async function shown() {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', A.turn('alice', A.chat('alice'))))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })
  const tools = r.result.tools as { name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[]; description?: string }> } }[]
  const mf = tools.find((t) => t.name === 'make_file')!
  const turnTools = A.ctx.services.turnTools!
  const offered = (n: string) => { const t = turnTools.find((x) => x.name === n)!; return t.available ? t.available({ userId: 'alice', chatId: 'c', browser: false }) : true }
  const turnMf = turnTools.find((t) => t.name === 'make_file')!
  expect(offered('edit_hwp')).toBe(tools.some((t) => t.name === 'edit_hwp'))
  expect(offered('hwp_render')).toBe(tools.some((t) => t.name === 'hwp_render'))
  expect(turnMf.description).toBe(mf.description)
  expect(turnMf.inputSchema).toEqual(mf.inputSchema)
  return {
    editHwp: tools.some((t) => t.name === 'edit_hwp'), hwpRender: tools.some((t) => t.name === 'hwp_render'),
    formats: mf.inputSchema.properties.format!.enum, description: mf.description, template: mf.inputSchema.properties.template!.description ?? '',
  }
}

/** Reading, search, the original and the plaintext guard: core, in every plugin state. */
async function coreWorks() {
  const call = turn()
  const hwpx = await call('read', { file_path: FORM })
  expect(hwpx.isError, hwpx.text).toBe(false)
  expect(hwpx.text).toContain('{{발급일}}')
  const hwp = await call('read', { file_path: HWP })
  expect(hwp.isError, hwp.text).toBe(false)
  expect(hwp.text.length).toBeGreaterThan(20)
  const found = await call('grep', { pattern: '발급일', path: 'users/alice', output_mode: 'files_with_matches' })
  expect(found.text).toContain(FORM)
  const download = await A.req(`/api/files/download?path=${encodeURIComponent(FORM)}`, { as: 'alice' })
  expect(download.status).toBe(200)
  expect(Buffer.from(await download.arrayBuffer()).equals(fs.readFileSync(file(FORM)))).toBe(true)
  const w = await call('write', { file_path: 'users/alice/메모.hwpx', content: '평문' })
  expect(w.isError).toBe(true)
  expect(w.text).toContain('cannot be written as text')
  expect(fs.existsSync(file('users/alice/메모.hwpx'))).toBe(false)
  const e = await call('edit', { file_path: FORM, old_string: '발급일', new_string: '날짜' })
  expect(e.isError).toBe(true)
  expect(e.text).toContain('only text files can be edited')
}

/** Off: nothing of Hangul writing is shown, and a call anyway (an engine that kept an older list) changes nothing. */
async function writingOff() {
  expect(pluginsOf(A.ctx).hwpWriting()).toBe(false)
  const s = await shown()
  expect(s.editHwp).toBe(false)
  expect(s.formats).toEqual(['docx', 'pptx', 'xlsx', 'pdf'])
  expect(s.description).not.toMatch(/hwpx|hangul|edit_hwp/i)
  expect(s.template).not.toMatch(/hwpx/i)
  const call = turn()
  const made = await call('make_file', { content: MD, format: 'hwpx', output: 'users/alice/out/보고서' })
  expect(made.isError).toBe(true)
  expect(made.text).toContain('Making or filling Hangul documents (HWP, HWPX) needs the HWP plugin')
  expect(made.text).toContain('Admin > Plugins')
  const styled = await call('make_file', { content: MD, format: 'docx', output: 'users/alice/out/보고서', template: TEMPLATE })
  expect(styled.isError).toBe(true)
  expect(styled.text).toContain('needs the HWP plugin')
  expect(fs.existsSync(file('users/alice/out'))).toBe(false)
  const before = fs.readFileSync(file(FORM)), kept = versions(FORM)
  expect((await call('read', { file_path: FORM })).isError).toBe(false)
  const edited = await call('edit_hwp', { file_path: FORM, changes: [{ find: '{{발급일}}', replace: '2026년 11월 4일' }] })
  expect(edited.isError).toBe(true)
  expect(edited.text).toContain("unknown tool 'edit_hwp'")
  expect(fs.readFileSync(file(FORM)).equals(before)).toBe(true)
  expect(versions(FORM)).toEqual(kept)
  await coreWorks()
}

/** On: edit_hwp is offered and fills the form; make_file shows .hwpx. */
async function writingOn() {
  expect(pluginsOf(A.ctx).hwpWriting()).toBe(true)
  const s = await shown()
  expect(s.editHwp).toBe(true)
  expect(s.formats).toEqual(['docx', 'pptx', 'xlsx', 'pdf', 'hwpx'])
  expect(s.description).toContain('Hangul (.hwpx)')
  expect(s.description).toContain('use edit_hwp')
  expect(s.template).toContain('.hwpx')
  const call = turn()
  const n = versions(FORM).length
  expect((await call('read', { file_path: FORM })).text).toContain('{{발급일}}')
  const r = await call('edit_hwp', { file_path: FORM, changes: [{ find: '{{발급일}}', replace: '{{발급일}} ' }] })
  expect(r.isError, r.text).toBe(false)
  expect(r.text).toContain(`Saved a new version of ${FORM}`)
  expect(versions(FORM)).toHaveLength(n + 1)
  await coreWorks()
}

describe('Hangul writing follows the HWP plugin: installed and on for the company', () => {
  test('no plugin: edit_hwp is not offered, make_file shows no .hwpx and refuses one, nothing is written; reading and the guard work', async () => {
    await writingOff()
  })

  test('installed but not turned on: the same', async () => {
    installHwpPlugin(A.ctx, { on: false })
    await writingOff()
  })

  test('on, with a renderer that cannot run here and without the page-image permission: no preview or hwp_render, but writing and filling work', async () => {
    installHwpPlugin(A.ctx, { on: true, permissions: REQUIRED })
    const view = (await A.json('/api/admin/plugins', { as: 'carol' })).body.installed.find((p: { id: string }) => p.id === HWP_PLUGIN_ID)
    expect(view).toMatchObject({ enabled: true, status: 'unsupported', unsupported: 'driver' })
    expect(pluginsOf(A.ctx).usable(HWP_PLUGIN_ID)).toBe(false)
    const preview = await A.json(`/api/files/hwp-preview?path=${encodeURIComponent(FORM)}&page=1`, { as: 'alice' })
    expect(`${preview.status}:${preview.body?.error?.params?.reason}`).toBe('503:disabled')
    expect((await shown()).hwpRender).toBe(false)
    await writingOn()
  })

  test.skipIf(!pandoc)('on: make_file writes a new .hwpx, with a team .hwpx template too', async () => {
    const call = turn()
    const r = await call('make_file', { content: MD, format: 'hwpx', output: 'users/alice/out/보고서' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('Saved users/alice/out/보고서.hwpx')
    const styled = await call('make_file', { content: MD, format: 'hwpx', output: 'users/alice/out/서식', template: TEMPLATE })
    expect(styled.isError, styled.text).toBe(false)
    expect((await call('read', { file_path: 'users/alice/out/서식.hwpx' })).text).toContain('3분기 보고서')
    fs.rmSync(file('users/alice/out'), { recursive: true, force: true })
  })

  test('turned off, on again and removed while the server runs: each takes effect at the next listing and call', async () => {
    const off = await A.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/disable`, { ...jsonBody({}), as: 'carol' })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body).toMatchObject({ enabled: false })
    await writingOff()
    // the row Turn on writes (Turn on itself re-hashes the package first, which a stand-in renderer cannot pass)
    setHwpPlugin(A.ctx, true)
    await writingOn()
    const removed = await A.req(`/api/admin/plugins/${HWP_PLUGIN_ID}`, { method: 'DELETE', as: 'carol' })
    expect(removed.status).toBe(204)
    await writingOff()
    // installed again as a later version, on: back
    installHwpPlugin(A.ctx, { on: true, version: '1.0.1' })
    await writingOn()
  })

  test('a build the official list of this release withdrew is off, even with its row on', async () => {
    const digest = installHwpPlugin(A.ctx, { on: true })
    const dir = path.join(A.data, 'withdrawn-catalog')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 1, sequence: 2, entries: [], revoked: [{ id: HWP_PLUGIN_ID, manifestSha256: digest }] }))
    const m = pluginsOf(A.ctx)
    try {
      m.reconfigure({ catalogDir: dir })
      await writingOff()
      setHwpPlugin(A.ctx, true)
      expect(m.hwpWriting()).toBe(false)
    } finally { m.reconfigure({ catalogDir: defaultCatalogDir() }) }
    await writingOn()
    removeHwpPlugin(A.ctx)
    await writingOff()
  })
})
