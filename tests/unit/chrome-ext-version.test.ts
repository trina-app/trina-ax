// The Chrome extension's version guard (chrome-extension/release.ts, inputs.ts; docs/RELEASE-CI.md "Chrome extension
// releases"): shipped.json names EXTENSION_VERSION and the fingerprint of what the store zip is built from today, so a
// change that reaches the zip cannot merge without a bump. A guard test (scripts/ci/guard-tests.ts).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_VERSION } from '../../chrome-extension/build'
import { extensionInputs, fingerprintOf } from '../../chrome-extension/inputs'
import { compareVersions, nextVersion, parseShipped, problems, SHIPPED_FILE } from '../../chrome-extension/release'

const ROOT = join(import.meta.dir, '../..')

describe('chrome-extension/shipped.json', () => {
  test('names EXTENSION_VERSION and the fingerprint of today\'s inputs (else: bun run chrome:bump patch|minor|major)', () => {
    const shipped = parseShipped(readFileSync(join(ROOT, SHIPPED_FILE), 'utf8'))
    expect(problems({ version: EXTENSION_VERSION, fingerprint: fingerprintOf(extensionInputs()), shipped, base: null })).toEqual([])
  })

  test('the inputs are the bundle\'s sources, its copied files and its packages', () => {
    const i = extensionInputs()
    const files = Object.keys(i.files)
    for (const f of ['chrome-extension/build.ts', 'chrome-extension/src/worker.ts', 'chrome-extension/src/popup.html', 'shared/src/api/chrome.ts',
      'shared/src/product.ts', 'desktop/src/main/pane/page-script.js', 'editions/trina/branding/chrome/icon-128.png']) expect(files).toContain(f)
    // reached through the workspace package name (@mycel/shared/…), not only relative imports
    expect(files).toContain('shared/src/web-site.ts')
    expect(Object.keys(i.packages)).toContain('zod')
    expect(Object.keys(i.packages).some((p) => p.startsWith('@mycel/'))).toBe(false)
    // never the tests, the store listing or the dev key
    expect(files.some((f) => f.startsWith('tests/') || f.startsWith('chrome-extension/store/') || f.endsWith('dev-key.pub'))).toBe(false)
  })
})

describe('the version rules', () => {
  const shipped = { version: '0.2.0', fingerprint: 'a' }
  test('current and unchanged: nothing', () => {
    expect(problems({ version: '0.2.0', fingerprint: 'a', shipped, base: { version: '0.2.0', fingerprint: 'a' } })).toEqual([])
  })
  test('a change not recorded', () => {
    expect(problems({ version: '0.2.0', fingerprint: 'b', shipped, base: null })[0]).toContain('chrome:bump')
  })
  test('a version edited by hand', () => {
    expect(problems({ version: '0.2.1', fingerprint: 'a', shipped, base: null })[0]).toContain('names 0.2.0')
  })
  test('changed against the base with the same version (shipped.json written by hand)', () => {
    const p = problems({ version: '0.2.0', fingerprint: 'a', shipped, base: { version: '0.2.0', fingerprint: 'z' } })
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('not above the base')
  })
  test('changed against the base with a higher version: fine; only a version bump: fine', () => {
    expect(problems({ version: '0.2.0', fingerprint: 'a', shipped, base: { version: '0.1.9', fingerprint: 'z' } })).toEqual([])
    expect(problems({ version: '0.2.0', fingerprint: 'a', shipped, base: { version: '0.1.9', fingerprint: 'a' } })).toEqual([])
  })
  test('numbers only, compared as numbers', () => {
    expect(problems({ version: '0.3.0-beta.1', fingerprint: 'a', shipped: { version: '0.3.0-beta.1', fingerprint: 'a' }, base: null })[0]).toContain('not MAJOR.MINOR.PATCH')
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(nextVersion('0.2.9', 'patch')).toBe('0.2.10')
    expect(nextVersion('0.2.9', 'minor')).toBe('0.3.0')
    expect(nextVersion('0.2.9', 'major')).toBe('1.0.0')
    expect(() => nextVersion('01.2.3', 'patch')).toThrow()
  })
})
