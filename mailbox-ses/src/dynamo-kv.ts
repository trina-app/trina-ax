// The mailbox's key-value store (mailbox/src/store.ts KvLike) in one DynamoDB table, for mailbox-ses.
//
// Table: partition key `pk` (S), sort key `sk` (S) = the store's key, value `v` (S, JSON), expiry `x` (N, epoch
// seconds, DynamoDB TTL). The partition is what `list({ prefix })` reads: the first part of the key (`t`, `s`, `h`,
// `c`, `n`, `d`), and for queue heads also the team (`q:<team>`). A list is one Query with begins_with on `sk`, in key
// order, as MemoryKv answers it. A chunk of a sealed mail (`b:…`) is its own partition: the store reads and deletes
// chunks by key only, and one 10 MiB mail is about 47 chunks of 300 KB, more than one partition takes per second.
// Every read is strongly consistent: the gateway and the API are separate Lambda functions. Throttled writes are tried
// again with backoff (aws.ts).
//
// TTL is a backstop only (DynamoDB deletes within days, not at once): the store itself drops old nonces, counters and
// items. Queue items get 26 hours (the store expires them after 24), counters 3 days, nonces their own end, receipt
// marks (`d:`) 2 days. Team records, stats and address hashes have no TTL.
import type { KvLike } from '../../mailbox/src/store.ts'
import type { Aws } from './aws.ts'

/** The largest `ct` part per item: DynamoDB items are at most 400 KB (names and values together). */
export const DYNAMO_CHUNK = 300_000

const HOUR_S = 3600

/** The partition of a key, or of a list prefix (which always names the team for `q:`; chunks are never listed). */
export function partitionOf(key: string): string {
  const i = key.indexOf(':')
  if (i <= 0) throw new Error('a store key has a kind before ":"')
  const kind = key.slice(0, i)
  if (kind === 'b') {
    if (key.split(':').length !== 4) throw new Error('a chunk is read by its whole key, never listed')
    return key
  }
  if (kind !== 'q') return kind
  const j = key.indexOf(':', i + 1)
  if (j < 0) throw new Error('a queue key names its team')
  return key.slice(0, j)
}

/** When DynamoDB may delete the item (epoch seconds), or null for never. */
export function expiryOf(key: string, value: unknown, nowMs: number): number | null {
  const now = Math.floor(nowMs / 1000)
  switch (key.slice(0, key.indexOf(':'))) {
    case 'n': return typeof value === 'number' ? Math.ceil(value / 1000) + 60 : now + 2 * HOUR_S
    case 'c': return now + 72 * HOUR_S
    case 'q': case 'b': return now + 26 * HOUR_S
    case 'd': return now + 48 * HOUR_S
    default: return null
  }
}

export class DynamoKv implements KvLike {
  constructor(private aws: Aws, private table: string, private now: () => number = () => Date.now()) {}

  private keyOf(key: string) { return { pk: { S: partitionOf(key) }, sk: { S: key } } }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.aws.json('dynamodb', 'GetItem', { TableName: this.table, Key: this.keyOf(key), ConsistentRead: true })
    const v = r.Item?.v?.S
    return typeof v === 'string' ? JSON.parse(v) as T : undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    const item: Record<string, unknown> = { ...this.keyOf(key), v: { S: JSON.stringify(value) } }
    const x = expiryOf(key, value, this.now())
    if (x !== null) item.x = { N: String(x) }
    await this.aws.json('dynamodb', 'PutItem', { TableName: this.table, Item: item })
  }

  async delete(key: string): Promise<boolean> {
    const r = await this.aws.json('dynamodb', 'DeleteItem', { TableName: this.table, Key: this.keyOf(key), ReturnValues: 'ALL_OLD' })
    return !!r.Attributes
  }

  async list<T = unknown>(o: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>()
    let start: unknown
    do {
      const r = await this.aws.json('dynamodb', 'Query', {
        TableName: this.table, ConsistentRead: true,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': { S: partitionOf(o.prefix) }, ':s': { S: o.prefix } },
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
      for (const it of (r.Items ?? []) as { sk: { S: string }; v: { S: string } }[]) out.set(it.sk.S, JSON.parse(it.v.S) as T)
      start = r.LastEvaluatedKey
    } while (start)
    return out
  }
}
