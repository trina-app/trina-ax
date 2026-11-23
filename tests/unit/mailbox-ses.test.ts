// The mailbox on AWS (mailbox-ses): the SigV4 signer against AWS's published example, the DynamoDB key-value store
// (over an in-memory fake of the DynamoDB JSON API, with pagination and the 400 KB item limit), the SES gateway
// (recipients, unknown address, too big, virus, a retried invocation, the S3 object deleted), the API on a function
// URL event, the held poll that sees mail queued by another process, and the registry lookup with its cache.
import { expect, test } from 'bun:test'
import nodeCrypto, { type KeyObject } from 'node:crypto'
import { MAIL_IN_PATHS, MAIL_IN_RAW_MAX, mailInAuthorization, mailInSealAad, mailInSigningString, type MailInOp } from '../../shared/src/cloud-protocol/mail-in'
import { Waiters, type MailboxDeps } from '../../mailbox/src/deps'
import { nodeMailCrypto, nodeOpenSealed } from '../../mailbox/src/node-crypto'
import { MailStore } from '../../mailbox/src/store'
import { RETRY_ATTEMPTS, awsClient, signV4, type Aws } from '../../mailbox-ses/src/aws'
import { DYNAMO_CHUNK, DynamoKv, expiryOf, partitionOf } from '../../mailbox-ses/src/dynamo-kv'
import { PollingWaiters, SES_AUTHSERV_ID, cpTeams, handleSesEvent, handleUrlEvent, type SesEvent } from '../../mailbox-ses/src/handlers'

