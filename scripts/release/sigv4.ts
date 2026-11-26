// AWS Signature Version 4 for the few calls the image scripts make without the AWS CLI: the EBS direct APIs
// (scripts/image/snapshot-to-qcow2.ts reads an AMI's root snapshot) and the S3 API of Cloudflare R2
// (scripts/release/r2-s3.ts uploads a large file in parts). No SDK: one function, checked against the AWS test vector
// (tests/unit/image-qcow2.test.ts). The keys come from the caller and are never printed.
import crypto from 'node:crypto'

export interface AwsCreds { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

/** the credentials that aws-actions/configure-aws-credentials (or the owner's shell) puts in the environment */
export function envCreds(env: NodeJS.ProcessEnv = process.env): AwsCreds {
  const accessKeyId = env.AWS_ACCESS_KEY_ID, secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) throw new Error('no AWS credentials in the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)')
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined }
}

const hmac = (key: string | Buffer, s: string) => crypto.createHmac('sha256', key).update(s).digest()
export const sha256Hex = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')
/** RFC 3986: what SigV4 wants in the path and the query */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface SignInput {
  method: string
  url: string
  region: string
  service: string
  creds: AwsCreds
  headers?: Record<string, string>
  /** the sha256 hex of the body, or 'UNSIGNED-PAYLOAD' (S3 only); default: the hash of an empty body */
  payloadHash?: string
  /** for a test: the time of the signature */
  now?: Date
}

/** The headers to send (the given ones + host, x-amz-date, x-amz-content-sha256 for s3, the token, authorization). */
export function signV4(i: SignInput): Record<string, string> {
  const u = new URL(i.url)
  const now = i.now ?? new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const payloadHash = i.payloadHash ?? sha256Hex('')
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.headers ?? {})) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ')
  h.host = u.host
  h['x-amz-date'] = amzDate
  if (i.service === 's3') h['x-amz-content-sha256'] = payloadHash
  if (i.creds.sessionToken) h['x-amz-security-token'] = i.creds.sessionToken
  const names = Object.keys(h).sort()
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('')
  const signedHeaders = names.join(';')
  // S3 takes the path as it is (encoded once); the other services want each segment encoded again
  const p = u.pathname || '/'
  const canonicalPath = i.service === 's3' ? p : p.split('/').map((s) => enc(decodeURIComponent(s))).join('/')
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')
  const canonical = [i.method.toUpperCase(), canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${day}/${i.region}/${i.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
  const kDate = hmac(`AWS4${i.creds.secretAccessKey}`, day)
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex')
  const out: Record<string, string> = { ...h }
  delete out.host // fetch sets it
  out.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return out
}
