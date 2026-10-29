import { z } from 'zod'

/** model_not_found, endpoint_unreachable, provider_error: the API engine (server/src/engine/api-agent.ts) only */
export const EngineErrorCode = z.enum(['auth', 'rate_limit', 'context', 'timeout', 'refused', 'crash', 'model_not_found', 'endpoint_unreachable', 'provider_error'])
export const EngineEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('thinking'), delta: z.string() }),
  /** input: the tool input as the engine sent it (server-side only: step labels, audit; never sent to clients raw) */
  z.object({ type: z.literal('tool_start'), id: z.string(), name: z.string(), summary: z.string(), input: z.unknown().optional() }),
  /** output: the tool result text (capped), e.g. WebSearch links for the search card */
  z.object({ type: z.literal('tool_end'), id: z.string(), ok: z.boolean(), summary: z.string().optional(), output: z.string().optional() }),
  z.object({ type: z.literal('session'), sessionId: z.string() }),
  /** costUnknown: the provider gave no cost and the model has no list price (never recorded as free); requestId: the
   * provider's id of the request (OpenRouter's generation id), for the log */
  z.object({ type: z.literal('usage'), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().optional(), costUnknown: z.boolean().optional(), requestId: z.string().optional() }),
  /** status: the provider's HTTP status, when there was one */
  z.object({ type: z.literal('error'), code: EngineErrorCode, message: z.string(), status: z.number().int().optional() }),
  z.object({ type: z.literal('done') }),
])
export type EngineEvent = z.infer<typeof EngineEvent>
export type EngineErrorCode = z.infer<typeof EngineErrorCode>

/** How the engine authenticates to the model.
 * - managed: the team's AI connections (server/src/credentials: Claude subscription tokens, API keys, ChatGPT
 *   sign-ins) stay with the server; the engine talks to the server's model proxy with a per-turn token and the proxy
 *   puts the real credential of the connection chosen for the turn on the request (production, cloud, Linux, the
 *   office "subscription" choice; docs/DECISIONS.md "AI 연결").
 * - subscription, proxy: older names of managed, read as managed (server/src/app-config.ts normalizeAuthMode), so a
 *   server rolled back to the previous release still starts with a server.json the newer installer wrote.
 * - local-login: the engine uses the CLI's own existing login on this machine (dev / office; no credential here). */
export const AuthMode = z.enum(['proxy', 'local-login', 'subscription', 'managed'])
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
  /** Codex as the engine account: the launcher copies the account's Codex login (--codex-auth-dir) into
   * <chatDir>/.codex for this turn and writes a refreshed one back after it (one Codex turn at a time). Older
   * "agent-own" setup, kept for the F1 fallback (docs/DECISIONS.md "AI 연결" D11) and the one-time migration. */
  codexAuth: z.boolean().optional(),
  /** managed Codex turn: the launcher writes this placeholder auth.json into a fresh <chatDir>/.codex (0600) and
   * removes the folder after the turn. It carries only this turn's proxy token (access token / API key) and fixed
   * placeholders; the launcher refuses anything that looks like a real ChatGPT login (credentials D9). */
  codexHome: z.object({ authJson: z.string().max(16 * 1024) }).optional(),
  /** F1 only: the AI connection the turn's real Codex login belongs to (one turn per connection at a time) */
  credentialId: z.string().max(64).optional(),
})
export type LaunchRequest = z.infer<typeof LaunchRequest>
export const LaunchEvent = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('started'), pid: z.number(), pgid: z.number() }),
  z.object({ ev: z.literal('stdout'), b64: z.string() }),
  z.object({ ev: z.literal('stderr'), b64: z.string() }),
  /** signal: "stopped" | "timeout", and on Linux "oom" (the turn cgroup's memory limit) | "disk_limit" (the chat folder
   * grew past the turn disk limit; the launcher emptied it) — linux-runtime spec 3.3.7 */
  z.object({ ev: z.literal('exit'), code: z.number(), signal: z.string().optional(), session: z.object({ b64: z.string() }).optional() }),
  z.object({ ev: z.literal('error'), message: z.string() }),
  /** something the server should audit (e.g. a refreshed Codex login that was not written back) */
  z.object({ ev: z.literal('note'), message: z.string() }),
])
export type LaunchEvent = z.infer<typeof LaunchEvent>

// ---------------- launcher requests besides turns (linux-runtime spec 3.3.2, both platforms) ----------------
/** {"op":"status"} from the server account -> one `status` line, then the launcher closes the connection: the engine
 * sandbox (bwrap + Landlock + seccomp on Linux, sandbox-exec on macOS), the per-turn cgroups and the firewall state the
 * launcher checks before each turn (docs/INSTALL-LINUX.md). Lenient on purpose: an older or macOS launcher may leave
 * fields out (the diagnostics then show them as unknown); unknown fields pass through. */
export const LauncherStatus = z.object({
  ev: z.literal('status'),
  os: z.string(),
  /** "bwrap" | "sandbox-exec" | "none" */
  sandbox: z.string(),
  liveTurns: z.number().int().nonnegative().optional(),
  dedicated: z.boolean().optional(),
  bwrapVersion: z.string().nullable().optional(),
  /** Landlock ABI the kernel offers (0 = none) */
  landlockAbi: z.number().int().nonnegative().nullable().optional(),
  /** "off" | "best-effort" | "required" | "required-scoped" */
  landlockMode: z.string().nullable().optional(),
  /** Landlock ABI 6+: abstract unix sockets and signals scoped to the turn (Linux 6.12+) */
  scoped: z.boolean().optional(),
  seccomp: z.boolean().optional(),
  /** "allowed" | "denied" */
  listen: z.string().optional(),
  kernel: z.string().optional(),
  /** "delegated" | "none" | "off" */
  cgroup: z.string().optional(),
  maxLiveTurns: z.number().int().nonnegative().optional(),
  plan: z.string().optional(),
  turnMemoryMaxMiB: z.number().int().optional(),
  planError: z.string().optional(),
  firewall: z.object({ loaded: z.boolean(), at: z.string().nullable().optional(), rules: z.number().int().optional(), problem: z.string().optional() }).nullable().optional(),
}).passthrough()
export type LauncherStatus = z.infer<typeof LauncherStatus>
/** {"op":"forget","chatId"}: delete <agent root>/<chatId> (the server cannot: the folder is the engine account's).
 * Answer {"ev":"forgot","ok"} or {"ev":"error","message"} ("busy: …" while a turn of that chat runs). */
export const LauncherForget = z.object({ op: z.literal('forget'), chatId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
export type LauncherForget = z.infer<typeof LauncherForget>
