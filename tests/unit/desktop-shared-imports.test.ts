// The desktop app imports shared code module by module, never through a barrel (shared/src/index.ts, api/index.ts, …).
// A barrel pulled 94 of 140 shared files into the desktop bundles, every API schema included, and tree shaking does not
// drop zod schemas: the built app changed on releases that only changed the server, and the Windows/Mac installer was
// rebuilt and re-downloaded for nothing. With direct imports the bundles hold only the shared code the desktop really
// uses (plan: docs/AGENTS/plan/20261126-0701-desk-direct-shared-imports.md).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const DESKTOP = join(ROOT, 'desktop')
/** the specifiers of shared/package.json "exports" that are barrels (a file of re-exports) */
const BARRELS = new Set(['@mycel/shared', '@mycel/shared/api', '@mycel/shared/relay-protocol', '@mycel/shared/cloud-protocol'])

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return tsFiles(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

/** every module specifier a file imports or re-exports (static and dynamic) */
function specifiers(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]!)
  return out
}

describe('desktop imports of shared code', () => {
  test('no desktop source file (nor build.ts) imports a shared barrel or reaches into shared/ by a relative path', () => {
    const bad: string[] = []
    for (const f of [...tsFiles(join(DESKTOP, 'src')), join(DESKTOP, 'build.ts')]) {
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        const shared = s.startsWith('@mycel/shared')
        if ((shared && (BARRELS.has(s) || /\/index(\.ts)?$/.test(s))) || (!shared && /(^|\/)shared\/src\//.test(s))) bad.push(`${relative(ROOT, f)}: '${s}'`)
      }
    }
    expect(bad).toEqual([])
  })

  test('the built bundles hold no shared barrel and no API schema the desktop does not use', () => {
    // Built in a child process: Bun.build in a test process that already ran some other test files (the CI shard ran
    // c-local-apps-e2e.test.ts first) fails with "Unexpected reading file" on shared/src files, on dev as well.
    const script = `
      import { join } from 'node:path'
      import { BUNDLE_ENTRIES } from ${JSON.stringify(join(DESKTOP, 'build-entries.ts'))}
      const out = { failed: [], sources: [] }
      // every bundle desktop/build.ts makes (desktop/build-entries.ts), so a new screen or preload is checked too
      for (const [entry, , target] of BUNDLE_ENTRIES) {
        // the options of desktop/build.ts that decide what goes in (sourcemaps only to read the file list)
        const r = await Bun.build({ entrypoints: [join(${JSON.stringify(DESKTOP)}, entry)], target, format: target === 'node' ? 'cjs' : 'esm', external: ['electron'], sourcemap: 'external', minify: true, throw: false })
        if (!r.success) { out.failed.push(entry + ': ' + r.logs.map(String).join(' | ').slice(0, 300)); continue }
        const map = r.outputs.find((o) => o.path.endsWith('.map'))
        if (map) out.sources.push(...JSON.parse(await map.text()).sources)
      }
      console.log(JSON.stringify(out))`
    const run = Bun.spawnSync([process.execPath, '-e', script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    const built = JSON.parse(run.stdout.toString().trim().split('\n').pop()!) as { failed: string[]; sources: string[] }
    expect(built.failed).toEqual([])
    const shared = new Set<string>()
    for (const s of built.sources) {
      const i = s.indexOf('shared/src/')
      if (i >= 0) shared.add(s.slice(i + 'shared/src/'.length))
    }
    expect([...shared].filter((f) => /(^|\/)index\.ts$/.test(f))).toEqual([])
    // server-only schemas and the step list's words: a change there must leave the desktop app as it is
    for (const f of ['api/rooms.ts', 'api/admin.ts', 'api/chats.ts', 'api/ws.ts', 'api/drive.ts', 'step-labels.ts']) expect(shared.has(f)).toBe(false)
    // what the desktop really uses is still there (the check above would pass on an empty set)
    for (const f of ['product.ts', 'desktop-bridge.ts', 'api/browser.ts', 'api/local-apps.ts']) expect(shared.has(f)).toBe(true)
  }, 60_000)
})
