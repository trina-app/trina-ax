// A newer team server keeps working with the Chrome extension versions already in the store (docs/RELEASE-CI.md
// "Chrome extension releases"): every released version's snapshot (tests/fixtures/chrome-protocol/<version>.json,
// chrome-extension/protocol.ts) is checked against today's contract in shared/src/api/chrome.ts. The server must accept
// everything that version can send and send only what it reads (a frame type it does not know is skipped).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_VERSION } from '../../chrome-extension/build'
import { accepts, incompatibilities, protocolSnapshot, type ProtocolSnapshot, type Schema } from '../../chrome-extension/protocol'
import { PROTOCOL_DIR } from '../../chrome-extension/release'

const ROOT = join(import.meta.dir, '../..')
const snapshots = readdirSync(join(ROOT, PROTOCOL_DIR)).filter((f) => f.endsWith('.json')).sort()

/** Known breaks a reviewer accepted: "<version>: <message>" → why it is fine. Only with a reason that holds for every
 * install of that version. A new browser tool, for one, does not belong here: it reaches an older extension as a call
 * it cannot read (the call times out), so ship the extension that knows it first. */
const ACCEPTED: Record<string, string> = {
  // 0.1.0 (the hand upload, snapshot from e1ffb7743, the commit with the store screenshots): its label went through
  // cleanLabel (control characters to spaces, \s+ — which covers U+2028/U+2029 — to one space), so it never sends one
  [`0.1.0: redeem body .label: the pattern ^[^\\u0000-\\u001f\\u007f\\u2028\\u2029]+$ is new`]: 'cleanLabel in 0.1.0 strips these characters',
}

describe('older extension versions still work with this server', () => {
  test('the current version has its snapshot, and it is today\'s contract (else: bun run chrome:bump patch|minor|major)', () => {
    const file = join(ROOT, PROTOCOL_DIR, `${EXTENSION_VERSION}.json`)
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as ProtocolSnapshot
    expect(recorded).toEqual(JSON.parse(JSON.stringify(protocolSnapshot(EXTENSION_VERSION))))
  })

  for (const f of snapshots) {
    test(f, () => {
      const old = JSON.parse(readFileSync(join(ROOT, PROTOCOL_DIR, f), 'utf8')) as ProtocolSnapshot
      expect(`${old.version}.json`).toBe(f)
      expect(incompatibilities(old).filter((m) => !ACCEPTED[`${old.version}: ${m}`])).toEqual([])
    })
  }
})

describe('accepts (the compatibility rule)', () => {
  const obj = (properties: Record<string, Schema>, required: string[], extra: Schema = {}): Schema => ({ type: 'object', properties, required, ...extra })
  const str: Schema = { type: 'string' }
  test('a new optional field the old side does not know: fine; a strict reader refuses it', () => {
    expect(accepts(obj({ a: str }, ['a']), obj({ a: str, b: str }, ['a']))).toEqual([])
    expect(accepts(obj({ a: str }, ['a'], { additionalProperties: false }), obj({ a: str, b: str }, ['a']))[0]).toContain('strict')
  })
  test('a field read as required must always be sent', () => {
    expect(accepts(obj({ a: str }, ['a']), obj({ a: str }, []))[0]).toContain('not always sent')
  })
  test('a tighter reader limit, a new pattern, a changed type', () => {
    expect(accepts({ type: 'string', maxLength: 40 }, { type: 'string', maxLength: 60 })).toHaveLength(1)
    expect(accepts({ type: 'string', maxLength: 60 }, { type: 'string', maxLength: 40 })).toEqual([])
    expect(accepts({ type: 'string', pattern: '^a$' }, { type: 'string' })).toHaveLength(1)
    expect(accepts({ type: 'integer' }, { type: 'number' })).toHaveLength(1)
    expect(accepts({ type: 'number' }, { type: 'integer' })).toEqual([])
  })
  test('enums: the sender may make fewer values, not more', () => {
    expect(accepts({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] })).toEqual([])
    expect(accepts({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })[0]).toContain('"b" not read')
  })
  test('unions by their type tag: an unknown frame type only where the reader skips it', () => {
    const hello = obj({ type: { type: 'string', const: 'hello' } }, ['type'])
    const ping = obj({ type: { type: 'string', const: 'ping' } }, ['type'])
    expect(accepts({ oneOf: [hello] }, { oneOf: [hello, ping] }, '', { unknownVariantsOk: true })).toEqual([])
    expect(accepts({ oneOf: [hello] }, { oneOf: [hello, ping] })[0]).toContain('"ping"')
  })
})
