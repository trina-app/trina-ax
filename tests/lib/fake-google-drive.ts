import crypto from 'node:crypto'
import { DRIVE_SCOPE, type DriveConfig } from '../../server/src/integrations/google-drive/config'
import { DRIVE_API, GOOGLE_TOKEN, GOOGLE_REVOKE, type DriveFetch } from '../../server/src/integrations/google-drive/client'

export const DRIVE_CONFIG: DriveConfig = { clientId: 'synthetic-client', clientSecret: 'CANARY-client-secret', redirectUri: 'https://team.example.test/api/integrations/google-drive/callback' }
/** In-process HTTP provider. It can only answer the fixed Google URLs; it never opens a network connection. */
export class FakeGoogleDrive {
  now = Date.now()
  calls: { url: string; method: string }[] = []
  codeChallenges = new Map<string, { challenge: string; who: string }>()
  refreshCount = 0
  expired = false
  invalidRefresh = false
  rotateRefresh = false
  refreshTokens = new Set<string>()
  revoked = false
  scope = DRIVE_SCOPE
  delayRefresh: (() => Promise<void>) | null = null
  delayRead: (() => Promise<void>) | null = null
  delayRevoke: (() => Promise<void>) | null = null
  response: ((url: URL) => Response | null) | null = null
  access = new Map<string, string>()
  blobs = new Map<string, { owner: string; name: string; mime: string; bytes: Uint8Array; canDownload?: boolean; target?: string }>()
  constructor() {
    this.blobs.set('alice-file', { owner: 'alice', name: 'private.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Alice private content') })
    this.blobs.set('bob-file', { owner: 'bob', name: 'other.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Bob private content') })
    this.blobs.set('shared-file', { owner: '*', name: 'shared.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Shared drive content') })
  }
  authorize(url: string, who = 'alice') {
    const u = new URL(url), code = 'synthetic-code-' + this.codeChallenges.size
    this.codeChallenges.set(code, { challenge: u.searchParams.get('code_challenge')!, who })
    return { code, state: u.searchParams.get('state')! }
  }
  fetch: DriveFetch = async (raw, init = {}) => {
    this.calls.push({ url: raw, method: init.method ?? 'GET' })
    const url = new URL(raw)
    if (raw === GOOGLE_TOKEN) {
      const body = new URLSearchParams(String(init.body))
      if (body.get('client_secret') !== DRIVE_CONFIG.clientSecret) return Response.json({ error: 'invalid_client' }, { status: 401 })
      let who = 'alice'
      if (body.get('grant_type') === 'authorization_code') {
        const c = this.codeChallenges.get(body.get('code')!)
        if (!c || crypto.createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 })
        who = c.who; this.codeChallenges.delete(body.get('code')!)
      } else {
        this.refreshCount++
        await this.delayRefresh?.()
        if (this.invalidRefresh || !this.refreshTokens.has(body.get('refresh_token')!)) return Response.json({ error: 'invalid_grant', secret: 'CANARY-upstream-error' }, { status: 400 })
        who = (body.get('refresh_token') ?? '').split(':')[1] ?? 'alice'
        if (this.rotateRefresh) this.refreshTokens.delete(body.get('refresh_token')!)
      }
      const access = 'CANARY-access:' + who + ':' + this.calls.length
      this.access.set(access, who)
      const refresh = 'CANARY-refresh:' + who + (this.rotateRefresh ? ':' + this.calls.length : '')
      const returned = body.get('grant_type') === 'authorization_code' || this.rotateRefresh
      if (returned) this.refreshTokens.add(refresh)
      return Response.json({ access_token: access, ...(returned ? { refresh_token: refresh } : {}), expires_in: this.expired ? 30 : 3600, scope: this.scope })
    }
    if (raw === GOOGLE_REVOKE) { await this.delayRevoke?.(); this.revoked = true; return new Response('') }
    if (!raw.startsWith(DRIVE_API)) throw new Error('Fake provider refuses non-Google endpoint')
    const who = this.access.get(new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '')
    if (!who) return Response.json({ error: 'denied' }, { status: 401 })
    if (url.pathname.endsWith('/about')) return Response.json({ user: { permissionId: who, displayName: who, emailAddress: who + '@example.test' } })
    const custom = this.response?.(url)
    if (custom) return custom
    if (url.pathname.endsWith('/files')) {
      return Response.json({ files: [...this.blobs].filter(([, b]) => b.owner === '*' || b.owner === who).map(([id, b]) => ({ id, name: b.name, mimeType: b.mime })), incompleteSearch: true, nextPageToken: 'opaque-page' })
    }
    const id = url.pathname.split('/')[4]!, b = this.blobs.get(id)
    if (!b || (b.owner !== who && b.owner !== '*')) return Response.json({ error: 'hidden CANARY-upstream-error' }, { status: 403 })
    if (url.searchParams.get('alt') === 'media' || url.pathname.endsWith('/export')) { await this.delayRead?.(); return new Response(new Uint8Array(b.bytes)) }
    return Response.json({ id, name: b.name, mimeType: b.mime, size: String(b.bytes.byteLength), capabilities: { canDownload: b.canDownload !== false }, ...(b.target ? { shortcutDetails: { targetId: b.target } } : {}) })
  }
}
