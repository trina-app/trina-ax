// The mail gateway (mailbox/src/gateway.ts, contract shared/src/cloud-protocol/mail-in.ts): every SMTP refusal, the
// authentication headers removed (folded lines too, the top-level block only), the receiving service's own verdict,
// the seal opened as the contract says (the associated data binds id, hash and time), limits, a full queue, and a
// replaced address refused at once.
import { expect, test } from 'bun:test'
import nodeCrypto from 'node:crypto'
import {
  MAIL_IN_PER_ADDRESS_HOUR, MAIL_IN_PER_TEAM_DAY, MAIL_IN_QUEUE_MAX_ITEMS, MAIL_IN_RAW_MAX, MAIL_IN_SMTP, mailInSealAad, parseMailInItem, parseMailInMeta,
} from '../../shared/src/cloud-protocol/mail-in'
import { Waiters, type MailboxDeps } from '../../mailbox/src/deps'
import { authVerdict, counterIsOld, handleEmail, headerEnd, receiveMail, stripAuthHeaders } from '../../mailbox/src/gateway'
import { nodeMailCrypto, nodeOpenSealed } from '../../mailbox/src/node-crypto'
import { MailStore, MemoryKv } from '../../mailbox/src/store'

const DOMAIN = 'mail.example'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const sha = (s: string) => nodeCrypto.createHash('sha256').update(s).digest('hex')
const local = () => Array.from(nodeCrypto.randomBytes(26), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('')

async function setup(o: { now?: () => number } = {}) {
  let t = Date.parse('2026-11-23T10:00:00Z')
  const now = o.now ?? (() => t)
  const deps: MailboxDeps = { store: new MailStore(new MemoryKv()), crypto: nodeMailCrypto, domain: DOMAIN, teams: async () => 'team-a', now, waiters: new Waiters() }
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('x25519')
  const sealKey = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  await deps.store.setSealKey('team-a', sealKey)
  const addr = local()
  await deps.store.syncHashes('team-a', [sha(addr)])
  return { deps, privateKey, addr, to: `${addr}@${DOMAIN}`, move: (ms: number) => { t += ms } }
}
const mail = (to: string, raw = 'From: Shop <shop@example.com>\r\nSubject: Order\r\n\r\nHello') => ({ to, from: 'bounce@example.com', raw: enc(raw) })

test('a mail to a known address is sealed and queued; it opens with the team key and the contract AAD', async () => {
  const s = await setup()
  const r = await receiveMail(s.deps, mail(s.to, 'Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass\r\nFrom: Shop <shop@example.com>\r\nSubject: Order\r\n\r\nHello'))
  expect(r.accepted).toBe(true)
  const items = await s.deps.store.take('team-a', s.deps.now(), 60_000, 10, 1e9)
  expect(items.length).toBe(1)
  const item = parseMailInItem(items[0])!
  expect(item).not.toBeNull()
  expect(item.hash).toBe(sha(s.addr))
  const plain = nodeOpenSealed(item.sealed, s.privateKey, mailInSealAad(item.id, item.hash, item.receivedAt))
  const nl = plain.indexOf(0x0a)
  const meta = parseMailInMeta(JSON.parse(plain.subarray(0, nl).toString('utf8')))!
  expect(meta.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
  expect(meta.envelopeFrom).toBe('bounce@example.com')
  const raw = plain.subarray(nl + 1).toString('utf8')
  expect(raw).toBe('From: Shop <shop@example.com>\r\nSubject: Order\r\n\r\nHello')
  expect(meta.size).toBe(Buffer.byteLength(raw))
  // the associated data binds the item: another id, hash or time does not open
  expect(() => nodeOpenSealed(item.sealed, s.privateKey, mailInSealAad('x'.repeat(24), item.hash, item.receivedAt))).toThrow()
  expect(() => nodeOpenSealed(item.sealed, s.privateKey, mailInSealAad(item.id, sha('other'), item.receivedAt))).toThrow()
  expect(() => nodeOpenSealed(item.sealed, s.privateKey, mailInSealAad(item.id, item.hash, new Date(0).toISOString()))).toThrow()
  // another team's key does not open
  const other = nodeCrypto.generateKeyPairSync('x25519').privateKey
  expect(() => nodeOpenSealed(item.sealed, other, mailInSealAad(item.id, item.hash, item.receivedAt))).toThrow()
})

test('unknown recipients get 550: wrong domain, wrong shape, unknown hash, a +tag, no seal key', async () => {
  const s = await setup()
  for (const to of [`${s.addr}@other.example`, `short@${DOMAIN}`, `${local()}@${DOMAIN}`, `${s.addr}+x@${DOMAIN}`, 'no-at-sign']) {
    const r = await receiveMail(s.deps, mail(to))
    expect(r).toEqual({ accepted: false, reason: 'unknown', smtp: MAIL_IN_SMTP.unknown })
  }
  // upper case is the same address
  expect((await receiveMail(s.deps, mail(`${s.addr.toUpperCase()}@${DOMAIN.toUpperCase()}`))).accepted).toBe(true)
  // a team without a seal key
  const addr2 = local()
  await s.deps.store.syncHashes('team-b', [sha(addr2)])
  expect((await receiveMail(s.deps, mail(`${addr2}@${DOMAIN}`))).accepted).toBe(false)
  // no domain configured
  expect((await receiveMail({ ...s.deps, domain: null }, mail(s.to))).accepted).toBe(false)
})

test('a replaced address is refused at once; queued items stay', async () => {
  const s = await setup()
  expect((await receiveMail(s.deps, mail(s.to))).accepted).toBe(true)
  const next = local()
  await s.deps.store.syncHashes('team-a', [sha(next)])
  expect(await receiveMail(s.deps, mail(s.to))).toMatchObject({ accepted: false, smtp: MAIL_IN_SMTP.unknown })
  expect((await receiveMail(s.deps, mail(`${next}@${DOMAIN}`))).accepted).toBe(true)
  expect((await s.deps.store.queueStats('team-a')).items).toBe(2)
  // another team cannot take a hash a team holds
  expect(await s.deps.store.syncHashes('team-b', [sha(next)])).toEqual([])
  expect(await s.deps.store.teamOfHash(sha(next))).toBe('team-a')
  // an empty set stops all mail
  await s.deps.store.syncHashes('team-a', [])
  expect((await receiveMail(s.deps, mail(`${next}@${DOMAIN}`))).accepted).toBe(false)
})

test('too big: 552 by the reported size and by the bytes, before the bytes are read in the Worker', async () => {
  const s = await setup()
  expect(await receiveMail(s.deps, { ...mail(s.to), rawSize: MAIL_IN_RAW_MAX + 1 })).toMatchObject({ reason: 'too_big', smtp: MAIL_IN_SMTP.too_big })
  expect(await receiveMail(s.deps, { to: s.to, from: 'a@b', raw: new Uint8Array(MAIL_IN_RAW_MAX + 1) })).toMatchObject({ reason: 'too_big' })
  let rejected = ''
  let read = false
  await handleEmail({
    from: 'a@b', to: s.to, rawSize: MAIL_IN_RAW_MAX + 1, setReject: (r) => { rejected = r },
    raw: new ReadableStream({ pull() { read = true } }, { highWaterMark: 0 }),
  }, async () => { throw new Error('not reached') })
  expect(rejected).toBe(MAIL_IN_SMTP.too_big)
  expect(read).toBe(false)
  // a stream longer than it said is cut and refused
  rejected = ''
  await handleEmail({
    from: 'a@b', to: s.to, rawSize: 10, setReject: (r) => { rejected = r },
    raw: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAIL_IN_RAW_MAX)); c.enqueue(new Uint8Array(10)); c.close() } }),
  }, async () => { throw new Error('not reached') })
  expect(rejected).toBe(MAIL_IN_SMTP.too_big)
  // an accepted one sets no reject
  rejected = ''
  await handleEmail({ from: 'a@b', to: s.to, rawSize: 5, setReject: (r) => { rejected = r }, raw: new ReadableStream({ start(c) { c.enqueue(enc('Subject: x\r\n\r\nhi')); c.close() } }) }, (m) => receiveMail(s.deps, m))
  expect(rejected).toBe('')
})

