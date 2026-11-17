// Bun.build settings shared by every build that bundles pdf-lib: the office worker built on first use in a source
// checkout (extract.ts officeWorkerScript) and the release bundles (scripts/build-bundle.ts, scripts/build-office.ts).
//
// pdf-lib's PNG reader imports @pdf-lib/upng, a package with both an ES module ("module") and a CommonJS file ("main",
// whose export is `{ default: UPNG }`). Bun.build sometimes took the CommonJS one for that import and bundled a call
// of `.default.decode` on its CommonJS helper, which is not a function: every stamp_pdf / edit_pdf image of that
// process then failed with "a damaged PNG or JPG" (b-card-approved-once and others failed now and then in CI,
// 2026-11-17). The plugin names the ES module, so the choice does not depend on the bundler's order of work, and the
// check stops a bad bundle.
import fs from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'

/** The ES module file of @pdf-lib/upng as pdf-lib resolves it, or null when it cannot be found. */
export function upngModulePath(): string | null {
  try {
    const pdfLib = path.dirname(require.resolve('pdf-lib/package.json', { paths: [import.meta.dir] }))
    const upng = path.join(path.dirname(require.resolve('@pdf-lib/upng/package.json', { paths: [pdfLib] })), 'UPNG.js')
    return fs.existsSync(upng) ? upng : null
  } catch {
    return null
  }
}

/** Bun.build plugins that pin @pdf-lib/upng to its ES module. Throws when the module is missing: a build without the
 * pin could come out broken. */
export function pdfLibBundlePlugins(): BunPlugin[] {
  const upng = upngModulePath()
  if (!upng) throw new Error('bundle: @pdf-lib/upng/UPNG.js not found next to pdf-lib (run bun install)')
  return [{ name: 'pin-upng-es', setup(b) { b.onResolve({ filter: /^@pdf-lib\/upng$/ }, () => ({ path: upng })) } }]
}

/** Throws when a built file bundled @pdf-lib/upng as CommonJS. This looks for Bun's CommonJS interop helper of that
 * import, which Bun names `import_<package>` (here with the package name upng). The check depends on that naming: a
 * Bun release that names it differently would make it pass without looking, so tests/unit/office-worker-bundle.test.ts
 * builds a CommonJS bundle and expects a throw.
 * Neither the pattern nor any text of this file contains that name, since main.js bundles this file. */
const COMMONJS_UPNG = /\bimport_[u]png\b/
export function assertNoCommonJsUpng(file: string): void {
  if (COMMONJS_UPNG.test(fs.readFileSync(file, 'utf8'))) {
    throw new Error(`bundle: ${path.basename(file)} bundled the PNG reader (@pdf-lib/upng) as a CommonJS import; PNG images would fail to read`)
  }
}
