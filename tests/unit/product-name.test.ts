// The product's name is written in one place, shared/src/product.ts (PRODUCT), so a rename is a one-line change.
// This guard fails when the name (displayName, shortName or the file-name form artifactBase) is written as a literal in
// user-facing source anywhere else: the web app and its pages, the desktop app and its electron-builder config, the
// server, the relay, the menubar app and the office scripts. Comments count too (they turn into stale docs).
// Names already on people's machines (~/TeamAX, `teamax`, app.team-ax.office, TEAMAX_* settings) are ids, not the
// name, and are not checked. Also checked: product.env is safe for the shell scripts that read it.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT, productEnv } from '@mycel/shared'
import { fillProduct, pwaFile } from '../../web/scripts/product-pages'
import builderConfig from '../../desktop/electron-builder.config'
import { isOfficeFolder } from '../../server/src/office/update'

const ROOT = path.resolve(import.meta.dir, '../..')

/** user-facing source: folders (every text file under them) and single files */
const SCOPE = [
  'web/src', 'web/public', 'web/pwa', 'web/scripts', 'web/index.html', 'web/vite.config.ts',
  'desktop/src', 'desktop/package.json', 'desktop/build.ts', 'desktop/electron-builder.config.ts',
  'server/src', 'relay/src', 'shared/src',
  'menubar/Sources', 'menubar/build.sh',
  'scripts/office',
]
/** Files that may carry the name, each with the reason. Keep this short. */
const ALLOW: Record<string, string> = {
  'shared/src/product.ts': 'the one place the name is written',
  // the office's "read me first" sheet is a document (docs-neutralization owns its wording), copied into the zip as is
  'scripts/office/README.txt': 'document copied verbatim into the office zip; reworded with the docs',
}
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|webmanifest|html|css|sh|swift|txt|sb|plist)$|^[^.]+$/

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [rel]
  return fs.readdirSync(abs, { recursive: true }).map(String)
    .filter((f) => !f.split(path.sep).some((p) => p === 'node_modules' || p === 'dist' || p === 'build'))
    .map((f) => path.join(rel, f))
    .filter((f) => fs.statSync(path.join(ROOT, f)).isFile() && TEXT.test(path.basename(f)))
}

const NAMES = [...new Set([PRODUCT.displayName, PRODUCT.shortName, PRODUCT.artifactBase])]

describe('the product name is written only in shared/src/product.ts', () => {
  test('no literal product name in user-facing source', () => {
    const all = SCOPE.flatMap(files)
    expect(all.length).toBeGreaterThan(200) // the scope really is scanned
    const hits: string[] = []
    for (const f of all) {
      if (f in ALLOW) continue
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')
      lines.forEach((l, i) => { for (const n of NAMES) if (l.includes(n)) hits.push(`${f}:${i + 1}: "${n}" in ${l.trim().slice(0, 120)}`) })
    }
    expect(hits).toEqual([])
  })
  test('the allow-list names files that exist', () => {
    for (const f of Object.keys(ALLOW)) expect({ f, exists: fs.existsSync(path.join(ROOT, f)) }).toEqual({ f, exists: true })
  })
  test('the names are usable everywhere they go', () => {
    for (const n of [PRODUCT.displayName, PRODUCT.shortName]) expect(n).toMatch(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u)
    expect(PRODUCT.artifactBase).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/) // file names, a User-Agent token
    expect(PRODUCT.officeBundle).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}-office$/) // update.ts isOfficeFolder
    expect(PRODUCT.id).toBe('mycel') // folders, sockets, bundle ids: never renamed
  })
})

describe('files built from PRODUCT', () => {
  test('product.env: KEY=value lines a shell script can read with sed', () => {
    const env = productEnv({ PRODUCT_OFFICE_PDF: 'guide.pdf' })
    expect(env).toContain(`PRODUCT_NAME=${PRODUCT.displayName}\n`)
    expect(env).toContain(`PRODUCT_ARTIFACT_BASE=${PRODUCT.artifactBase}\n`)
    expect(env).toContain('PRODUCT_OFFICE_PDF=guide.pdf\n')
    for (const l of env.trimEnd().split('\n')) expect(l).toMatch(/^[A-Z_]+=[^"'`$\\]*$/)
    expect(() => productEnv({ X: 'a$(reboot)' })).toThrow()
    expect(() => productEnv({ X: 'a\nB=c' })).toThrow()
  })
  test('web: index.html, manifest and the service worker get the name at build', () => {
    const html = fillProduct(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8'), 'index.html')
    expect(html).toContain(`<title>${PRODUCT.displayName}</title>`)
    const manifest = JSON.parse(pwaFile('manifest.webmanifest')) as { name: string; short_name: string }
    expect(manifest).toMatchObject({ name: PRODUCT.displayName, short_name: PRODUCT.shortName })
    expect(pwaFile('sw.js')).toContain(`<title>${PRODUCT.displayName}</title>`)
    expect(() => fillProduct('__PRODUCT_TYPO__', 'x')).toThrow(/unknown placeholder/)
  })
  test('office updates take a zip whose folder has another product name (a rename does not strand an office)', () => {
    expect(isOfficeFolder(`${PRODUCT.officeBundle}-0.3.0`, '0.3.0')).toBe(true)
    expect(isOfficeFolder('TeamAX-office-0.3.0', '0.3.0')).toBe(true)
    expect(isOfficeFolder('Acme-Desk-office-0.3.0-beta.1', '0.3.0-beta.1')).toBe(true)
    expect(isOfficeFolder('Acme-Desk-office-0.3.1', '0.3.0')).toBe(false)
    expect(isOfficeFolder('-office-0.3.0', '0.3.0')).toBe(false)
    expect(isOfficeFolder('../x-office-0.3.0', '0.3.0')).toBe(false)
    expect(isOfficeFolder('a b-office-0.3.0', '0.3.0')).toBe(false)
  })
  test('desktop: electron-builder takes the name, the file names and the shortcut from PRODUCT; appId stays', () => {
    const c = builderConfig
    expect(c.appId).toBe('com.treesoop.mycel')
    expect(c.productName).toBe(PRODUCT.displayName)
    expect(c.nsis.shortcutName).toBe(PRODUCT.displayName)
    expect(c.nsis.artifactName).toBe(`${PRODUCT.artifactBase}-Setup-\${version}-win-\${arch}.\${ext}`)
    expect(c.dmg.artifactName).toBe(`${PRODUCT.artifactBase}-\${version}-mac-\${arch}.\${ext}`)
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8')) as Record<string, unknown> & { scripts: Record<string, string> }
    expect(pkg.build).toBeUndefined()
    expect(pkg.productName).toBeUndefined()
    for (const [k, v] of Object.entries(pkg.scripts)) if (v.includes('electron-builder')) expect({ k, v: v.includes('--config electron-builder.config.ts') }).toEqual({ k, v: true })
  })
})
