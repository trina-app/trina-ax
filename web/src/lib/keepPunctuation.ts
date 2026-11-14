import type { Element, ElementContent, Root } from 'hast'

/** Punctuation that belongs to the word before it: a comma, full stop, closing bracket or quote, also the CJK ones. */
const TRAILING = /^[,.;:!?)\]}%、。，．；：！？）］｝」』〉》”’»]+/

/**
 * A link followed at once by punctuation ("the [file], and ...") keeps that punctuation on its line: the link and the
 * punctuation go into one span that does not break between them. A file link is a button (atomic inline), and a line
 * may break between it and the comma after it, which then starts the next line (QA TC-1294). The span's own
 * `white-space: nowrap` ends at the link (`[&>*]:whitespace-normal`), so a long link text still wraps inside itself.
 */
export function keepPunctuation() {
  return (tree: Root) => {
    const visit = (node: { children: ElementContent[] }) => {
      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i]!
        if (c.type !== 'element') continue
        const next = node.children[i + 1]
        if (c.tagName === 'a' && next?.type === 'text') {
          const m = TRAILING.exec(next.value)
          if (m) {
            const rest = next.value.slice(m[0].length)
            const span: Element = { type: 'element', tagName: 'span', properties: { className: ['whitespace-nowrap', '[&>*]:whitespace-normal'] }, children: [c, { type: 'text', value: m[0] }] }
            node.children.splice(i, 2, span, ...(rest ? [{ type: 'text' as const, value: rest }] : []))
            continue
          }
        }
        visit(c)
      }
    }
    visit(tree as unknown as { children: ElementContent[] })
  }
}
