// Release gate for plugins (docs/PLUGINS.md "배포 제외"): default server, office and desktop builds carry the official
// plugin list (metadata) and nothing else of plugins — no rhwp executable, no runtime font, no .trinaplugin package,
// no resources/hwp. Build scripts call assertNoPluginPayload() on their staging folder; CI runs this file on the
// finished archives:
//   bun scripts/plugins/release-check.ts dist/release-linux-amd64.tar dist/office/*-mac.zip desktop/dist
import fs from 'node:fs'
import path from 'node:path'

/** A path that must never be in a default release artifact. */
export function forbiddenPluginPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  const base = p.split('/').pop() ?? ''
  return /(^|\/)native\/bin\/hwp(\/|$)/.test(p) || /(^|\/)resources\/hwp(\/|$)/.test(p) || /^rhwp(-|$)/i.test(base)
    || /^NotoSansKR/i.test(base) || /\.trinaplugin$/i.test(base) || /(^|\/)resources\/plugins\/(?!catalog\.(json|sig)$)./.test(p)
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const n of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${n}` : n
    const st = fs.lstatSync(path.join(dir, r))
    out.push(r)
    if (st.isDirectory()) out.push(...walk(dir, r))
  }
  return out
}

/** The forbidden entries in a folder, a .tar(.gz|.zst), a .zip or an .asar-free folder of a desktop build. */
export function findPluginPayload(target: string): string[] {
  const st = fs.statSync(target)
  let entries: string[]
  if (st.isDirectory()) entries = walk(target)
  else if (/\.zip$/i.test(target)) entries = Bun.spawnSync(['unzip', '-Z1', target]).stdout.toString().split('\n')
  else if (/\.(tar|tgz|tar\.gz|tar\.zst)$/i.test(target)) entries = Bun.spawnSync(['tar', '-tf', target]).stdout.toString().split('\n')
  else throw new Error(`cannot list ${target}`)
  return entries.filter(Boolean).filter(forbiddenPluginPath)
}

export function assertNoPluginPayload(dir: string): void {
  const bad = findPluginPayload(dir)
  if (bad.length) throw new Error(`release artifact must not contain plugin payloads: ${bad.slice(0, 5).join(', ')}`)
}

/** Copy the official plugin list (and its signature, once an owner signed it) into a release folder. */
export function stagePluginCatalog(repo: string, destination: string): void {
  const from = path.join(repo, 'resources/plugins'), to = path.join(destination, 'resources/plugins')
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  for (const f of ['catalog.json', 'catalog.sig']) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, f))
}

if (import.meta.main) {
  const targets = process.argv.slice(2)
  if (!targets.length) { console.error('usage: bun scripts/plugins/release-check.ts <folder|archive>...'); process.exit(2) }
  let failed = false
  for (const t of targets) {
    const bad = findPluginPayload(t)
    if (bad.length) { failed = true; console.error(`${t}: plugin payload in a default release artifact: ${bad.slice(0, 10).join(', ')}`) }
    else console.log(`${t}: no plugin payload`)
  }
  process.exit(failed ? 1 : 0)
}
