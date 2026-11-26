// Test vectors for implementations of these contracts in other languages (mycel-enroll and ax-hostd are Go; the
// control plane copies this folder). `bun scripts/cloud-protocol-vectors.ts` writes them to vectors/vectors.json;
// tests/unit/cloud-protocol.test.ts fails when the file and this code disagree. MIT (see LICENSE in this folder).
//
// Ed25519 signatures are deterministic, so a fixed seed gives fixed signatures: an implementation that signs the
// strings below with the seed must produce exactly these bytes.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { canonicalJson, keyRotationString, reattachSigningString, registerSigningString, sha256Hex } from './signing.ts'
import { opsAuthorizationHeader, opsSigningString } from './relay-ops.ts'
import { tenantCommandArgv } from './tenant-commands.ts'
import { driveBrokerAuthorization } from './drive-broker.ts'
import { appCallbackUrl, appConnectUrl, OWNER_CLAIM_CONFIRM_PATH, OWNER_CLAIM_RESERVE_PATH, ownerClaimSetupUrl, ownerClaimSigningString, suggestTeamSlug, type OwnerClaimPath } from './owner-claim.ts'

/** a fixed test seed: RFC 8032 section 7.1 test 1 (public, never a real key) */
export const VECTOR_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'

export function seedKey(seedHex: string) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64')
  return { priv, publicKey, sign: (m: string) => sign(null, Buffer.from(m, 'utf8'), priv).toString('base64') }
}

const T = 1_761_100_000_000

const PLAN = {
  format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 3, diskGiB: 50, reserveMiB: 768,
  turnMemoryMaxMiB: null, turnPidsMax: 256, turnDiskMaxMiB: 1024, readMaxMiB: 128, convMemoryMaxMiB: null,
  localBackupRetentionDays: 3, updatedAt: '2026-10-22T00:00:00Z', maxActiveMembers: 12,
  display: { name: { ko: '\uD300', en: 'Team', id: 'Tim', ja: "チーム", es: "Equipo" } },
  links: { account: 'https://account.treesoop.com', status: 'https://status.treesoop.com', support: 'support@treesoop.com' },
}
const NOTICES = { format: 1, issuedAt: '2026-10-22T00:00:00Z', notices: [] as unknown[] }

