// Bundle the desktop app into dist/: main process, the two preloads, the desktop's own screens and the injected
// page script. `bun run build` (desktop/). Shared code (@mycel/shared, zod) is bundled; only electron is external.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { parseKit } from './src/common/kit'
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
// the screens' <title>: the product name from shared/src/product.ts (the one place it is written)
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
for (const f of ['welcome.html', 'pane.html']) writeFileSync(join(out, 'ui', f), readFileSync(join(root, 'src/ui', f), 'utf8').replace(/__PRODUCT_NAME_HTML__/g, () => html(PRODUCT.displayName)))
cpSync(join(root, 'src/ui/ui.css'), join(out, 'ui', 'ui.css'))
cpSync(join(root, 'src/main/pane/page-script.js'), join(out, 'page-script.js'))
// a kit build for one team (src/common/kit.ts): TEAMAX_KIT_TEAM=<team address> [TEAMAX_KIT_LOCALE=ko|en|id]
const kitEnv = { team: process.env.TEAMAX_KIT_TEAM || undefined, locale: process.env.TEAMAX_KIT_LOCALE || undefined }
if (kitEnv.team || kitEnv.locale) {
  const kit = parseKit(kitEnv)
  if ((kitEnv.team && !kit.team) || (kitEnv.locale && !kit.locale)) throw new Error(`TEAMAX_KIT_TEAM / TEAMAX_KIT_LOCALE not usable: ${JSON.stringify(kitEnv)}`)
  writeFileSync(join(out, 'kit.json'), JSON.stringify(kit) + '\n')
  console.log(`kit: ${JSON.stringify(kit)}`)
}
await ensureElectron()
console.log(`built ${out}`)
