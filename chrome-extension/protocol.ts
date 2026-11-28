// What one extension version and the team server say to each other, as a snapshot a newer server is checked against
// (tests/unit/chrome-ext-protocol.test.ts; docs/RELEASE-CI.md "Chrome extension releases"). People update the extension
// when the store gets to it and the team server on its own schedule, so a server must keep working with the extension
// versions already in the store. Each released version leaves tests/fixtures/chrome-protocol/<version>.json:
//   - the WebSocket subprotocol and the addresses the extension opens,
//   - what it reads (the server's frames, the redeem answer) and what it sends (its frames, the redeem body), as JSON
//     Schema from the shared zod contract (shared/src/api/chrome.ts) of that version.
// The test then asks of today's contract: does the server accept everything that version can send, and does that
// version accept everything the server can send now? (`accepts` below; a frame type the old version does not know is
// fine: the extension skips a frame it cannot read.)
// zod is the shared package's dependency (the root has none): the same copy the contract was built with
import { z } from '../shared/node_modules/zod'
import {
  API, CHROME_CONNECT_DONE_PATH, CHROME_CONNECT_PATH, CHROME_WS_PATH, CHROME_WS_PROTOCOL,
  ChromeClientFrame, ChromeRedeemBody, ChromeRedeemed, ChromeServerFrame,
} from '../shared/src/api'

export type Schema = Record<string, unknown>

export interface ProtocolSnapshot {
  version: string
  protocol: string
  paths: Record<string, string>
  /** what the extension reads */
  reads: { serverFrame: Schema; redeemed: Schema }
  /** what the extension sends */
  sends: { clientFrame: Schema; redeem: Schema }
}

const json = (s: z.ZodType) => {
  const out = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Schema
  delete out.$schema
  return out
}

export function protocolSnapshot(version: string): ProtocolSnapshot {
  return {
    version,
    protocol: CHROME_WS_PROTOCOL,
    paths: { ws: CHROME_WS_PATH, connect: CHROME_CONNECT_PATH, connectDone: CHROME_CONNECT_DONE_PATH, redeem: API.chromeRedeem.path, upload: API.chromeUpload.path },
    reads: { serverFrame: json(ChromeServerFrame), redeemed: json(ChromeRedeemed) },
    sends: { clientFrame: json(ChromeClientFrame), redeem: json(ChromeRedeemBody) },
  }
}

/** today's contract as the snapshot's other side sees it */
export const currentContract = () => protocolSnapshot('current')

const NUM_MAX = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const
const NUM_MIN = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const
const variants = (s: Schema) => (s.oneOf ?? s.anyOf) as Schema[] | undefined
const tag = (s: Schema) => ((s.properties as Record<string, Schema> | undefined)?.type?.const as string | undefined)
const typeOf = (s: Schema) => s.type as string | undefined
const isAny = (s: Schema) => Object.keys(s).filter((k) => k !== 'description').length === 0

/**
 * Where `consumer` would refuse a value `producer` allows (empty: every value the producer can make, the consumer
 * reads). JSON Schema as zod writes it: objects, strings, numbers, booleans, arrays, unions (oneOf/anyOf), const and
 * enum. `unknownVariantsOk`: at the top level a union member the consumer has no match for is fine (the extension
 * skips a frame type it does not know).
 */