export function buildVectors() {
  const k = seedKey(VECTOR_SEED_HEX)
  const tenantId = '01JC8Z5V3Q1X2Y3Z4A5B6C7D8E'
  const teamId = '0f6c2b1e-6a4c-4e0e-9a51-2d1f6f3b7c10'
  const reg = registerSigningString('acme', k.publicKey, T)
  const rot = keyRotationString(teamId, k.publicKey)
  const re = reattachSigningString(tenantId, teamId, T)
  const opsBody = canonicalJson({ name: 'acme', ttlSec: 1800 })
  const ops = opsSigningString('post', '/ops/v1/holds', T, opsBody)
  const regSig = k.sign(reg)
  return {
    format: 1,
    key: { seedHex: VECTOR_SEED_HEX, publicKeySpkiB64: k.publicKey },
    canonicalJson: [
      { in: { b: 1, a: [true, null, 'x'], c: { z: 'é', y: 0.5 } }, out: '{"a":[true,null,"x"],"b":1,"c":{"y":0.5,"z":"é"}}' },
      { in: { tenantId, op: 'tenantCommand', args: { command: 'status', args: {} }, notAfter: '2026-10-22T00:10:00Z' }, out: canonicalJson({ tenantId, op: 'tenantCommand', args: { command: 'status', args: {} }, notAfter: '2026-10-22T00:10:00Z' }) },
    ],
    signing: [
      { kind: 'register', string: reg, sha256: sha256Hex(reg), sig: regSig },
      { kind: 'rotate', string: rot, sha256: sha256Hex(rot), sig: k.sign(rot) },
      { kind: 'reattach', string: re, sha256: sha256Hex(re), sig: k.sign(re) },
      { kind: 'ops', method: 'POST', path: '/ops/v1/holds', ts: T, body: opsBody, string: ops, sha256: sha256Hex(ops), sig: k.sign(ops), authorization: opsAuthorizationHeader('cp', T, k.sign(ops)) },
    ],
    tenantCommandArgv: [
      { command: 'status', args: {}, argv: tenantCommandArgv('status', {}) },
      // the onboarding block is opt-in by the reader
      { command: 'status', args: { onboarding: true }, argv: tenantCommandArgv('status', { onboarding: true }) },
      { command: 'idle-wait', args: { max: 600 }, argv: tenantCommandArgv('idle-wait', { max: 600 }) },
      // F2 sleep: a true flag is a bare --activity
      { command: 'idle-wait', args: { max: 0, activity: true }, argv: tenantCommandArgv('idle-wait', { max: 0, activity: true }) },
      { command: 'data-grow', args: {}, argv: tenantCommandArgv('data-grow', {}) },
      { command: 'reset-link', args: { owner: true }, argv: tenantCommandArgv('reset-link', { owner: true }) },
      { command: 'relay-key-proof', args: { teamId }, argv: tenantCommandArgv('relay-key-proof', { teamId }) },
      // camelCase argument names become --kebab-case flags
      { command: 'backup-prepare', args: { kind: 'daily', localId: '20261022T020000Z-daily' }, argv: tenantCommandArgv('backup-prepare', { kind: 'daily', localId: '20261022T020000Z-daily' }) },
    ],
    tenantCommands: {
      allowed: [
        { command: 'status', args: {}, stdin: null },
        { command: 'status', args: { onboarding: true }, stdin: null },
        { command: 'apply-plan', args: {}, stdin: PLAN },
        // the hosting service's free speech-to-text hours a month: whole hours 1-1000, null = the server's default (10)
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, speechFreeHours: 200 } },
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, speechFreeHours: null } },
        { command: 'idle-wait', args: { max: 600 }, stdin: null },
        { command: 'idle-wait', args: { max: 0, activity: true }, stdin: null },
        { command: 'data-grow', args: {}, stdin: null },
        { command: 'update', args: { version: '0.3.1' }, stdin: null },
        { command: 'reset-link', args: { username: 'kim' }, stdin: null },
        // the team server's username rule: dots and @ too
        { command: 'reset-link', args: { username: 'kim.lee@acme' }, stdin: null },
        { command: 'backup-prepare', args: { kind: 'daily' }, stdin: null },
        // https, or http to this machine (dev)
        { command: 'set-server-config', args: {}, stdin: { publicOrigins: ['https://acme.treesoop.com', 'http://acme.localhost:19100'] } },
        // the hosting service's speech key, and taking it away
        { command: 'hosted-speech-key-set', args: {}, stdin: { key: 'sk-or-test-vector-not-a-key-0123456789' } },
        { command: 'hosted-speech-key-set', args: {}, stdin: { key: null } },
        // the hosting service's error report key (fake keys), with a port and a path prefix, and taking it away
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1' } },
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@o0.ingest.example.invalid:8443/prefix/42' } },
        { command: 'error-reports-set', args: {}, stdin: { url: null } },
        // the hosting service's GitHub App (fake values), with and without its name
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: '0000000000000000000000000000000000000000', slug: 'example-app' } },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv1.0123456789abcdef', clientSecret: 'not-a-secret_!#$%&()*+,./:;<=>?@[]^`{|}~' } },
        // the hosting service's Microsoft app (fake values), with the default tenant and a directory's own
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: 'not~a.secret_0000000000000000000000' } },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: 'ABCDEF01-2345-4678-89AB-CDEF01234567', clientSecret: '0000000000000000000000000000000000000000', tenant: 'organizations' } },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: '0000000000000000000000000000000000000000', tenant: '11111111-1111-4111-8111-111111111111' } },
        // the hosting service's mail service for room email, with a port, and taking it away
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://abc123.lambda-url.us-east-1.on.aws', domain: 'in.example.com' } },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid:8443', domain: 'in.example.invalid' } },
        { command: 'mail-in-set', args: {}, stdin: { url: null, domain: null } },
      ],
      refused: [
        { command: 'sh', args: {}, stdin: null, why: 'not a command' },
        { command: 'status', args: { path: '/etc/shadow' }, stdin: null, why: 'unknown argument' },
        { command: 'status', args: { onboarding: 'yes' }, stdin: null, why: 'onboarding is a flag' },
        { command: 'update', args: { version: '0.3.1; rm -rf /' }, stdin: null, why: 'version format' },
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, maxConcurrency: 99 }, why: 'stdin schema' },
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, speechFreeHours: 0 }, why: 'stdin schema' },
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, speechFreeHours: 1001 }, why: 'stdin schema' },
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, speechFreeHours: 1.5 }, why: 'stdin schema' },
        { command: 'status', args: {}, stdin: { x: 1 }, why: 'no stdin for status' },
        { command: '__proto__', args: {}, stdin: null, why: 'not a command' },
        { command: 'reset-link', args: { username: '../root' }, stdin: null, why: 'username rule' },
        { command: 'set-server-config', args: {}, stdin: { publicOrigins: ['http://evil.example'] }, why: 'http to another machine' },
        { command: 'hosted-speech-key-set', args: {}, stdin: { key: 'sk-or-short' }, why: 'not an OpenRouter key' },
        { command: 'hosted-speech-key-set', args: {}, stdin: { key: 'sk-or-test-vector-not-a-key-0123456789', extra: 1 }, why: 'unknown stdin field' },
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1\nNODE_OPTIONS=--require=/tmp/x.js' }, why: 'a newline adds a variable' },
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1"' }, why: 'a quote' },
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1\\' }, why: 'a backslash' },
        { command: 'error-reports-set', args: {}, stdin: { url: 'http://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1' }, why: 'not https' },
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://errors.example.invalid/1' }, why: 'no public key' },
        { command: 'error-reports-set', args: {}, stdin: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/abc' }, why: 'no numeric project id' },
        { command: 'error-reports-set', args: {}, stdin: { url: '' }, why: 'empty: null takes it away' },
        { command: 'error-reports-set', args: {}, stdin: { url: null, extra: 1 }, why: 'unknown stdin field' },
        { command: 'error-reports-set', args: {}, stdin: {}, why: 'url is required' },
        { command: 'error-reports-set', args: { url: 'https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1' }, stdin: null, why: 'the key goes on stdin only' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid\nNODE_OPTIONS=--require=/tmp/x.js', domain: 'in.example.invalid' }, why: 'a newline adds a variable' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid', domain: 'in.example.invalid"' }, why: 'a quote' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid/', domain: 'in.example.invalid' }, why: 'a path' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'http://mail-in.example.invalid', domain: 'in.example.invalid' }, why: 'not https' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://Mail-In.example.invalid', domain: 'in.example.invalid' }, why: 'upper case' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://user@mail-in.example.invalid', domain: 'in.example.invalid' }, why: 'user info' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid', domain: null }, why: 'both or neither' },
        { command: 'mail-in-set', args: {}, stdin: { url: null, domain: 'in.example.invalid' }, why: 'both or neither' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid', domain: 'localhost' }, why: 'a domain with a dot' },
        { command: 'mail-in-set', args: {}, stdin: { url: 'https://mail-in.example.invalid' }, why: 'domain is required' },
        { command: 'mail-in-set', args: {}, stdin: { url: null, domain: null, extra: 1 }, why: 'unknown stdin field' },
        { command: 'mail-in-set', args: { url: 'https://mail-in.example.invalid' }, stdin: null, why: 'values go on stdin only' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0' }, why: 'clientSecret is required' },
        { command: 'github-app-set', args: {}, stdin: { clientSecret: '0000000000000000000000000000000000000000' }, why: 'clientId is required' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: '' }, why: 'an empty secret' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: 'two words' }, why: 'a space in the secret' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: 'line\nbreak' }, why: 'a newline in the secret' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: 'x'.repeat(4097) }, why: 'a secret over 4096 characters' },
        { command: 'github-app-set', args: {}, stdin: { clientId: '../../etc', clientSecret: '0000000000000000000000000000000000000000' }, why: 'clientId rule' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: '0000000000000000000000000000000000000000', slug: 'Example App' }, why: 'slug rule' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: '0000000000000000000000000000000000000000', path: '/etc/shadow' }, why: 'unknown stdin field' },
        { command: 'github-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: 0 }, why: 'the secret is a string' },
        { command: 'github-app-set', args: {}, stdin: null, why: 'the app goes on stdin' },
        { command: 'github-app-set', args: { clientSecret: '0000000000000000000000000000000000000000' }, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: '0000000000000000000000000000000000000000' }, why: 'the secret goes on stdin only' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000' }, why: 'clientSecret is required' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: 'Iv23liTestVectorOnly0', clientSecret: '0000000000000000000000000000000000000000' }, why: 'clientId is a GUID' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: 'two words' }, why: 'a space in the secret' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: 'x'.repeat(4097) }, why: 'a secret over 4096 characters' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: '0000000000000000000000000000000000000000', tenant: '../etc' }, why: 'tenant rule' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: '0000000000000000000000000000000000000000', redirectUris: [] }, why: 'unknown stdin field' },
        { command: 'microsoft-app-set', args: {}, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: '0000000000000000000000000000000000000000', tenant: 'consumers' }, why: 'personal accounts are not supported' },
        { command: 'microsoft-app-set', args: {}, stdin: null, why: 'the app goes on stdin' },
        { command: 'microsoft-app-set', args: { clientSecret: '0000000000000000000000000000000000000000' }, stdin: { clientId: '00000000-0000-4000-8000-000000000000', clientSecret: '0000000000000000000000000000000000000000' }, why: 'the secret goes on stdin only' },
      ],
    },
    enroll: {
      file: {
        valid: [
          { v: 1, tenantId, controlPlane: 'https://cp.treesoop.com', enrollToken: 'ent_0123456789abcdefghijKLMN', mode: 'new', teamSlug: 'acme', relayTeamId: null, timeZone: 'Asia/Seoul', locale: 'ko', backupWindowStartMin: 150, maintenanceWindowStartMin: 270 },
          // reattach: no enroll token, the relay team id instead
          { v: 1, tenantId, controlPlane: 'https://cp.treesoop.com', enrollToken: null, mode: 'reattach', relayTeamId: teamId, timeZone: 'Asia/Jakarta', locale: 'id', backupWindowStartMin: 120, maintenanceWindowStartMin: 270 },
          // reattach as ax-hostd writes it (reimageTenant: the relay team id is on the data disk, not in the file)
          { v: 1, tenantId, controlPlane: 'https://cp.treesoop.com', enrollToken: null, mode: 'reattach', teamSlug: null, relayTeamId: null, timeZone: 'UTC', locale: 'en', backupWindowStartMin: 150, maintenanceWindowStartMin: 270 },
        ],
        invalid: [
          // plain http control plane; then the isolation §5.4 shape without mode / teamSlug (read as new, which needs a slug); then restore without a token
          { v: 1, tenantId, controlPlane: 'http://cp.treesoop.com', enrollToken: 'ent_0123456789abcdefghijKLMN', mode: 'new', teamSlug: 'acme', timeZone: 'Asia/Seoul', locale: 'ko', backupWindowStartMin: 150, maintenanceWindowStartMin: 270 },
          { v: 1, tenantId, controlPlane: 'https://cp.treesoop.com', enrollToken: 'ent_0123456789abcdefghijKLMN', timeZone: 'Asia/Seoul', locale: 'ko', backupWindowStartMin: 150, maintenanceWindowStartMin: 270 },
          { v: 1, tenantId, controlPlane: 'https://cp.treesoop.com', enrollToken: null, mode: 'restore', relayTeamId: teamId, timeZone: 'Asia/Seoul', locale: 'ko', backupWindowStartMin: 150, maintenanceWindowStartMin: 270 },
        ],
      },
      request: {
        valid: [
          { v: 1, tenantId, enrollToken: 'ent_0123456789abcdefghijKLMN', mode: 'new', relayPublicKey: k.publicKey, relayProof: { kind: 'register', ts: T, sig: regSig }, oneTimeRecipient: null, kitVersion: '0.3.0', appVersion: '0.3.0' },
          { v: 1, tenantId, enrollToken: null, mode: 'reattach', relayPublicKey: k.publicKey, relayProof: { kind: 'reattach', relayTeamId: teamId, ts: T, sig: k.sign(re) }, oneTimeRecipient: null, kitVersion: '0.3.0', appVersion: '0.3.0' },
          // versions are informational: an empty one (an older mycel-enroll) reads as "unknown"
          { v: 1, tenantId, enrollToken: 'ent_0123456789abcdefghijKLMN', mode: 'new', relayPublicKey: k.publicKey, relayProof: { kind: 'register', ts: T, sig: regSig }, oneTimeRecipient: null, kitVersion: '0.3.0', appVersion: '' },
        ],
        invalid: [
          { v: 1, tenantId, enrollToken: 'ent_0123456789abcdefghijKLMN', mode: 'new', relayPublicKey: k.publicKey, relayProof: { kind: 'rotate', relayTeamId: teamId, sig: k.sign(rot) }, oneTimeRecipient: null, kitVersion: '0.3.0', appVersion: '0.3.0' },
          { v: 1, tenantId, enrollToken: 'ent_0123456789abcdefghijKLMN', mode: 'verify', relayPublicKey: null, relayProof: null, oneTimeRecipient: null, kitVersion: '0.3.0', appVersion: '0.3.0' },
        ],
      },
      plan: PLAN,
      notices: NOTICES,
    },
    ownerClaim: ownerClaimVectors(k),
  }
}

