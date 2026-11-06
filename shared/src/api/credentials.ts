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
export type SealPurpose = 'credential.create' | 'credential.replace' | 'credential.login-code' | 'speech.key' | 'integration.secret' | 'slack.token'
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
  /** server.json engine.anthropicGateway: Claude API keys are that gateway's keys (any format of the safe shape);
   * absent or null = Anthropic's */
  anthropicGateway: z.object({ label: z.string() }).nullable().optional(),
})
export type CredentialsResponse = z.infer<typeof CredentialsResponse>
const Label = z.string().trim().min(1).max(60)
const Reauth = { password: z.string().min(1).max(256) }
export const CreateCredentialBody = z.object({
  kind: CredentialKind.exclude(['chatgpt']), label: Label, sealed: SealedSecret,
  assignments: z.array(CredentialAssignment).max(200).default([]), priority: z.number().int().min(0).max(1000).default(100),
  /** true required for a subscription kind (anthropic-oauth): the owner read the plan notice; the server checks */
  acknowledgedPlanNotice: z.boolean().optional(),
  /** "Move it to the team": the id of a member's personal connection that holds this same token / key (the 409's
   * `params.credentialId` with `movable`). That personal connection is removed and this team connection made in one
   * step, and its owner is told. The sealed secret proves the owner holds the token; anything else is still a 409. */
  moveFrom: Uuid7.optional(), ...Reauth,
})
export const UpdateCredentialBody = z.object({
  label: Label.optional(), priority: z.number().int().min(0).max(1000).optional(), disabled: z.boolean().optional(),
  assignments: z.array(CredentialAssignment).max(200).optional(), spendLimit: SpendLimit.optional(),
})
export const ReplaceSecretBody = z.object({ sealed: SealedSecret, ...Reauth })
export const LoginId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
/** what a sign-in in the browser connects: a ChatGPT plan (device code, `codex login --device-auth`) or a Claude
 * subscription (`claude setup-token`: an address to approve, then the code Claude shows is pasted back) */
export const CredentialLoginKind = z.enum(['chatgpt', 'anthropic-oauth'])
export type CredentialLoginKind = z.infer<typeof CredentialLoginKind>
export const StartCredentialLoginBody = z.object({
  /** absent = chatgpt (the first sign-in kind) */
  kind: CredentialLoginKind.default('chatgpt'),
  label: Label, assignments: z.array(CredentialAssignment).max(200).default([]), priority: z.number().int().min(0).max(1000).default(100),
  reconnectId: Uuid7.optional(),
  /** both are subscription kinds: true required */
  acknowledgedPlanNotice: z.literal(true), ...Reauth,
})
/** starting → code (ChatGPT: url + code to enter there; Claude: url to approve, then a code to paste back) → checking
 * (Claude: the pasted code is being exchanged and the token checked) → done | failed | expired | cancelled */
export const CredentialLoginState = z.enum(['starting', 'code', 'checking', 'done', 'failed', 'expired', 'cancelled'])
export const CredentialLogin = z.object({
  loginId: LoginId, kind: CredentialLoginKind, state: CredentialLoginState,
  url: z.string().url().nullable(), code: z.string().max(20).nullable(), expiresAt: IsoTime,
  credential: Credential.nullable(), reason: z.string().nullable(),
})
export type CredentialLogin = z.infer<typeof CredentialLogin>
/** the code the Claude page shows after approval, sealed in the browser like a token (purpose credential.login-code) */
export const SubmitLoginCodeBody = z.object({ sealed: SealedSecret })
/** The 409 `params` when the token / key is already connected on this team. The owner and admins hold the secret they
 * pasted, so they hear where the copy is: a team connection (`team`, its label) or someone's personal connection
 * (`personal`, the person's id and name and its label). A member hears where only when it is their own connection (`own`);
 * otherwise only that it is connected on this team (`elsewhere`), never whose. Never any part of the secret. */