const DOMAIN = 'in.example'
const sha = (s: string) => nodeCrypto.createHash('sha256').update(s).digest('hex')
const local = () => Array.from(nodeCrypto.randomBytes(26), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('')

test('SigV4: the signature of AWS\'s published example (IAM ListUsers, 2015-08-30)', () => {
  const h = signV4({
    method: 'GET', service: 'iam', region: 'us-east-1', host: 'iam.amazonaws.com', path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, new Date('2015-08-30T12:36:00Z'), 'Action=ListUsers&Version=2010-05-08')
  expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
  // S3 signs the payload hash header; a session token is signed too
  const s3 = signV4({ method: 'GET', service: 's3', region: 'us-east-1', host: 'b.s3.us-east-1.amazonaws.com', path: '/raw/x' }, { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' }, new Date())
  expect(s3.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token')
})

/** An in-memory DynamoDB (the calls DynamoKv makes), with a small page size and the item size limit. */
function fakeDynamo(pageSize = 3) {
  const rows = new Map<string, { pk: string; sk: string; item: Record<string, any> }>()
  const id = (k: any) => `${k.pk.S}\u0000${k.sk.S}`
  let biggest = 0
  const aws: Aws = {
    async json(service, target, b) {
      expect(service).toBe('dynamodb')
      switch (target) {
        case 'GetItem': return rows.has(id(b.Key)) ? { Item: rows.get(id(b.Key))!.item } : {}
        case 'PutItem': {
          const size = JSON.stringify(b.Item).length
          if (size > 400_000) throw new Error('dynamodb PutItem: 400 ValidationException')
          biggest = Math.max(biggest, size)
          rows.set(id(b.Item), { pk: b.Item.pk.S, sk: b.Item.sk.S, item: b.Item })
          return {}
        }
        case 'DeleteItem': { const old = rows.get(id(b.Key)); rows.delete(id(b.Key)); return old ? { Attributes: old.item } : {} }
        case 'Query': {
          const p = b.ExpressionAttributeValues[':p'].S, s = b.ExpressionAttributeValues[':s'].S
          const all = [...rows.values()].filter((r) => r.pk === p && r.sk.startsWith(s)).sort((x, y) => (x.sk < y.sk ? -1 : 1))
          const from = b.ExclusiveStartKey ? all.findIndex((r) => r.sk === b.ExclusiveStartKey.sk.S) + 1 : 0
          const page = all.slice(from, from + pageSize)
          return { Items: page.map((r) => r.item), ...(from + pageSize < all.length ? { LastEvaluatedKey: { pk: { S: p }, sk: { S: page.at(-1)!.sk } } } : {}) }
        }
      }
      throw new Error(`unexpected ${target}`)
    },
    async s3Get() { throw new Error('no') },
    async s3Delete() { throw new Error('no') },
  }
  return { aws, rows, biggest: () => biggest }
}

test('AWS JSON calls: throttling and faults are tried again with backoff, other errors are not', async () => {
  const statuses: [number, string][] = [[400, 'com.amazonaws.dynamodb.v20120810#ThrottlingException'], [500, 'InternalServerError'], [200, '']]
  let calls = 0
  const waits: number[] = []
  const aws = awsClient({
    region: 'us-east-1', credentials: () => ({ accessKeyId: 'A', secretAccessKey: 'S' }), sleep: async (ms) => { waits.push(ms) },
    fetch: async () => { const [st, type] = statuses[calls++]!; return new Response(st === 200 ? '{"ok":1}' : JSON.stringify({ __type: type }), { status: st }) },
  })
  expect(await aws.json('dynamodb', 'PutItem', {})).toEqual({ ok: 1 })
  expect(calls).toBe(3)
  expect(waits.length).toBe(2)
  const bad = awsClient({ region: 'us-east-1', credentials: () => ({ accessKeyId: 'A', secretAccessKey: 'S' }), sleep: async () => {}, fetch: async () => new Response('{"__type":"x#ValidationException"}', { status: 400 }) })
  await expect(bad.json('dynamodb', 'PutItem', {})).rejects.toThrow('400 ValidationException')
  let n = 0
  const always = awsClient({ region: 'us-east-1', credentials: () => ({ accessKeyId: 'A', secretAccessKey: 'S' }), sleep: async () => {}, fetch: async () => { n++; return new Response('{"__type":"ThrottlingException"}', { status: 400 }) } })
  await expect(always.json('dynamodb', 'PutItem', {})).rejects.toThrow('ThrottlingException')
  expect(n).toBe(RETRY_ATTEMPTS)
})

test('DynamoKv: partitions, expiry, get/put/delete, list in key order across pages', async () => {
  expect(partitionOf('t:team-a')).toBe('t')
  expect(partitionOf('q:team-a:000000000000001:id')).toBe('q:team-a')
  expect(partitionOf('q:team-a:')).toBe('q:team-a')
  expect(partitionOf('b:team-a:id:0')).toBe('b:team-a:id:0')
  expect(() => partitionOf('b:team-a:')).toThrow()
  expect(() => partitionOf('q:')).toThrow()
  expect(expiryOf('t:x', {}, 0)).toBeNull()
  expect(expiryOf('h:x', 'team', 0)).toBeNull()
  expect(expiryOf('n:k:nonce', 120_000, 0)).toBe(180)
  expect(expiryOf('q:t:1:id', {}, 0)).toBe(26 * 3600)
  const d = fakeDynamo(2)
  const kv = new DynamoKv(d.aws, 'tbl', () => 0)
  await kv.put('c:b', 2); await kv.put('c:a', 1); await kv.put('c:c', 3); await kv.put('n:x', 5000)
  expect(await kv.get('c:a')).toBe(1)
  expect(await kv.get('c:zz')).toBeUndefined()
  expect([...(await kv.list({ prefix: 'c:' })).entries()]).toEqual([['c:a', 1], ['c:b', 2], ['c:c', 3]])
  expect(await kv.delete('c:b')).toBe(true)
  expect(await kv.delete('c:b')).toBe(false)
  expect(d.rows.get('n\u0000n:x')!.item.x).toEqual({ N: '65' })
  expect(d.rows.get('c\u0000c:a')!.item.x).toEqual({ N: String(72 * 3600) })
})

interface Team { key: KeyObject; spki: string; sealPriv: KeyObject; sealKey: string }
function team(): Team {
  const { privateKey } = nodeCrypto.generateKeyPairSync('ed25519')
  const spki = (nodeCrypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')
  const x = nodeCrypto.generateKeyPairSync('x25519')
  const sealKey = (x.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
  return { key: privateKey, spki, sealPriv: x.privateKey, sealKey }
}

/** Two processes over one table, as on AWS: the API (PollingWaiters) and the gateway (its own Waiters). */
function setup() {
  const d = fakeDynamo(5)
  const kv = new DynamoKv(d.aws, 'tbl')
  const store = new MailStore(kv, { chunk: DYNAMO_CHUNK })
  const served = new Map<string, string>()
  const logs: [string, Record<string, string | number>][] = []
  const base = { store, crypto: nodeMailCrypto, domain: DOMAIN, now: () => Date.now(), authServId: SES_AUTHSERV_ID, log: (e: string, f: Record<string, string | number>) => { logs.push([e, f]) } }
  const api: MailboxDeps = { ...base, teams: async (k) => served.get(k) ?? null, waiters: new PollingWaiters((t) => store.ready(t, Date.now()), 20) }
  const gw: MailboxDeps = { ...base, teams: async () => null, waiters: new Waiters() }
  const objects = new Map<string, Uint8Array>()
  const deleted: string[] = []
  const s3 = {
    async get(key: string, max: number) { const b = objects.get(key); return b ? (b.length > max ? { size: b.length, bytes: null } : { size: b.length, bytes: b }) : null },
    async delete(key: string) { deleted.push(key); objects.delete(key) },
  }
  const call = async (who: Team, op: MailInOp, body: unknown) => {
    const text = JSON.stringify(body)
    const path = MAIL_IN_PATHS[op], ts = Date.now(), nonce = nodeCrypto.randomBytes(18).toString('base64url')
    const sig = nodeCrypto.sign(null, Buffer.from(mailInSigningString(path, ts, nonce, sha(text))), who.key).toString('base64')
    // a function URL event: lower-case headers, the body in base64
    const r = await handleUrlEvent(api, { rawPath: path, requestContext: { http: { method: 'POST' } }, headers: { authorization: mailInAuthorization(who.spki, ts, nonce, sig), 'content-type': 'application/json' }, body: Buffer.from(text).toString('base64'), isBase64Encoded: true })
    return { status: r.status, json: await r.json() as any }
  }
  const sesEvent = (messageId: string, recipients: string[], virus = 'PASS'): SesEvent => ({ Records: [{ ses: { mail: { messageId, source: 'bounce@forwarder.example' }, receipt: { recipients, virusVerdict: { status: virus } } } }] })
  const gateway = (ev: SesEvent) => handleSesEvent({ deps: gw, kv, s3, prefix: 'raw/' }, ev)
  return { d, store, served, logs, objects, deleted, call, sesEvent, gateway }
}

test('SES gateway → DynamoDB → API: recipients, unknown, too big, virus, retried once, S3 object deleted, held poll wakes', async () => {
  const s = setup()
  const a = team()
  s.served.set(a.spki, 'team-a')
  const addr = local()
  expect((await s.call(a, 'key', { v: 1, sealKey: a.sealKey })).status).toBe(200)
  expect((await s.call(a, 'sync', { v: 1, hashes: [sha(addr)] })).json).toEqual({ ok: true, addresses: 1 })

  // a held poll (another process) sees the mail the gateway queues
  const held = s.call(a, 'poll', { v: 1, ack: [], waitMs: 5000 })
  await Bun.sleep(60)
  // 1 MiB of body: several DynamoDB chunks, each under the item limit; SES's own Authentication-Results on top, a
  // forged one under it
  const body = 'x'.repeat(1024 * 1024)
  const raw = `Authentication-Results: amazonses.com;\r\n spf=pass (spfCheck: ok) smtp.mailfrom=shop.example;\r\n dkim=pass header.i=@shop.example;\r\n dmarc=pass header.from=shop.example;\r\nAuthentication-Results: amazonses.com; spf=fail\r\nFrom: Shop <s@shop.example>\r\nSubject: Order\r\n\r\n${body}`
  s.objects.set('raw/msg1', new TextEncoder().encode(raw))
  const started = Date.now()
  await s.gateway(s.sesEvent('msg1', [`${addr}@${DOMAIN}`, `${local()}@${DOMAIN}`, `someone@other.example`]))
  const got = await held
  expect(Date.now() - started).toBeLessThan(2000)
  expect(got.json.items.length).toBe(1)
  expect(s.d.biggest()).toBeLessThan(400_000)
  expect(s.deleted).toEqual(['raw/msg1'])
  expect(s.logs.filter(([e]) => e === 'mail_refused').map(([, f]) => f.reason)).toEqual(['unknown', 'unknown'])
  const item = got.json.items[0]
  const plain = nodeOpenSealed(item.sealed, a.sealPriv, mailInSealAad(item.id, item.hash, item.receivedAt))
  const nl = plain.indexOf(0x0a)
  const meta = JSON.parse(plain.subarray(0, nl).toString())
  expect(meta.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
  expect(meta.envelopeFrom).toBe('bounce@forwarder.example')
  const msg = plain.subarray(nl + 1).toString()
  expect(msg).not.toContain('Authentication-Results')
  expect(msg.endsWith(body)).toBe(true)

  // the same SES invocation again (Lambda retries): nothing queued twice
  s.objects.set('raw/msg1', new TextEncoder().encode(raw))
  await s.gateway(s.sesEvent('msg1', [`${addr}@${DOMAIN}`]))
  expect((await s.call(a, 'poll', { v: 1, ack: [item.id], waitMs: 0 })).json.items).toEqual([])

  // too big: dropped without reading it; a virus: dropped; a missing object: nothing
  s.objects.set('raw/big', new Uint8Array(MAIL_IN_RAW_MAX + 1))
  await s.gateway(s.sesEvent('big', [`${addr}@${DOMAIN}`]))
  s.objects.set('raw/vir', new TextEncoder().encode('Subject: x\r\n\r\nx'))
  await s.gateway(s.sesEvent('vir', [`${addr}@${DOMAIN}`], 'FAIL'))
  await s.gateway(s.sesEvent('gone', [`${addr}@${DOMAIN}`]))
  expect(s.logs.filter(([e]) => e === 'mail_refused').map(([, f]) => f.reason).slice(2)).toEqual(['too_big', 'virus', 'no_object'])
  expect(s.objects.size).toBe(0)
  expect((await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })).json.items).toEqual([])

  // a new address (rotation): the old one is refused from then on
  const next = local()
  await s.call(a, 'sync', { v: 1, hashes: [sha(next)] })
  s.objects.set('raw/old', new TextEncoder().encode('Subject: x\r\n\r\nx'))
  s.objects.set('raw/new', new TextEncoder().encode('Subject: y\r\n\r\ny'))
  await s.gateway(s.sesEvent('old', [`${addr}@${DOMAIN}`]))
  await s.gateway(s.sesEvent('new', [`${next.toUpperCase()}@${DOMAIN.toUpperCase()}`]))
  const after = (await s.call(a, 'poll', { v: 1, ack: [], waitMs: 0 })).json.items
  expect(after.map((i: any) => i.hash)).toEqual([sha(next)])
  // a held poll with nothing waiting ends after waitMs
  const t0 = Date.now()
  expect((await s.call(a, 'poll', { v: 1, ack: [after[0].id], waitMs: 300 })).json.items).toEqual([])
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
})

test('registry lookup: served, not served, cached, a fault throws, a bad answer throws', async () => {
  let t = 0, calls = 0
  const answers: (() => Response)[] = []
  const lookup = cpTeams({
    url: 'https://cp.example/internal/mail-in/team', token: async () => 'tok', now: () => t,
    fetch: async (_u, i) => { calls++; expect((i.headers as Record<string, string>).authorization).toBe('Bearer tok'); return answers.shift()!() },
  })
  answers.push(() => Response.json({ teamId: 'team-01a2' }))
  expect(await lookup('k1')).toBe('team-01a2')
  expect(await lookup('k1')).toBe('team-01a2')
  expect(calls).toBe(1)
  answers.push(() => new Response('', { status: 404 }))
  expect(await lookup('k2')).toBeNull()
  t += 61_000
  answers.push(() => new Response('', { status: 500 }))
  await expect(lookup('k2')).rejects.toThrow('registry: 500')
  answers.push(() => Response.json({ teamId: 'a:b' }))
  await expect(lookup('k3')).rejects.toThrow('bad answer')
  t += 300_000
  answers.push(() => new Response('', { status: 404 }))
  expect(await lookup('k1')).toBeNull()
})
