// A password export (.tar.zst.age) must open with `age -d`, not only with the server's own library. No age CLI is
// needed here: a small decoder written from the age v1 spec (https://age-encryption.org/v1, scrypt recipient) opens
// the server's file. Only the ChaCha20-Poly1305 primitive comes from a library (Bun has no such cipher; it is the
// @noble/ciphers package that the age library itself depends on); the header, stanza, MAC and chunk framing are ours. It also checks that the encrypted file is not a plain archive, that a
// wrong password fails, and that the export API refuses a password shorter than 8 characters.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { StartExportBody } from '../../shared/src/api/system'
import { openDb } from '../../server/src/db'
import { runExport } from '../../server/src/system/export'
import { zstdDecompress } from '../../server/src/system/streams'
import { extractTar } from '../../server/src/system/tar'
import { WORK } from '../lib/env'

const W = path.join(WORK, `g-export-age-spec-${process.pid}`)
fs.rmSync(W, { recursive: true, force: true })

const b64 = (s: string) => Buffer.from(s, 'base64') // age uses unpadded standard base64; Node accepts it
const hkdf = (ikm: Buffer, salt: Buffer, info: string) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), 32))
// resolved next to age-encryption (a transitive dependency of the server)
const ageReq = createRequire(createRequire(path.join(import.meta.dir, '../../server/package.json')).resolve('age-encryption'))
const { chacha20poly1305 } = ageReq('@noble/ciphers/chacha.js') as { chacha20poly1305: (k: Uint8Array, n: Uint8Array) => { decrypt(c: Uint8Array): Uint8Array } }
const chachaOpen = (key: Buffer, nonce: Buffer, sealed: Buffer) => Buffer.from(chacha20poly1305(key, nonce).decrypt(sealed))

/** age v1 with one scrypt stanza, from the spec. Throws on a wrong password or any bad MAC. */
function specDecrypt(file: Buffer, password: string): Buffer {
  const end = file.indexOf('\n---')
  if (end < 0) throw new Error('no header end')
  const macLineEnd = file.indexOf('\n', end + 1)
  const header = file.subarray(0, end + 4).toString('latin1') // up to and including "---"
  const mac = b64(file.subarray(end + 5, macLineEnd).toString('latin1'))
  const lines = header.split('\n')
  if (lines[0] !== 'age-encryption.org/v1') throw new Error('not age v1')
  const stanza = lines[1]!.split(' ')
  if (stanza[0] !== '->' || stanza[1] !== 'scrypt') throw new Error('not a scrypt stanza')
  const salt = Buffer.concat([Buffer.from('age-encryption.org/v1/scrypt'), b64(stanza[2]!)])
  const logN = Number(stanza[3])
  const body = b64(lines.slice(2, -1).join(''))
  const wrap = crypto.scryptSync(Buffer.from(password), salt, 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 512 * 1024 * 1024 })
  const fileKey = chachaOpen(wrap, Buffer.alloc(12), body) // throws on a wrong password
  const want = crypto.createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(header, 'latin1').digest()
  if (!crypto.timingSafeEqual(want, mac)) throw new Error('header MAC')
  const rest = file.subarray(macLineEnd + 1)
  const key = hkdf(fileKey, rest.subarray(0, 16), 'payload')
  const payload = rest.subarray(16)
  const out: Buffer[] = []
  const CH = 64 * 1024 + 16
  for (let i = 0, n = 0; i < payload.length; i += CH, n++) {
    const last = i + CH >= payload.length
    const nonce = Buffer.alloc(12)
    nonce.writeUIntBE(n, 5, 6)
    nonce[11] = last ? 1 : 0
    out.push(chachaOpen(key, nonce, payload.subarray(i, i + CH)))
  }
  return Buffer.concat(out)
}

describe('password export opens with any age v1 reader', () => {
  test('spec decoder opens the export; same scope as the plain export; wrong password and short password refused', async () => {
    const team = path.join(W, 'team')
    fs.mkdirSync(path.join(team, 'shared'), { recursive: true })
    fs.mkdirSync(path.join(team, 'users', 'olga'), { recursive: true })
    fs.mkdirSync(path.join(team, 'users', 'bob'), { recursive: true })
    fs.writeFileSync(path.join(team, 'shared', 'plan.md'), 'QA-MARK-EXPORT-SHARED')
    fs.writeFileSync(path.join(team, 'shared', 'big.bin'), crypto.randomBytes(200 * 1024)) // several age chunks
    fs.writeFileSync(path.join(team, 'users', 'olga', 'note.txt'), 'QA-MARK-EXPORT-OWNER')
    fs.writeFileSync(path.join(team, 'users', 'bob', 'diary.txt'), 'QA-MARK-EXPORT-MKT')
    fs.mkdirSync(path.join(W, 'data'), { recursive: true })
    const db = openDb(path.join(W, 'data', 'app.db'))
    db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner'), ('bob', 'bob', 'Bob', 'member')").run()
    db.query("INSERT INTO memories (id, user_id, text) VALUES ('m1', 'olga', 'QA-MARK-EXPORT-OWNER memory'), ('m2', 'bob', 'QA-MARK-EXPORT-MKT memory')").run()

    // the API refuses a 7-character password and takes an 8-character one
    expect(StartExportBody.safeParse({ what: ['files'], password: 'qa-1234' }).success).toBe(false)
    expect(StartExportBody.safeParse({ what: ['files'], password: 'qa-12345' }).success).toBe(true)

    const r = await runExport(db, team, { ownerId: 'olga', what: ['memories', 'files'], password: 'qa-export-pass' })
    const enc = fs.readFileSync(path.join(team, r.path))
    expect(enc.subarray(0, 22).toString('latin1')).toBe('age-encryption.org/v1\n')
    // not a plain archive: no zstd magic, no readable marker
    expect(enc.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe(false)
    expect(enc.includes('QA-MARK-EXPORT')).toBe(false)
    expect(() => specDecrypt(enc, 'wrong-password')).toThrow()

    const tarZst = specDecrypt(enc, 'qa-export-pass')
    expect(tarZst.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe(true)
    const out = path.join(W, 'out')
    fs.mkdirSync(out)
    await extractTar(zstdDecompress((async function* () { yield new Uint8Array(tarZst) })()), out)
    const root = path.join(out, fs.readdirSync(out)[0]!)
    expect(fs.readFileSync(path.join(root, 'files', 'users', 'olga', 'note.txt'), 'utf8')).toBe('QA-MARK-EXPORT-OWNER')
    expect(fs.readFileSync(path.join(root, 'files', 'shared', 'plan.md'), 'utf8')).toBe('QA-MARK-EXPORT-SHARED')
    expect(fs.existsSync(path.join(root, 'files', 'users', 'bob'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'files', '.system'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'files', 'users', 'olga', 'exports'))).toBe(false)
    const csv = fs.readFileSync(path.join(root, 'memories.csv'), 'utf8')
    expect(csv).toContain('QA-MARK-EXPORT-OWNER memory')
    expect(csv).not.toContain('QA-MARK-EXPORT-MKT')
    db.close()
  }, 60_000)
})
