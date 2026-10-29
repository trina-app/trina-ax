import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeHwpEngine } from '../../server/src/files/hwp-engine'
import { stageHwp, type HwpTarget } from '../../scripts/hwp-bundle'
import { bundleManifest } from '../../scripts/build-office'
import { linuxBundleFiles } from '../../scripts/build-bundle'
import manifest from '../../resources/hwp/manifest.json'
import { sha256 } from '../../server/src/files/store'

// This gate protects distribution as well as execution. Existing local QA assets
// and even stale destination assets must not leak into a default release.
test('HWP runtime and office/Linux staging are default off, independently of installed assets', async () => {
  const prior = process.env.MYCEL_HWP_PREVIEW
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-gate-'))
  const repo = path.resolve(import.meta.dir, '../..')
  const target = `${process.platform}-${process.arch}` as HwpTarget
  try {
    delete process.env.MYCEL_HWP_PREVIEW
    expect(nativeHwpEngine().identity).toBe('hwp-disabled')
    await expect(nativeHwpEngine().render(Buffer.from('unparsed'), 'hwp', 1)).rejects.toMatchObject({ reason: 'disabled' })
    for (const rel of ['native/bin/hwp', 'resources/hwp']) {
      fs.mkdirSync(path.join(stage, rel), { recursive: true })
      fs.writeFileSync(path.join(stage, rel, 'stale'), 'old QA assets')
    }
    await stageHwp(repo, stage, [target])
    for (const rel of ['native/bin/hwp', 'resources/hwp']) expect(fs.existsSync(path.join(stage, rel))).toBe(false)
    expect(bundleManifest({ pandoc: false, desktop: false }).some(p => p.includes('rhwp-'))).toBe(false)
    expect(linuxBundleFiles({ arch: 'arm64', codexVersion: 'test', whisper: false, systemd: [] }).some(p => p.includes('rhwp-'))).toBe(false)
    process.env.MYCEL_HWP_PREVIEW = '1'
    await stageHwp(repo, stage, [target])
    expect(sha256(fs.readFileSync(path.join(stage, 'native/bin/hwp', `rhwp-${target}`)))).toBe(manifest.targets[target].binary)
    expect(fs.existsSync(path.join(stage, 'resources/hwp/notices/rhwp-MIT.txt'))).toBe(true)
    expect(bundleManifest({ pandoc: false, desktop: false }).some(p => p.includes('rhwp-'))).toBe(true)
    expect(linuxBundleFiles({ arch: 'arm64', codexVersion: 'test', whisper: false, systemd: [] }).some(p => p.includes('rhwp-'))).toBe(true)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    if (prior === undefined) delete process.env.MYCEL_HWP_PREVIEW
    else process.env.MYCEL_HWP_PREVIEW = prior
  }
})