test('limits per address (hour) and per team (day): 451; a new hour lets the address in again', async () => {
  const s = await setup()
  for (let i = 0; i < MAIL_IN_PER_ADDRESS_HOUR; i++) expect((await receiveMail(s.deps, mail(s.to))).accepted).toBe(true)
  expect(await receiveMail(s.deps, mail(s.to))).toMatchObject({ accepted: false, reason: 'limited', smtp: MAIL_IN_SMTP.limited })
  s.move(3_600_000)
  expect((await receiveMail(s.deps, mail(s.to))).accepted).toBe(true)
  // the team's day: many addresses together
  const t = await setup()
  const addrs = Array.from({ length: Math.ceil(MAIL_IN_PER_TEAM_DAY / 50) + 1 }, local)
  await t.deps.store.syncHashes('team-a', addrs.map(sha))
  let n = 0, refused: unknown = null
  outer: for (const a of addrs) for (let i = 0; i < 50; i++) {
    const r = await receiveMail(t.deps, mail(`${a}@${DOMAIN}`, 'Subject: x\r\n\r\n.'))
    if (!r.accepted) { refused = r; break outer }
    n++
    // ack as it goes so the queue cap does not come first
    if (n % 500 === 0) { const got = await t.deps.store.take('team-a', t.deps.now(), 1, 1000, 1e12); await t.deps.store.ack('team-a', got.map((g) => g.id)) }
  }
  expect(n).toBe(MAIL_IN_PER_TEAM_DAY)
  expect(refused).toMatchObject({ reason: 'limited' })
}, 60_000)

