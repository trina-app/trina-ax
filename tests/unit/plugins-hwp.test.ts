// HWP as the first plugin (docs/PLUGINS.md): preview and hwp_render exist only while the HWP Preview plugin is
// installed, on for the company, runnable here AND the release gate MYCEL_HWP_PREVIEW=1 is open. Reading HWP text and
// refusing plaintext writes to .hwp/.hwpx are core and work in every plugin state. Turning the plugin off, updating
// it or rolling it back cancels renders, drops cached pages and replaces the renderer; a replaced executable is refused.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { HwpError, type HwpEngine } from '../../server/src/files/hwp-engine'
import { HwpPreviews } from '../../server/src/files/hwp-preview'
import { makeHandler } from '../../server/src/mcp/protocol'
import { HWP_PLUGIN_ID } from '../../server/src/plugins/drivers'
import { pluginsOf, type PluginManager } from '../../server/src/plugins/manager'
import { componentC } from '../../server/src/team-files/component'
import { buildHwpPlugin } from '../../scripts/plugins/build-hwp'
import type { HwpTarget } from '../../scripts/hwp-bundle'
import { jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { newKey, prodTrust } from '../lib/plugins'

setDefaultTimeout(60_000)
const key = newKey()
const target = `${process.platform}-${process.arch}` as HwpTarget
const SRC = 'users/alice/test.hwp'
const REQUIRED = ['files.read.selected', 'preview.render', 'runtime.native.isolated']
let app: CApp
let m: PluginManager
let v100: Buffer, v101: Buffer

const listed = async () => {
  const t = app.toolCtx('alice', app.turn('alice', app.chat('alice')))
  const r = await makeHandler(app.ctx.files, app.ctx.db, t)({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const viaMcp = r.result.tools.some((x: { name: string }) => x.name === 'hwp_render')
  const turnTool = app.ctx.services.turnTools!.find((x) => x.name === 'hwp_render')!
  const viaTurn = turnTool.available!({ userId: 'alice', chatId: 'c', browser: false })
  expect(viaMcp).toBe(viaTurn)
  return viaMcp
}
const preview = async () => {
  const r = await app.json(`/api/files/hwp-preview?path=${encodeURIComponent(SRC)}&page=1`, { as: 'alice' })
  return r.status === 200 ? 'png' : `${r.status}:${r.body?.error?.params?.reason}`
}
const coreStillWorks = async () => {
  const t = app.toolCtx('alice')
  const read = await app.ctx.files.call('read', { file_path: SRC }, t)
  expect(read.isError ?? false).toBe(false)
  expect(read.text.length).toBeGreaterThan(20)
  const write = await app.ctx.files.call('write', { file_path: 'users/alice/new.HWPX', content: 'plain text' }, t)
  expect(write.isError).toBe(true)
  const grep = await app.ctx.files.call('grep', { pattern: '.', path: 'users/alice', output_mode: 'files_with_matches' }, t)
  expect(grep.isError ?? false).toBe(false)
}
async function installHwp(bytes: Buffer, permissions = [...REQUIRED, 'model.send.preview-pixels'], enable = true) {
  const fd = new FormData(); fd.set('file', new Blob([new Uint8Array(bytes)]), 'hwp.trinaplugin')
  const plan = (await app.json('/api/admin/plugins/inspect', { method: 'POST', body: fd, as: 'carol' })).body
  expect(plan.supported, JSON.stringify(plan)).toBe(true)
  const r = await app.json('/api/admin/plugins/install', { ...jsonBody({ token: plan.token, manifestSha256: plan.manifestSha256, enable, permissions }), as: 'carol' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body
}
const storeBin = () => {
  const row = app.ctx.db.query('SELECT p.store_dir FROM plugin_packages p JOIN plugin_installs i ON i.plugin_id = p.plugin_id AND i.active_version = p.version').get() as { store_dir: string }
  return path.join(app.data, 'plugins/store', HWP_PLUGIN_ID, row.store_dir, 'bin/rhwp')
}

beforeAll(async () => {
  app = await makeCApp('plugins-hwp')
  fs.copyFileSync(path.join(import.meta.dir, '../fixtures/hwp/agreement.hwp'), path.join(app.team, SRC))
  m = pluginsOf(app.ctx)
  m.reconfigure({ trust: prodTrust(key.pub), env: { MYCEL_HWP_PREVIEW: '1' } })
  v100 = (await buildHwpPlugin({ target, keyPem: key.pem, provision: false })).bytes
  v101 = (await buildHwpPlugin({ target, keyPem: key.pem, provision: false, version: '1.0.1' })).bytes
})
afterAll(async () => { await app.close() })

describe('HWP availability follows the plugin state', () => {
  test('no plugin: no tool, preview not available, text reading and the write guard unchanged', async () => {
    expect(await listed()).toBe(false)
    expect(await preview()).toBe('503:disabled')
    await coreStillWorks()
  })

  test('installed but off: still nothing', async () => {
    const r = await installHwp(v100, undefined, false)
    expect(r).toMatchObject({ id: HWP_PLUGIN_ID, enabled: false, status: 'disabled', license: 'MIT AND OFL-1.1' })
    expect(await listed()).toBe(false)
    expect(await preview()).toBe('503:disabled')
    await coreStillWorks()
  })

  test('on, but the release gate is closed (no MYCEL_HWP_PREVIEW=1): the uncleared renderer never runs', async () => {
    m.reconfigure({ env: {} })
    const r = await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/enable`, { ...jsonBody({}), as: 'carol' })
    expect(r.body).toMatchObject({ enabled: true, status: 'unsupported', unsupported: 'gate' })
    expect(await listed()).toBe(false)
    expect(await preview()).toBe('503:disabled')
    await coreStillWorks()
    m.reconfigure({ env: { MYCEL_HWP_PREVIEW: '1' } })
  })

  test('on with the gate open: the plugin renderer previews real pages, and the AI tool is offered', async () => {
    expect(m.usable(HWP_PLUGIN_ID)).toBe(true)
    expect(await preview()).toBe('png')
    expect(m.hwpEngine().identity).toContain(`:pkg-`)
    expect(await listed()).toBe(true)
    const t = app.toolCtx('alice', app.turn('alice', app.chat('alice')))
    const out = await makeHandler(app.ctx.files, app.ctx.db, t)({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hwp_render', arguments: { source: SRC, page: 1, format: 'png' } } })
    expect(out.result.isError ?? false).toBe(false)
    expect(out.result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    await coreStillWorks()
  })

  test('without the page-image permission the preview works but the AI tool is not offered', async () => {
    const r = await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/enable`, { ...jsonBody({ permissions: REQUIRED, manifestSha256: (await app.json('/api/admin/plugins', { as: 'carol' })).body.installed[0].manifestSha256 }), as: 'carol' })
    expect(r.status).toBe(200)
    expect(await preview()).toBe('png')
    expect(await listed()).toBe(false)
    const t = app.toolCtx('alice', app.turn('alice', app.chat('alice')))
    const out = await makeHandler(app.ctx.files, app.ctx.db, t)({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hwp_render', arguments: { source: SRC, page: 1, format: 'png' } } })
    expect(out.result.isError).toBe(true)
    expect(out.result.content[0].text).toContain('unknown tool')
  })

  test('update: new renderer instance, no cache hit from the old package; rollback the same', async () => {
    const before = await app.json(`/api/files/hwp-preview?path=${encodeURIComponent(SRC)}&page=1`, { as: 'alice' })
    expect(before.status).toBe(200)
    const oldEngine = m.hwpEngine()
    const r = await installHwp(v101)
    expect(r).toMatchObject({ version: '1.0.1', previousVersion: '1.0.0', enabled: true })
    expect(m.hwpEngine()).not.toBe(oldEngine)
    expect(m.hwpEngine().identity).not.toBe(oldEngine.identity)
    const stale = await app.json(`/api/files/hwp-preview?path=${encodeURIComponent(SRC)}&page=1&cacheId=${before.body.id}`, { as: 'alice' })
    expect(stale.body.error.params.reason).toBe('changed')
    const after = await app.json(`/api/files/hwp-preview?path=${encodeURIComponent(SRC)}&page=1`, { as: 'alice' })
    expect(after.status).toBe(200)
    const rolled = await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/rollback`, { ...jsonBody({}), as: 'carol' })
    expect(rolled.body).toMatchObject({ version: '1.0.0', previousVersion: '1.0.1' })
    expect((await app.json(`/api/files/hwp-preview?path=${encodeURIComponent(SRC)}&page=1&cacheId=${after.body.id}`, { as: 'alice' })).body.error.params.reason).toBe('changed')
    expect(await listed()).toBe(true)
  })

  test('turning it off while a page renders cancels the render and discards the result', async () => {
    let started!: () => void
    const running = new Promise<void>((r) => { started = r })
    const slow: HwpEngine = {
      identity: 'slow-fake',
      render: (_b, _e, _p, signal) => new Promise((_, reject) => {
        started()
        signal?.addEventListener('abort', () => reject(new HwpError('cancelled')), { once: true })
      }),
    }
    const c = componentC(app.ctx), old = c.hwp
    c.hwp = new HwpPreviews(c.files, () => (m.usable(HWP_PLUGIN_ID) ? slow : m.hwpEngine()))
    try {
      const page = c.hwp.page('alice', SRC, 1)
      await running
      await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/disable`, { ...jsonBody({}), as: 'carol' })
      await expect(page).rejects.toBeInstanceOf(HwpError)
      await expect(c.hwp.page('alice', SRC, 1)).rejects.toMatchObject({ reason: 'disabled' })
    } finally { c.hwp = old }
    expect(await listed()).toBe(false)
  })

  test('a replaced executable is refused on enable and before every run', async () => {
    const on = await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/enable`, { ...jsonBody({}), as: 'carol' })
    expect(on.status).toBe(200)
    expect(await preview()).toBe('png')
    const bin = storeBin(), good = fs.readFileSync(bin)
    fs.chmodSync(bin, 0o755)
    // same size, different bytes: the cheap check passes, the hash before the run does not
    const evil = Buffer.from(good); evil[evil.length - 1] = evil[evil.length - 1]! ^ 0xff
    fs.writeFileSync(bin, evil)
    try {
      // a page not rendered before (a cached page came from the verified binary)
      componentC(app.ctx).hwp.invalidate()
      expect(await preview()).toBe('503:engine')
      await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/disable`, { ...jsonBody({}), as: 'carol' })
      const refused = await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/enable`, { ...jsonBody({}), as: 'carol' })
      expect(refused.body.error.params.reason).toBe('tampered')
    } finally { fs.writeFileSync(bin, good); fs.chmodSync(bin, 0o555) }
    expect((await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}/enable`, { ...jsonBody({}), as: 'carol' })).status).toBe(200)
    expect(await preview()).toBe('png')
  })

  test('a broken store and an uninstalled plugin: nothing HWP-specific remains, core reading stays', async () => {
    const dir = path.dirname(path.dirname(storeBin()))
    fs.renameSync(dir, dir + '.moved')
    expect(await listed()).toBe(false)
    expect(await preview()).toBe('503:disabled')
    await coreStillWorks()
    fs.renameSync(dir + '.moved', dir)
    expect(await preview()).toBe('png')
    expect((await app.json(`/api/admin/plugins/${HWP_PLUGIN_ID}`, { method: 'DELETE', as: 'carol' })).status).toBe(204)
    expect(await listed()).toBe(false)
    expect(await preview()).toBe('503:disabled')
    await coreStillWorks()
    expect(fs.existsSync(path.join(app.data, 'plugins/store', HWP_PLUGIN_ID))).toBe(false)
  })
})