export function accepts(consumer: Schema, producer: Schema, at = '', o: { unknownVariantsOk?: boolean } = {}): string[] {
  if (isAny(consumer)) return []
  const cv = variants(consumer), pv = variants(producer)
  if (pv) {
    const out: string[] = []
    for (const p of pv) {
      const t = tag(p)
      if (cv) {
        const same = t !== undefined ? cv.filter((c) => tag(c) === t) : cv
        if (!same.length) { if (!o.unknownVariantsOk) out.push(`${at || '(top)'}: a "${t ?? '?'}" the other side does not know`); continue }
        const tries = same.map((c) => accepts(c, p, t ? `${at}[${t}]` : at))
        if (!tries.some((r) => r.length === 0)) out.push(...tries[0]!)
      } else out.push(...accepts(consumer, p, at))
    }
    return out
  }
  if (cv) {
    const tries = cv.map((c) => accepts(c, producer, at))
    return tries.some((r) => r.length === 0) ? [] : tries[0]!
  }
  const out: string[] = []
  const ct = typeOf(consumer), pt = typeOf(producer)
  if (ct && ct !== pt && !(ct === 'number' && pt === 'integer')) return [`${at}: ${pt ?? 'any'} where ${ct} is read`]
  if ('const' in consumer && consumer.const !== producer.const) out.push(`${at}: must be ${JSON.stringify(consumer.const)}`)
  if (Array.isArray(consumer.enum)) {
    const made = Array.isArray(producer.enum) ? producer.enum : 'const' in producer ? [producer.const] : null
    const extra = made ? made.filter((v) => !(consumer.enum as unknown[]).includes(v)) : ['any value']
    if (extra.length) out.push(`${at}: ${extra.map((v) => JSON.stringify(v)).join(', ')} not read`)
  }
  if (typeof consumer.pattern === 'string' && consumer.pattern !== producer.pattern && !('const' in producer)) out.push(`${at}: the pattern ${consumer.pattern} is new`)
  for (const k of NUM_MAX) if (typeof consumer[k] === 'number' && !(typeof producer[k] === 'number' && producer[k] <= consumer[k])) out.push(`${at}: ${k} ${String(producer[k] ?? 'none')} where ${consumer[k]} is read`)
  for (const k of NUM_MIN) if (typeof consumer[k] === 'number' && !(typeof producer[k] === 'number' && producer[k] >= consumer[k])) out.push(`${at}: ${k} ${String(producer[k] ?? 'none')} where ${consumer[k]} is read`)
  if (ct === 'object') {
    const cp = (consumer.properties ?? {}) as Record<string, Schema>
    const pp = (producer.properties ?? {}) as Record<string, Schema>
    const preq = new Set((producer.required ?? []) as string[])
    for (const k of (consumer.required ?? []) as string[]) if (!preq.has(k)) out.push(`${at}.${k}: read as required, not always sent`)
    for (const [k, p] of Object.entries(pp)) {
      if (cp[k]) out.push(...accepts(cp[k]!, p, `${at}.${k}`))
      else if (consumer.additionalProperties === false) out.push(`${at}.${k}: sent but refused (a strict object)`)
    }
    if (consumer.additionalProperties && typeof consumer.additionalProperties === 'object' && producer.additionalProperties && typeof producer.additionalProperties === 'object')
      out.push(...accepts(consumer.additionalProperties as Schema, producer.additionalProperties as Schema, `${at}.*`))
  }
  if (ct === 'array' && consumer.items && producer.items) out.push(...accepts(consumer.items as Schema, producer.items as Schema, `${at}[]`))
  return out
}

/** Every way today's server would fail the extension version of `old` (empty: they work together). */
export function incompatibilities(old: ProtocolSnapshot, now: Omit<ProtocolSnapshot, 'version'> = currentContract()): string[] {
  const out: string[] = []
  if (old.protocol !== now.protocol) out.push(`the WebSocket subprotocol is ${now.protocol}; ${old.version} offers ${old.protocol} (accept both)`)
  for (const [k, p] of Object.entries(old.paths)) if (now.paths[k] !== p) out.push(`${k}: ${old.version} opens ${p}, the server now serves ${now.paths[k] ?? 'nothing'}`)
  const tagged = (side: string, l: string[]) => l.map((x) => `${side} ${x}`)
  out.push(...tagged('server frame', accepts(old.reads.serverFrame, now.reads.serverFrame, '', { unknownVariantsOk: true })))
  out.push(...tagged('redeem answer', accepts(old.reads.redeemed, now.reads.redeemed)))
  out.push(...tagged('extension frame', accepts(now.sends.clientFrame, old.sends.clientFrame)))
  out.push(...tagged('redeem body', accepts(now.sends.redeem, old.sends.redeem)))
  return out
}
