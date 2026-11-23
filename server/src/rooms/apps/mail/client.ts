// The mail service's client (shared/src/cloud-protocol/mail-in.ts): signed calls with this server's relay team key, the
// team's seal key (X25519, private key in the credentials vault), and opening a sealed mail.
//
// When it is used: ONLY when the operator set MYCEL_MAIL_IN_URL (the mail service's https origin; http only to this
// machine) and MYCEL_MAIL_IN_DOMAIN (the domain of the addresses). Without both, Email cannot be added ("Email needs
// this server to be connected to the Trina service.") and this server never calls a mail service.
import crypto, { type KeyObject } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import {
  MAIL_IN_ANSWER_MAX_BYTES, MAIL_IN_MAX_BODY_BYTES, MAIL_IN_PATHS, MAIL_IN_POLL_MAX_WAIT_MS, MAIL_IN_SEAL_INFO,
  mailInAuthorization, mailInSealAad, mailInSigningString, parseMailInItem, parseMailInMeta,
  type MailInItem, type MailInMeta, type MailInOp,
} from '@mycel/shared/cloud-protocol'
import { getSetting, setSetting } from '../../../admin/settings'
import type { Vault } from '../../../credentials/vault'

export type MailFetch = (input: string, init: RequestInit) => Promise<Response>
export interface MailIdentity { key: KeyObject; publicKey: string }
export interface MailInOptions { origin: string; domain: string; identity: () => MailIdentity; fetch?: MailFetch; now?: () => number }

export class MailInError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(`mail_in_${code}`) }
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** The mail service of this server from its settings, or null. */
export function mailInConfig(env: Record<string, string | undefined> = process.env): { origin: string; domain: string } | null {
  const raw = env.MYCEL_MAIL_IN_URL?.trim(), domain = env.MYCEL_MAIL_IN_DOMAIN?.trim().toLowerCase()
  if (!raw || raw === 'off' || !domain || !DOMAIN_RE.test(domain)) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  return { origin: u.origin, domain }
}

// ---------------- the team's seal key ----------------
const KEY_SETTING = 'mailIn.sealKey'
const KEY_ID = 'mail-in'
const KEY_KIND = 'mail_in_seal_key'
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const rawOf = (k: KeyObject) => (crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)

/** The team's seal key (made once, kept sealed in the vault): the private key and its raw public key, base64url. */
export function sealKeyOf(db: Database, vault: Vault): { privateKey: KeyObject; sealKey: string } {
  const s = getSetting<{ enc: string; keyVersion: number }>(db, KEY_SETTING)
  if (s) {
    try {
      const v = vault.decrypt(KEY_ID, KEY_KIND, s.enc, s.keyVersion) as { pkcs8: string }
      const privateKey = crypto.createPrivateKey({ key: Buffer.from(v.pkcs8, 'base64'), format: 'der', type: 'pkcs8' })
      return { privateKey, sealKey: rawOf(privateKey).toString('base64url') }
    } catch { /* a key that no longer opens: a new one (mail sealed to the old one waits and expires) */ }
  }
  const { privateKey } = crypto.generateKeyPairSync('x25519')
  const pkcs8 = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64')
  setSetting(db, KEY_SETTING, vault.encrypt(KEY_ID, KEY_KIND, { pkcs8 }))
  return { privateKey, sealKey: rawOf(privateKey).toString('base64url') }
}

/** credentials/rekey.ts: the seal key sealed again under the new key. */
export function rekeyMailKey(db: Database, from: Vault, next: Vault): { versions: number[]; write: () => void } {
  const s = getSetting<{ enc: string; keyVersion: number }>(db, KEY_SETTING)
  if (!s) return { versions: [], write: () => {} }
  let value: unknown
  try { value = from.decrypt(KEY_ID, KEY_KIND, s.enc, s.keyVersion) } catch { return { versions: [s.keyVersion], write: () => {} } }
  const out = next.encrypt(KEY_ID, KEY_KIND, value)
  return { versions: [], write: () => setSetting(db, KEY_SETTING, out) }
}

/** Open one sealed mail (contract "Sealed item"); throws when it does not open or its head is not one. */
export function openMailItem(item: MailInItem, privateKey: KeyObject): { meta: MailInMeta; raw: Uint8Array } {
  const s = item.sealed
  const epk = Buffer.from(s.epk, 'base64url')
  const shared = crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, epk]), format: 'der', type: 'spki' }) })
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epk, rawOf(privateKey)]), Buffer.from(MAIL_IN_SEAL_INFO, 'utf8'), 32))
  const ct = Buffer.from(s.ct, 'base64url')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64url'))
  d.setAAD(Buffer.from(mailInSealAad(item.id, item.hash, item.receivedAt), 'utf8'))
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  const nl = plain.indexOf(0x0a)
  if (nl < 0 || nl > 8192) throw new Error('no head')
  const meta = parseMailInMeta(JSON.parse(plain.subarray(0, nl).toString('utf8')))
  if (!meta) throw new Error('bad head')
  return { meta, raw: new Uint8Array(plain.subarray(nl + 1)) }
}