/** owner-claim.ts: the claim, its hash and setup address, the signed reserve and confirm calls, the parsers' cases, the
 * app's connect address and callback, and address labels from team names */
function ownerClaimVectors(k: ReturnType<typeof seedKey>) {
  const claim = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' // bytes 0..31, base64url (a test value)
  const nonce = 'bm9uY2Utb2YtYS10ZXN0LXZlY3Rvcg'
  const body = JSON.stringify({ v: 1, claim })
  const bodySha = sha256Hex(body)
  const signed = (path: OwnerClaimPath) => {
    const string = ownerClaimSigningString(path, T, nonce, bodySha)
    const sig = k.sign(string)
    return { path, ts: T, nonce, body, bodySha256: bodySha, string, sig, authorization: driveBrokerAuthorization(k.publicKey, T, nonce, sig) }
  }
  const owner = { teamName: 'Acme', email: 'owner@example.com', name: 'Alex Kim', locale: 'en', timeZone: 'Asia/Seoul', google: null }
  const state = Buffer.alloc(32, 7).toString('base64url'), challenge = Buffer.alloc(32, 9).toString('base64url')
  return {
    claim, claimSha256: sha256Hex(claim),
    setupUrl: ownerClaimSetupUrl('https://acme.treesoop.com', claim),
    reserve: signed(OWNER_CLAIM_RESERVE_PATH),
    confirm: signed(OWNER_CLAIM_CONFIRM_PATH),
    request: {
      valid: [{ v: 1, claim }],
      invalid: [
        { raw: { v: 1, claim: claim.slice(1) }, why: 'claim is 43 characters' },
        { raw: { v: 1, claim: claim.slice(0, 42) + '=' }, why: 'base64url, no padding' },
        { raw: { v: 2, claim }, why: 'version' },
        { raw: { v: 1, claim, team: 'acme' }, why: 'unknown key' },
      ],
    },
    owner: {
      valid: [owner, { ...owner, locale: 'ko', timeZone: null, google: { sub: '109876543210987654321', email: 'owner@example.com', hd: null } }],
      invalid: [
        { raw: { ...owner, email: 'not-an-address' }, why: 'e-mail' },
        { raw: { ...owner, name: '' }, why: 'empty name' },
        { raw: { ...owner, teamName: 'Acme\u200B' }, why: 'team name rule' },
        { raw: { ...owner, name: 'Alex\nKim' }, why: 'a control character' },
        { raw: { ...owner, google: { sub: 'x y', email: 'owner@example.com', hd: null } }, why: 'Google sub' },
        { raw: { ...owner, password: 'x' }, why: 'unknown key' },
      ],
    },
    connect: {
      url: appConnectUrl('https://account.treesoop.com', { state, challenge, port: 53682, locale: 'en', store: false }),
      storeUrl: appConnectUrl('https://account.treesoop.com', { state, challenge, port: 53682, locale: 'ko', store: true }),
      callback: appCallbackUrl(53682, { code: claim, state }),
      cancelled: appCallbackUrl(53682, { error: 'cancelled', state }),
    },
    email: {
      start: {
        valid: [{ email: 'owner@example.com', locale: 'en', challenge }, { email: 'owner@example.com', locale: 'ko', challenge, store: true }],
        invalid: [
          { raw: { email: 'owner@example.com', locale: 'en', challenge, store: false }, why: 'store is true or absent' },
          { raw: { email: ' owner@example.com', locale: 'en', challenge }, why: 'surrounding spaces' },
          { raw: { email: 'owner@localhost', locale: 'en', challenge }, why: 'a domain with a dot' },
          { raw: { email: 'owner@example.com', locale: 'en' }, why: 'challenge is required' },
          { raw: { email: 'owner@example.com', locale: 'en', challenge, password: 'x' }, why: 'unknown key' },
        ],
      },
      verify: {
        valid: [{ email: 'owner@example.com', code: '042917', verifier: Buffer.alloc(32, 3).toString('base64url') }],
        invalid: [
          { raw: { email: 'owner@example.com', code: '42917', verifier: Buffer.alloc(32, 3).toString('base64url') }, why: '6 digits' },
          { raw: { email: 'owner@example.com', code: '04291a', verifier: Buffer.alloc(32, 3).toString('base64url') }, why: 'digits only' },
          { raw: { email: 'owner@example.com', code: '042917', verifier: 'short' }, why: 'verifier' },
        ],
      },
    },
    slugs: [
      ['Acme', 'acme'], ['Café Olé Studio', 'cafe-ole-studio'], ['  ACME — Seoul  ', 'acme-seoul'], ['東京チーム', 'team-x7k2'], ['ab', 'team-x7k2'],
    ].map(([name, slug]) => ({ name, suffix: 'x7k2', slug, out: suggestTeamSlug(name!, 'x7k2') })),
  }
}
