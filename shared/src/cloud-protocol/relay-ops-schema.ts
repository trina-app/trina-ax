// zod mirrors of the relay operator API bodies (relay-ops.ts holds the types, signing and the plain validators the
// relay itself runs). The control plane validates what it sends and receives with these; tests/unit/cloud-protocol
// keeps the two in step with shared vectors. MIT (see LICENSE in this folder).
import { z } from 'zod'
import { IsoTime } from './common.ts'
import {
  EXTERNAL_REF_RE, MAX_CLAIM_TTL_SEC, MAX_HOLD_TTL_SEC, OPS_SCOPES, REGION_RE, SUSPEND_REASONS, TEAM_ORIGINS,
} from './relay-ops.ts'

const B64 = /^[A-Za-z0-9+/]+=*$/
const Name = z.string().min(1).max(64)
const ExternalRef = z.string().regex(EXTERNAL_REF_RE)

export const OperatorKeySchema = z.object({
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  publicKey: z.string().max(200).regex(B64),
  label: z.string().max(200),
  scopes: z.array(z.enum(OPS_SCOPES)).min(1),
})
export const OperatorKeysFile = z.array(OperatorKeySchema).max(32)

export const OpsHoldRequestSchema = z.strictObject({ name: Name, ttlSec: z.number().int().min(1).max(MAX_HOLD_TTL_SEC) })
export const OpsCreateTeamRequestSchema = z.strictObject({
  name: Name,
  publicKey: z.string().max(200).regex(B64),
  ts: z.number().int().nonnegative(),
  sig: z.string().max(200).regex(B64),
  region: z.string().regex(REGION_RE),
  origin: z.enum(['cloud', 'addon']),
  externalRef: ExternalRef,
})
export const OpsSuspendRequestSchema = z.strictObject({ reason: z.enum(SUSPEND_REASONS) })
export const OpsSleepRequestSchema = z.strictObject({ sleeping: z.boolean() })
export const OpsWakeRequestSchema = z.strictObject({ teamId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), reason: z.enum(['http', 'ws']) })
export const OpsWakeResponseSchema = z.object({ state: z.enum(['waking', 'awake', 'unknown']), retryAfterSec: z.number().int().nonnegative() })
export const OpsMaintenanceRequestSchema = z.strictObject({ untilMs: z.number().int().nullable() })
export const OpsKeyRequestSchema = z.strictObject({ publicKey: z.string().max(200).regex(B64), newKeySig: z.string().max(200).regex(B64) })
export const OpsRenameRequestSchema = z.strictObject({ name: Name })
export const OpsNoticeRequestSchema = z.strictObject({ level: z.enum(['info', 'warn']), code: z.string().regex(/^[a-z0-9_.-]{1,64}$/), message: z.string().min(1).max(500) })
export const OpsClaimRequestSchema = z.strictObject({ name: Name, ttlSec: z.number().int().min(60).max(MAX_CLAIM_TTL_SEC), externalRef: ExternalRef })

export const OperatorTeamInfoSchema = z.object({
  teamId: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended', 'released']),
  address: z.string(),
  lastHeartbeatAt: IsoTime.nullable(),
  origin: z.enum(TEAM_ORIGINS),
  externalRef: z.string().nullable(),
  region: z.string(),
  suspendReason: z.enum(SUSPEND_REASONS).nullable(),
  maintenanceUntil: IsoTime.nullable(),
  sleepingSince: IsoTime.nullable().optional(),
  online: z.boolean(),
  conns: z.number().int().nonnegative(),
  lastConnectedAt: IsoTime.nullable(),
  lastVersion: z.string().nullable(),
  memberCount: z.number().int().nullable(),
  createdAt: IsoTime,
})
export const OpsTeamListSchema = z.object({ teams: z.array(OperatorTeamInfoSchema), next: z.string().nullable() })
export const OpsNameCheckSchema = z.object({ name: z.string(), available: z.boolean(), problem: z.enum(['too_short', 'too_long', 'invalid', 'reserved', 'taken']).nullable() })
export const OpsHoldResponseSchema = z.object({ name: z.string(), holdUntil: IsoTime })
export const OpsClaimResponseSchema = z.object({ name: z.string(), code: z.string().min(16), expiresAt: IsoTime })
export const OpsStatsSchema = z.object({
  teams: z.object({ active: z.number().int(), suspended: z.number().int() }),
  online: z.number().int(), conns: z.number().int(), clientSockets: z.number().int(), uptimeS: z.number().int(),
})
export const OpsErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
