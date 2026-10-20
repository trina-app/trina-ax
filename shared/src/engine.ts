import { z } from 'zod'

export const EngineErrorCode = z.enum(['auth', 'rate_limit', 'context', 'timeout', 'refused', 'crash'])
export const EngineEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('thinking'), delta: z.string() }),
  z.object({ type: z.literal('tool_start'), id: z.string(), name: z.string(), summary: z.string() }),
  z.object({ type: z.literal('tool_end'), id: z.string(), ok: z.boolean(), summary: z.string().optional() }),
  z.object({ type: z.literal('session'), sessionId: z.string() }),
  z.object({ type: z.literal('usage'), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().optional() }),
  z.object({ type: z.literal('error'), code: EngineErrorCode, message: z.string() }),
  z.object({ type: z.literal('done') }),
])
export type EngineEvent = z.infer<typeof EngineEvent>
export type EngineErrorCode = z.infer<typeof EngineErrorCode>

/** How the engine authenticates to the model.
 * - proxy: company key behind the server's model proxy; the engine only gets a per-turn proxy token (design default).
 * - local-login: the engine uses the claude CLI's own existing login on this machine (dev/test only; no proxy). */
export const AuthMode = z.enum(['proxy', 'local-login'])
export type AuthMode = z.infer<typeof AuthMode>

export interface RunInput {
  turnId: string
  chatId: string
  /** per-chat empty working folder (no team files) */
  chatDir: string
  model?: string
  fallbackModel?: string
  systemPrompt: string
  message: string
  attachments: { path: string; name: string }[]
  sessionId?: string
  resume?: boolean
  history?: { role: 'user' | 'assistant'; content: string }[]
  tools: { token: string }
  modelProxy?: { baseUrl: string; token: string }
  timeoutMs: number
  maxTurns: number
}

export interface Engine {
  id: 'claude-code' | 'openai' | string
  check(): Promise<{ ok: boolean; detail?: string }>
  run(input: RunInput, signal: AbortSignal): AsyncIterable<EngineEvent>
}

// ---------------- launcher protocol (server <-> native launcher, JSON lines over launcher.sock) ----------------
export const LaunchRequest = z.object({
  op: z.literal('run'),
  turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  chatDir: z.string(),
  cmd: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  /** written to <chatDir>/.turn/token (0600); the bridge reads and deletes it */
  token: z.string(),
  /** written to <chatDir>/.turn/system.md (0600); deleted after the engine's first output */
  systemPrompt: z.string(),
  /** session file to restore before the turn */
  sessionRestore: z.object({ dir: z.string(), name: z.string(), b64: z.string() }).optional(),
  /** collect the session file (dir/name or one level below dir) after the turn; removeDir deletes dir afterwards */
  sessionCollect: z.object({ dir: z.string(), name: z.string(), removeDir: z.boolean() }).optional(),
  timeoutMs: z.number().int().positive(),
  /** written to the engine's stdin, then stdin is closed */
  stdin: z.string(),
  /** extra files written under chatDir before the run (e.g. a per-turn engine config) */
  files: z.array(z.object({ rel: z.string(), content: z.string() })).optional(),
})
export type LaunchRequest = z.infer<typeof LaunchRequest>
export const LaunchEvent = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('started'), pid: z.number(), pgid: z.number() }),
  z.object({ ev: z.literal('stdout'), b64: z.string() }),
  z.object({ ev: z.literal('stderr'), b64: z.string() }),
  z.object({ ev: z.literal('exit'), code: z.number(), signal: z.string().optional(), session: z.object({ b64: z.string() }).optional() }),
  z.object({ ev: z.literal('error'), message: z.string() }),
])
export type LaunchEvent = z.infer<typeof LaunchEvent>
