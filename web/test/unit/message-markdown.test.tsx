// People's messages in rooms, DMs and threads render Markdown like the AI's answers (QA TC-072; lib/messageMarkdown.ts,
// components/Markdown.tsx PersonMarkdown): the formatting renders, line breaks stay, mentions still stand out and plain
// addresses are links; nothing a person types is ever HTML, a javascript: link, or a picture that loads by itself. A
// quote of a message and a message being sent stay plain.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7 } from '@mycel/shared/api'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { PersonMarkdown } from '../../src/components/Markdown'
import { protectMentions, type MessageMention } from '../../src/lib/messageMarkdown'
import type { PendingSend } from '../../src/store/rooms'
import { BEN, CY, ME, message } from './rooms-fixtures'

const R = uuidv7()
type Ms = ReturnType<typeof message>[]
const render = (ms: Ms, pending: PendingSend[] = []) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RoomMessages roomId={R} messages={ms} pending={pending} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />
    </MemoryRouter>,
  )
/** one message from Ben, the words of its Markdown block */
const words = (body: string, mentions: string[] = []) => {
  const html = render([message({ roomId: R, seq: 1, body, mentions })])
  const at = html.indexOf('data-testid="message-markdown"')
  expect(at).toBeGreaterThan(0)
  return html.slice(at, html.indexOf('role="toolbar"', at))
}
const md = (text: string, mentions: MessageMention[] = []) => renderToStaticMarkup(<MemoryRouter><PersonMarkdown text={text} mentions={mentions} /></MemoryRouter>)

test('bold, italic, code, lists, code blocks and links render like an answer; line breaks stay', () => {
  const h = words('**bold** *italic* `code`\nnext line\n\n- one\n- two\n\n```\nconst a = 1\n```\n\n[Trina](https://trina.app)')
  expect(h).toContain('<strong>bold</strong>')
  expect(h).toContain('<em>italic</em>')
  expect(h).toContain('<code>code</code><br/>\nnext line')
  expect(h).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
  expect(h).toContain('const a = 1')
  expect(h).toContain('<pre')
  const a = /<a [^>]*>Trina<\/a>/.exec(h)![0]
  expect(a).toContain('href="https://trina.app/"')
  expect(a).toContain('target="_blank"')
  expect(a).toContain('rel="noopener noreferrer nofollow"')
  expect(a).toMatch(/referrerPolicy="no-referrer"/i)
})

test('raw HTML is its text: <b>, <script>, <img onerror>, an HTML block with a mention and line breaks', () => {
  expect(words('<b>hi</b>')).toContain('&lt;b&gt;hi&lt;/b&gt;')
  const s = words('<script>alert(1)</script>')
  expect(s).not.toContain('<script')
  expect(s).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  const i = words('<img src=x onerror=alert(1)>\n@Cy Park look', [CY.id])
  expect(i).not.toMatch(/<img/)
  expect(i).toContain('&lt;img src=x onerror=alert(1)&gt;<br/>\n<span class="font-medium text-accent-text">@Cy Park</span> look')
  const d = words('<div onclick="x()">a</div>\n<iframe src="https://evil.example"></iframe>')
  expect(d).not.toMatch(/<div onclick|<iframe/)
  // an HTML comment is shown too: nothing in a message is hidden
  expect(words('a <!-- hidden --> b')).toContain('&lt;!-- hidden --&gt;')
})

test('HTML entities are text, never markup', () => {
  const h = words('&lt;script&gt;x&lt;/script&gt; &#60;img src=x onerror=alert(1)&#62; &amp;')
  expect(h).not.toMatch(/<script|<img/)
  expect(h).toContain('&lt;script&gt;x&lt;/script&gt;')
  expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;')
})