/** Seal one mail as the gateway does (tests and the dev mail service only). */
export function sealMailItem(o: { id: string; hash: string; receivedAt: string; sealKey: string; meta: MailInMeta; raw: Uint8Array }): MailInItem {
  const eph = crypto.generateKeyPairSync('x25519')
  const team = Buffer.from(o.sealKey, 'base64url')
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, team]), format: 'der', type: 'spki' }) })
  const epk = rawOf(eph.privateKey)
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epk, team]), Buffer.from(MAIL_IN_SEAL_INFO, 'utf8'), 32))
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(mailInSealAad(o.id, o.hash, o.receivedAt), 'utf8'))
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(JSON.stringify(o.meta) + '\n', 'utf8'), o.raw])), c.final(), c.getAuthTag()])
  return { id: o.id, hash: o.hash, receivedAt: o.receivedAt, size: o.raw.byteLength, sealed: { alg: 'X25519-HKDF-SHA256-A256GCM', epk: epk.toString('base64url'), iv: iv.toString('base64url'), ct: ct.toString('base64url') } }
}

// ---------------- calls ----------------
export class MailInClient {
  constructor(readonly o: MailInOptions) {}
  private now() { return (this.o.now ?? Date.now)() }

  private async call(op: MailInOp, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 20_000): Promise<Record<string, any>> {
    const path = MAIL_IN_PATHS[op], text = JSON.stringify(body)
    if (Buffer.byteLength(text) > MAIL_IN_MAX_BODY_BYTES) throw new MailInError('invalid_request')
    let id: MailIdentity
    try { id = this.o.identity() } catch { throw new MailInError('unreachable') }
    const ts = this.now(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(mailInSigningString(path, ts, nonce, crypto.createHash('sha256').update(text).digest('hex')), 'utf8'), id.key).toString('base64')
    const s = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    let r: Response
    try {
      r = await (this.o.fetch ?? fetch)(this.o.origin + path, { method: 'POST', redirect: 'manual', signal: s, headers: { 'content-type': 'application/json', authorization: mailInAuthorization(id.publicKey, ts, nonce, sig) }, body: text })
    } catch { throw new MailInError(signal?.aborted ? 'cancelled' : 'unreachable') }
    let json: any = null
    try {
      const raw = await r.text()
      if (raw.length > MAIL_IN_ANSWER_MAX_BYTES) throw new Error('too large')
      json = JSON.parse(raw)
    } catch { json = null }
    if (r.ok && json && typeof json === 'object' && !Array.isArray(json)) return json
    const code = typeof json?.error?.code === 'string' && /^[a-z_]{1,40}$/.test(json.error.code) ? json.error.code : r.status === 429 ? 'rate_limited' : 'unreachable'
    throw new MailInError(code, r.status)
  }

  async status(): Promise<{ domain: string; sealKey: string | null }> {
    const j = await this.call('status', { v: 1 }, undefined, 8000)
    if (j.ok !== true || typeof j.domain !== 'string') throw new MailInError('unreachable')
    return { domain: j.domain.toLowerCase(), sealKey: typeof j.sealKey === 'string' ? j.sealKey : null }
  }
  async setKey(sealKey: string): Promise<void> { await this.call('key', { v: 1, sealKey }) }
  async sync(hashes: string[]): Promise<void> {
    const j = await this.call('sync', { v: 1, hashes })
    if (j.ok !== true) throw new MailInError('unreachable')
  }
  async poll(ack: string[], waitMs: number, signal?: AbortSignal): Promise<{ items: MailInItem[]; expired: number }> {
    const j = await this.call('poll', { v: 1, ack, waitMs: Math.min(waitMs, MAIL_IN_POLL_MAX_WAIT_MS) }, signal, waitMs + 20_000)
    const items: MailInItem[] = []
    for (const raw of Array.isArray(j.items) ? j.items.slice(0, 100) : []) {
      const it = parseMailInItem(raw)
      if (it) items.push(it)
    }
    const expired = typeof j.expired === 'number' && Number.isInteger(j.expired) && j.expired >= 0 ? j.expired : 0
    return { items, expired }
  }
}
