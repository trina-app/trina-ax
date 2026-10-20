// Minimal MCP (JSON-RPC 2.0) server side: initialize, tools/list, tools/call, ping.
import { z } from 'zod'
import { FILE_TOOLS } from '@mycel/shared'
import type { Database } from 'bun:sqlite'
import type { FileService, ToolCtx } from '../files/service'
import { toolRegistry } from '../tools/registry'
import type { TurnToolSet } from '../turns'

const toolList = Object.entries(FILE_TOOLS).map(([name, t]) => {
  const schema = z.toJSONSchema(t.input as any, { target: 'draft-7' }) as any
  delete schema.$schema
  return { name, description: t.description, inputSchema: schema }
})
export const MCP_TOOL_NAMES = toolList.map((t) => t.name)

export function makeHandler(files: FileService, db: Database, ctx: ToolCtx, extra?: TurnToolSet) {
  const audit = db.query('INSERT INTO tool_events (turn_id, user_id, tool, summary, ok) VALUES (?,?,?,?,?)')
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
        if (extra?.has(name)) {
          const out = await extra.call(name, msg.params?.arguments ?? {}).catch((e) => ({ content: [{ type: 'text' as const, text: 'Error: internal error' }], isError: true, summary: `${name} -> internal: ${String(e?.message ?? e).slice(0, 200)}` }))
          audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), out.summary.slice(0, 1000), out.isError ? 0 : 1)
          return reply({ content: out.content, ...(out.isError ? { isError: true } : {}) })
        }
        const registry = extra ? null : toolRegistry(files)
        const refusal = extra?.beforeFileTool ? await extra.beforeFileTool(name, msg.params?.arguments ?? {}).catch(() => 'The save could not be checked, so nothing was written. Try again.') : null
        if (refusal) {
          audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), `${name} -> not allowed by the user (wider audience)`, 0)
          return reply({ content: [{ type: 'text', text: refusal }], isError: true })
        }
        const out = registry?.has(name) ? await registry.call(name, msg.params?.arguments ?? {}, ctx) : await files.call(name, msg.params?.arguments ?? {}, ctx)
        audit.run(ctx.turnId, ctx.user.id, name.slice(0, 64), out.summary.slice(0, 1000), out.isError ? 0 : 1)
        try { extra?.afterFileTool?.(name, !!out.isError, msg.params?.arguments) } catch {}
        return reply({ content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) })
      }
      default:
        if (msg.id === undefined) return null // notification
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
    }
  }
}
