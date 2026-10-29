// AI connections (credentials): the team's pool of Claude subscription tokens, API keys and ChatGPT sign-ins the model
// proxy puts on the engines' requests (docs/DECISIONS.md "AI 연결"). Owner: A (server/src/routes/admin.ts,
// server/src/credentials/*). Never carries a secret: tokens and keys come in sealed in the browser (SealedSecret) and
// no response, log line or audit entry ever holds one.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { IsoTime } from './common'
import { endpoint, empty } from './endpoint'
import { UserRef } from './entities'

export const CredentialKind = z.enum(['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'])
export type CredentialKind = z.infer<typeof CredentialKind>
export const CREDENTIAL_KINDS = CredentialKind.options
/** subscription kinds: no price per request (cost 0), the owner confirms the plan notice when adding one */
export const SUBSCRIPTION_KINDS: readonly CredentialKind[] = ['anthropic-oauth', 'chatgpt']
/** which engine a kind serves */
export const KIND_ENGINE: Record<CredentialKind, 'claude-code' | 'codex'> = { 'anthropic-oauth': 'claude-code', 'anthropic-api-key': 'claude-code', chatgpt: 'codex', 'openai-api-key': 'codex' }

/** what the screen shows (stored status + what is computed now); `detail` is in the caller's language */
export const CredentialState = z.enum(['ok', 'unverified', 'expiring', 'expired', 'invalid', 'needs_reconnect', 'limited', 'over_limit', 'disabled', 'kind_off', 'sharing_off'])
export type CredentialState = z.infer<typeof CredentialState>
export const CredentialAssignment = z.object({ subjectType: z.enum(['group', 'user']), subjectId: z.string().min(1).max(64) })
export type CredentialAssignment = z.infer<typeof CredentialAssignment>
/** A token / key sealed in the browser with the server's public key (ECDH P-256 + HKDF-SHA256 + AES-256-GCM). There is
 * no plaintext secret field anywhere in this contract. */
export const SealedSecret = z.object({
  kid: z.string().regex(/^[0-9a-f]{16}$/),
  /** the browser's one-time public key: uncompressed P-256 point (65 bytes), base64url */
  epk: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  /** 12 bytes, base64url */
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ct: z.string().regex(/^[A-Za-z0-9_-]{24,16000}$/),
})
export type SealedSecret = z.infer<typeof SealedSecret>
export const SEAL_ALG = 'ECDH-ES+P256+HKDF-SHA256+A256GCM' as const
export const SealingKey = z.object({
  kid: z.string(), alg: z.literal(SEAL_ALG),
  publicJwk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }),
})
export type SealingKey = z.infer<typeof SealingKey>
/** what the sealed plaintext says (JSON): the secret, a one-time nonce and what it is for */
export type SealPurpose = 'credential.create' | 'credential.replace' | 'speech.key'
export const SpendLimit = z.object({ usd: z.number().nonnegative().nullable(), tokens: z.number().int().nonnegative().nullable(), action: z.enum(['warn', 'block']) })
export type SpendLimit = z.infer<typeof SpendLimit>
export const Credential = z.object({
  id: Uuid7, kind: CredentialKind, label: z.string(),
  scope: z.enum(['team', 'personal']), owner: UserRef.nullable(),
  assignments: z.array(CredentialAssignment.extend({ name: z.string() })),
  priority: z.number().int(), disabled: z.boolean(),
  state: CredentialState, detail: z.string().nullable(),
  /** API keys: the last 4 characters */
  hint: z.string().nullable(),
  /** ChatGPT: the plan (plus, pro, business, ...) */
  planType: z.string().nullable(),
  expiresAt: IsoTime.nullable(), limitedUntil: IsoTime.nullable(), checkedAt: IsoTime.nullable(), lastUsedAt: IsoTime.nullable(),
  spendLimit: SpendLimit,
  /** this month (server time zone), counted per request by the model proxy; cost only for API keys (estimate) */
  month: z.object({ usd: z.number(), tokens: z.number().int(), requests: z.number().int() }),
  createdAt: IsoTime,
})
export type Credential = z.infer<typeof Credential>
export const CredentialsResponse = z.object({
  items: z.array(Credential), memberOwn: z.boolean(), sharedSubscriptions: z.boolean(), allowedKinds: z.array(CredentialKind),
  /** price table date (costs are estimates at list prices) */
  pricesAsOf: z.string(),
})
export type CredentialsResponse = z.infer<typeof CredentialsResponse>
const Label = z.string().trim().min(1).max(60)
const Reauth = { password: z.string().min(1).max(256) }
export const CreateCredentialBody = z.object({
  kind: CredentialKind.exclude(['chatgpt']), label: Label, sealed: SealedSecret,
  assignments: z.array(CredentialAssignment).max(200).default([]), priority: z.number().int().min(0).max(1000).default(100),
  /** true required for a subscription kind (anthropic-oauth): the owner read the plan notice; the server checks */
  acknowledgedPlanNotice: z.boolean().optional(), ...Reauth,
})
export const UpdateCredentialBody = z.object({
  label: Label.optional(), priority: z.number().int().min(0).max(1000).optional(), disabled: z.boolean().optional(),
  assignments: z.array(CredentialAssignment).max(200).optional(), spendLimit: SpendLimit.optional(),
})
export const ReplaceSecretBody = z.object({ sealed: SealedSecret, ...Reauth })
export const LoginId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
export const StartCredentialLoginBody = z.object({
  label: Label, assignments: z.array(CredentialAssignment).max(200).default([]), priority: z.number().int().min(0).max(1000).default(100),
  reconnectId: Uuid7.optional(),
  /** ChatGPT is a subscription kind: true required */
  acknowledgedPlanNotice: z.literal(true), ...Reauth,
})
export const CredentialLoginState = z.enum(['starting', 'code', 'done', 'failed', 'expired', 'cancelled'])
export const CredentialLogin = z.object({
  loginId: LoginId, state: CredentialLoginState,
  url: z.string().url().nullable(), code: z.string().max(20).nullable(), expiresAt: IsoTime,
  credential: Credential.nullable(), reason: z.string().nullable(),
})
export type CredentialLogin = z.infer<typeof CredentialLogin>
export const CredentialSettings = z.object({ memberOwn: z.boolean(), sharedSubscriptions: z.boolean() })
export const UpdateCredentialSettingsBody = CredentialSettings.partial().extend({
  /** Required when enabling shared subscriptions; not a grant of hosting/resale rights. */
  acknowledgedSharedSubscriptionRisk: z.boolean().optional(),
})
export const MyCredentialsResponse = z.object({ allowed: z.boolean(), allowedKinds: z.array(CredentialKind), items: z.array(Credential) })
export const CreateMyCredentialBody = CreateCredentialBody.omit({ assignments: true, priority: true, password: true })
export const StartMyLoginBody = StartCredentialLoginBody.omit({ assignments: true, priority: true, password: true })

