// The mailbox's team API (mailbox/src/api.ts, contract shared/src/cloud-protocol/mail-in.ts): signed calls (a bad
// signature, a clock off, a nonce used twice, an unknown team), strict bodies, status / key / sync, and the long poll
// with its lease, acks, the 24-hour expiry and the `expired` count. Also the local dev mailbox end to end.
import { afterEach, expect, test } from 'bun:test'
import nodeCrypto, { type KeyObject } from 'node:crypto'
import {
  MAIL_IN_ITEM_TTL_MS, MAIL_IN_LEASE_MS, MAIL_IN_MAX_SKEW_MS, MAIL_IN_PATHS, mailInAuthorization, mailInSealAad, mailInSigningString,
  type MailInOp,
} from '../../shared/src/cloud-protocol/mail-in'
import { handleApi } from '../../mailbox/src/api'
import { Waiters, type MailboxDeps } from '../../mailbox/src/deps'
import { startDevMailbox, type DevMailbox } from '../../mailbox/src/dev'
import { receiveMail } from '../../mailbox/src/gateway'
import { nodeMailCrypto, nodeOpenSealed } from '../../mailbox/src/node-crypto'
import { MailStore, MemoryKv } from '../../mailbox/src/store'

const DOMAIN = 'mail.example'
const sha = (s: string) => nodeCrypto.createHash('sha256').update(s).digest('hex')
const local = () => Array.from(nodeCrypto.randomBytes(26), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('')
const enc = (s: string) => new TextEncoder().encode(s)

interface Team { key: KeyObject; spki: string; sealPriv: KeyObject; sealKey: string }
function team(): Team {
  const { privateKey } = nodeCrypto.generateKeyPairSync('ed25519')
  const spki = (nodeCrypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')
  const x = nodeCrypto.generateKeyPairSync('x25519')
  const sealKey = (x.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  return { key: privateKey, spki, sealPriv: x.privateKey, sealKey }
}

function setup() {
  let t = Date.parse('2026-11-23T10:00:00Z')
  const served = new Map<string, string>()
  const deps: MailboxDeps = { store: new MailStore(new MemoryKv()), crypto: nodeMailCrypto, domain: DOMAIN, teams: async (k) => served.get(k) ?? null, now: () => t, waiters: new Waiters() }
  const call = async (who: Team, op: MailInOp, body: unknown, o: { ts?: number; nonce?: string; sigBody?: string; raw?: string; path?: string; method?: string } = {}) => {
    const text = o.raw ?? JSON.stringify(body)
    const path = o.path ?? MAIL_IN_PATHS[op]
    const ts = o.ts ?? t, nonce = o.nonce ?? nodeCrypto.randomBytes(18).toString('base64url')
    const sig = nodeCrypto.sign(null, Buffer.from(mailInSigningString(path, ts, nonce, sha(o.sigBody ?? text))), who.key).toString('base64')
    const r = await handleApi(deps, new Request(`https://mailbox.example${path}`, { method: o.method ?? 'POST', headers: { authorization: mailInAuthorization(who.spki, ts, nonce, sig), 'content-type': 'application/json' }, body: (o.method ?? 'POST') === 'POST' ? text : undefined }))
    return { status: r.status, json: await r.json().catch(() => null) as any }
  }
  return { deps, served, call, move: (ms: number) => { t += ms } }
}

test('auth: a bad signature, a clock off, a nonce used twice, an unknown team, no header', async () => {
  const s = setup()
  const a = team()
  s.served.set(a.spki, 'team-a')
  expect((await s.call(a, 'status', { v: 1 })).status).toBe(200)
  // the signature over another body
  expect((await s.call(a, 'status', { v: 1 }, { sigBody: '{"v":2}' })).json.error.code).toBe('unauthorized')
  // the clock
  expect((await s.call(a, 'status', { v: 1 }, { ts: Date.parse('2026-11-23T10:00:00Z') - MAIL_IN_MAX_SKEW_MS - 1 })).status).toBe(401)
  expect((await s.call(a, 'status', { v: 1 }, { ts: Date.parse('2026-11-23T10:00:00Z') + MAIL_IN_MAX_SKEW_MS + 1 })).status).toBe(401)
  // the same nonce twice
  const nonce = nodeCrypto.randomBytes(18).toString('base64url')
  expect((await s.call(a, 'status', { v: 1 }, { nonce })).status).toBe(200)
  expect((await s.call(a, 'status', { v: 1 }, { nonce })).json.error.code).toBe('unauthorized')
  // a key the hosting service does not serve
  const b = team()
  expect((await s.call(b, 'status', { v: 1 })).json).toEqual({ error: { code: 'not_hosted', message: expect.any(String) } })
  // no header, another path, GET
  const r = await handleApi(s.deps, new Request(`https://m${MAIL_IN_PATHS.status}`, { method: 'POST', body: '{"v":1}' }))
  expect(r.status).toBe(401)
  expect((await handleApi(s.deps, new Request('https://m/api/mail-in/v1/other', { method: 'POST', body: '{}' }))).status).toBe(404)
  expect((await handleApi(s.deps, new Request(`https://m${MAIL_IN_PATHS.status}`))).status).toBe(405)
  // not configured
  const off = await handleApi({ ...s.deps, domain: null }, new Request(`https://m${MAIL_IN_PATHS.status}`, { method: 'POST', body: '{"v":1}' }))
  expect(off.status).toBe(503)
})

test('strict bodies: unknown keys, wrong values, too large', async () => {
  const s = setup()
  const a = team()
  s.served.set(a.spki, 'team-a')
  for (const [op, body] of [
    ['status', { v: 1, x: 1 }], ['status', { v: 2 }], ['key', { v: 1, sealKey: 'short' }], ['sync', { v: 1, hashes: ['nothex'] }],
    ['sync', { v: 1 }], ['poll', { v: 1, ack: [], waitMs: 30_000 }], ['poll', { v: 1, ack: ['bad id!'], waitMs: 0 }],
  ] as [MailInOp, unknown][]) expect((await s.call(a, op, body)).json?.error?.code).toBe('invalid_request')
  expect((await s.call(a, 'status', null, { raw: 'not json' })).status).toBe(400)
  expect((await s.call(a, 'sync', null, { raw: JSON.stringify({ v: 1, hashes: [] }) + ' '.repeat(140_000) })).status).toBe(400)
})

test('key, sync, status; poll before a key is no_key', async () => {
  const s = setup()
  const a = team()
  s.served.set(a.spki, 'team-a')
  expect((await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })).json.error.code).toBe('no_key')
  expect((await s.call(a, 'key', { v: 1, sealKey: a.sealKey })).json).toEqual({ ok: true })
  const addr = local()
  expect((await s.call(a, 'sync', { v: 1, hashes: [sha(addr), sha(addr)] })).json).toEqual({ ok: true, addresses: 1 })
  expect((await s.call(a, 'status', { v: 1 })).json).toEqual({ ok: true, domain: DOMAIN, sealKey: a.sealKey, addresses: 1 })
  expect((await receiveMail(s.deps, { to: `${addr}@${DOMAIN}`, from: 'x@y', raw: enc('Subject: hi\r\n\r\nbody') })).accepted).toBe(true)
  // sync without it: refused at once
  expect((await s.call(a, 'sync', { v: 1, hashes: [] })).json.addresses).toBe(0)
  expect((await receiveMail(s.deps, { to: `${addr}@${DOMAIN}`, from: 'x@y', raw: enc('Subject: hi\r\n\r\nbody') })).accepted).toBe(false)
})

test('poll: items, the lease, acks, the 24-hour expiry and the expired count', async () => {
  const s = setup()
  const a = team()
  s.served.set(a.spki, 'team-a')
  await s.call(a, 'key', { v: 1, sealKey: a.sealKey })
  const addr = local()
  await s.call(a, 'sync', { v: 1, hashes: [sha(addr)] })
  const send = () => receiveMail(s.deps, { to: `${addr}@${DOMAIN}`, from: 'x@y', raw: enc('Subject: hi\r\n\r\nbody') })
  await send(); s.move(1); await send()
  const p1 = await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })
  expect(p1.json.items.length).toBe(2)
  expect(p1.json.expired).toBe(0)
  const it = p1.json.items[0]
  const plain = nodeOpenSealed(it.sealed, a.sealPriv, mailInSealAad(it.id, it.hash, it.receivedAt))
  expect(plain.toString('utf8')).toContain('Subject: hi')
  // leased: not handed out again within the lease
  expect((await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })).json.items.length).toBe(0)
  // after the lease, unacked ones come again (at least once)
  s.move(MAIL_IN_LEASE_MS + 1)
  const p2 = await s.call(a, 'poll', { v: 1, ack: [p1.json.items[0].id], waitMs: 0 })
  expect(p2.json.items.map((i: any) => i.id)).toEqual([p1.json.items[1].id])
  // ack the second; nothing left
  await s.call(a, 'poll', { v: 1, ack: [p2.json.items[0].id], waitMs: 0 })
  expect((await s.deps.store.queueStats('team-a')).items).toBe(0)
  // another team's ack deletes nothing
  await send()
  const b = team(); s.served.set(b.spki, 'team-b'); await s.call(b, 'key', { v: 1, sealKey: b.sealKey })
  const p3 = await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })
  await s.call(b, 'poll', { v: 1, ack: [p3.json.items[0].id], waitMs: 0 })
  expect((await s.deps.store.queueStats('team-a')).items).toBe(1)
  // older than 24 hours: dropped unread, counted once
  s.move(MAIL_IN_ITEM_TTL_MS + 1)
  const p4 = await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })
  expect(p4.json).toEqual({ items: [], expired: 1 })
  expect((await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })).json.expired).toBe(0)
})

