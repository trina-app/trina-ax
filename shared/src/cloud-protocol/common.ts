// Small zod pieces the cloud contracts share. MIT (see LICENSE in this folder). Self-contained on purpose: nothing
// here imports the AGPL parts of the repository, so the control plane can copy the folder as is.
import { z } from 'zod'

export const IsoTime = z.iso.datetime({ offset: true })
export const Locale = z.enum(['ko', 'en', 'id'])
export type Locale = z.infer<typeof Locale>
/** a text shown to people, in the three product languages */
export const I18nText = z.object({ ko: z.string().min(1).max(500), en: z.string().min(1).max(500), id: z.string().min(1).max(500) })
export type I18nText = z.infer<typeof I18nText>

/** Team address label <slug>.treesoop.com: the relay's name rule (shared/src/relay-protocol/names.ts, kept equal by a test). */
export const TEAM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const TeamSlug = z.string().min(3).max(40).regex(TEAM_SLUG_RE).refine((s) => s.slice(2, 4) !== '--', 'no "--" in positions 3-4 (IDNA labels)')

/** the control plane's tenant id: a ULID (Crockford base32, 26 characters). It ends up in VM names (t-<id>), file
 * names and DHCP host names, so nothing else is accepted (ax-hostd's HC-1 rule, ee/cloud/contracts). */
export const TenantId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'tenantId must be a ULID')
/** relay registry team id (a UUID; letters, digits, "-" and "_") */
export const RelayTeamId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** plan id: basic | team | pro | ... (plan.json `plan`, ax-hostd createTenant / resizeTenant `planId`) */
export const PlanId = z.string().regex(/^[a-z0-9_-]{1,32}$/)
/** IANA time zone name: UTC or Area/City (Area/Sub/City); what Intl and the tenant's /usr/share/zoneinfo know */
export const TimeZoneName = z.string().max(64).regex(/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/, 'IANA time zone')
export const MinuteOfDay = z.number().int().min(0).max(1439)
/** a team account's username: the team server's rule (shared/src/api/auth.ts Username, kept equal by a test) */
export const ACCOUNT_USERNAME_RE = /^[A-Za-z0-9._@-]{2,64}$/
export const AccountUsername = z.string().regex(ACCOUNT_USERNAME_RE)
/** a version string as a release names it: 0.3.1, 0.3.1-beta.2 */
export const VersionString = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)

const B64 = /^[A-Za-z0-9+/]+=*$/
/** base64 SPKI DER of an Ed25519 public key (the relay team key format) */
export const Ed25519PublicKeyB64 = z.string().min(40).max(200).regex(B64)
/** base64 Ed25519 signature (64 bytes) */
export const SignatureB64 = z.string().min(80).max(100).regex(B64)
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/** age X25519 recipient (age1 + bech32). Post-quantum hybrid recipients (age1pq1...) are not used in v1 (control-plane 3.8.4). */
export const AgeRecipient = z.string().regex(/^age1[02-9ac-hj-np-z]{58}$/)
/** an age-encrypted payload carried inside JSON: ASCII armor (age -a / age-encryption armor.encode) */
export const AgeArmored = z.string().max(1 << 20).regex(/^-----BEGIN AGE ENCRYPTED FILE-----\r?\n[\s\S]+\r?\n-----END AGE ENCRYPTED FILE-----\r?\n?$/)

/** this machine: 127.0.0.1, [::1], localhost and <name>.localhost (the dev relay's team addresses) */
export const isLocalHost = (h: string) => h === '127.0.0.1' || h === '[::1]' || h === 'localhost' || h.endsWith('.localhost')
/** https, or http to this machine only (development and tests: fake control plane / fake S3) */
export const HttpsUrl = z.url().refine((u) => {
  try {
    const x = new URL(u)
    if (x.username || x.password) return false
    return x.protocol === 'https:' || (x.protocol === 'http:' && isLocalHost(x.hostname))
  } catch { return false }
}, 'must be https:// (http:// only for 127.0.0.1 / localhost)')
/** the relay control connection: wss://, or ws:// to this machine */
export const WsUrl = z.url().refine((u) => {
  try {
    const x = new URL(u)
    return x.protocol === 'wss:' || (x.protocol === 'ws:' && isLocalHost(x.hostname))
  } catch { return false }
}, 'must be wss:// (ws:// only for 127.0.0.1 / localhost)')

/** AI credential kinds (credentials spec D22, engine_credentials.kind) */
export const CredentialKind = z.enum(['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'])
export type CredentialKind = z.infer<typeof CredentialKind>
/** what the hosted service (cloud) enrolls with by default: all four kinds, like a self-installed server (owner's
 * decision 2026-10-22: the team rents its own VM and connects its own accounts; adding a subscription kind still shows
 * the plan notice and needs its checkbox, credentials D23). The control plane can narrow it fleet-wide. */
export const CLOUD_DEFAULT_CREDENTIAL_KINDS: readonly CredentialKind[] = ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key']

/** The error body every cloud HTTP endpoint (enroll) answers with. */
export const CloudError = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]{2,40}$/), message: z.string().max(1000) }) })
export type CloudError = z.infer<typeof CloudError>