test('javascript:, data: and other schemes never become links; the words stay', () => {
  for (const body of ['[click](javascript:alert(1))', '[click](JaVaScRiPt:alert(1))', '[click](java&#x73;cript:alert(1))', '[click](  javascript:alert(1) )', '[click](data:text/html,<script>alert(1)</script>)', '[click](vbscript:x)', '[click](file:///etc/passwd)']) {
    const h = words(body)
    expect(h).not.toContain('<a ')
    expect(h).not.toMatch(/href="(?!https?:|\/)/i)
    expect(h).toContain('click')
  }
  expect(words('<javascript:alert(1)>')).not.toContain('<a ')
  // a reference link the same
  expect(words('[click][x]\n\n[x]: javascript:alert(1)')).not.toContain('<a ')
})

test("pictures never load by themselves: another site's is the answers' card, a team file a link, data: its words", () => {
  const ext = words('![pixel](https://evil.example/t.png?u=me)')
  expect(ext).not.toMatch(/<img/)
  expect(ext).toMatch(/<a href="https:\/\/evil\.example\/t\.png\?u=me" target="_blank" rel="noopener noreferrer nofollow"/)
  expect(words('![x](data:image/png;base64,iVBORw0KGgo=)')).not.toMatch(/<img/)
  expect(words('![x](/api/files/download?path=a/b.png)')).not.toMatch(/<img/)
  expect(words('![x](javascript:alert(1))')).not.toMatch(/<img|<a /)
})

test('mentions still stand out: inside bold, as a link label, next to Markdown; not inside code', () => {
  expect(words('**@Cy Park** look', [CY.id])).toContain('<strong><span class="font-medium text-accent-text">@Cy Park</span></strong> look')
  expect(words('@Cy Park\n@Ada', [CY.id, ME.id])).toContain('<span class="font-medium text-accent-text">@Cy Park</span><br/>\n<span class="font-medium text-accent-text rounded bg-accent-soft px-0.5">@Ada</span>')
  expect(words('[@Cy Park](https://example.com)', [CY.id])).toMatch(/<a [^>]*><span class="font-medium text-accent-text">@Cy Park<\/span><\/a>/)
  const code = words('`@Cy Park` and\n```\n@Cy Park\n```', [CY.id])
  expect(code).toContain('<code>@Cy Park</code>')
  expect(code.match(/text-accent-text">@Cy Park/g)?.length ?? 0).toBe(0)
  // a name Markdown would read as formatting stays one name
  const odd: MessageMention[] = [{ id: 'k', name: 'Kim_Ji_Ho_' }, { id: 's', name: '*star* <b>' }]
  const h = md('@Kim_Ji_Ho_ and @*star* <b> hi _x_', odd)
  expect(h).toContain('<span class="font-medium text-accent-text">@Kim_Ji_Ho_</span>')
  expect(h).toContain('<span class="font-medium text-accent-text">@*star* &lt;b&gt;</span> hi <em>x</em>')
  // a mention's name is never markup, and nothing typed poses as a placeholder
  expect(protectMentions('0 @x', [{ id: 'x', name: 'x' }]).source).toBe('�0� 0')
  expect(md('0', [])).not.toContain('text-accent-text')
  // "@전체": data-mention="all", soft background in someone else's message
  expect(md('@all now', [{ id: '*', name: 'all', all: true, strong: true }])).toContain('<span class="font-medium text-accent-text rounded bg-accent-soft px-0.5" data-mention="all">@all</span>')
})

test('plain addresses are links by the room rules (in Markdown too); email and "www." in words as before', () => {
  const h = words('**see https://example.com/a_b_c** and https://x.y/a에서 or me@example.com')
  expect(h).toMatch(/<strong>see <a href="https:\/\/example\.com\/a_b_c"[^>]*data-testid="room-link"/)
  expect(h).toContain('</a>에서')
  expect(h).not.toContain('mailto:')
  expect(h).toContain('me@example.com')
  expect(words('go www.example.org/a.')).toContain('href="https://www.example.org/a"')
  // an address with a user name stays text as before
  expect(words('https://bank.com@evil.example/x')).not.toContain('<a ')
})

test("a chat's own signs stay words: 3~5, prices, # without a space; a Mermaid fence is code", () => {
  const h = words('3~5분, 7~8시 cost $5 and $10 #tag')
  expect(h).not.toContain('<del>')
  expect(h).not.toContain('katex')
  expect(h).toContain('3~5분, 7~8시 cost $5 and $10 #tag')
  expect(words('```mermaid\ngraph TD; A-->B\n```')).not.toContain('md-mermaid')
})

test('"edited" stays on the last line; a quote and a message being sent stay plain', () => {
  const ed = words('**fixed**', [])
  expect(ed).toContain('<strong>fixed</strong>')
  const edited = render([message({ roomId: R, seq: 1, body: '**fixed**', editedAt: new Date().toISOString() })])
  expect(edited).toMatch(/<\/p><span class="ml-1 text-xs text-faint select-none">/)
  const q = message({ roomId: R, seq: 1, body: '**bold** <b>x</b>' })
  const reply = message({ roomId: R, seq: 2, author: CY, body: 'ok', replyTo: { id: q.id, author: BEN, excerpt: q.body, fileCount: 0, deleted: false } })
  const p = { clientMessageId: 'c1', body: '*sending* `x`', files: [], mentions: [], state: 'sending' } as unknown as PendingSend
  const html = render([q, reply], [p])
  const quote = html.slice(html.indexOf('data-testid="message-quote"'))
  expect(quote).toContain('**bold** &lt;b&gt;x&lt;/b&gt;')
  const pending = html.slice(html.indexOf('room-pending-message'))
  expect(pending).toContain('*sending* `x`')
})
