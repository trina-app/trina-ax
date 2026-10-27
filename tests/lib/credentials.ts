// AI connections for tests: a credential context on a test database with its own secrets folder, fake upstream
// addresses, and quick ways to add a connection without the HTTP API (no provider check).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { CredentialAssignment, CredentialKind } from '@mycel/shared/api'
import type { ModelUpstreams } from '../../server/src/app-config'
import { insertRow } from '../../server/src/credentials/service'
import { makeCredCtx, type CredCtx, type Notice, type Secrets } from '../../server/src/credentials/store'
import { accountRef } from '../../server/src/credentials/openai-oauth'

export interface TestCred { cc: CredCtx; notices: { n: Notice; to?: string[] }[]; events: { userId: string; ev: unknown }[] }

export function testCredCtx(db: Database, dir: string, o: { upstreams?: Partial<ModelUpstreams>; kinds?: CredentialKind[]; now?: () => number; fetch?: typeof fetch } = {}): TestCred {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const notices: TestCred['notices'] = []
  const events: TestCred['events'] = []
  const cc = makeCredCtx({
    db, secretsDir: dir, log: { info() {}, warn() {}, error() {} },
    config: { mode: 'dev', dataDir: path.join(dir, 'data'), engine: { authMode: 'managed', modelUpstreams: o.upstreams ?? {}, ...(o.kinds ? { credentialKinds: o.kinds } : {}) } },
    notify: (n, to) => notices.push({ n, to }), publish: (userId, ev) => events.push({ userId, ev }), ...(o.now ? { now: o.now } : {}), ...(o.fetch ? { fetch: o.fetch } : {}),
  })
  return { cc, notices, events }
}

/** a JWT-shaped token (unsigned) with these claims */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(claims)}.sig`
}
export function chatgptSecret(accountId: string, o: { access?: string; refresh?: string; plan?: string; expSec?: number; lastRefresh?: string } = {}): Secrets['chatgpt'] {
  const now = Math.floor(Date.now() / 1000)
  return {
    idToken: fakeJwt({ email: 'team@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: o.plan ?? 'pro', chatgpt_account_id: accountId, chatgpt_user_id: 'u-1' } }),
    accessToken: o.access ?? fakeJwt({ exp: o.expSec ?? now + 3600, n: Math.random() }),
    refreshToken: o.refresh ?? 'rt-' + accountId,
    accountId, lastRefresh: o.lastRefresh ?? new Date().toISOString(),
  }
}

export function addCred(cc: CredCtx, kind: CredentialKind, secret: string | Secrets['chatgpt'], o: { label?: string; priority?: number; owner?: string | null; assignments?: CredentialAssignment[]; createdAt?: string; disabled?: boolean; plan?: string } = {}): string {
  const value = kind === 'chatgpt' ? secret as Secrets['chatgpt'] : kind === 'anthropic-oauth' ? { token: secret as string } : { key: secret as string }
  const id = insertRow(cc, {
    kind, label: o.label ?? kind, secret: value, ownerUserId: o.owner ?? null, priority: o.priority ?? 100, assignments: o.assignments ?? [], createdBy: null,
    meta: kind === 'chatgpt' ? { planType: o.plan ?? 'pro', accountRef: accountRef((value as Secrets['chatgpt']).accountId) } : {},
    expiresAt: kind === 'anthropic-oauth' ? new Date(Date.now() + 365 * 86400_000).toISOString() : null, checkedAt: new Date().toISOString(),
  })
  if (o.createdAt) cc.db.query('UPDATE engine_credentials SET created_at = ? WHERE id = ?').run(o.createdAt, id)
  if (o.disabled) cc.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id = ?').run(id)
  return id
}
