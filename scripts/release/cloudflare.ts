// Cloudflare API access for the release feed (scripts/release/hosting.ts, publish.ts). The API token comes from
// CLOUDFLARE_API_TOKEN or ~/.config/treesoop/secrets.env and is never printed. It needs, on the account of the
// feed's zone: Workers R2 Storage Edit, Workers Scripts Edit, and on the zone Workers Routes Edit (the custom domain of
// the feed, whose DNS record Cloudflare creates for the Worker; no other record is touched). Zone, host, bucket and
// Worker are this product's release channel (shared/src/release-channel.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

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

export class CfError extends Error { name = 'CfError' }

export class Cloudflare {
  constructor(private token = apiToken()) {}

  async raw(method: string, p: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(API + p, { method, body, headers: { authorization: `Bearer ${this.token}`, ...headers } })
  }

  async json<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, p, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { 'content-type': 'application/json' })
    const j = (await r.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null
    if (!j?.success) throw new CfError(`${method} ${p}: HTTP ${r.status} ${(j?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`)
    return j.result as T
  }

  async accountAndZone(): Promise<{ account: string; zone: string }> {
    const zones = await this.json<{ id: string; account: { id: string } }[]>('GET', `/zones?name=${ZONE}`)
    if (!zones[0]) throw new CfError(`zone ${ZONE} is not visible to this token`)
    return { account: zones[0].account.id, zone: zones[0].id }
  }

  /** PUT an object into the bucket (the API takes the body as is; content-type becomes its metadata) */
  async putObject(account: string, key: string, file: string, contentType: string): Promise<void> {
    const r = await this.raw('PUT', `/accounts/${account}/r2/buckets/${BUCKET}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, Bun.file(file), { 'content-type': contentType })
    const j = (await r.json().catch(() => null)) as { success?: boolean; errors?: { code: number; message: string }[] } | null
    if (!r.ok || !j?.success) throw new CfError(`upload ${key}: HTTP ${r.status} ${(j?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`)
  }

  async deleteObject(account: string, key: string): Promise<void> {
    await this.raw('DELETE', `/accounts/${account}/r2/buckets/${BUCKET}/objects/${key.split('/').map(encodeURIComponent).join('/')}`)
  }
}
