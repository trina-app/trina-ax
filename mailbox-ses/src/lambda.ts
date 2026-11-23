// The Lambda entries of the mailbox on AWS (mailbox-ses/README.md). One bundle, two handlers:
//   index.gateway  the SES receipt rule's Lambda action (asynchronous)
//   index.api      the function URL (invoke mode RESPONSE_STREAM: a poll answer can hold one sealed 10 MiB mail,
//                  about 14 MB, over the 6 MB of a buffered answer)
// Environment: MAIL_DOMAIN, TABLE, BUCKET, RAW_PREFIX (gateway), CP_TEAMS_URL and CP_TOKEN_PARAM (api; the SSM
// SecureString with the bearer token of the hosting service's registry). AWS_REGION and the credentials come from
// the runtime. Logs: JSON lines with an event name, a hash prefix and a reason only.
import { MailStore } from '../../mailbox/src/store.ts'
import { Waiters, type MailboxDeps } from '../../mailbox/src/deps.ts'
import { nodeMailCrypto } from '../../mailbox/src/node-crypto.ts'
import { awsClient, envCredentials } from './aws.ts'
import { DYNAMO_CHUNK, DynamoKv } from './dynamo-kv.ts'
import { PollingWaiters, SES_AUTHSERV_ID, cpTeams, handleSesEvent, handleUrlEvent, type SesEvent, type UrlEvent } from './handlers.ts'

const env = process.env
const need = (name: string) => { const v = env[name]?.trim(); if (!v) throw new Error(`${name} is not set`); return v }
const log = (event: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ event, ...fields }))

const aws = awsClient({ region: need('AWS_REGION'), credentials: () => envCredentials() })
const kv = new DynamoKv(aws, need('TABLE'))
const store = new MailStore(kv, { chunk: DYNAMO_CHUNK })
const domain = env.MAIL_DOMAIN?.trim().toLowerCase() || null

let token: Promise<string> | null = null
const cpToken = () => {
  token ??= aws.json('ssm', 'GetParameter', { Name: need('CP_TOKEN_PARAM'), WithDecryption: true })
    .then((r) => { const v = String(r.Parameter?.Value ?? '').trim(); if (!v) throw new Error('empty registry token'); return v })
    .catch((e) => { token = null; throw e })
  return token
}

const base = { store, crypto: nodeMailCrypto, domain, now: () => Date.now(), authServId: SES_AUTHSERV_ID, log }

export async function gateway(event: SesEvent): Promise<void> {
  const deps: MailboxDeps = { ...base, teams: async () => null, waiters: new Waiters() }
  const bucket = need('BUCKET')
  await handleSesEvent({ deps, kv, prefix: env.RAW_PREFIX ?? 'raw/', s3: { get: (k, max) => aws.s3Get(bucket, k, max), delete: (k) => aws.s3Delete(bucket, k) } }, event)
}

let apiDeps: MailboxDeps | null = null
const getApiDeps = () => apiDeps ??= {
  ...base,
  teams: cpTeams({ url: need('CP_TEAMS_URL'), token: cpToken }),
  waiters: new PollingWaiters((teamId) => store.ready(teamId, Date.now())),
}

interface ResponseStream { write(b: Uint8Array): boolean; end(cb?: () => void): void; on(e: string, f: (...a: unknown[]) => void): void }
declare const awslambda: {
  streamifyResponse(f: (event: UrlEvent, stream: ResponseStream) => Promise<void>): unknown
  HttpResponseStream: { from(s: ResponseStream, meta: { statusCode: number; headers: Record<string, string> }): ResponseStream }
}

async function serve(event: UrlEvent, stream: ResponseStream) {
  let res: Response
  try { res = await handleUrlEvent(getApiDeps(), event) } catch (e) {
    log('api_fault', { reason: String((e as Error)?.message ?? e).slice(0, 120) })
    res = new Response('{"error":{"code":"unavailable","message":"Try again later."}}', { status: 502, headers: { 'content-type': 'application/json' } })
  }
  const body = new Uint8Array(await res.arrayBuffer())
  const out = awslambda.HttpResponseStream.from(stream, { statusCode: res.status, headers: Object.fromEntries(res.headers) })
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    for (let i = 0; i < body.length; i += 1 << 20) out.write(body.subarray(i, i + (1 << 20)))
    out.end(() => resolve())
  })
}

export const api = typeof awslambda === 'undefined' ? serve : awslambda.streamifyResponse(serve)
