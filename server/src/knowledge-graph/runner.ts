// What the knowledge graph asks of its indexer: build or update one project's index, count it, find symbols and their
// callers and callees. CodeGraphRunner does it with CodeGraph (codegraph.ts); the tests use a small stand-in with the
// same answers' shape. Paths in answers are relative to the project folder ("tree/src/app.ts").
import { jsonOf, runCodeGraph, type CodeGraphTool } from './codegraph'

export interface GraphSymbol { kind: string; name: string; filePath: string; startLine: number; endLine: number; signature: string | null; score: number }
export interface GraphRef { kind: string; name: string; filePath: string; startLine: number }

export interface GraphRunner {
  /** `full`: make the index from nothing (first run, rebuild); else take in what changed since the last run */
  build(project: string, full: boolean, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>
  stats(project: string): Promise<{ files: number; symbols: number } | null>
  search(project: string, query: string, limit: number): Promise<GraphSymbol[]>
  callers(project: string, name: string, limit: number): Promise<GraphRef[]>
  callees(project: string, name: string, limit: number): Promise<GraphRef[]>
  /** shown in Admin (CodeGraph's version) */
  version: string | null
}

const BUILD_MS = 30 * 60_000
const QUERY_MS = 20_000
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function sym(x: any): GraphSymbol | null {
  const n = x?.node
  if (!n || !str(n.filePath) || !str(n.name)) return null
  return { kind: str(n.kind) || 'symbol', name: str(n.name).slice(0, 200), filePath: str(n.filePath), startLine: Math.max(1, num(n.startLine)), endLine: Math.max(1, num(n.endLine) || num(n.startLine)), signature: typeof n.signature === 'string' ? n.signature.slice(0, 300) : null, score: num(x.score) }
}
function ref(x: any): GraphRef | null {
  if (!x || !str(x.filePath) || !str(x.name)) return null
  return { kind: str(x.kind) || 'symbol', name: str(x.name).slice(0, 200), filePath: str(x.filePath), startLine: Math.max(1, num(x.startLine)) }
}

export class CodeGraphRunner implements GraphRunner {
  constructor(private tool: CodeGraphTool) {}
  get version() { return this.tool.version }
  private run(project: string, args: string[], o: { background: boolean; timeoutMs: number; signal?: AbortSignal }) {
    return runCodeGraph(this.tool, { project, args, ...o })
  }
  async build(project: string, full: boolean, signal?: AbortSignal) {
    // --force: the run's own home folder is inside the project, which CodeGraph otherwise refuses to index
    const r = await this.run(project, full ? ['init', '--force', project] : ['sync', '--quiet', project], { background: true, timeoutMs: BUILD_MS, signal })
    if (r.code === 0) return { ok: true }
    return { ok: false, error: r.killed ? `stopped (${r.killed})` : `exit ${r.code}` }
  }
  async stats(project: string) {
    const r = await this.run(project, ['status', project, '--json'], { background: true, timeoutMs: QUERY_MS })
    const j = jsonOf(r.out) as any
    if (r.code !== 0 || !j?.initialized) return null
    return { files: num(j.fileCount), symbols: Math.max(0, num(j.nodeCount) - num(j.nodesByKind?.file) - num(j.nodesByKind?.import)) }
  }
  async search(project: string, query: string, limit: number) {
    const r = await this.run(project, ['query', '--path', project, '--limit', String(limit), '--json', '--', query], { background: false, timeoutMs: QUERY_MS })
    const j = jsonOf(r.out)
    return r.code === 0 && Array.isArray(j) ? j.map(sym).filter((s): s is GraphSymbol => !!s) : []
  }
  private async refs(project: string, cmd: 'callers' | 'callees', name: string, limit: number) {
    const r = await this.run(project, [cmd, '--path', project, '--limit', String(limit), '--json', '--', name], { background: false, timeoutMs: QUERY_MS })
    const j = jsonOf(r.out) as any
    const list = j?.[cmd]
    return r.code === 0 && Array.isArray(list) ? list.map(ref).filter((s): s is GraphRef => !!s) : []
  }
  callers(project: string, name: string, limit: number) { return this.refs(project, 'callers', name, limit) }
  callees(project: string, name: string, limit: number) { return this.refs(project, 'callees', name, limit) }
}
