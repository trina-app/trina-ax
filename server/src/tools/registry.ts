// Non-file MCP tools (design tab 3 "도구 목록"): make_file, share_file, artifact, web_fetch (component C), and
// remember / forget / ask_user / browser_* (component B) register here. The MCP handler (mcp/protocol.ts) lists
// them after the six file tools and routes tools/call to them. A registry belongs to one FileService (= one
// server instance), so tests with several apps in one process don't mix tools.
import { z } from 'zod'
import type { FileService, ToolCtx, ToolOutput } from '../files/service'
import { Denied, ToolError } from '../policy/errors'
import { toolErrorText } from '../safe-ops/strings'

export interface ToolResult extends ToolOutput {
  /** machine-readable result (contract output of the tool) for server-side callers and tests; the engine gets `text` */
  structured?: Record<string, unknown>
}

export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string
  description: string
  input: I
  run(args: z.output<I>, ctx: ToolCtx): Promise<ToolResult> | ToolResult
  /** short audit line of the input (tool_events.summary prefix); default: the tool name */
  describe?(args: z.output<I>): string
  /** offered right now? (default: always). A tool that is not available is not listed and its calls are refused as
   * unknown, e.g. hwp_render while the HWP plugin is not usable (server/src/plugins). */
  available?(): boolean
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  constructor(private files?: FileService) {}

  register<I extends z.ZodType>(def: ToolDef<I>): void {
    if (this.tools.has(def.name)) throw new Error(`tool ${def.name} registered twice`)
    this.tools.set(def.name, def as unknown as ToolDef)
  }
  has(name: string) { return this.tools.has(name) }
  names() { return [...this.tools.keys()] }
  private offered(t: ToolDef) { try { return t.available ? t.available() : true } catch { return false } }
  /** Is this registered tool offered right now? */
  available(name: string) { const t = this.tools.get(name); return !!t && this.offered(t) }

  private entry(t: ToolDef) {
    const schema = z.toJSONSchema(t.input as z.ZodType, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
    delete schema.$schema
    return { name: t.name, description: t.description, inputSchema: schema }
  }
  /** MCP tools/list entries (only the tools offered right now) */
  list(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return [...this.tools.values()].filter((t) => this.offered(t)).map((t) => this.entry(t))
  }
  /** One registered tool's listing, offered or not (for wiring it into chat turns with its own availability). */
  describeTool(name: string) { const t = this.tools.get(name); return t ? this.entry(t) : undefined }

  /** Run a tool; errors become an isError result (the engine sees the message, the audit log the summary). */
  async call(name: string, raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
    const t = this.tools.get(name)
    if (!t || !this.offered(t)) return { text: `Error: unknown tool '${name}'`, isError: true, summary: `${name} -> unknown tool` }
    const parsed = t.input.safeParse(raw ?? {})
    if (!parsed.success) {
      return { text: 'Invalid input: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; '), isError: true, summary: `${name} -> invalid input` }
    }
    const what = t.describe ? t.describe(parsed.data) : name
    try {
      return await t.run(parsed.data, ctx)
    } catch (e) {
      if (e instanceof Denied) return { text: 'Access denied: ' + e.message, isError: true, summary: `${what} -> denied: ${e.message}`.slice(0, 1000) }
      if (e instanceof ToolError) return { text: 'Error: ' + (this.files?toolErrorText(this.files.db,ctx.user.id,e):e.message), isError: true, summary: `${what} -> error: ${e.message}`.slice(0, 1000) }
      return { text: 'Error: internal error', isError: true, summary: `${what} -> internal: ${String((e as Error)?.message ?? e).slice(0, 200)}` }
    }
  }
}

const registries = new WeakMap<FileService, ToolRegistry>()
/** The tool registry of a server instance (keyed by its FileService). */
export function toolRegistry(files: FileService): ToolRegistry {
  let r = registries.get(files)
  if (!r) { r = new ToolRegistry(files); registries.set(files, r) }
  return r
}
