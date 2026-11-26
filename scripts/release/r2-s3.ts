// A large file into the release bucket through R2's S3 API, in parts (a qcow2 template is gigabytes; the Cloudflare
// REST API that cloudflare.ts uses is for small objects). No second secret: R2 takes an API token as S3 credentials,
// access key id = the token's id, secret = sha256 hex of the token value (Cloudflare R2 docs "S3 API tokens"). The
// token is the same CLOUDFLARE_API_TOKEN (Workers R2 Storage Edit); it is never printed.
import fs from 'node:fs'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { apiToken, Cloudflare } from './cloudflare'
import { sha256Hex, signV4, type AwsCreds } from './sigv4'

/** 100 MiB parts: R2 wants equal parts (the last one smaller), each 5 MiB to 5 GiB, at most 10 000 */
export const PART_BYTES = 100 * 1024 * 1024

export interface S3Target { endpoint: string; bucket: string; creds: AwsCreds; fetch?: typeof fetch; partBytes?: number; log?: (l: string) => void }

/** The S3 credentials of the API token (its id from Cloudflare's verify call: a user token or an account token). */
export async function r2Target(cf = new Cloudflare(), token = apiToken()): Promise<S3Target> {
  const { account } = await cf.accountAndZone()
  let id: string | undefined
  for (const p of ['/user/tokens/verify', `/accounts/${account}/tokens/verify`]) {
    try { id = (await cf.json<{ id?: string }>('GET', p)).id } catch { id = undefined }
    if (id) break
  }
  if (!id) throw new Error('the Cloudflare token\'s id is not readable (tokens/verify): no S3 credentials for R2')
  return { endpoint: `https://${account}.r2.cloudflarestorage.com`, bucket: RELEASE_CHANNEL.hosting.bucket, creds: { accessKeyId: id, secretAccessKey: sha256Hex(token) } }
}

const xmlTag = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]

/** multipart upload of one file to one key; a failed upload is aborted (no parts left behind) */
export async function putLarge(t: S3Target, key: string, file: string, contentType: string): Promise<void> {
  const f = t.fetch ?? fetch
  const log = t.log ?? console.log
  const part = t.partBytes ?? PART_BYTES
  const url = (q: string) => `${t.endpoint}/${t.bucket}/${key.split('/').map(encodeURIComponent).join('/')}${q}`
  const call = async (method: string, u: string, body?: BodyInit, headers: Record<string, string> = {}, payloadHash?: string): Promise<Response> => {
    for (let n = 1; ; n++) {
      let r: Response | null = null
      try { r = await f(u, { method, body, headers: { ...headers, ...signV4({ method, url: u, region: 'auto', service: 's3', creds: t.creds, headers, payloadHash }) }, signal: AbortSignal.timeout(30 * 60_000) }) } catch (e) { if (n >= 5) throw e }
      if (r?.ok) return r
      if (r && r.status !== 429 && r.status < 500) throw new Error(`${method} ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
      if (n >= 5) throw new Error(`${method} ${key}: ${r ? `HTTP ${r.status}` : 'no answer'} after ${n} tries`)
      await Bun.sleep(2000 * 2 ** (n - 1))
    }
  }
  const size = fs.statSync(file).size
  const init = await (await call('POST', url('?uploads='), undefined, { 'content-type': contentType })).text()
  const uploadId = xmlTag(init, 'UploadId')
  if (!uploadId) throw new Error(`${key}: no UploadId in the answer`)
  const q = (n?: number) => `?${n ? `partNumber=${n}&` : ''}uploadId=${encodeURIComponent(uploadId)}`
  try {
    const etags: string[] = []
    for (let n = 1, pos = 0; pos < size || n === 1; n++, pos += part) {
      const end = Math.min(size, pos + part)
      const r = await call('PUT', url(q(n)), Bun.file(file).slice(pos, end), {}, 'UNSIGNED-PAYLOAD')
      const etag = r.headers.get('etag')
      if (!etag) throw new Error(`${key}: part ${n} has no ETag`)
      etags.push(etag)
      if (n % 5 === 0 || end === size) log(`${key}: ${end} of ${size} bytes`)
      if (end === size) break
    }
    const body = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
    const done = await (await call('POST', url(q()), body, { 'content-type': 'application/xml' }, sha256Hex(body))).text()
    if (/<Error>/.test(done)) throw new Error(`${key}: complete failed: ${done.slice(0, 300)}`)
  } catch (e) {
    await f(url(q()), { method: 'DELETE', headers: signV4({ method: 'DELETE', url: url(q()), region: 'auto', service: 's3', creds: t.creds }) }).catch(() => undefined)
    throw e
  }
}
