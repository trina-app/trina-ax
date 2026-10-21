// The runtime of search by meaning (server/src/search/semantic.ts) for the office and release bundles. The server
// bundles keep @huggingface/transformers external (its native onnxruntime / sharp addons can't be inlined: Bun.build
// baked this repo's absolute node_modules paths into them), so this copies the package and its dependencies, resolved
// like Node, into <serverDir>/node_modules, pruned to macOS arm64 (onnxruntime-node ships no macOS x64 build, so
// Intel Macs run without search by meaning). onnxruntime-web is left out (browser only). About 85 MB.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
export const SEMANTIC_EXTERNAL = ['@huggingface/transformers']
const SKIP = new Set(['onnxruntime-web'])

export function vendorSemantic(serverDir: string): { packages: string[]; bytes: number } {
  const out = path.join(serverDir, 'node_modules')
  const done = new Map<string, string>()
  const copy = (name: string, base: string) => {
    if (SKIP.has(name) || done.has(name)) return
    const dir = fs.realpathSync(path.dirname(createRequire(path.join(base, 'x.js')).resolve(`${name}/package.json`)))
    done.set(name, dir)
    fs.cpSync(dir, path.join(out, name), { recursive: true, dereference: true })
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    for (const d of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies })) {
      try { copy(d, dir) } catch { /* optional dependency for another platform (e.g. @img/sharp-linux-x64) */ }
    }
  }
  copy('@huggingface/transformers', path.join(REPO, 'server'))
  // onnxruntime-node: only darwin/arm64, and one copy of its library (the binding loads @rpath/libonnxruntime.1.dylib)
  const ort = path.join(out, 'onnxruntime-node', 'bin', 'napi-v6')
  for (const plat of fs.readdirSync(ort)) {
    for (const arch of fs.readdirSync(path.join(ort, plat))) if (!(plat === 'darwin' && arch === 'arm64')) fs.rmSync(path.join(ort, plat, arch), { recursive: true })
  }
  for (const f of fs.readdirSync(path.join(ort, 'darwin', 'arm64'))) if (/^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(f)) fs.rmSync(path.join(ort, 'darwin', 'arm64', f))
  const du = (p: string): number => { const st = fs.lstatSync(p); return st.isDirectory() ? fs.readdirSync(p).reduce((a, n) => a + du(path.join(p, n)), 0) : st.size }
  return { packages: [...done.keys()], bytes: du(out) }
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: bun scripts/vendor-semantic.ts <server dir>'); process.exit(2) }
  const r = vendorSemantic(dir)
  console.log(`${r.packages.length} packages, ${(r.bytes / 1e6).toFixed(0)} MB → ${path.join(dir, 'node_modules')}`)
}
