// Links in the Markdown make_file turns into a Word, PowerPoint or PDF file (QA TC-4949; docs/decisions/20261118-docx-link-schemes.md).
// A link in an Office file opens whatever it points at when someone clicks it: file:///C:/...exe, a network share
// (\\host\share, which also hands the reader's Windows sign-in to that host), javascript:, a protocol handler such as
// ms-word:, search-ms: or ms-msdt:, or a relative path such as ..\..\x.exe next to wherever the file is saved. The
// only targets a file made here may carry are web pages (http, https), mail addresses (mailto) and places inside the
// document (#name).
// Here, on the server, every Link node of pandoc's tree whose target is not allowed becomes its plain text, and the AI
// is told which targets were dropped. The finished package is checked again in the office worker, where a real XML
// parser catches whatever a template or our own header and footer code wrote (files/office-links-check.ts).
import { allowedLinkTarget } from '../files/office-rules'

export { allowedLinkTarget }

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s)
/** a target as it can be quoted to the AI: control and format characters shown, not acted on */
// eslint-disable-next-line no-control-regex
const shown = (s: string) => clip(s.replace(/[\x00-\x1f\x7f\p{Cf}]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`))

/**
 * Every Link node of pandoc's tree whose target is not allowed becomes a Span with the same attributes and words.
 * Walks the whole tree (metadata, footnotes, tables included), without recursion. Returns the dropped targets.
 */
export function stripUnsafeLinks(ast: unknown): string[] {
  const dropped: string[] = []
  const stack: unknown[] = [ast]
  while (stack.length) {
    const v = stack.pop()
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue }
    if (!v || typeof v !== 'object') continue
    const node = v as { t?: unknown; c?: unknown }
    if (node.t === 'Link' && Array.isArray(node.c)) {
      const target = Array.isArray(node.c[2]) ? node.c[2][0] : undefined
      if (typeof target !== 'string' || !allowedLinkTarget(target)) {
        dropped.push(shown(String(target ?? '')))
        const attr = Array.isArray(node.c[0]) ? node.c[0] : ['', [], []]
        node.t = 'Span'
        node.c = [attr, Array.isArray(node.c[1]) ? node.c[1] : []]
      }
    }
    for (const x of Object.values(node)) if (x && typeof x === 'object') stack.push(x)
  }
  return dropped
}
