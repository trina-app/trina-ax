// Build-time only. Never downloads an engine in response to a document or at server startup.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import manifest from '../resources/hwp/manifest.json'
export type HwpTarget = keyof typeof manifest.targets
const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
/**
 * Repo (destination === repo): provision the pinned rhwp CLI into ignored native/bin/hwp (`bun run prepare:hwp`; the
 * HWP plugin build, scripts/plugins/build-hwp.ts, and local tests use it).
 * Release staging (any other destination): server, office and desktop bundles never carry the renderer, its font or
 * any plugin package, whatever the environment says. HWP now ships only as the separately built HWP Preview plugin
 * package, and only once its licence and platform review is cleared (docs/PLUGINS.md). Stale assets are removed.
 */
export async function stageHwp(repo: string, destination: string, targets: HwpTarget[]) {
  if (destination !== repo) {
    for (const rel of ['native/bin/hwp', 'resources/hwp']) fs.rmSync(path.join(destination, rel), { recursive: true, force: true })
    return
  }
  const bins = path.join(repo, 'native/bin/hwp')
  fs.mkdirSync(bins, { recursive: true })
  for (const target of targets) {
    const pin = manifest.targets[target]
    if (!pin) throw new Error('Unsupported HWP target')
    const bin = path.join(bins, `rhwp-${target}`)
    if (!fs.existsSync(bin) || hash(bin) !== pin.binary) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-package-'))
      try {
        const response = await fetch(`https://github.com/edwardkim/rhwp/releases/download/v${manifest.version}/rhwp-v${manifest.version}-${pin.asset}.tar.gz`)
        if (!response.ok) throw new Error(`rhwp download failed: ${response.status}`)
        const archive = path.join(work, 'engine.tgz')
        fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
        if (hash(archive) !== pin.archive) throw new Error('rhwp archive checksum mismatch')
        const result = Bun.spawnSync(['tar', 'xzf', archive, '-C', work, 'rhwp/rhwp'])
        if (result.exitCode !== 0) throw new Error('rhwp extraction failed')
        const extracted = path.join(work, 'rhwp/rhwp')
        if (hash(extracted) !== pin.binary) throw new Error('rhwp executable checksum mismatch')
        fs.copyFileSync(extracted, bin); fs.chmodSync(bin, 0o755)
      } finally { fs.rmSync(work, { recursive: true, force: true }) }
    }
  }
}
if (import.meta.main) {
  const repo = path.resolve(import.meta.dir, '..')
  const targets = process.argv.slice(2) as HwpTarget[]
  await stageHwp(repo, repo, targets.length ? targets : [`${process.platform}-${process.arch}` as HwpTarget])
}
