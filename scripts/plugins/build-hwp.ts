// Build the HWP Preview plugin package from the pinned assets (docs/PLUGINS.md "HWP 플러그인 만들기"):
//
//   bun run plugin:hwp                                   test package for this Mac/Linux CPU, signed with the
//                                                        developer's test key (scripts/plugins/test-key.ts)
//   bun run plugin:hwp -- --target linux-x64 --out dist/plugins
//   bun run plugin:hwp -- --key <pem> --cleared          a release package: refused until resources/hwp/clearance.json
//                                                        lists the target (licence + platform review), and never with
//                                                        the test key
//
// The package holds third-party bytes only: the pinned rhwp executable (downloaded and checked against
// resources/hwp/manifest.json by scripts/hwp-bundle.ts), the unchanged Noto Sans KR Regular font, and their notices and
// source offer. The driver, preflight, limits and isolation stay in core (server/src/files/hwp-*.ts), so the package
// licence is MIT AND OFL-1.1. Default server/office/desktop builds never include it (scripts/plugins/release-check.ts).
import fs from 'node:fs'
import path from 'node:path'
import hwpPins from '../../resources/hwp/manifest.json'
import serverPkg from '../../server/package.json'
import { PLUGIN_SCHEMA_VERSION, PluginCatalog } from '../../shared/src/plugins'
import { buildPackage } from '../../server/src/plugins/package'
import { publicKeyOfPem } from '../../server/src/plugins/trust'
import { stageHwp, type HwpTarget } from '../hwp-bundle'
import { ensureTestKey } from './test-key'

const REPO = path.resolve(import.meta.dir, '../..')
export const HWP_PLUGIN_VERSION = '1.0.0'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }

/** Targets whose redistribution review is finished (none yet). */
export function clearedTargets(repo = REPO): string[] {
  try { return (JSON.parse(fs.readFileSync(path.join(repo, 'resources/hwp/clearance.json'), 'utf8')) as { cleared?: string[] }).cleared ?? [] } catch { return [] }
}

export async function buildHwpPlugin(o: { target: HwpTarget; keyPem: string; version?: string; repo?: string; provision?: boolean }): Promise<{ bytes: Buffer; fileName: string }> {
  const repo = o.repo ?? REPO
  const pin = hwpPins.targets[o.target]
  if (!pin) throw new Error(`unknown HWP target ${o.target}`)
  if (o.provision !== false) await stageHwp(repo, repo, [o.target])
  const read = (rel: string) => fs.readFileSync(path.join(repo, rel))
  const catalog = PluginCatalog.parse(JSON.parse(fs.readFileSync(path.join(repo, 'resources/plugins/catalog.json'), 'utf8')))
  const entry = catalog.entries.find((e) => e.id === 'app.trina.hwp-preview')!
  const [os, cpu] = o.target.split('-') as ['darwin' | 'linux', 'arm64' | 'x64']
  const platform = entry.platforms!.find((p) => p.os === os && p.arch === cpu)!
  const payload = new Map<string, Uint8Array>([
    ['bin/rhwp', read(`native/bin/hwp/rhwp-${o.target}`)],
    ...hwpPins.fonts.map((f) => [`fonts/${f.file}`, read(`resources/hwp/fonts/${f.file}`)] as [string, Uint8Array]),
    ['notices/rhwp-MIT.txt', read('resources/hwp/notices/rhwp-MIT.txt')],
    ['notices/NotoSans-OFL.txt', read('resources/hwp/notices/NotoSans-OFL.txt')],
    ['notices/THIRD_PARTY_LICENSES.md', read('resources/hwp/notices/THIRD_PARTY_LICENSES.md')],
    ['notices/SOURCE-OFFER.txt', read('resources/hwp/notices/SOURCE-OFFER.txt')],
    ['NOTICE', Buffer.from(`HWP Preview plugin for Trina AX\n\nThis package contains third-party software only:\n- rhwp ${hwpPins.version} (MIT), ${hwpPins.source}\n- Noto Sans KR Regular (SIL Open Font License 1.1), unchanged\n\nSee notices/ for licences, the source offer and open notice findings (native Skia inventory, compiled font-metric provenance).\nThe HWP adapter, input checks and isolation are part of Trina AX core (AGPL-3.0-only).\n`)],
  ])
  const { bytes, manifest } = buildPackage({
    manifest: {
      schemaVersion: PLUGIN_SCHEMA_VERSION, id: 'app.trina.hwp-preview', version: o.version ?? HWP_PLUGIN_VERSION,
      publisher: { id: 'trina', name: 'Trina', homepage: 'https://trina.app' },
      kinds: ['native-tool', 'preview'],
      product: { apiVersion: 1, minVersion: serverPkg.version },
      scopes: { install: ['company'], enable: ['company'] },
      i18n: entry.i18n,
      permissions: entry.permissions,
      platforms: [platform],
      runtime: { driver: 'rhwp-v1', executable: 'bin/rhwp', fonts: hwpPins.fonts.map((f) => `fonts/${f.file}`) },
      contributes: { tools: [{ id: 'render-page', name: 'hwp_render', driver: 'rhwp-v1' }], previews: [{ extensions: ['hwp', 'hwpx'], tool: 'render-page', viewer: 'core-raster-v1' }] },
      license: 'MIT AND OFL-1.1',
      components: [
        { name: 'rhwp', version: hwpPins.version, license: 'MIT', notice: 'notices/rhwp-MIT.txt' },
        { name: 'Noto Sans KR Regular', license: 'OFL-1.1', notice: 'notices/NotoSans-OFL.txt' },
      ],
      notices: ['NOTICE', 'notices/THIRD_PARTY_LICENSES.md', 'notices/SOURCE-OFFER.txt'],
      source: { url: 'https://github.com/edwardkim/rhwp', revision: hwpPins.source.split('/').pop() },
    },
    payload, executables: new Set(['bin/rhwp']), keyPem: o.keyPem, gzip: true,
  })
  return { bytes, fileName: `${manifest.id}-${manifest.version}-${o.target}.trinaplugin` }
}

if (import.meta.main) {
  const target = (arg('--target') ?? `${process.platform}-${process.arch}`) as HwpTarget
  const out = path.resolve(arg('--out') ?? path.join(REPO, 'dist/plugins'))
  const testPem = ensureTestKey()
  const keyFile = arg('--key')
  const keyPem = keyFile ? fs.readFileSync(keyFile, 'utf8') : testPem
  const isTest = publicKeyOfPem(keyPem) === publicKeyOfPem(testPem)
  if (!isTest && !clearedTargets().includes(target)) {
    console.error(`HWP redistribution is not cleared for ${target} (resources/hwp/README.md: exact-version notices, native Skia inventory, font-metric provenance, platform qualification). Only test packages can be built.`)
    process.exit(1)
  }
  if (isTest && process.argv.includes('--cleared')) { console.error('a release package is never signed with the test key'); process.exit(1) }
  const { bytes, fileName } = await buildHwpPlugin({ target, keyPem, version: arg('--version') })
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, fileName), bytes)
  console.log(`${isTest ? 'TEST ' : ''}package: ${path.join(out, fileName)} (${bytes.length} bytes)`)
}