test('a full queue: 452 until items are taken', async () => {
  const s = await setup()
  const addrs = Array.from({ length: Math.ceil(MAIL_IN_QUEUE_MAX_ITEMS / 50) }, local)
  await s.deps.store.syncHashes('team-a', addrs.map(sha))
  let n = 0
  for (const a of addrs) for (let i = 0; i < 50 && n < MAIL_IN_QUEUE_MAX_ITEMS; i++, n++) expect((await receiveMail(s.deps, mail(`${a}@${DOMAIN}`, 'Subject: x\r\n\r\n.'))).accepted).toBe(true)
  // the next day (the team's day limit is new; the items are 14 hours old, still kept)
  s.move(14 * 3_600_000)
  const extra = local()
  await s.deps.store.syncHashes('team-a', [...addrs.map(sha), sha(extra)])
  expect(await receiveMail(s.deps, mail(`${extra}@${DOMAIN}`))).toMatchObject({ accepted: false, reason: 'full', smtp: MAIL_IN_SMTP.full })
  const got = await s.deps.store.take('team-a', s.deps.now(), 60_000, 5, 1e12)
  await s.deps.store.ack('team-a', got.map((g) => g.id))
  expect((await receiveMail(s.deps, mail(`${extra}@${DOMAIN}`))).accepted).toBe(true)
}, 60_000)

test('authentication headers: every Authentication-Results and ARC-* field goes, folded lines too, body untouched', () => {
  const raw = [
    'Authentication-Results: mx.cloudflare.net;\r\n\tspf=pass smtp.mailfrom=shop.example;\r\n dkim=fail',
    'ARC-Seal: i=1; a=rsa-sha256; cv=none;\r\n  b=abc',
    'arc-message-signature: i=1; x',
    'From: Shop <shop@example.com>',
    'X-Note: keeps\r\n  its fold',
    'authentication-results: attacker.example; dmarc=pass',
    'Subject: Order',
    '',
    'Authentication-Results: in the body stays',
    'ARC-Seal: body too',
  ].join('\r\n')
  const out = stripAuthHeaders(enc(raw))
  expect(out.removed).toBe(4)
  expect(dec(out.raw)).toBe('From: Shop <shop@example.com>\r\nX-Note: keeps\r\n  its fold\r\nSubject: Order\r\n\r\nAuthentication-Results: in the body stays\r\nARC-Seal: body too')
  expect(out.removedAuth[0]).toBe('mx.cloudflare.net; spf=pass smtp.mailfrom=shop.example; dkim=fail')
  // the verdict: only the topmost header, only with the receiving service's authserv-id
  expect(authVerdict(out.removedAuth, 'mx.cloudflare.net')).toEqual({ spf: 'pass', dkim: 'fail' })
  expect(authVerdict(['attacker.example; dmarc=pass', 'mx.cloudflare.net; dmarc=fail'], 'mx.cloudflare.net')).toBeNull()
  expect(authVerdict([], 'mx.cloudflare.net')).toBeNull()
  // LF-only mail, 8-bit bytes kept exactly
  const lf = new Uint8Array([...enc('ARC-Seal: x\n y\nSubject: '), 0xc7, 0xd1, ...enc('\n\nbody '), 0xff])
  const o2 = stripAuthHeaders(lf)
  expect([...o2.raw]).toEqual([...enc('Subject: '), 0xc7, 0xd1, ...enc('\n\nbody '), 0xff])
  // no change: the same bytes
  const plain = enc('Subject: a\r\n\r\nb')
  expect(stripAuthHeaders(plain).raw).toBe(plain)
  expect(headerEnd(enc('\r\nbody'))).toBe(0)
  expect(headerEnd(enc('Subject: only'))).toBe(13)
})

test('old counters are pruned by window', () => {
  const now = Date.parse('2026-11-23T10:30:00Z')
  const h = Math.floor(now / 3_600_000), d = Math.floor(now / 86_400_000)
  expect(counterIsOld(`a:x:h:${h}`, now)).toBe(false)
  expect(counterIsOld(`a:x:h:${h - 1}`, now)).toBe(false)
  expect(counterIsOld(`a:x:h:${h - 2}`, now)).toBe(true)
  expect(counterIsOld(`t:x:d:${d - 1}`, now)).toBe(false)
  expect(counterIsOld(`t:x:b:${d - 2}`, now)).toBe(true)
})

test('logs never carry the address', async () => {
  const lines: string[] = []
  const s = await setup()
  s.deps.log = (e, f) => lines.push(e + JSON.stringify(f))
  await receiveMail(s.deps, mail(s.to))
  await receiveMail(s.deps, mail(`${local()}@${DOMAIN}`))
  expect(lines.length).toBe(2)
  for (const l of lines) expect(l).not.toContain(s.addr)
})
