// Minimal MCP (JSON-RPC 2.0) server side: initialize, tools/list, tools/call, ping.
import { z } from 'zod'
import { EDIT_FILES_TOOL, EditFilesInput, FILE_TOOLS } from '@mycel/shared'
import type { Database } from 'bun:sqlite'
import type { FileService, ToolCtx } from '../files/service'
import { toolRegistry } from '../tools/registry'
import { loadPrincipal } from '../policy/access'
import type { TurnToolSet } from '../turns'
import { confidentialTurn, localTool } from '../safe-ops/confidential'
import { safeText } from '../safe-ops/strings'

const toolList = Object.entries(FILE_TOOLS).map(([name, t]) => {
  const schema = z.toJSONSchema(t.input as any, { target: 'draft-7' }) as any
  delete schema.$schema
  return { name, description: t.description, inputSchema: schema }
})
export const MCP_TOOL_NAMES = toolList.map((t) => t.name)

/** Claude Code's id of the tool call (`_meta` of tools/call), or null */
export function toolUseIdOf(params: unknown): string | null {
  const meta = (params as { _meta?: unknown } | null)?._meta
  const id = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['claudecode/toolUseId'] : undefined
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null
}

export function makeHandler(files: FileService, db: Database, ctx: ToolCtx, extra?: TurnToolSet) {
  const insert = db.query('INSERT INTO tool_events (turn_id, user_id, tool, summary, ok, tool_use_id, parent_tool_use_id) VALUES (?,?,?,?,?,?,?)')
  type CallResult = { result: { content: unknown[]; isError?: true }; beforeDelivery?: () => void }
  const failed = (text: string): CallResult => ({ result: { content: [{ type: 'text', text }], isError: true } })

  /** One tool call (tools/call params): which agent made it, the person as they are now, the turn's checks, the tool
   * and its audit row. */
  async function callTool(params: any): Promise<CallResult> {
    const name = String(params?.name ?? '')
    // which agent made the call (docs/DECISIONS.md "Sub-agents"): the main AI or one of its sub-agents. Same person,
    // same checks; a sub-agent has its own read-before-write state, and the audit row says which one it was
    const toolUseId = toolUseIdOf(params)
    const call = await ctx.files.forCall(toolUseId, { signal: ctx.signal })
    const audit = { run: (turnId: string | null, userId: string, tool: string, summary: string, ok: number) => insert.run(turnId, userId, tool, summary, ok, toolUseId, call.agent) }
    // the person as they are now (tab 2 "권한 회수": access that shrank applies from the next tool call): role and
    // groups are loaded again for every call, and a disabled or deleted account gets nothing
    const user = loadPrincipal(db, ctx.user.id)
    if (!user) {
      audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), `${name} -> denied: account disabled`.slice(0, 1000), 0)
      return failed('Access denied: this account is disabled.')
    }
    ctx.user = user
    const callCtx: ToolCtx = call.files === ctx.files ? ctx : { ...ctx, files: call.files }
    const caller = { files: call.files }
    if (extra?.has(name)) {
      const out = await extra.call(name, params?.arguments ?? {}, caller).catch((e) => ({ content: [{ type: 'text' as const, text: 'Error: internal error' }], isError: true, summary: `${name} -> internal: ${String(e?.message ?? e).slice(0, 200)}` }))
      audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), out.summary.slice(0, 1000), out.isError ? 0 : 1)
      return { result: { content: out.content, ...(out.isError ? { isError: true as const } : {}) } }
    }
    const registry = extra ? null : toolRegistry(files)
    // fail closed: a check that throws stops the save
    const refusal = extra?.beforeFileTool ? await extra.beforeFileTool(name, params?.arguments ?? {}, caller).catch(() => ({ refusal: 'The save could not be checked, so nothing was written. Try again.', summary: `${name} -> not written (the check failed)` })) : null
    if (refusal) {
      const r = typeof refusal === 'string' ? { refusal, summary: `${name} -> not allowed by the user (wider audience)` } : refusal
      audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), r.summary.slice(0, 1000), 0)
      return failed(r.refusal)
    }
    const out = registry?.has(name) ? await registry.call(name, params?.arguments ?? {}, callCtx) : await files.call(name, params?.arguments ?? {}, callCtx)
    audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), out.summary.slice(0, 1000), out.isError ? 0 : 1)
    try { extra?.afterFileTool?.(name, !!out.isError, params?.arguments) } catch {}
    try { out.beforeDelivery?.() } catch {
      return failed(safeText(db,ctx.user.id,'changed'))
    }
    return { result: { content: out.content ?? [{ type: 'text', text: out.text }, ...(out.images ?? [])], ...(out.isError ? { isError: true as const } : {}) }, beforeDelivery: out.beforeDelivery }
  }

  /**
   * edit_files (docs/DECISIONS.md "Bulk edits in one call"): the same replacement in up to 50 files, one after the
   * other, each as its own edit call through callTool. So every file gets exactly what a separate edit gets: the person
   * loaded again, the template scope, the skills/ card, the wider-audience card, read-before-write, the version, a
   * conflict copy, the per-turn limits, its file event and its own audit row (tool 'edit', this call's id). A file that
   * fails does not stop the others; the answer lists every file. Stop ends the batch before the next file.
   */
  async function editFiles(params: any) {
    const toolUseId = toolUseIdOf(params)
    const owner = await ctx.files.forCall(toolUseId, { signal: ctx.signal })
    const row = (summary: string, ok: number) => insert.run(ctx.turnId, ctx.user.id, EDIT_FILES_TOOL, summary.slice(0, 1000), ok, toolUseId, owner.agent)
    const a = EditFilesInput.safeParse(params?.arguments ?? {})
    if (!a.success) {
      row(`${EDIT_FILES_TOOL} -> invalid input`, 0)
      return failed('Invalid input: ' + a.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')).result
    }
    const { old_string, new_string, replace_all } = a.data
    const paths = [...new Set(a.data.file_paths)]
    const lines: string[] = []
    let edited = 0
    for (const [i, p] of paths.entries()) {
      if (ctx.signal?.aborted) { lines.push(...paths.slice(i).map((q) => `- ${q}: not changed (the answer was stopped)`)); break }
      const r = await callTool({ ...params, name: 'edit', arguments: { file_path: p, old_string, new_string, ...(replace_all !== undefined ? { replace_all } : {}) } })
      let { result } = r
      // an edit never carries one (only image and PDF reads do); checked anyway, like the socket does
      try { r.beforeDelivery?.() } catch { result = failed(safeText(db, ctx.user.id, 'changed')).result }
      const said = result.content.flatMap((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? [String((c as { text?: unknown }).text ?? '')] : [])).join(' ').replace(/\s+/g, ' ').trim()
      if (!result.isError) edited++
      lines.push(`- ${p}: ${said}`)
    }
    const none = edited === 0
    row(`${EDIT_FILES_TOOL} ${paths.length} files -> ${edited} edited, ${paths.length - edited} not`, none ? 0 : 1)
    const head = `${edited} of ${paths.length} file${paths.length === 1 ? '' : 's'} edited. Each file was checked and saved on its own:`
    return { content: [{ type: 'text', text: [head, ...lines].join('\n') }], ...(none ? { isError: true as const } : {}) }
  }

  return async function handle(msg: any): Promise<any | null> {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'team', version: '0.1.0' } })
      case 'ping': return reply({})
      // file tools first, then the extra tools. A chat turn brings its own set (`extra`: B's tools plus every
      // ctx.services.turnTools entry, which includes C's registry tools). Without one (stage-1 turns, direct
      // tests) the tools other components registered in tools/registry.ts are served as they are.
      case 'tools/list': return reply({ tools: [...toolList, ...(extra ? extra.list() : toolRegistry(files).list())] })
      case 'tools/call': {
        const name = String(msg.params?.name ?? '')
        if(confidentialTurn(db,ctx.turnId) && !localTool(name)) return reply({content:[{type:'text',text:safeText(db,ctx.user.id,'external')}],isError:true})
        // the batch of edits a chat turn offers: each file goes through callTool below as its own edit call
        if (name === EDIT_FILES_TOOL && extra?.has(name)) return reply(await editFiles(msg.params))
        const r = await callTool(msg.params)
        const response = reply(r.result)
        if (r.beforeDelivery) Object.defineProperty(response, 'beforeDelivery', { value: r.beforeDelivery })
        return response
      }
      default:
        if (msg.id === undefined) return null // notification
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
    }
  }
}