test('a held poll answers when mail comes; a newer poll of the team ends the older one', async () => {
  const s = setup()
  const a = team()
  s.served.set(a.spki, 'team-a')
  await s.call(a, 'key', { v: 1, sealKey: a.sealKey })
  const addr = local()
  await s.call(a, 'sync', { v: 1, hashes: [sha(addr)] })
  const held = s.call(a, 'poll', { v: 1, ack: [], waitMs: 20_000 })
  await new Promise((r) => setTimeout(r, 20))
  expect((s.deps.waiters as Waiters).held('team-a')).toBe(1)
  await receiveMail(s.deps, { to: `${addr}@${DOMAIN}`, from: 'x@y', raw: enc('Subject: hi\r\n\r\nbody') })
  expect((await held).json.items.length).toBe(1)
  // two polls: the first answers empty at once
  const first = s.call(a, 'poll', { v: 1, ack: [], waitMs: 20_000 })
  await new Promise((r) => setTimeout(r, 20))
  const second = s.call(a, 'poll', { v: 1, ack: [], waitMs: 200 })
  const f = await first
  expect(f.json.items).toEqual([])
  await second
})

let dev: DevMailbox | null = null
afterEach(() => { dev?.stop(); dev = null })

test('the local dev mailbox: /dev/send runs the gateway, the API answers over HTTP on loopback', async () => {
  dev = startDevMailbox({ port: 0, domain: DOMAIN })
  expect(dev.url.startsWith('http://127.0.0.1:')).toBe(true)
  const a = team()
  const call = async (op: MailInOp, body: unknown) => {
    const text = JSON.stringify(body), ts = Date.now(), nonce = nodeCrypto.randomBytes(18).toString('base64url')
    const sig = nodeCrypto.sign(null, Buffer.from(mailInSigningString(MAIL_IN_PATHS[op], ts, nonce, sha(text))), a.key).toString('base64')
    return (await fetch(dev!.url + MAIL_IN_PATHS[op], { method: 'POST', headers: { authorization: mailInAuthorization(a.spki, ts, nonce, sig) }, body: text })).json() as any
  }
  await call('key', { v: 1, sealKey: a.sealKey })
  const addr = local()
  await call('sync', { v: 1, hashes: [sha(addr)] })
  const sent = await (await fetch(dev.url + '/dev/send', { method: 'POST', body: JSON.stringify({ to: `${addr}@${DOMAIN}`, raw: 'Subject: local\r\n\r\nhi' }) })).json() as any
  expect(sent.accepted).toBe(true)
  expect((await (await fetch(dev.url + '/dev/send', { method: 'POST', body: JSON.stringify({ to: `${local()}@${DOMAIN}`, raw: 'x' }) })).json() as any).accepted).toBe(false)
  const p = await call('poll', { v: 1, ack: [], waitMs: 0 })
  expect(p.items.length).toBe(1)
})
