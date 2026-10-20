// Bundle the desktop app into dist/: main process, the two preloads, the desktop's own screens and the injected
// page script. `bun run build` (desktop/). Shared code (@mycel/shared, zod) is bundled; only electron is external.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureElectron } from './scripts/ensure-electron'

const root = import.meta.dir
const out = join(root, 'dist')
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'ui'), { recursive: true })

const prod = process.env.NODE_ENV === 'production'
const node = { target: 'node' as const, format: 'cjs' as const, external: ['electron'], sourcemap: prod ? ('none' as const) : ('linked' as const), minify: prod }

async function one(entry: string, outName: string, opts: Partial<Parameters<typeof Bun.build>[0]>) {
  const r = await Bun.build({ entrypoints: [join(root, entry)], outdir: out, naming: outName, ...opts })
  if (!r.success) {
    for (const l of r.logs) console.error(l)
    throw new Error(`build failed: ${entry}`)
  }
}

await Promise.all([
  one('src/main/main.ts', 'main.cjs', node),
  one('src/preload/app.ts', 'preload-app.cjs', node),
  one('src/preload/ui.ts', 'preload-ui.cjs', node),
  one('src/ui/welcome.ts', 'ui/welcome.js', { target: 'browser', format: 'esm', minify: prod }),
  one('src/ui/pane.ts', 'ui/pane.js', { target: 'browser', format: 'esm', minify: prod }),
])
for (const f of ['welcome.html', 'pane.html', 'ui.css']) cpSync(join(root, 'src/ui', f), join(out, 'ui', f))
cpSync(join(root, 'src/main/pane/page-script.js'), join(out, 'page-script.js'))
await ensureElectron()
console.log(`built ${out}`)
