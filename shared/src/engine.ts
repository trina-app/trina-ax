import { z } from 'zod'

export const EngineErrorCode = z.enum(['auth', 'rate_limit', 'context', 'timeout', 'refused', 'crash'])
export const EngineEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('thinking'), delta: z.string() }),
  /** input: the tool input as the engine sent it (server-side only: step labels, audit; never sent to clients raw) */
  z.object({ type: z.literal('tool_start'), id: z.string(), name: z.string(), summary: z.string(), input: z.unknown().optional() }),
  /** output: the tool result text (capped), e.g. WebSearch links for the search card */
  z.object({ type: z.literal('tool_end'), id: z.string(), ok: z.boolean(), summary: z.string().optional(), output: z.string().optional() }),
  z.object({ type: z.literal('session'), sessionId: z.string() }),
  z.object({ type: z.literal('usage'), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().optional() }),
  z.object({ type: z.literal('error'), code: EngineErrorCode, message: z.string() }),
  z.object({ type: z.literal('done') }),
])
export type EngineEvent = z.infer<typeof EngineEvent>
export type EngineErrorCode = z.infer<typeof EngineErrorCode>

/** How the engine authenticates to the model.
 * - subscription: the owner's long-lived Claude subscription token (`claude setup-token`, <install>/secrets/
 *   claude-oauth-token) stays with the server; the engine talks to the server's model proxy with a per-turn token
 *   and the proxy puts the real one on the request (production / role-account install, design tab 1 "프록시 동작").
 * - proxy: the same with a company API key (code only; refused by chat/engines.ts, owner decision: subscriptions only).
 * - local-login: the engine uses the claude CLI's own existing login on this machine (dev/test only; no proxy). */
export const AuthMode = z.enum(['proxy', 'local-login', 'subscription'])
export type AuthMode = z.infer<typeof AuthMode>

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
  /** per-turn model proxy token. The launcher hands it to the engine on an inherited pipe (fd 3, read once by Claude
   * Code: CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR / CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR), never in argv or the
   * environment, which other processes of the engine account can read (KERN_PROCARGS2). */
  modelToken: z.object({ kind: z.enum(['oauth', 'api-key']), value: z.string().min(1).max(512) }).optional(),
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
