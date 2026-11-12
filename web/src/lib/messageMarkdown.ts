// A person's words in a room (a message, the note of a shared answer) as Markdown (QA TC-072; docs/DECISIONS.md
// "Markdown in people's messages"): the answer renderer (components/Markdown.tsx PersonMarkdown) with this remark step,
// which keeps what the plain text did:
// - the @names the message mentions stand out (as lib/rooms.ts mentionParts finds them, and after Markdown's marks). They are taken out before the Markdown is
//   read (a placeholder each), so no Markdown can split, eat or restyle a name ("@Kim_Ji_Ho", "@*star*"), and come back
//   as the same mention span. Inside code, a link's address, a picture's words or raw HTML a placeholder goes back to
//   the name as typed (text, no mention);
// - plain web addresses are links by lib/textLinks.ts's rules, as before (GFM's own looser autolinks are undone: no
//   email or "www." rule of its own; an address cut by Korean text stays text);
// - a line break stays a line break (Markdown would join the lines).
// No DOM, no network: test/unit/message-markdown.test.ts.
import { mentionCanStart } from './rooms'
import { linkParts } from './textLinks'

/** A mention to mark: the person (or "all", or the AI) and the name as the message writes it; `strong`: it is me (or
 * "@all" in someone else's message), shown on a soft background. */
export interface MessageMention { id: string; name: string; strong?: boolean; all?: boolean }
/** A name taken out of the text: its words and how it is drawn. */
interface Found { text: string; mention: MessageMention }

const OPEN = ''
const CLOSE = ''
/** Markdown's marks a mention may follow: emphasis, strike, a code span's tick, a list's or quote's sign */
const MARKS = /[*_~`>]/
const TOKEN = /(\d+)/g
/** The class of a mention: the accent colour; mine on a soft background (as RoomMessages drew it before) */
export const mentionClass = (strong?: boolean) => ['font-medium', 'text-accent-text', ...(strong ? ['rounded', 'bg-accent-soft', 'px-0.5'] : [])]

/** The text to read as Markdown, its mentions replaced by placeholders (the characters a placeholder uses, if the
 * text has them itself, become U+FFFD so nothing typed can pose as one). */
export function protectMentions(body: string, mentions: MessageMention[]): { source: string; found: Found[] } {
  const clean = body.replace(/[]/g, '�')
  const found: Found[] = []
  // longest name first, as lib/rooms.ts mentionParts; an "@" may also follow Markdown's own marks ("**@Ben**")
  const names = mentions.filter((m) => m.name).sort((a, b) => b.name.length - a.name.length)
  let source = ''
  for (let i = 0; i < clean.length; ) {
    const hit = clean[i] === '@' && (mentionCanStart(clean, i) || MARKS.test(clean[i - 1] ?? '')) ? names.find((m) => clean.startsWith(m.name, i + 1)) : undefined
    if (hit) {
      found.push({ text: `@${hit.name}`, mention: hit })
      source += `${OPEN}${found.length - 1}${CLOSE}`
      i += hit.name.length + 1
    } else source += clean[i++]
  }
  return { source, found }
}

/** The text of `s` with its placeholders back as the names typed. */
const restore = (s: string, found: Found[]) => s.replace(TOKEN, (m, i: string) => found[Number(i)]?.text ?? m)

// mdast, as far as this step needs it (web has no @types/mdast)
interface Node {
  type: string
  value?: string
  url?: string
  alt?: string | null
  title?: string | null
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] }
}

/** The pieces of one text node: mentions, plain addresses (not inside a link) and line breaks. */
function split(value: string, found: Found[], inLink: boolean): Node[] {
  const out: Node[] = []
  const words = (s: string) => {
    s.split('\n').forEach((line, i) => {
      if (i > 0) out.push({ type: 'break' })
      if (line) out.push({ type: 'text', value: line })
    })
  }
  let last = 0
  const plain = (s: string) => {
    if (!s) return
    if (inLink) return words(s)
    for (const p of linkParts(s)) {
      if (p.href) out.push({ type: 'link', url: p.href, title: null, children: [{ type: 'text', value: p.text }], data: { hProperties: { dataPlain: '' } } })
      else words(p.text)
    }
  }
  for (const m of value.matchAll(TOKEN)) {
    plain(value.slice(last, m.index))
    const f = found[Number(m[1])]
    if (f) {
      const props: Record<string, unknown> = { className: mentionClass(f.mention.strong) }
      if (f.mention.all) props.dataMention = 'all'
      out.push({ type: 'text', value: f.text, data: { hName: 'span', hProperties: props, hChildren: [{ type: 'text', value: f.text }] } })
    } else plain(m[0])
    last = m.index + m[0].length
  }
  plain(value.slice(last))
  return out
}

/** Nodes whose children are blocks (where an HTML block can stand). */
const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** The remark step for a person's words (after remark-gfm); `found`: what protectMentions took out. */
export function personWords({ found }: { found: Found[] }) {
  return (tree: Node, file: { value?: unknown }) => {
    const src = typeof file.value === 'string' ? file.value : ''
    const walk = (node: Node, inLink: boolean) => {
      if (node.children) {
        // GFM's autolink literals ("https://…", "www.…", "a@b.c" with no [ ] or < >) back to text, then neighbouring
        // texts joined, so lib/textLinks.ts reads the address with the words around it as before
        // raw HTML is words: a block of it a paragraph of text, inline HTML text (so its mentions, addresses and line
        // breaks are kept as in the rest of the message; nothing of it is ever HTML)
        const flow = FLOW.has(node.type)
        const kids: Node[] = []
        for (const c0 of node.children) {
          const c: Node = c0.type !== 'html' ? c0 : flow ? { type: 'paragraph', children: [{ type: 'text', value: c0.value ?? '' }] } : { type: 'text', value: c0.value ?? '' }
          const at = c.position?.start.offset
          const literal = c.type === 'link' && at !== undefined && src[at] !== '[' && src[at] !== '<'
          for (const k of literal ? (c.children ?? []) : [c]) {
            const prev = kids.at(-1)
            if (k.type === 'text' && prev?.type === 'text' && !prev.data) prev.value = (prev.value ?? '') + (k.value ?? '')
            else kids.push(k.type === 'text' ? { type: 'text', value: k.value ?? '' } : k)
          }
        }
        const link = inLink || node.type === 'link' || node.type === 'linkReference'
        node.children = kids.flatMap((c) => (c.type === 'text' ? split(c.value ?? '', found, link) : (walk(c, link), [c])))
      }
      // a placeholder anywhere else (code, raw HTML, an address, a picture's words): the name as typed
      if (node.type !== 'text' && typeof node.value === 'string') node.value = restore(node.value, found)
      if (typeof node.url === 'string') node.url = restore(node.url, found)
      if (typeof node.alt === 'string') node.alt = restore(node.alt, found)
      if (typeof node.title === 'string') node.title = restore(node.title, found)
    }
    walk(tree, false)
  }
}
