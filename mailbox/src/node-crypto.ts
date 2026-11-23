// The mailbox's cryptography with node:crypto (crypto.ts MailCrypto): tests and the local dev server. The Worker uses
// webMailCrypto (crypto.ts); this file is never part of its bundle.
import nodeCrypto, { type KeyObject } from 'node:crypto'
import { MAIL_IN_SEAL_ALG, MAIL_IN_SEAL_INFO, type MailInSealed } from '../../shared/src/cloud-protocol/mail-in.ts'
import type { MailCrypto } from './crypto.ts'

const utf8 = (s: string) => new TextEncoder().encode(s)
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** node:crypto (Bun, Node): tests and the local dev server. */
export const nodeMailCrypto: MailCrypto = {
  async sha256Hex(data) { return nodeCrypto.createHash('sha256').update(typeof data === 'string' ? utf8(data) : data).digest('hex') },
  async seal(sealKey, plaintext, aad) {
    const teamRaw = Buffer.from(sealKey, 'base64url')
    if (teamRaw.length !== 32) throw new Error('bad seal key')
    const teamPub = nodeCrypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, teamRaw]), format: 'der', type: 'spki' })
    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('x25519')
    const epk = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)
    const shared = nodeCrypto.diffieHellman({ privateKey, publicKey: teamPub })
    const key = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, Buffer.concat([epk, teamRaw]), Buffer.from(MAIL_IN_SEAL_INFO, 'utf8'), 32))
    const iv = nodeCrypto.randomBytes(12)
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from(aad, 'utf8'))
    const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
    return { alg: MAIL_IN_SEAL_ALG, epk: b64u(epk), iv: b64u(iv), ct: b64u(ct) }
  },
  async verify(spkiB64, message, sigB64) {
    try {
      const key = nodeCrypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' })
      if (key.asymmetricKeyType !== 'ed25519') return false
      return nodeCrypto.verify(null, message, key, Buffer.from(sigB64, 'base64'))
    } catch { return false }
  },
  randomId() { return nodeCrypto.randomBytes(18).toString('base64url') },
}

/** Open a sealed item (what a team server does; here for tests and the dev server). Throws when it does not open. */
export function nodeOpenSealed(sealed: MailInSealed, privateKey: KeyObject, aad: string): Buffer {
  const epk = Buffer.from(sealed.epk, 'base64url')
  const ownRaw = (nodeCrypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)
  const shared = nodeCrypto.diffieHellman({ privateKey, publicKey: nodeCrypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, epk]), format: 'der', type: 'spki' }) })
  const key = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, Buffer.concat([epk, ownRaw]), Buffer.from(MAIL_IN_SEAL_INFO, 'utf8'), 32))
  const raw = Buffer.from(sealed.ct, 'base64url')
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'))
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()])
}

