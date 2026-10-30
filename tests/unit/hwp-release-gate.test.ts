import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disabledHwpEngine } from '../../server/src/files/hwp-engine'
import { stageHwp, type HwpTarget } from '../../scripts/hwp-bundle'
import { bundleManifest } from '../../scripts/build-office'
import { linuxBundleFiles } from '../../scripts/build-bundle'
import { sha256 } from '../../server/src/files/store'
import { makeCApp, type CApp } from '../lib/c-app'

// HWP ships only as the separately built HWP Preview plugin (docs/PLUGINS.md): local QA assets, stale destination assets
// and the old MYCEL_HWP_PREVIEW build switch never put the renderer into a server or office release. At runtime the
// plugin turned on is the only switch (the old release gate was removed when the founder cleared the renderer).
test('release staging never carries the HWP runtime; without the plugin nothing renders', async () => {
  const prior = process.env.MYCEL_HWP_PREVIEW
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-gate-'))
  const repo = path.resolve(import.meta.dir, '../..')
  const target = `${process.platform}-${process.arch}` as HwpTarget
  try {
    expect(disabledHwpEngine.identity).toBe('hwp-disabled')
    await expect(disabledHwpEngine.render(Buffer.from('unparsed'), 'hwp', 1)).rejects.toMatchObject({ reason: 'disabled' })
    for (const flag of [undefined, '1']) {
      if (flag) process.env.MYCEL_HWP_PREVIEW = flag; else delete process.env.MYCEL_HWP_PREVIEW
      for (const rel of ['native/bin/hwp', 'resources/hwp']) {
        fs.mkdirSync(path.join(stage, rel), { recursive: true })
        fs.writeFileSync(path.join(stage, rel, 'stale'), 'old QA assets')
      }
      await stageHwp(repo, stage, [target])
      for (const rel of ['native/bin/hwp', 'resources/hwp']) expect(fs.existsSync(path.join(stage, rel))).toBe(false)
      expect(bundleManifest({ pandoc: false, desktop: false }).some(p => /rhwp-|NotoSansKR|resources\/hwp|\.trinaplugin/.test(p))).toBe(false)
      expect(linuxBundleFiles({ arch: 'arm64', codexVersion: 'test', whisper: false, systemd: [] }).some(p => /rhwp-|NotoSansKR|resources\/hwp|\.trinaplugin/.test(p))).toBe(false)
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    if (prior === undefined) delete process.env.MYCEL_HWP_PREVIEW
    else process.env.MYCEL_HWP_PREVIEW = prior
  }
})

// Without the HWP plugin, installed QA assets and the gate switch do not enable the preview route, and original downloads
// stay byte-identical.
test('default-off HTTP preview is 503 while authorized original download remains byte-identical', async () => {
  const prior = process.env.MYCEL_HWP_PREVIEW
  let app: CApp | undefined
  try {
    process.env.MYCEL_HWP_PREVIEW = '1'
    app = await makeCApp('hwp-default-route')
    const bytes = fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp/two-pages.hwp'))
    fs.writeFileSync(path.join(app.team, 'users/alice/original.hwp'), bytes)
    const query = '?path=users%2Falice%2Foriginal.hwp'
    const preview = await app.json('/api/files/hwp-preview' + query + '&page=1', { as: 'alice' })
    expect(preview.status).toBe(503)
    expect(JSON.stringify(preview.body)).toContain('disabled')
    expect((await app.req('/api/files/hwp-preview' + query + '&page=1', { as: 'bob' })).status).toBe(404)
    const download = await app.req('/api/files/download' + query, { as: 'alice' })
    expect(download.status).toBe(200)
    expect(sha256(Buffer.from(await download.arrayBuffer()))).toBe(sha256(bytes))
  } finally {
    await app?.close()
    if (prior === undefined) delete process.env.MYCEL_HWP_PREVIEW
    else process.env.MYCEL_HWP_PREVIEW = prior
  }
})
