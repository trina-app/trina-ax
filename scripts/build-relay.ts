// Production relay bundle (control-plane 3.6.1, RL-9): everything the relay needs to run under Node, nothing else.
//
//   bun scripts/build-relay.ts [--out dist/relay] [--version 0.2.0]
//   → dist/relay/teamax-relay-<version>.tar.zst (+ .sha256)
//
// Inside, one folder teamax-relay-<version>/:
//   package.json                       the bundle root: "type": "module" and exports for @mycel/shared/relay-protocol and
//                                      @mycel/shared/cloud-protocol/relay-ops (the relay's two bare imports resolve to the
//                                      files below through a package self-reference: Node will not strip types of .ts
//                                      files under node_modules, so the shared sources must not live there)
//   relay/src/*.ts                     the relay (run as is: node --disable-warning=ExperimentalWarning relay/src/main.ts)
//   shared/src/relay-protocol/*.ts     the wire protocol
//   shared/src/cloud-protocol/relay-ops.ts (+ LICENSE, README.md)   the operator API types (MIT)
//   shared/src/service-hosts.ts        the hosted service's addresses (default account / status links)
//   node_modules/ws/                   the only dependency (ws 8.18.0, versions.json)
//   deploy/                            relay/deploy (systemd units, a/b deploy, nftables, Litestream, Node install)
//   MANIFEST.json                      sha256 and size of every file
//   VERSION
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tarStream, type TarEntryInput } from '../server/src/system/tar.ts'
import { writeAtomic, zstdCompress } from '../server/src/system/streams.ts'

export const REPO = path.resolve(import.meta.dir, '..')

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** [archive path, source file] of every file in the bundle (sorted, so the archive is the same for the same tree) */
export function bundleFiles(): [string, string][] {
  const out: [string, string][] = []
  const add = (rel: string, src: string) => out.push([rel, src])
  const dir = (srcDir: string, rel: string, keep: (name: string) => boolean = () => true) => {
    for (const d of fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const s = path.join(srcDir, d.name)
      if (d.isDirectory()) dir(s, `${rel}/${d.name}`, keep)
      else if (d.isFile() && keep(d.name)) add(`${rel}/${d.name}`, s)
    }
  }
  dir(path.join(REPO, 'relay/src'), 'relay/src', (n) => n.endsWith('.ts'))
  dir(path.join(REPO, 'shared/src/relay-protocol'), 'shared/src/relay-protocol', (n) => n.endsWith('.ts'))
  for (const f of ['relay-ops.ts', 'LICENSE', 'README.md']) add(`shared/src/cloud-protocol/${f}`, path.join(REPO, 'shared/src/cloud-protocol', f))
  // the hosted service's addresses (relay/src/pages.ts default links), an edition sets them
  add('shared/src/service-hosts.ts', path.join(REPO, 'shared/src/service-hosts.ts'))
  const ws = fs.realpathSync(path.join(REPO, 'relay/node_modules/ws'))
  dir(ws, 'node_modules/ws', (n) => !n.endsWith('.md') || n === 'README.md')
  dir(path.join(REPO, 'relay/deploy'), 'deploy')
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

export function bundlePackageJson(version: string): string {
  const relayPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'relay/package.json'), 'utf8')) as { engines: { node: string } }
  return JSON.stringify({
    name: '@mycel/shared',
    version,
    private: true,
    type: 'module',
    description: 'Team AX relay bundle (scripts/build-relay.ts). The name lets relay/src import @mycel/shared/* from this folder.',
    license: 'AGPL-3.0-only',
    engines: relayPkg.engines,
    exports: {
      './relay-protocol': './shared/src/relay-protocol/index.ts',
      './cloud-protocol/relay-ops': './shared/src/cloud-protocol/relay-ops.ts',
      './service-hosts': './shared/src/service-hosts.ts',
    },
  }, null, 2) + '\n'
}

export async function buildRelay(o: { outDir: string; version?: string }): Promise<{ file: string; sha256: string; size: number; version: string; files: number }> {
  const version = o.version ?? (JSON.parse(fs.readFileSync(path.join(REPO, 'relay/package.json'), 'utf8')) as { version: string }).version
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new Error(`bad version ${version}`)
  const top = `teamax-relay-${version}`
  const files = bundleFiles()
  const generated: [string, Uint8Array][] = [
    ['package.json', Buffer.from(bundlePackageJson(version))],
    ['VERSION', Buffer.from(version + '\n')],
  ]
  const manifest: Record<string, { size: number; sha256: string }> = {}
  for (const [rel, src] of files) { const b = fs.readFileSync(src); manifest[rel] = { size: b.byteLength, sha256: crypto.createHash('sha256').update(b).digest('hex') } }
  for (const [rel, b] of generated) manifest[rel] = { size: b.byteLength, sha256: crypto.createHash('sha256').update(b).digest('hex') }
  generated.push(['MANIFEST.json', Buffer.from(JSON.stringify({ version, files: manifest }, null, 1) + '\n')])

  const dirs = new Set<string>([top])
  for (const rel of [...files.map((f) => f[0]), ...generated.map((g) => g[0])]) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${top}/${parts.slice(0, i).join('/')}`)
  }
  const mtimeMs = Date.UTC(2026, 0, 1)
  const entries: TarEntryInput[] = [
    ...[...dirs].sort().map((d) => ({ name: d, type: 'dir' as const, mode: 0o755, mtimeMs })),
    ...generated.map(([rel, data]) => ({ name: `${top}/${rel}`, type: 'file' as const, data, mode: 0o644, mtimeMs })),
    // file modes as in the repository (the deploy scripts are executable there)
    ...files.map(([rel, src]) => ({ name: `${top}/${rel}`, type: 'file' as const, source: src, mode: fs.statSync(src).mode & 0o111 ? 0o755 : 0o644 })),
  ]
  fs.mkdirSync(o.outDir, { recursive: true })
  const file = path.join(o.outDir, `${top}.tar.zst`)
  const w = await writeAtomic(zstdCompress(tarStream(entries), 19), file, 0o644)
  fs.writeFileSync(`${file}.sha256`, `${w.sha256}  ${path.basename(file)}\n`)
  return { file, sha256: w.sha256, size: w.size, version, files: Object.keys(manifest).length }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const r = await buildRelay({ outDir: path.resolve(arg(argv, '--out') ?? path.join(REPO, 'dist/relay')), version: arg(argv, '--version') })
  console.log(`${r.file}\n  ${r.files} files, ${(r.size / 1024).toFixed(0)} KiB, sha256 ${r.sha256}`)
}
