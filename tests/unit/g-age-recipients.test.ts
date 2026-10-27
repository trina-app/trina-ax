// age to X25519 recipients / with identities (control-plane SV-6), cross-checked against the age CLI when it is
// installed (brew install age; age 1.3.2 here): what the server encrypts, `age -d -i` opens, and what `age -r`
// encrypts, the server opens. Two recipients (team + organisation recovery key): either identity alone decrypts.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  ageArmorTo, ageDecryptWith, ageEncryptTo, ageUnarmorWith, newAgeIdentity, readFileChunks, writeAtomic, WrongPasswordError,
} from '../../server/src/system/streams.ts'
import { WORK } from '../lib/env'

const DIR = path.join(WORK, `age-${process.pid}`)
fs.mkdirSync(DIR, { recursive: true })
const AGE = Bun.which('age')
const KEYGEN = Bun.which('age-keygen')
const payload = crypto.randomBytes(300 * 1024 + 17) // several 64 KiB age chunks and a partial one
async function* once(b: Uint8Array) { yield b }
async function collect(src: AsyncIterable<Uint8Array>): Promise<Buffer> { const a: Uint8Array[] = []; for await (const c of src) a.push(c); return Buffer.concat(a) }

describe('age recipients and identities', () => {
  test('two recipients: either identity decrypts; another identity does not; bad keys are refused', async () => {
    const team = await newAgeIdentity()
    const org = await newAgeIdentity()
    expect(team.recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/)
    expect(team.identity).toMatch(/^AGE-SECRET-KEY-1/)
    const enc = await collect(ageEncryptTo(once(payload), [team.recipient, org.recipient]))
    expect(enc.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1')
    expect((await collect(ageDecryptWith(once(enc), [team.identity]))).equals(payload)).toBe(true)
    expect((await collect(ageDecryptWith(once(enc), [org.identity]))).equals(payload)).toBe(true)
    const other = await newAgeIdentity()
    await expect(collect(ageDecryptWith(once(enc), [other.identity]))).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(collect(ageEncryptTo(once(payload), ['age1pq1notsupported']))).rejects.toThrow(/recipient/)
    await expect(collect(ageEncryptTo(once(payload), []))).rejects.toThrow()
    await expect(collect(ageDecryptWith(once(enc), ['not-a-key']))).rejects.toThrow(/identity/)
  })
  test('armored small secrets round-trip', async () => {
    const k = await newAgeIdentity()
    const a = await ageArmorTo('credentials-key-material', [k.recipient])
    expect(a).toStartWith('-----BEGIN AGE ENCRYPTED FILE-----')
    expect(Buffer.from(await ageUnarmorWith(a, [k.identity])).toString()).toBe('credentials-key-material')
  })
  test('the age CLI opens what the server wrote (binary and armored)', async () => {
    if (!AGE) return console.log('age CLI not installed: cross-check skipped')
    const k = await newAgeIdentity()
    const org = await newAgeIdentity()
    const idFile = path.join(DIR, 'id.txt')
    fs.writeFileSync(idFile, k.identity + '\n', { mode: 0o600 })
    const encFile = path.join(DIR, 'x.age')
    await writeAtomic(ageEncryptTo(readFileChunks(await (async () => { const f = path.join(DIR, 'plain'); fs.writeFileSync(f, payload); return f })()), [org.recipient, k.recipient]), encFile)
    const p = Bun.spawnSync([AGE, '-d', '-i', idFile, encFile])
    expect(p.exitCode).toBe(0)
    expect(Buffer.from(p.stdout).equals(payload)).toBe(true)
    const armoredFile = path.join(DIR, 'x.age.txt')
    fs.writeFileSync(armoredFile, await ageArmorTo(payload.subarray(0, 1000), [k.recipient]))
    const q = Bun.spawnSync([AGE, '-d', '-i', idFile, armoredFile])
    expect(q.exitCode).toBe(0)
    expect(Buffer.from(q.stdout).equals(payload.subarray(0, 1000))).toBe(true)
  })
  test('the server opens what the age CLI wrote to a recipient (age-keygen key)', async () => {
    if (!AGE || !KEYGEN) return console.log('age CLI not installed: cross-check skipped')
    const keyFile = path.join(DIR, 'cli-key.txt')
    fs.rmSync(keyFile, { force: true })
    expect(Bun.spawnSync([KEYGEN, '-o', keyFile]).exitCode).toBe(0)
    const text = fs.readFileSync(keyFile, 'utf8')
    const recipient = /public key: (age1\S+)/.exec(text)![1]!
    const identity = /^(AGE-SECRET-KEY-1\S+)$/m.exec(text)![1]!
    const plain = path.join(DIR, 'cli-plain')
    fs.writeFileSync(plain, payload)
    const enc = path.join(DIR, 'cli.age')
    expect(Bun.spawnSync([AGE, '-r', recipient, '-o', enc, plain]).exitCode).toBe(0)
    expect((await collect(ageDecryptWith(readFileChunks(enc), [identity]))).equals(payload)).toBe(true)
  })
})