export const DuplicateCredentialParams = z.object({
  reason: z.literal('duplicate_credential'),
  where: z.enum(['team', 'personal', 'own', 'elsewhere']),
  credentialId: Uuid7.optional(), label: z.string().optional(), ownerId: z.string().optional(), ownerName: z.string().optional(),
  /** adding a team connection: the copy is a personal connection the owner can move to the team (send again with
   * `moveFrom: credentialId`, password re-entered) */
  movable: z.boolean().optional(),
})
export type DuplicateCredentialParams = z.infer<typeof DuplicateCredentialParams>
export const CredentialSettings = z.object({ memberOwn: z.boolean(), sharedSubscriptions: z.boolean() })
export const UpdateCredentialSettingsBody = CredentialSettings.partial().extend({
  /** Required when enabling shared subscriptions; not a grant of hosting/resale rights. */
  acknowledgedSharedSubscriptionRisk: z.boolean().optional(),
})
export const MyCredentialsResponse = z.object({ allowed: z.boolean(), allowedKinds: z.array(CredentialKind), items: z.array(Credential), anthropicGateway: z.object({ label: z.string() }).nullable().optional() })
export const CreateMyCredentialBody = CreateCredentialBody.omit({ assignments: true, priority: true, moveFrom: true, password: true })
export const StartMyLoginBody = StartCredentialLoginBody.omit({ assignments: true, priority: true, password: true })

/** Stream A (onboarding): can I use AI now, and what can I do if not. `requested`: I already asked the owner. `trial`:
 * nothing answers me because the hosting service's trial AI credit (stream B) is used up or over; the line above the
 * composer says that first. */
export const AiAccessResponse = z.object({ usable: z.boolean(), action: z.enum(['connect_team', 'connect_own', 'ask_owner']), requested: z.boolean(), trial: z.enum(['used', 'ended']).optional() })
export type AiAccessResponse = z.infer<typeof AiAccessResponse>
export const AiAccessRequestResponse = z.object({ requested: z.literal(true), already: z.boolean() })
/** The hosting service's trial AI credit (docs/DECISIONS.md "B — Hosted trial AI credit", "Z — trial credit on the API
 * engine"): a key of the hosting service's that answers the team's chats on the app's own API engine only when no AI
 * connection of the team or the person can. `state`: active (answers now), used (the dollar cap is reached), ended
 * (past `endsAt`, paused by the hosting service, or refused by the provider). Dollars as the team server counts them
 * (the provider's reported cost, else list prices). Never the key, not even part of it. */
/** the credential id of turns answered on the trial credit (turns.credential_id; Admin › Usage by connection): no
 * connection row has it */
export const TRIAL_CREDENTIAL_ID = 'hosted-trial'
export const TrialCredit = z.object({
  active: z.boolean(), state: z.enum(['active', 'used', 'ended']),
  usedUsd: z.number().nonnegative(), capUsd: z.number().nonnegative(), endsAt: IsoTime,
  /** the one model trial answers run on (an OpenRouter model id: the trial answers on the API engine) */
  model: z.string(),
})
export type TrialCredit = z.infer<typeof TrialCredit>
/** null: this server holds no trial credit (not hosted, never had one, or taken away) */
export const TrialCreditResponse = z.object({ credit: TrialCredit.nullable() })
export type TrialCreditResponse = z.infer<typeof TrialCreditResponse>