export const CREDENTIALS = {
  listCredentials: endpoint({ method: 'GET', path: '/api/admin/credentials', auth: 'admin', owner: 'A', response: CredentialsResponse, summary: 'AI connections of the team (and that members have their own), with state and this month\'s use. Never a secret.' }),
  createCredential: endpoint({ method: 'POST', path: '/api/admin/credentials', auth: 'owner-reauth', owner: 'A', status: 201, body: CreateCredentialBody, response: Credential, summary: 'Add a Claude subscription token or an API key (sealed in the browser); checked without spending tokens.' }),
  updateCredential: endpoint({ method: 'PATCH', path: '/api/admin/credentials/:id', auth: 'owner', owner: 'A', body: UpdateCredentialBody, response: Credential, summary: 'Rename, order, switch off, assign to groups / people, monthly limit.' }),
  replaceCredentialSecret: endpoint({ method: 'POST', path: '/api/admin/credentials/:id/secret', auth: 'owner-reauth', owner: 'A', body: ReplaceSecretBody, response: Credential, summary: 'Put a new token / key on an existing connection (same kind).' }),
  deleteCredential: endpoint({ method: 'DELETE', path: '/api/admin/credentials/:id', auth: 'owner', owner: 'A', response: empty, status: 204, summary: 'Remove a connection (usage history stays).' }),
  checkCredential: endpoint({ method: 'POST', path: '/api/admin/credentials/:id/check', auth: 'admin', owner: 'A', response: Credential, summary: 'Check a connection again now, without spending tokens.' }),
  startCredentialLogin: endpoint({ method: 'POST', path: '/api/admin/credential-logins', auth: 'owner-reauth', owner: 'A', status: 202, body: StartCredentialLoginBody, response: CredentialLogin, summary: 'Start a ChatGPT sign-in for the team (device code); progress on WebSocket credential.login.' }),
  getCredentialLogin: endpoint({ method: 'GET', path: '/api/admin/credential-logins/:id', auth: 'owner', owner: 'A', response: CredentialLogin, summary: 'State of a sign-in this owner started.' }),
  cancelCredentialLogin: endpoint({ method: 'DELETE', path: '/api/admin/credential-logins/:id', auth: 'owner', owner: 'A', response: empty, status: 204, summary: 'Stop a sign-in.' }),
  updateCredentialSettings: endpoint({ method: 'PATCH', path: '/api/admin/credential-settings', auth: 'owner', owner: 'A', body: UpdateCredentialSettingsBody, response: CredentialSettings, summary: 'Personal connections and explicit shared-subscription consent.' }),
  sealingKey: endpoint({ method: 'GET', path: '/api/credentials/sealing-key', auth: 'user', owner: 'A', response: SealingKey, summary: 'Public key the browser seals a token / key with before sending it.' }),
  myCredentials: endpoint({ method: 'GET', path: '/api/me/credentials', auth: 'user', owner: 'A', response: MyCredentialsResponse, summary: 'My own AI connections (when the team allows them).' }),
  createMyCredential: endpoint({ method: 'POST', path: '/api/me/credentials', auth: 'user', owner: 'A', status: 201, body: CreateMyCredentialBody, response: Credential, summary: 'Add my own Claude token or API key; used for my turns first.' }),
  deleteMyCredential: endpoint({ method: 'DELETE', path: '/api/me/credentials/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Remove one of my own connections.' }),
  startMyCredentialLogin: endpoint({ method: 'POST', path: '/api/me/credential-logins', auth: 'user', owner: 'A', status: 202, body: StartMyLoginBody, response: CredentialLogin, summary: 'Start my own ChatGPT sign-in.' }),
  getMyCredentialLogin: endpoint({ method: 'GET', path: '/api/me/credential-logins/:id', auth: 'user', owner: 'A', response: CredentialLogin, summary: 'State of my sign-in.' }),
  cancelMyCredentialLogin: endpoint({ method: 'DELETE', path: '/api/me/credential-logins/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Stop my sign-in.' }),
} as const
