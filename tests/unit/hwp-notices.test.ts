// The HWP Preview package notices (resources/hwp/notices, docs/DECISIONS.md "HWP plugin notices") describe exactly the
// pinned rhwp executable: every notice file the package lists exists, the install-prompt components point at a file that
// names their version, the generated Rust inventory matches its text, and the catalog shows the package licence.
// No executable or network is needed (the package build itself is covered by plugins-hwp.test.ts).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import hwpPins from '../../resources/hwp/manifest.json'
import rustCrates from '../../resources/hwp/notices/rust-crates.json'
import { HWP_COMPONENTS, HWP_NOTICE_FILES, HWP_PLUGIN_LICENSE } from '../../scripts/plugins/build-hwp'
import { conjuncts, elect } from '../../scripts/plugins/hwp-notices'
import { PluginCatalog } from '../../shared/src/plugins'

const REPO = path.resolve(import.meta.dir, '../..')
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8')
const LICENSE = /^[A-Za-z0-9.+() -]+$/ // the manifest's licence field

describe('HWP plugin notices', () => {
  test('every notice file exists; the stale upstream project-wide list is gone', () => {
    for (const from of Object.values(HWP_NOTICE_FILES)) expect(fs.existsSync(path.join(REPO, from))).toBe(true)
    expect(fs.existsSync(path.join(REPO, 'resources/hwp/notices/THIRD_PARTY_LICENSES.md'))).toBe(false)
    const files = new Set(Object.keys(HWP_NOTICE_FILES))
    for (const c of HWP_COMPONENTS) expect(files.has(c.notice)).toBe(true)
  })

  test('each component names a version the notices state, and fits the manifest fields', () => {
    const index = read('resources/hwp/notices/THIRD_PARTY_NOTICES.md')
    const native = read('resources/hwp/notices/native-libraries.txt')
    expect(HWP_COMPONENTS.length).toBeLessThanOrEqual(50)
    for (const c of HWP_COMPONENTS) {
      expect(c.license.length).toBeLessThanOrEqual(100)
      expect(c.license).toMatch(LICENSE)
      if (!c.version) continue
      expect(index).toContain(c.version)
      if (c.notice === 'notices/native-libraries.txt') expect(native).toContain(`${c.version} `)
    }
    expect(HWP_PLUGIN_LICENSE.length).toBeLessThanOrEqual(100)
    expect(HWP_PLUGIN_LICENSE).toMatch(LICENSE)
  })

  test('the generated Rust inventory belongs to the pinned rhwp and matches its text', () => {
    expect(rustCrates.rhwp).toBe(hwpPins.version)
    expect(rustCrates.source).toBe(hwpPins.source)
    const txt = read('resources/hwp/notices/rust-crates.txt')
    expect(txt).toContain(`${rustCrates.crates.length} crates.`)
    expect(txt).toContain(rustCrates.cargoLockSha256)
    for (const c of rustCrates.crates) {
      expect(txt).toContain(`${c.name} | ${c.version} | ${c.declared} | ${c.usedUnder.join(' AND ')} |`)
      expect(rustCrates.licenses).toEqual(expect.arrayContaining(c.usedUnder))
    }
    // no copyleft or unknown licence slipped in
    for (const id of rustCrates.licenses) expect(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'Zlib', 'BSL-1.0', 'Unicode-3.0', 'CC0-1.0', '0BSD', 'Unlicense']).toContain(id)
  })

  test('licence choice: the preferred alternative of each part of the expression', () => {
    expect(conjuncts('(Apache-2.0 OR MIT) AND BSD-3-Clause')).toEqual([['Apache-2.0', 'MIT'], ['BSD-3-Clause']])
    expect(elect('MIT/Apache-2.0')).toEqual(['MIT'])
    expect(elect('(MIT OR Apache-2.0) AND Unicode-3.0')).toEqual(['MIT', 'Unicode-3.0'])
    expect(elect('CC0-1.0 OR MIT-0 OR Apache-2.0')).toEqual(['MIT-0'])
    expect(elect('Apache-2.0 OR BSL-1.0')).toEqual(['Apache-2.0'])
  })

  test('the JPEG statement the IJG licence requires is in the package notices', () => {
    for (const f of ['THIRD_PARTY_NOTICES.md', 'native-libraries.txt']) expect(read(`resources/hwp/notices/${f}`)).toContain('This software is based in part on the work of the Independent JPEG Group.')
  })

  test('the catalog shows the package licence', () => {
    const catalog = PluginCatalog.parse(JSON.parse(read('resources/plugins/catalog.json')))
    expect(catalog.entries.find((e) => e.id === 'app.trina.hwp-preview')!.license).toBe(HWP_PLUGIN_LICENSE)
  })
})
