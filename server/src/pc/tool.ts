// The pc_* tools (docs/DECISIONS.md "PC runner"), offered to a turn sent from a desktop app window in a project where
// this person may use the PC runner (setting.ts), and checked again on every call. The engine keeps its lockdown (no
// Bash, --restricted) and stays on the server with the model token: only the tool call and its result travel. The call
// goes engine -> our MCP tool -> server -> the WebSocket of the window that sent the turn -> the desktop app, which asks
// the person in its own screen and runs the tool in the workspace folder. Every call leaves an audit line, refused ones
// too. The desktop app decides what runs; the server cannot answer for the person.
import { PC_APPROVAL_TIMEOUT_MS, type PcResult, type PcToolName } from '@mycel/shared/api'
import { PC_SHELL_TIMEOUT_DEFAULT_SEC, PC_TOOL_NAMES, PC_TOOLS, parsePcToolInput, pcToolJsonSchema, type ParsedPcCall } from '@mycel/shared'
import type { AppContext } from '../context'
import type { McpContent } from '../turns'
import { audit } from '../admin/audit'
import type { PcRelay } from './relay'
import { mayUsePc, type PcProjectRef } from './setting'

export const PC_TOOL_SET: ReadonlySet<string> = new Set(PC_TOOL_NAMES)

/** the time a file tool gets once the person said yes */
const FILE_TOOL_MS = 60_000
/** the app answers a background command at once; the margin covers the way there and back */
const BACKGROUND_MS = 20_000
const MARGIN_MS = 30_000

export interface PcHost {
  ctx: AppContext
  relay: PcRelay
  project: PcProjectRef & { name: string }
  userId: string
  turnId: string
  chatId: string
  windowId: string
  signal: AbortSignal
  /** the turn's time limit pauses while the person decides */
  onWaiting(waiting: boolean): void
  redact(s: string): string
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }] as McpContent[], ...(isError ? { isError: true } : {}) })

/** One short line of what a call does, for the audit list and the step summary. No file content goes in. */
export function pcCallText(c: ParsedPcCall): string {
  switch (c.tool) {
    case 'pc_shell': return c.input.command.slice(0, 2000)
    case 'pc_read': return c.input.file_path
    case 'pc_write': return `${c.input.file_path} (${Buffer.byteLength(c.input.content)} bytes)`
    case 'pc_edit': return c.input.file_path
    case 'pc_search': return [c.input.pattern, c.input.glob, c.input.path].filter(Boolean).join(' ').slice(0, 500)
  }
}

/** How long the server waits: the person's answer (twice: the workspace folder can be asked for first) and the tool. */
export function pcCallTimeoutMs(c: ParsedPcCall): number {
  const work = c.tool !== 'pc_shell' ? FILE_TOOL_MS : c.input.background ? BACKGROUND_MS : (c.input.timeout_sec ?? PC_SHELL_TIMEOUT_DEFAULT_SEC) * 1000
  return 2 * PC_APPROVAL_TIMEOUT_MS + work + MARGIN_MS
}

function pcTool(h: PcHost, name: PcToolName) {
  return {
    name,
    description: PC_TOOLS[name].description,
    inputSchema: pcToolJsonSchema(name),
    async call(args: unknown): Promise<{ content: McpContent[]; isError?: boolean; summary?: string }> {
      const { ctx, project } = h
      const parsed = parsePcToolInput(name, args)
      if (!parsed.ok) return { ...text(parsed.error, true), summary: `${name} -> invalid input` }
      const line = h.redact(pcCallText(parsed.call))
      const what = `${name} ${line.slice(0, 200)}`
      // never trust the start of the turn alone: the admin may have turned it off, the folder rules may have changed
      if (!mayUsePc(ctx.db, ctx.files, project, h.userId)) return { ...text('The PC runner is off for this project or for you now. Do not try again.', true), summary: `${what} -> off` }
      const r: PcResult = await h.relay.call({
        userId: h.userId, windowId: h.windowId, turnId: h.turnId, chatId: h.chatId, project: { id: project.id, name: project.name.slice(0, 200) },
        tool: name, args: parsed.call.input as Record<string, unknown>, timeoutMs: pcCallTimeoutMs(parsed.call), signal: h.signal, onWaiting: h.onWaiting,
      })
      audit(ctx.db, { actor: h.userId, action: 'pc_runner.call', target: project.id, detail: {
        turnId: h.turnId, chatId: h.chatId, tool: name, text: line, approval: r.approval, ...(r.grants ? { grants: r.grants } : {}), ok: r.ok,
        result: r.run ?? (r.error ? { error: h.redact(r.error).slice(0, 300) } : null),
      } })
      const out = h.redact(r.content.map((c) => c.text).join('\n'))
      const parts = [out, r.ok || !r.error || out.includes(r.error) ? '' : `Error: ${h.redact(r.error)}`].filter(Boolean)
      const outcome = r.run ? `${r.run.signal ?? 'exit ' + r.run.code} ${r.run.ms} ms` : r.ok ? 'ok' : h.redact(r.error ?? 'error').slice(0, 200)
      return { ...text(parts.join('\n') || (r.ok ? 'OK' : 'Error'), !r.ok), summary: `${what} -> ${r.approval}, ${outcome}` }
    },
  }
}

export const pcTools = (h: PcHost) => PC_TOOL_NAMES.map((n) => pcTool(h, n))
