// CodeGraph (https://github.com/colbymchenry/codegraph, MIT): the program that makes the knowledge graph's code map.
// It is found on the server, never shipped with it (docs/KNOWLEDGE-GRAPH.md "Why CodeGraph is not bundled"): each
// platform's CodeGraph is a 280 MB folder with its own Node runtime. Without it the knowledge graph is off.
//
// How it runs: the bundle's own `node` with CodeGraph's script, as a converter (tools/isolate.ts): no network, writes
// only into the index folder (<project>/.codegraph), reads only the bundle and the project (the copy of the code in the
// server's data folder, never the team folder), lower CPU and disk priority, a time and a memory limit. Its telemetry,
// update check and self-download are off (DO_NOT_TRACK and its own switches), and `git` is not found (exec is refused).
import fs from 'node:fs'
import path from 'node:path'
import { which } from '../config'
import { runIsolated, type IsolatedResult } from '../tools/isolate'

export interface CodeGraphTool {
  /** the bundle folder (node, lib/dist/…, package.json) */
  bundle: string
  /** the bundle's own Node runtime: the one program the run may start */
  node: string
  /** lib/dist/bin/codegraph.js */
  entry: string
  /** the bundle's version (package.json), or null */
  version: string | null
}

const target = () => `${process.platform}-${process.arch}`
const isFile = (p: string) => { try { return fs.statSync(p).isFile() } catch { return false } }

/** A CodeGraph bundle folder: node + lib/dist/bin/codegraph.js. */
function bundleAt(dir: string): CodeGraphTool | null {
  const node = path.join(dir, 'node'), entry = path.join(dir, 'lib', 'dist', 'bin', 'codegraph.js')
  if (!isFile(node) || !isFile(entry)) return null
  try { fs.accessSync(node, fs.constants.X_OK) } catch { return null }
  let version: string | null = null
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; if (typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v)) version = v } catch {}
  return { bundle: fs.realpathSync(dir), node: fs.realpathSync(node), entry: fs.realpathSync(entry), version }
}

/**
 * The CodeGraph to use: `explicit` (server.json knowledgeGraph.codegraph; '' = none) or `codegraph` on the PATH. That
 * command is one of: the npm launcher (npm-shim.js, next to node_modules/@colbymchenry/codegraph-<os>-<arch>), a
 * bundle's bin/codegraph (install.sh links it into ~/.local/bin), or the bundle folder itself. null: none here.
 */
export function findCodeGraph(explicit?: string): CodeGraphTool | null {
  if (explicit === '') return null
  const cmd = explicit ?? which('codegraph')
  if (!cmd) return null
  let real: string
  try { real = fs.realpathSync(cmd) } catch { return null }
  try { if (fs.statSync(real).isDirectory()) return bundleAt(real) } catch { return null }
  const dir = path.dirname(real)
  if (path.basename(real) === 'npm-shim.js') return bundleAt(path.join(dir, 'node_modules', '@colbymchenry', `codegraph-${target()}`))
  if (path.basename(dir) === 'bin') return bundleAt(path.dirname(dir))
  return null
}

export interface Run { code: number | null; out: string; err: string; killed: IsolatedResult['killed'] }

/** A fixed environment: nothing of the server's own (keys, paths) reaches it. */
function env(work: string): Record<string, string> {
  return {
    HOME: path.join(work, 'home'), TMPDIR: work, NO_COLOR: '1',
    DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
    // two parse workers and one resolver: ~0.7 GB at most instead of one worker per core (~1.1 GB on 10 cores), at
    // about the same speed (measured on 673 files: 12 s)
    CODEGRAPH_PARSE_WORKERS: '2', CODEGRAPH_RESOLVE_WORKERS: '1',
  }
}

export interface RunOptions {
  /** the project folder: <project>/tree (the copy of the code) and <project>/.codegraph (the index, writable) */
  project: string
  args: string[]
  timeoutMs: number
  /** below people's work (indexing); queries for a person's question run at normal priority */
  background: boolean
  signal?: AbortSignal
}

export const MAX_RSS_MIB = 1536

/** Run CodeGraph on one project, isolated. Never throws for CodeGraph's own failure: check `code`. */
export async function runCodeGraph(tool: CodeGraphTool, o: RunOptions): Promise<Run> {
  const work = path.join(o.project, '.codegraph')
  fs.mkdirSync(path.join(work, 'home'), { recursive: true })
  // macOS: the sandbox reads by folder, and CodeGraph lists the project folder itself; Linux (bwrap): the copy is
  // mounted read-only on its own (a read-only mount of the whole project would cover the index folder too)
  const reads = process.platform === 'darwin' ? [tool.bundle, o.project] : [tool.bundle, path.join(o.project, 'tree')]
  const r = await runIsolated({
    cmd: tool.node,
    args: ['--liftoff-only', '--disable-warning=ExperimentalWarning', tool.entry, ...o.args],
    workDir: work, readPaths: reads, timeoutMs: o.timeoutMs, maxStdout: 8 << 20, maxRssMiB: MAX_RSS_MIB,
    background: o.background, env: env(work), signal: o.signal,
  })
  return { code: r.code, out: r.stdout.toString('utf8'), err: r.stderr, killed: r.killed }
}

/** The JSON a `-j` command printed (anything before its first `{` or `[` is a banner). */
export function jsonOf(out: string): unknown {
  const i = out.search(/[[{]/)
  if (i < 0) return null
  try { return JSON.parse(out.slice(i)) } catch { return null }
}
