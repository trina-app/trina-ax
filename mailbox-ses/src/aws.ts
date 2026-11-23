// A small AWS client for the mailbox on AWS (mailbox-ses): Signature Version 4 over fetch, with the Lambda role's
// credentials from the environment. No AWS SDK: the bundle stays small and the repository gets no new dependency.
// Only what mailbox-ses calls: DynamoDB and SSM (JSON APIs) and S3 (GET and DELETE of one object).
import nodeCrypto from 'node:crypto'

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface AwsRequest {
  method: string
  service: string
  region: string
  host: string
  /** the path as it is sent (each segment already URI-encoded) */
  path: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

const sha256Hex = (d: string | Uint8Array) => nodeCrypto.createHash('sha256').update(d).digest('hex')
const hmac = (key: string | Buffer, d: string) => nodeCrypto.createHmac('sha256', key).update(d, 'utf8').digest()

/** RFC 3986 encoding of one path segment, as SigV4 and S3 want it. */
export const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The headers that sign `r` at `date` (SigV4, no query string). Returns every header to send, `authorization` too. */
export function signV4(r: AwsRequest, creds: AwsCredentials, date: Date, query = ''): Record<string, string> {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const body = r.body ?? ''
  const payloadHash = sha256Hex(body)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v
  headers.host = r.host
  headers['x-amz-date'] = amzDate
  if (r.service === 's3') headers['x-amz-content-sha256'] = payloadHash
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('')
  const signed = names.join(';')
  const canonical = [r.method, r.path, query, canonicalHeaders, signed, payloadHash].join('\n')
  const scope = `${day}/${r.region}/${r.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, day)
  const kSigning = hmac(hmac(hmac(kDate, r.region), r.service), 'aws4_request')
  const sig = nodeCrypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`
  return headers
}

/** The Lambda role's credentials (the runtime sets these variables). */
export function envCredentials(env: Record<string, string | undefined> = process.env): AwsCredentials {
  const accessKeyId = env.AWS_ACCESS_KEY_ID, secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) throw new Error('no AWS credentials in the environment')
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface Aws {
  /** a JSON API call (DynamoDB: x-amz-json-1.0, SSM: x-amz-json-1.1); throws with the error type only */
  json(service: 'dynamodb' | 'ssm', target: string, body: unknown): Promise<any>
  /** S3 GET of one object: null when it does not exist; `bytes` null (not read) when it is larger than `max` */
  s3Get(bucket: string, key: string, max: number): Promise<{ size: number; bytes: Uint8Array | null } | null>
  s3Delete(bucket: string, key: string): Promise<void>
}

/** DynamoDB and SSM answers to try again (with backoff): throttling, and faults of the service. */
const RETRY_TYPES = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'InternalServerError', 'ServiceUnavailable', 'ThrottledException'])
export const RETRY_ATTEMPTS = 8

export function awsClient(o: { region: string; credentials: () => AwsCredentials; fetch?: Fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> }): Aws {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i))
  const now = o.now ?? (() => new Date())
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const send = (r: AwsRequest) => f(`https://${r.host}${r.path}`, { method: r.method, headers: signV4(r, o.credentials(), now()), body: r.body as BodyInit | undefined })
  return {
    async json(service, target, body) {
      const host = `${service}.${o.region}.amazonaws.com`
      const prefix = service === 'dynamodb' ? 'DynamoDB_20120810' : 'AmazonSSM'
      const ctype = service === 'dynamodb' ? 'application/x-amz-json-1.0' : 'application/x-amz-json-1.1'
      const payload = JSON.stringify(body)
      for (let attempt = 1; ; attempt++) {
        const r = await send({ method: 'POST', service, region: o.region, host, path: '/', headers: { 'content-type': ctype, 'x-amz-target': `${prefix}.${target}` }, body: payload })
        const text = await r.text()
        if (r.ok) return text ? JSON.parse(text) : {}
        let type = 'unknown'
        try { type = String((JSON.parse(text) as { __type?: string }).__type ?? 'unknown').split('#').pop()! } catch { /* not JSON */ }
        // a new on-demand table takes a burst of 300 KB chunks slowly at first: wait and try again
        if (attempt < RETRY_ATTEMPTS && (RETRY_TYPES.has(type) || r.status >= 500)) {
          await sleep(Math.min(4000, 100 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2))
          continue
        }
        throw new Error(`${service} ${target}: ${r.status} ${type}`)
      }
    },
    async s3Get(bucket, key, max) {
      const host = `${bucket}.s3.${o.region}.amazonaws.com`
      const path = '/' + key.split('/').map(encodeSegment).join('/')
      const r = await send({ method: 'GET', service: 's3', region: o.region, host, path })
      if (r.status === 404) { await r.body?.cancel(); return null }
      if (!r.ok) { await r.body?.cancel(); throw new Error(`s3 GetObject: ${r.status}`) }
      const size = Number(r.headers.get('content-length') ?? NaN)
      if (Number.isFinite(size) && size > max) { await r.body?.cancel(); return { size, bytes: null } }
      const bytes = new Uint8Array(await r.arrayBuffer())
      return bytes.length > max ? { size: bytes.length, bytes: null } : { size: bytes.length, bytes }
    },
    async s3Delete(bucket, key) {
      const host = `${bucket}.s3.${o.region}.amazonaws.com`
      const path = '/' + key.split('/').map(encodeSegment).join('/')
      const r = await send({ method: 'DELETE', service: 's3', region: o.region, host, path })
      await r.body?.cancel()
      if (!r.ok && r.status !== 404) throw new Error(`s3 DeleteObject: ${r.status}`)
    },
  }
}