export const CREDENTIALS = {
  getAiAccess: endpoint({ method: 'GET', path: '/api/me/ai-access', auth: 'user', owner: 'A', response: AiAccessResponse, summary: 'Can I use AI now, which button fits me (connect for the team / connect my own / ask the owner), and did I already ask.' }),
  requestAiAccess: endpoint({ method: 'POST', path: '/api/me/ai-access/request', auth: 'user', owner: 'A', response: AiAccessRequestResponse, summary: 'Tell the owner(s) and admins I have no AI connection: one inbox notice per owner or admin, a second ask changes nothing. Not for the owner or an admin, nor for someone who can use AI.' }),
  listCredentials: endpoint({ method: 'GET', path: '/api/admin/credentials', auth: 'admin', owner: 'A', response: CredentialsResponse, summary: 'AI connections of the team (and that members have their own), with state and this month\'s use. Never a secret.' }),
  createCredential: endpoint({ method: 'POST', path: '/api/admin/credentials', auth: 'admin-reauth', owner: 'A', status: 201, body: CreateCredentialBody, response: Credential, summary: 'Add a Claude subscription token or an API key (sealed in the browser); checked without spending tokens. Already connected: 409 saying where (DuplicateCredentialParams); with moveFrom, a member\'s personal copy moves to the team.' }),
  updateCredential: endpoint({ method: 'PATCH', path: '/api/admin/credentials/:id', auth: 'admin', owner: 'A', body: UpdateCredentialBody, response: Credential, summary: 'Rename, order, switch off, assign to groups / people, monthly limit.' }),
  replaceCredentialSecret: endpoint({ method: 'POST', path: '/api/admin/credentials/:id/secret', auth: 'admin-reauth', owner: 'A', body: ReplaceSecretBody, response: Credential, summary: 'Put a new token / key on an existing connection (same kind).' }),
  deleteCredential: endpoint({ method: 'DELETE', path: '/api/admin/credentials/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Remove a connection (usage history stays).' }),
  checkCredential: endpoint({ method: 'POST', path: '/api/admin/credentials/:id/check', auth: 'admin', owner: 'A', response: Credential, summary: 'Check a connection again now, without spending tokens.' }),
  startCredentialLogin: endpoint({ method: 'POST', path: '/api/admin/credential-logins', auth: 'admin-reauth', owner: 'A', status: 202, body: StartCredentialLoginBody, response: CredentialLogin, summary: 'Start a ChatGPT (device code) or Claude (setup-token) sign-in for the team; progress on WebSocket credential.login.' }),
  getCredentialLogin: endpoint({ method: 'GET', path: '/api/admin/credential-logins/:id', auth: 'admin', owner: 'A', response: CredentialLogin, summary: 'State of a sign-in this person started (the owner or an admin; no one else can read it).' }),
  cancelCredentialLogin: endpoint({ method: 'DELETE', path: '/api/admin/credential-logins/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Stop a sign-in.' }),
  submitCredentialLoginCode: endpoint({ method: 'POST', path: '/api/admin/credential-logins/:id/code', auth: 'admin', owner: 'A', body: SubmitLoginCodeBody, response: CredentialLogin, summary: 'The code Claude showed after approval (sealed), for a Claude sign-in this person started.' }),
  updateCredentialSettings: endpoint({ method: 'PATCH', path: '/api/admin/credential-settings', auth: 'admin', owner: 'A', body: UpdateCredentialSettingsBody, response: CredentialSettings, summary: 'Personal connections and explicit shared-subscription consent.' }),
  sealingKey: endpoint({ method: 'GET', path: '/api/credentials/sealing-key', auth: 'user', owner: 'A', response: SealingKey, summary: 'Public key the browser seals a token / key with before sending it.' }),
  myCredentials: endpoint({ method: 'GET', path: '/api/me/credentials', auth: 'user', owner: 'A', response: MyCredentialsResponse, summary: 'My own AI connections (when the team allows them).' }),
  createMyCredential: endpoint({ method: 'POST', path: '/api/me/credentials', auth: 'user', owner: 'A', status: 201, body: CreateMyCredentialBody, response: Credential, summary: 'Add my own Claude token or API key; used for my turns first.' }),
  deleteMyCredential: endpoint({ method: 'DELETE', path: '/api/me/credentials/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Remove one of my own connections.' }),
  startMyCredentialLogin: endpoint({ method: 'POST', path: '/api/me/credential-logins', auth: 'user', owner: 'A', status: 202, body: StartMyLoginBody, response: CredentialLogin, summary: 'Start my own ChatGPT or Claude sign-in.' }),
  getMyCredentialLogin: endpoint({ method: 'GET', path: '/api/me/credential-logins/:id', auth: 'user', owner: 'A', response: CredentialLogin, summary: 'State of my sign-in.' }),
  cancelMyCredentialLogin: endpoint({ method: 'DELETE', path: '/api/me/credential-logins/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Stop my sign-in.' }),
  trialCredit: endpoint({ method: 'GET', path: '/api/admin/trial-credit', auth: 'admin', owner: 'A', response: TrialCreditResponse, summary: 'The hosting service\'s trial AI credit: active, dollars used of the cap, when it ends. Used only when no AI connection can answer.' }),
  submitMyCredentialLoginCode: endpoint({ method: 'POST', path: '/api/me/credential-logins/:id/code', auth: 'user', owner: 'A', body: SubmitLoginCodeBody, response: CredentialLogin, summary: 'The code Claude showed after approval (sealed), for my Claude sign-in.' }),
} as const
