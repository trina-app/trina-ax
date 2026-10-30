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
// carries no AGPL code. The executable statically links Rust crates, the Rust standard library, Skia and Skia's
// third-party C/C++ libraries; resources/hwp/notices/THIRD_PARTY_NOTICES.md lists them with exact versions and licences.
// Default server/office/desktop builds never include it (scripts/plugins/release-check.ts).
import fs from 'node:fs'
import path from 'node:path'
import hwpPins from '../../resources/hwp/manifest.json'
import rustCrates from '../../resources/hwp/notices/rust-crates.json'
import serverPkg from '../../server/package.json'
import { PLUGIN_SCHEMA_VERSION, PluginCatalog } from '../../shared/src/plugins'
import { buildPackage } from '../../server/src/plugins/package'
import { publicKeyOfPem } from '../../server/src/plugins/trust'
import { stageHwp, type HwpTarget } from '../hwp-bundle'
import { ensureTestKey } from './test-key'

const REPO = path.resolve(import.meta.dir, '../..')
export const HWP_PLUGIN_VERSION = '1.0.0'

/** Package licence (also the catalog entry's). MPL-2.0: the part of svg2pdf's draw_path that its NOTICE puts under it.
 * LicenseRef-HWP-Notices: the further licences that notices/THIRD_PARTY_NOTICES.md names and notices/ reproduces
 * (BSD-2-Clause, MIT-0, Zlib, Unicode-3.0, MIT-Modern-Variant, IJG, libpng-2.0). */
export const HWP_PLUGIN_LICENSE = 'MIT AND Apache-2.0 AND BSD-3-Clause AND MPL-2.0 AND OFL-1.1 AND LicenseRef-HWP-Notices'

/** Package path → repository path of every notice file the package carries. */
export const HWP_NOTICE_FILES: Record<string, string> = Object.fromEntries([
  'THIRD_PARTY_NOTICES.md', 'SOURCE-OFFER.txt', 'rhwp-MIT.txt', 'rust-crates.txt', 'rust-std-1.93.1-COPYRIGHT-library.html',
  'native-libraries.txt', 'NotoSans-OFL.txt',
].map((f) => [`notices/${f}`, `resources/hwp/notices/${f}`]))

const NATIVE = 'notices/native-libraries.txt'
/** What the install prompt lists: what the linker kept in the four executables (ICU and Skia text layout are built but
 * not linked; Expat is in the Linux executables only). Versions of the C/C++ parts mirror notices/native-libraries.txt
 * (tested). */
export const HWP_COMPONENTS: { name: string; version?: string; license: string; notice: string; linuxOnly?: true }[] = [
  { name: 'rhwp', version: hwpPins.version, license: 'MIT', notice: 'notices/rhwp-MIT.txt' },
  { name: `Rust crates linked into rhwp (${rustCrates.crates.length})`, license: rustCrates.licenses.join(' AND '), notice: 'notices/rust-crates.txt' },
  { name: 'svg2pdf, the part of draw_path taken from resvg', version: '0.13.0', license: 'MPL-2.0', notice: 'notices/rust-crates.txt' },
  { name: 'Rust standard library', version: '1.93.1', license: '(MIT OR Apache-2.0) AND Unicode-3.0', notice: 'notices/rust-std-1.93.1-COPYRIGHT-library.html' },
  { name: 'Skia', version: 'm153', license: 'BSD-3-Clause', notice: NATIVE },
  { name: 'HarfBuzz', version: '13.1.0', license: 'MIT-Modern-Variant AND MIT', notice: NATIVE },
  { name: 'libjpeg-turbo', version: '3.1.0', license: 'IJG AND BSD-3-Clause AND Zlib', notice: NATIVE },
  { name: 'libpng', version: '1.6.56', license: 'libpng-2.0', notice: NATIVE },
  { name: 'zlib (Chromium)', version: '1.3.0.1', license: 'Zlib AND BSD-3-Clause', notice: NATIVE },
  { name: 'Expat', version: '2.7.4', license: 'MIT', notice: NATIVE, linuxOnly: true },
  { name: 'Wuffs', version: '0.3.3', license: 'Apache-2.0', notice: NATIVE },
  { name: 'Noto Sans KR Regular', license: 'OFL-1.1', notice: 'notices/NotoSans-OFL.txt' },
]
/** The components the package for one target lists. */
export const hwpComponents = (target: HwpTarget) =>
  HWP_COMPONENTS.filter((c) => target.startsWith('linux-') || !c.linuxOnly).map(({ linuxOnly: _, ...c }) => c)

const PACKAGE_NOTICE = `HWP Preview plugin for Trina AX

This package contains third-party software only, unchanged:
- rhwp ${hwpPins.version} command-line program (MIT), ${hwpPins.source}
  It statically links Rust crates, the Rust standard library, Skia and Skia's libraries HarfBuzz, libjpeg-turbo,
  libpng, zlib, Wuffs and (Linux) Expat (BSD, MIT, Apache-2.0, Zlib, Unicode, IJG and libpng licences). One function
  of the svg2pdf crate contains code under the Mozilla Public License 2.0; notices/SOURCE-OFFER.txt says where its
  source is.
- Noto Sans KR Regular (SIL Open Font License 1.1).

This software is based in part on the work of the Independent JPEG Group.

notices/THIRD_PARTY_NOTICES.md lists every component with its version and licence; the full licence texts are in
notices/. notices/SOURCE-OFFER.txt says where the exact sources are.
The HWP adapter, input checks and isolation are part of Trina AX core (AGPL-3.0-only).
`

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
    ...Object.entries(HWP_NOTICE_FILES).map(([to, from]) => [to, read(from)] as [string, Uint8Array]),
    ['NOTICE', Buffer.from(PACKAGE_NOTICE)],
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
      license: HWP_PLUGIN_LICENSE,
      components: hwpComponents(o.target),
      notices: ['NOTICE', 'notices/THIRD_PARTY_NOTICES.md', 'notices/SOURCE-OFFER.txt'],
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
    console.error(`HWP redistribution is not cleared for ${target} (resources/hwp/README.md: compiled font-metric provenance, platform qualification, owner sign-off). Only test packages can be built.`)
    process.exit(1)
  }
  if (isTest && process.argv.includes('--cleared')) { console.error('a release package is never signed with the test key'); process.exit(1) }
  const { bytes, fileName } = await buildHwpPlugin({ target, keyPem, version: arg('--version') })
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, fileName), bytes)
  console.log(`${isTest ? 'TEST ' : ''}package: ${path.join(out, fileName)} (${bytes.length} bytes)`)
}
