// What the store zip is built from, as one fingerprint (chrome-extension/shipped.json; docs/RELEASE-CI.md "Chrome
// extension releases"). A change to any of it must bump EXTENSION_VERSION, so the store never gets one version with two
// different contents. The parts:
//   - every TypeScript file the entry points and build.ts import, found through their imports (type-only imports do
//     not count: they are not in the bundle), hashed without comments and types (TypeScript's own transpiler, pinned in
//     bun.lock, so a comment or a type changes nothing and the result does not depend on the Bun version);
//   - build.ts the same way, with the version's value left out (bumping it is not a change);
//   - the pages, the icons and the desktop pane's page script, byte for byte (they are copied into the zip as they are);
//   - the version of each npm package the code imports (zod …).
// Not in it: the Bun version that bundles (CI pins it), tests, docs, the store listing (store/: uploaded by hand).
//   bun chrome-extension/inputs.ts   prints the files and the fingerprint
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { ENTRYPOINTS, ICON_SIZES, ICONS_DIR, PAGES, PAGE_SCRIPT_FILE } from './build'

const ROOT = resolve(import.meta.dir, '..')
const BUILD = 'chrome-extension/build.ts'
const VERSION_LINE = /(export const EXTENSION_VERSION = )'[^']*'/
const CODE = /\.(ts|tsx|js|mjs)$/

export interface Inputs {
  /** repository-relative path → sha256 of what counts in it */
  files: Record<string, string>
  /** npm package → its version */
  packages: Record<string, string>
}

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/')

function codeHash(file: string, src: string): string {
  const text = file === BUILD ? src.replace(VERSION_LINE, "$1'<version>'") : src
  const out = ts.transpileModule(text, {
    fileName: file,
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
  }).outputText
  return sha(out)
}

function packageOf(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function packageVersion(name: string, entry: string): string {
  for (let d = dirname(entry); d !== dirname(d); d = dirname(d)) {
    const pj = join(d, 'package.json')
    if (!existsSync(pj)) continue
    const j = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string }
    if (j.name === name && j.version) return j.version
  }
  throw new Error(`no version found for ${name} (${entry})`)
}

/** Every input of the store zip, each hashed. */
export function extensionInputs(): Inputs {
  const files: Record<string, string> = {}
  const packages: Record<string, string> = {}
  const scanner = new Bun.Transpiler({ loader: 'ts' })
  const queue = [BUILD, ...ENTRYPOINTS].map((f) => join(ROOT, f))
  const seen = new Set<string>()
  while (queue.length) {
    const abs = queue.shift()!
    if (seen.has(abs)) continue
    seen.add(abs)
    const src = readFileSync(abs, 'utf8')
    files[rel(abs)] = codeHash(rel(abs), src)
    for (const imp of scanner.scanImports(src)) {
      const spec = imp.path
      if (spec === 'bun' || spec.startsWith('node:') || spec.startsWith('bun:')) continue
      const target = Bun.resolveSync(spec, dirname(abs))
      const inRepo = target.startsWith(ROOT + sep) && !target.includes(`${sep}node_modules${sep}`)
      if (inRepo) {
        // a relative import, or a workspace package of this repository (@mycel/shared/…): its file is code we build
        if (!CODE.test(target)) throw new Error(`${rel(abs)} imports ${spec}: not code; add it to the copied files in build.ts`)
        queue.push(target)
      } else if (spec.startsWith('.')) {
        throw new Error(`${rel(abs)} imports ${spec} outside the repository`)
      } else {
        const name = packageOf(spec)
        packages[name] = packageVersion(name, target)
      }
    }
  }
  const raw = [...PAGES.map((p) => `chrome-extension/src/${p}`), ...ICON_SIZES.map((s) => `${ICONS_DIR}/icon-${s}.png`), PAGE_SCRIPT_FILE]
  for (const f of raw) files[f] = sha(readFileSync(join(ROOT, f)))
  return { files: sortKeys(files), packages: sortKeys(packages) }
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** One sha256 over all the inputs (stable order). */
export function fingerprintOf(i: Inputs): string {
  const lines = [...Object.entries(i.files).map(([f, h]) => `file ${f} ${h}`), ...Object.entries(i.packages).map(([p, v]) => `package ${p} ${v}`)]
  return sha(`${lines.join('\n')}\n`)
}

export const extensionFingerprint = () => fingerprintOf(extensionInputs())

if (import.meta.main) {
  const i = extensionInputs()
  console.log(JSON.stringify({ ...i, fingerprint: fingerprintOf(i) }, null, 2))
}
