// Cloudflare API access for the release feed (scripts/release/hosting.ts, publish.ts). The API token comes from
// CLOUDFLARE_API_TOKEN or ~/.config/treesoop/secrets.env and is never printed. It needs, on the account of the
// feed's zone: Workers R2 Storage Edit, Workers Scripts Edit, and on the zone Workers Routes Edit (the custom domain of
// the feed, whose DNS record Cloudflare creates for the Worker; no other record is touched). Zone, host, bucket and
// Worker are this product's release channel (shared/src/release-channel.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { retrying, TransientError, transientStatus, type RetryOptions } from './sign'

export const ZONE: string = RELEASE_CHANNEL.hosting.zone
export const HOST: string = new URL(RELEASE_CHANNEL.feed).hostname
export const BUCKET: string = RELEASE_CHANNEL.hosting.bucket
export const WORKER: string = RELEASE_CHANNEL.hosting.worker
const API = 'https://api.cloudflare.com/client/v4'

export function apiToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const f = path.join(os.homedir(), '.config', 'treesoop', 'secrets.env')
  let text = ''
  try { text = fs.readFileSync(f, 'utf8') } catch { throw new Error(`no CLOUDFLARE_API_TOKEN in the environment and ${f} is not readable`) }
  const m = /^CLOUDFLARE_API_TOKEN=(.+)$/m.exec(text)
  if (!m) throw new Error(`${f} has no CLOUDFLARE_API_TOKEN`)
  return m[1]!.trim().replace(/^["']|["']$/g, '')
}

export class CfError extends Error {
  name = 'CfError'
  constructor(message: string, readonly status?: number) { super(message) }
}

/** The biggest release file on a slow line; bounded so that a stalled upload is tried again */
const PUT_TIMEOUT_MS = 20 * 60_000
const LIST_TIMEOUT_MS = 30_000

export class Cloudflare {
  constructor(private token = apiToken()) {}

  async raw(method: string, p: string, body?: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    return fetch(API + p, { method, body, headers: { authorization: `Bearer ${this.token}`, ...headers }, signal })
  }

  async json<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, p, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { 'content-type': 'application/json' })
    const j = (await r.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null
    if (!j?.success) throw new CfError(`${method} ${p}: HTTP ${r.status} ${(j?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`, r.status)
    return j.result as T
  }

  async accountAndZone(o: RetryOptions = {}): Promise<{ account: string; zone: string }> {
    const zones = await retrying(async () => {
      try { return await this.json<{ id: string; account: { id: string } }[]>('GET', `/zones?name=${ZONE}`) } catch (e) {
        throw e instanceof CfError && !transientStatus(e.status ?? 0) ? e : new TransientError((e as Error).message)
      }
    }, o)
    if (!zones[0]) throw new CfError(`zone ${ZONE} is not visible to this token`)
    return { account: zones[0].account.id, zone: zones[0].id }
  }

  /**
   * Is the object in the bucket? R2's own answer, past the Worker and the CDN: List Objects, strongly consistent. Not Get
   * Object: its 404 is the same for a missing key and a missing bucket, and a wrong answer here lets an upload replace a
   * published file. So only a list that was really answered can say "not there"; anything else throws, a TransientError
   * while the server is in trouble (the read around this tries again).
   */
  async hasObject(account: string, key: string): Promise<boolean> {
    const list = `/accounts/${account}/r2/buckets/${BUCKET}/objects?${new URLSearchParams({ prefix: key, per_page: '1000' })}`
    let r: Response
    try { r = await this.raw('GET', list, undefined, {}, AbortSignal.timeout(LIST_TIMEOUT_MS)) } catch (e) { throw new TransientError(`list ${key}: ${(e as Error).message}`) }
    const j = (await r.json().catch(() => null)) as { success?: boolean; result?: { key?: string }[]; result_info?: { is_truncated?: boolean }; errors?: { code: number; message: string }[] } | null
    const m = `list ${key}: HTTP ${r.status} ${(j?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`
    if (transientStatus(r.status) || (r.ok && !j)) throw new TransientError(m)
    if (!r.ok || j?.success !== true || !Array.isArray(j.result)) throw new CfError(m, r.status)
    if (j.result.some((x) => x.key === key)) return true
    // keys are in order and a key sorts before any other with it as a prefix, so a cut list cannot hide it; if it does, stop
    if (j.result_info?.is_truncated) throw new CfError(`${m}: the list is cut off`, r.status)
    return false
  }

  /** PUT an object into the bucket (the API takes the body as is; content-type becomes its metadata). A 502 and the like
   * are tried again: the same file to the same key, so an upload that landed before its answer was lost lands again as
   * the same bytes. A missing local file is no trouble of the network: it stops at once. */
  async putObject(account: string, key: string, file: string, contentType: string, o: RetryOptions = {}): Promise<void> {
    const object = `/accounts/${account}/r2/buckets/${BUCKET}/objects/${key.split('/').map(encodeURIComponent).join('/')}`
    await retrying(async () => {
      fs.statSync(file)
      let r: Response
      try { r = await this.raw('PUT', object, Bun.file(file), { 'content-type': contentType }, AbortSignal.timeout(PUT_TIMEOUT_MS)) } catch (e) { throw new TransientError(`upload ${key}: ${(e as Error).message}`) }
      const j = (await r.json().catch(() => null)) as { success?: boolean; errors?: { code: number; message: string }[] } | null
      if (r.ok && j?.success) return
      const m = `upload ${key}: HTTP ${r.status} ${(j?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`
      throw transientStatus(r.status) ? new TransientError(m) : new CfError(m, r.status)
    }, o)
  }

  async deleteObject(account: string, key: string): Promise<void> {
    await this.raw('DELETE', `/accounts/${account}/r2/buckets/${BUCKET}/objects/${key.split('/').map(encodeURIComponent).join('/')}`)
  }
}

/** The release bucket as the publish scripts use it. */
export interface Bucket {
  /** is the object there (Cloudflare.hasObject)? What a 404 from the feed is checked against before anything goes up */
  holds(key: string): Promise<boolean>
  put(key: string, file: string, contentType: string): Promise<void>
}

export async function openBucket(cf: Cloudflare = new Cloudflare(), o: RetryOptions = {}): Promise<Bucket> {
  const { account } = await cf.accountAndZone(o)
  return { holds: (key) => cf.hasObject(account, key), put: (key, file, type) => cf.putObject(account, key, file, type, o) }
}
