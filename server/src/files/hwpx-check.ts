// make_file's .hwpx, the parts outside the writer (files/hwpx-write.ts, which runs only in the office worker):
// - the worker request: pandoc's JSON tree and an optional template, framed on the worker's stdin;
// - the read-back check: the lines a document should read back as (from pandoc's tree, walked here on its own, not
//   with the writer's code) against what hwp.ts reads from the written file. A file that does not read back as the
//   document is not saved.
// Nothing here parses a document: the tree is pandoc's JSON, already parsed by make_file.

/** worker mode that writes a .hwpx (office-worker.ts) */
export const HWPX_WRITE_MODE = 'hwpx-write'
/** The text of one document, in characters: larger ones are refused (hwp.ts reads at most 8M characters back). */
export const HWPX_TEXT_MAX = 6_000_000
/** a template .hwpx (a team's, under skills/) */
export const HWPX_TEMPLATE_MAX = 20 * 1024 * 1024

/** stdin of the worker: 4 bytes (big-endian) for the length of the JSON tree, the tree, then the template's bytes */
export function encodeHwpxRequest(astJson: string, template?: Uint8Array): Uint8Array {
  const json = Buffer.from(astJson, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(json.length, 0)
  return new Uint8Array(Buffer.concat([head, json, Buffer.from(template ?? new Uint8Array())]))
}

export function decodeHwpxRequest(b: Uint8Array): { astJson: string; template: Uint8Array | null } {
  if (b.length < 4) throw new Error('bad request')
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false)
  if (4 + n > b.length) throw new Error('bad request')
  const rest = b.subarray(4 + n)
  return { astJson: new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(4, 4 + n)), template: rest.length ? rest : null }
}

/** Characters XML 1.0 cannot hold (and tabs, which the writer turns into spaces): dropped from text on both sides. */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
export const cleanText = (s: string) => s.replace(NOT_XML, '').replace(/[\t\r]/g, ' ')

interface Node { t?: unknown; c?: unknown }
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v)
const QUOTES: Record<string, [string, string]> = { DoubleQuote: ['“', '”'], SingleQuote: ['‘', '’'] }

/** The text of inlines: `flat` (a heading) joins hard line breaks with a space, as hwp.ts does for headings. Only the
 * inlines the writer supports have text here; it refuses the rest before this is asked. */
function inlineText(inlines: unknown, flat: boolean): string {
  let s = ''
  const stack: unknown[] = [inlines]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') { s += v; continue }
    if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]); continue }
    if (!isNode(v)) continue
    switch (v.t) {
      case 'Str': s += String(v.c ?? ''); break
      case 'Space': case 'SoftBreak': s += ' '; break
      case 'LineBreak': s += flat ? ' ' : '\n'; break
      case 'Strong': case 'Emph': stack.push(v.c); break
      case 'Quoted': {
        const [kind, inner] = (v.c as [Node, unknown]) ?? []
        const q = QUOTES[String(kind?.t)] ?? ['"', '"']
        stack.push(q[1], inner, q[0])
        break
      }
    }
  }
  return s
}

const line = (heading: number, text: string) => (heading ? `${'#'.repeat(heading)} ${text}` : `| ${text}`)
const norm = (s: string) => cleanText(s).replace(/\s+/g, ' ').trim()

/** The lines a document of pandoc's tree reads back as: one per paragraph, `# text` for a heading of that level,
 * `| text` for any other paragraph (a list item or a table cell too, in reading order); empty ones left out. */
export function hwpxExpectedLines(ast: unknown): string[] {
  const out: string[] = []
  const push = (heading: number, text: string) => {
    for (const part of heading ? [text] : text.split('\n')) {
      const t = norm(part)
      if (t) out.push(line(heading, t))
    }
  }
  const blocks = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const b of list) {
      if (!isNode(b)) continue
      const c = b.c as any
      switch (b.t) {
        case 'Header': push(Math.min(6, Number(c?.[0]) || 1), inlineText(c?.[2], true)); break
        case 'Para': case 'Plain': push(0, inlineText(c, false)); break
        case 'BulletList': for (const item of c ?? []) blocks(item); break
        case 'OrderedList': for (const item of c?.[1] ?? []) blocks(item); break
        case 'Table': {
          const rows: unknown[] = [...(c?.[3]?.[1] ?? [])]
          for (const body of c?.[4] ?? []) rows.push(...(body?.[2] ?? []), ...(body?.[3] ?? []))
          rows.push(...(c?.[5]?.[1] ?? []))
          for (const row of rows as any[]) for (const cell of row?.[1] ?? []) blocks(cell?.[4])
          break
        }
      }
    }
  }
  blocks(isNode(ast) ? (ast as { blocks?: unknown }).blocks : [])
  return out
}

/** The same lines from hwp.ts's text of a .hwpx (`# text` only where hwp.ts marked a heading paragraph: it puts a space
 * in front of a body line that starts with `#`). */
export function hwpxReadLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const h = /^(#{1,6}) (.*)$/.exec(raw)
    const t = norm(h ? h[2]! : raw)
    if (t) out.push(line(h ? h[1]!.length : 0, t))
  }
  return out
}

/** null when the two agree, else where they first differ (for the tool error) */
export function firstDifference(want: string[], got: string[]): string | null {
  const clip = (s: string | undefined) => (s === undefined ? '(nothing)' : JSON.stringify(s.length > 120 ? s.slice(0, 120) + '…' : s))
  const n = Math.max(want.length, got.length)
  for (let i = 0; i < n; i++) {
    if (want[i] !== got[i]) return `paragraph ${i + 1}: expected ${clip(want[i])}, read ${clip(got[i])}`
  }
  return null
}
