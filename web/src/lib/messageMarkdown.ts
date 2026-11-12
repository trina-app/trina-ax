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
      // one placeholder per name, so "[@Ben]" and its "[@Ben]: …" definition still match
      let n = found.findIndex((f) => f.mention === hit)
      if (n < 0) n = found.push({ text: `@${hit.name}`, mention: hit }) - 1
      source += `${OPEN}${n}${CLOSE}`
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
  label?: string | null
  identifier?: string
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
const FLOW = new Set(['root', 'blockquote', 'listItem'])

/** The text of a node and what is in it, its placeholders back as the names typed. */
const textOf = (n: Node, found: Found[]): string => restore(n.type === 'text' || n.type === 'inlineCode' ? (n.value ?? '') : (n.children ?? []).map((c) => textOf(c, found)).join(''), found)

/** The host a link opens, without "www." (null: no address) */
function hostOf(url: string): string | null {
  try {
    return new URL(url, 'http://localhost').host.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** What one child becomes before its words are read:
 * - raw HTML is words: a block of it a paragraph of text, inline HTML text (its mentions, addresses and line breaks are
 *   kept as in the rest of the message; nothing of it is ever HTML);
 * - GFM's autolink literals ("https://…", "www.…", "a@b.c" with no [ ] or < >) are their text again (textLinks rules);
 * - a reference link is its definition's link (the checks below);
 * - a footnote ("x[^1]", "[^1]: note") is its text: its links and ids would jump out of the room ("/#user-content-fn-1")
 *   and repeat in every message; a link to "#…" the same;
 * - a link whose words are another site's address ("[https://bank.com](https://evil.example)"), or look like one,
 *   shows where it really goes: its words, then the real address as a link in brackets. */
function expand(c0: Node, flow: boolean, src: string, found: Found[], defs: Map<string, Node>): Node[] {
  const text = (value: string): Node => ({ type: 'text', value })
  // a reference link ("[words][r]" … "[r]: https://…") is the link its definition makes, so the same checks see it
  const def = c0.type === 'linkReference' ? defs.get(c0.identifier ?? '') : undefined
  const c: Node = def ? { type: 'link', url: def.url ?? '', title: def.title ?? null, children: c0.children ?? [], position: c0.position } : c0
  if (c.type === 'html') return [flow ? { type: 'paragraph', children: [text(c.value ?? '')] } : text(c.value ?? '')]
  if (c.type === 'footnoteReference') return [text(`[^${c.label ?? c.identifier ?? ''}]`)]
  if (c.type === 'footnoteDefinition') {
    const kids = [...(c.children ?? [])]
    const mark = text(`[^${c.label ?? c.identifier ?? ''}]: `)
    if (kids[0]?.type === 'paragraph') kids[0] = { ...kids[0], children: [mark, ...(kids[0].children ?? [])] }
    else kids.unshift({ type: 'paragraph', children: [mark] })
    return kids.flatMap((k) => expand(k, true, src, found, defs))
  }
  if (c.type !== 'link') return [c]
  const at = c.position?.start.offset
  if ((at !== undefined && src[at] !== '[' && src[at] !== '<') || (c.url ?? '').startsWith('#')) return c.children ?? []
  // (words that only look like an address, "https://bank.com@x.y" or "https://bank．com", show it too)
  const words = textOf(c, found)
  const shown = linkParts(words).find((p) => p.href)
  const real = restore(c.url ?? '', found)
  if ((shown && hostOf(shown.href!) !== hostOf(real)) || (!shown && /:\/\/|www\./i.test(words)))
    return [...(c.children ?? []), text(' ('), { type: 'link', url: real, title: null, children: [text(real)], data: { hProperties: { dataPlain: '' } } }, text(')')]
  return [c]
}

/** The remark step for a person's words (after remark-gfm); `found`: what protectMentions took out. */
export function personWords({ found }: { found: Found[] }) {
  return (tree: Node, file: { value?: unknown }) => {
    const src = typeof file.value === 'string' ? file.value : ''
    // the definitions of reference links, by their identifier
    const defs = new Map<string, Node>()
    const collect = (n: Node) => {
      if (n.type === 'definition' && n.identifier && !defs.has(n.identifier)) defs.set(n.identifier, n)
      n.children?.forEach(collect)
    }
    collect(tree)
    const walk = (node: Node, inLink: boolean) => {
      if (node.children) {
        // (expand), then neighbouring texts joined, so lib/textLinks.ts reads an address with the words around it
        const flow = FLOW.has(node.type)
        const kids: Node[] = []
        for (const c0 of node.children) {
          for (const k of expand(c0, flow, src, found, defs)) {
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
