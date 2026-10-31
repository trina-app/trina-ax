// Wire protocol between the server and the box helper mycel-boxd (native/cmd/mycel-boxd), dev environment EXPERIMENT
// (docs/DECISIONS.md "Dev environment (experiment)"). One JSON request line per connection on boxd.sock; only the
// server's uid may connect. The server never runs podman: boxd owns all boxes (rootless podman as the box account).
import { z } from 'zod'
import { DevEnvLimits, DevEnvNetwork, DevEnvProcess } from './api/dev-env'

/** box id = the project id (neutral host paths: boxd uses it, never the folder name, for its own paths) */
export const BoxId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

export const BoxdStatusReq = z.object({ op: z.literal('status') })
/** Make the box if it is not there and start it. folder: the project folder relative to the team root (boxd checks
 * it is a real folder below its --team-root, no links). denyAddrs: the team server's public addresses (the box's
 * reject list, in addition to the private ranges). */
export const BoxdEnsureReq = z.object({
  op: z.literal('ensure'), box: BoxId, folder: z.string().min(1).max(4096), network: DevEnvNetwork, limits: DevEnvLimits,
  denyAddrs: z.array(z.string().max(64)).max(32).default([]),
})
export const BoxdStopReq = z.object({ op: z.enum(['stop', 'destroy']), box: BoxId })
/** One shell command in the box (bash -lc), as box root without capabilities. cwd: relative to /work. background:
 * the command is started with setsid/nohup, its output goes to /cache/logs/<name>.log, and exec returns at once. */
export const BoxdExecReq = z.object({
  op: z.literal('exec'), box: BoxId, cwd: z.string().max(4096).default(''), command: z.string().min(1).max(64 * 1024),
  timeoutMs: z.number().int().positive().max(1_800_000), background: z.boolean().default(false),
  logName: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  /** for boxd's own log line only (the server keeps the audit) */
  actor: z.string().max(64),
})
export const BoxdPsReq = z.object({ op: z.literal('ps'), box: BoxId })
/** A unix socket (owned by the server's uid, 0600) whose every connection boxd joins to 127.0.0.1:<port> in the box's
 * network namespace (preview; P0 spike section 3.5, no host port). It goes away when the box stops. */
export const BoxdPreviewReq = z.object({ op: z.literal('preview'), box: BoxId, port: z.number().int().min(1024).max(65535) })
/** New connections of an open box (conntrack in the box's namespace): "<unix time> <proto> <address>:<port>" lines */
export const BoxdNetlogReq = z.object({ op: z.literal('netlog'), box: BoxId })
export const BoxdRequest = z.discriminatedUnion('op', [BoxdStatusReq, BoxdEnsureReq, BoxdStopReq, BoxdExecReq, BoxdPsReq, BoxdPreviewReq, BoxdNetlogReq])
export type BoxdRequest = z.infer<typeof BoxdRequest>

export const BoxdBoxInfo = z.object({
  box: BoxId, state: z.enum(['none', 'stopped', 'running']),
  startedAt: z.string().nullable(), lastActiveAt: z.string().nullable(), memoryMiB: z.number().nullable(),
})
export type BoxdBoxInfo = z.infer<typeof BoxdBoxInfo>
export const BoxdStatus = z.object({
  ev: z.literal('status'), available: z.boolean(), reason: z.string().optional(),
  /** what boxd found at start: podman version, idmapped mount support, cgroup controllers, the image digest */
  checks: z.record(z.string(), z.string()).optional(),
  boxes: z.array(BoxdBoxInfo).default([]),
})
export type BoxdStatus = z.infer<typeof BoxdStatus>
export const BoxdExit = z.object({
  ev: z.literal('exit'), code: z.number().int(),
  /** timeout | oom | stopped | "" (ended by itself) */
  signal: z.string(), stdout: z.string(), stderr: z.string(), truncated: z.boolean(), ms: z.number(),
})
export type BoxdExit = z.infer<typeof BoxdExit>
export const BoxdOk = z.object({ ev: z.literal('ok'), box: BoxdBoxInfo.optional() })
export const BoxdPs = z.object({ ev: z.literal('ps'), processes: z.array(DevEnvProcess) })
export const BoxdPreview = z.object({ ev: z.literal('preview'), socket: z.string().min(1).max(4096) })
export const BoxdNetlog = z.object({ ev: z.literal('netlog'), lines: z.array(z.string()).default([]) })
export const BoxdError = z.object({ ev: z.literal('error'), message: z.string() })
