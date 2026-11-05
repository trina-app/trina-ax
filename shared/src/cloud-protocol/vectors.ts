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
        { command: 'idle-wait', args: { max: 600 }, stdin: null },
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
        // the hosting service's trial AI credit, paused, and taken away
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-or-v1-test-vector-not-a-key-0123456789', capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true } },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-or-v1-test-vector-not-a-key-0123456789', capUsd: 12.5, endsAt: '2026-11-19T00:00:00+09:00', enabled: false } },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: null } },
        // the hosting service's Higgsfield credential for the welcome steps' brand photos, and taking it away
        { command: 'hosted-image-key-set', args: {}, stdin: { token: 'hf-test-vector.not-a-token_0123456789~+/=', workspace: '7b0e5c1a-3d2f-4a6b-9c8d-1e2f3a4b5c6d' } },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: null } },
      ],
      refused: [
        { command: 'sh', args: {}, stdin: null, why: 'not a command' },
        { command: 'status', args: { path: '/etc/shadow' }, stdin: null, why: 'unknown argument' },
        { command: 'status', args: { onboarding: 'yes' }, stdin: null, why: 'onboarding is a flag' },
        { command: 'update', args: { version: '0.3.1; rm -rf /' }, stdin: null, why: 'version format' },
        { command: 'apply-plan', args: {}, stdin: { ...PLAN, maxConcurrency: 99 }, why: 'stdin schema' },
        { command: 'status', args: {}, stdin: { x: 1 }, why: 'no stdin for status' },
        { command: '__proto__', args: {}, stdin: null, why: 'not a command' },
        { command: 'reset-link', args: { username: '../root' }, stdin: null, why: 'username rule' },
        { command: 'set-server-config', args: {}, stdin: { publicOrigins: ['http://evil.example'] }, why: 'http to another machine' },
        { command: 'hosted-speech-key-set', args: {}, stdin: { key: 'sk-or-short' }, why: 'not an OpenRouter key' },
        { command: 'hosted-speech-key-set', args: {}, stdin: { key: 'sk-or-test-vector-not-a-key-0123456789', extra: 1 }, why: 'unknown stdin field' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-ant-api03-test-vector-not-a-key-0123456789', capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true }, why: 'a direct Anthropic key: the trial runs on an OpenRouter key, never in Claude Code' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-ant-oat01-test-vector-not-a-key-0123456789', capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true }, why: 'a subscription token, not an OpenRouter key' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-or-short', capUsd: 10, endsAt: '2026-11-18T15:00:00Z', enabled: true }, why: 'not an OpenRouter key' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-or-v1-test-vector-not-a-key-0123456789', capUsd: 10, endsAt: '2026-11-18T15:00:00Z' }, why: 'enabled missing' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-or-v1-test-vector-not-a-key-0123456789', capUsd: -1, endsAt: '2026-11-18T15:00:00Z', enabled: true }, why: 'negative cap' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: 'sk-or-v1-test-vector-not-a-key-0123456789', capUsd: 10, endsAt: 'next week', enabled: true }, why: 'not a time' },
        { command: 'hosted-chat-key-set', args: {}, stdin: { key: null, capUsd: 10 }, why: 'unknown field beside a null key' },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: 'short', workspace: '7b0e5c1a-3d2f-4a6b-9c8d-1e2f3a4b5c6d' }, why: 'token too short' },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: 'hf-test-vector not-a-token 0123456789', workspace: '7b0e5c1a-3d2f-4a6b-9c8d-1e2f3a4b5c6d' }, why: 'a space is not a token character' },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: 'hf-test-vector.not-a-token_0123456789', workspace: 'acme' }, why: 'workspace is not a UUID' },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: 'hf-test-vector.not-a-token_0123456789' }, why: 'workspace missing' },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: 'hf-test-vector.not-a-token_0123456789', workspace: '7b0e5c1a-3d2f-4a6b-9c8d-1e2f3a4b5c6d', model: 'z_image' }, why: 'unknown stdin field' },
        { command: 'hosted-image-key-set', args: {}, stdin: { token: null, workspace: '7b0e5c1a-3d2f-4a6b-9c8d-1e2f3a4b5c6d' }, why: 'unknown field beside a null token' },
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
  }
}
