// People's messages in rooms, DMs and threads render Markdown like the AI's answers (QA TC-072; lib/messageMarkdown.ts,
// components/Markdown.tsx PersonMarkdown): the formatting renders, line breaks stay, mentions still stand out and plain
// addresses are links; nothing a person types is ever HTML, a javascript: link, or a picture that loads by itself. A
// quote of a message and a message being sent stay plain.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7 } from '@mycel/shared/api'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { Markdown, PersonMarkdown } from '../../src/components/Markdown'
import { capDepth, footnotesTooHeavy, MAX_TABLE_CELLS, tableTooBig, hiddenAddress, MAX_AUTOLINK_TRIES, MAX_FOOTNOTES, MAX_LINE_MARKS, MAX_LINES, MAX_LOOSE, MAX_NEST, MAX_OPEN, tooHeavyForMarkdown, protectMentions, type MessageMention } from '../../src/lib/messageMarkdown'
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

test('footnotes and "#…" links are text (no jump out of the room, no repeated ids); a link names where it really goes', () => {
  const f = words('x[^1] and [top](#top)\n\n[^1]: note')
  expect(f).not.toContain('<a ')
  expect(f).not.toContain('user-content')
  expect(f).toContain('x[^1] and top')
  expect(f).toContain('[^1]: note')
  // the words name one site, the link goes to another: both are shown, each a link to itself
  const d = words('[https://bank.com/login](https://evil.example/x)')
  expect(d).toMatch(/<a href="https:\/\/bank\.com\/login"[^>]*>https:\/\/<wbr\/>bank\.com\/<wbr\/>login<\/a> \(<a href="https:\/\/evil\.example\/x"/)
  // the same site, or words that are no address: a link as written
  expect(words('[https://trina.app/docs](https://www.trina.app/docs#a)')).toMatch(/<a href="https:\/\/www\.trina\.app\/docs#a"[^>]*>https:\/\/trina\.app\/docs<\/a>/)
  expect(words('[report.pdf](https://example.com/r.pdf)')).toMatch(/<a href="https:\/\/example\.com\/r\.pdf"[^>]*>report\.pdf<\/a>/)
  expect(words('[x](javascript:alert(1)) [https://a.com](javascript:alert(1))')).not.toMatch(/href="javascript/)
  // a reference link whose label is a mention still finds its definition
  expect(words('[@Cy Park]\n\n[@Cy Park]: https://example.com/cy', [CY.id])).toMatch(/<a href="https:\/\/example\.com\/cy"[^>]*><span class="font-medium text-accent-text">@Cy Park<\/span><\/a>/)
  // reference links get the same checks; words that only look like an address show the real one too
  for (const body of ['[https://bank.com][r]\n\n[r]: https://evil.example/x', '[https://bank.com]\n\n[https://bank.com]: https://evil.example/x', '[https://bank.com@x.y](https://evil.example/x)', '[https://bank\uff0ecom](https://evil.example/x)'])
    expect(words(body)).toMatch(/ \(<a href="https:\/\/evil\.example\/x"[^>]*>https:\/\/<wbr\/>evil\.example\/<wbr\/>x<\/a>\)/)
  expect(words('[x][r]\n\n[r]: #top')).not.toContain('<a ')
  expect(words('[docs][r]\n\n[r]: https://example.com/d')).toMatch(/<a href="https:\/\/example\.com\/d"[^>]*>docs<\/a>/)
  // raw HTML in a footnote's text is a paragraph's words too
  expect(words('[^1]: note\n\n    more\n\nx')).not.toContain('<a ')
  // read without footnotes, "[^1]" is no link to its "definition", and the definition is not hidden
  const g = words('x[^1] and [see][^1]\n\n[^1]: note "title"\n[^2]: https://evil.example')
  expect(g).not.toContain('href="note"')
  expect(g).toContain('x[^1] and [see][^1]')
  expect(g).toContain('[^1]: note &quot;title&quot;')
  expect(g).toMatch(/\[\^2\]: <a href="https:\/\/evil\.example\/"/)
})

// ---- review of PR #514 (revmd): nesting that blanked the app, links whose words hide where they go ----

/** how deep `tag` nests in `html` */
const depthOf = (html: string, tag: string) => {
  let d = 0
  let max = 0
  for (const m of html.matchAll(new RegExp(`<(/?)${tag}[ >]`, 'g'))) {
    d += m[1] ? -1 : 1
    max = Math.max(max, d)
  }
  return max
}
const answer = (text: string) => renderToStaticMarkup(<MemoryRouter><Markdown text={text} /></MemoryRouter>)

test('quotes, lists and emphasis nested thousands deep render (at most MAX_NEST deep), in messages and in answers', () => {
  const deep = ['- '.repeat(1000) + 'x', '- '.repeat(2500) + 'x', '>'.repeat(2000) + ' x', '>'.repeat(5000) + ' x', '* '.repeat(4000) + 'x', '1. '.repeat(3000) + 'x', '> - '.repeat(2000) + 'x']
  // (an AI's answer has no plain fallback: capDepth alone, so only the faster ones here)
  for (const body of deep)
    for (const html of [md(body), ...(body.length < 2100 ? [answer(body)] : [])]) {
      expect(html).toContain('x')
      for (const tag of ['blockquote', 'ul', 'ol', 'li']) expect(depthOf(html, tag)).toBeLessThanOrEqual(MAX_NEST + 1)
      expect(depthOf(html, 'blockquote') + depthOf(html, 'ul') + depthOf(html, 'ol')).toBeLessThanOrEqual(MAX_NEST + 2)
    }
  // a line of thousands of signs is too slow to read as Markdown: its plain words (fast), as a message being sent
  const t = performance.now()
  for (const body of deep) expect(md(body)).toContain('data-plain=""')
  expect(performance.now() - t).toBeLessThan(2000)
  // so are hundreds of "[" or emphasis openers, and a long run mixing "*" and "_" (each took the parser 1-2 s)
  for (const body of ['!['.repeat(1600) + 'x' + '](u)'.repeat(1600), '!['.repeat(2000) + '](u)'.repeat(1500), '*x '.repeat(1666) + 'x* '.repeat(1666), '_x '.repeat(1666) + 'x_ '.repeat(1666), '*_'.repeat(5000)])
    expect(md(body.slice(0, 10_000))).toContain('data-plain=""')
  // ordinary Markdown is not: a banner or a fill-in line of one sign, a list of "* " items, snake_case words
  for (const body of ['- a\n  - b\n    > c', '1. one\n2. two', '***bold italic***', '---', '* * *', '- '.repeat(MAX_LINE_MARKS) + 'x', '_'.repeat(200), '/' + '*'.repeat(200) + '/', '* item\n'.repeat(1000), 'snake_case_name '.repeat(500), '[a](https://a.b) '.repeat(1000), '**x** '.repeat(1600), '*x '.repeat(MAX_OPEN) + 'x* '.repeat(MAX_OPEN)])
    expect(tooHeavyForMarkdown(body)).toBe(false)
  for (const body of ['- '.repeat(MAX_LINE_MARKS + 1) + 'x', 'ok\n' + '> '.repeat(40) + 'x', '1) '.repeat(40), '*_'.repeat(33), '['.repeat(MAX_OPEN + 1), '_x '.repeat(MAX_OPEN + 1)])
    expect(tooHeavyForMarkdown(body)).toBe(true)
  // an AI's answer keeps its Markdown whatever it holds (a C banner in a code block)
  expect(answer('```c\n/' + '*'.repeat(80) + '/\n```\n\n**bold**')).toContain('<strong>bold</strong>')
  // what is past the cap is still there, at the deepest level allowed
  const q = md('>'.repeat(20) + ' deep words')
  expect(depthOf(q, 'blockquote')).toBe(MAX_NEST)
  expect(q).toContain('deep words')
  const l = md(Array.from({ length: 30 }, (_, i) => `${'  '.repeat(i)}- item ${i}`).join('\n'))
  expect(depthOf(l, 'ul')).toBe(MAX_NEST)
  for (const i of [0, 7, 8, 29]) expect(l).toContain(`item ${i}`)
  const q2 = md(('> '.repeat(30) + 'x\n').repeat(100))
  expect(depthOf(q2, 'blockquote')).toBe(MAX_NEST)
  // a list or quote up to the cap is as written
  expect(depthOf(md('- a\n  - b\n    - c'), 'ul')).toBe(3)
  // emphasis inside emphasis, as deep as a message allows
  const em = md('*'.repeat(3000) + 'a' + '*'.repeat(3000))
  expect(depthOf(em, 'em') + depthOf(em, 'strong')).toBeLessThanOrEqual(MAX_NEST)
  expect(em).toContain('a')
  // a tree no recursion could walk
  const tree = { type: 'root', children: [] as unknown[] }
  let at = tree
  for (let i = 0; i < 200_000; i++) {
    const q2 = { type: 'blockquote', children: [] as unknown[] }
    at.children.push(q2)
    at = q2
  }
  at.children.push({ type: 'paragraph', children: [{ type: 'text', value: 'bottom' }] })
  capDepth(tree as never)
  expect(JSON.stringify(tree)).toContain('bottom')
})

test('pathological messages of the longest size render quickly', () => {
  const N = 10_000
  const cases = {
    stars: '*a'.repeat(N / 2),
    emph: '**a*'.repeat(N / 4),
    under: '_a'.repeat(N / 2),
    brackets: '['.repeat(N),
    bracketsParen: '[a]('.repeat(N / 4),
    backticks: '`a'.repeat(N / 2),
    tildes: '~~a'.repeat(N / 3),
    table: '|a'.repeat(1000) + '|\n' + '|-'.repeat(1000) + '|\n' + ('|x'.repeat(1000) + '|\n').repeat(2),
    tableRows: '|a|b|\n|-|-|\n' + '|x|y|\n'.repeat(N / 6),
    longLine: 'a'.repeat(N),
    longWord: 'https://example.com/' + 'a'.repeat(N - 20),
    links: '[x](https://a.b) '.repeat(N / 17),
    lt: '<a'.repeat(N / 2),
  }
  for (const [name, body] of Object.entries(cases)) {
    const t = performance.now()
    md(body.slice(0, N))
    const ms = performance.now() - t
    // (the slowest is about 0.4 s here; a slow shared machine gets room)
    if (ms > 4000) throw new Error(`${name}: ${Math.round(ms)} ms`)
  }
}, 60_000)

test('a link whose words do not show where it goes shows its real host (or address) next to it', () => {
  const real = (h: string) => /<span class="text-muted \[unicode-bidi:isolate\]" data-real-address="">\(([^)]*)\)<\/span>/.exec(h)?.[1] ?? null
  // words that look like a site, a path on it, an e-mail address; words that say nothing about where it goes
  expect(real(md('[paypal.com](https://evil.example)'))).toBe('evil.example')
  expect(real(md('[paypal.com/login](https://evil.example/x)'))).toBe('evil.example')
  expect(real(md('[PayPal](https://evil.example/x)'))).toBe('evil.example')
  expect(real(md('[paypal.com](https://paypal.com.evil.example)'))).toBe('paypal.com.evil.example')
  expect(real(md('[paypal.com](https://evil.example/paypal.com)'))).toBe('evil.example')
  expect(real(md('[ceo@company.com](mailto:x@evil.example)'))).toBe('x@evil.example')
  expect(real(md('[mail me](mailto:ceo@company.com)'))).toBe('ceo@company.com')
  expect(real(md('[x](//evil.example)'))).toBe('evil.example')
  // zero-width and wide characters: the words as read show another address, so the real one is shown as a link
  for (const body of ['[https:/​/paypal.com](https://evil.example)', '[https://paypal．com](https://evil.example)', '[https://paypal。com](https://evil.example)', '[ｈｔｔｐｓ://paypal.com](https://evil.example)'])
    expect(md(body)).toMatch(/ \(<a href="https:\/\/evil\.example\/"[^>]*>https:\/\/<wbr\/>evil\.example<\/a>\)/)
  // and for words with zero-width characters in a bare host
  expect(real(md('[pay​pal.com](https://evil.example)'))).toBe('evil.example')
  // words that are its address: nothing added
  for (const body of ['[paypal.com](https://paypal.com)', '[paypal.com/login](https://www.paypal.com/login)', '[www.paypal.com](https://paypal.com/)', '[ceo@company.com](mailto:ceo@company.com)', '[<ceo@company.com>](mailto:ceo@company.com)', '<https://paypal.com>', '<ceo@company.com>', '[x](/rooms/abc)', 'https://paypal.com', '[+82 10-1234-5678](tel:+821012345678)'])
    expect(real(md(body))).toBeNull()
  // the room's own links (this server) are the app's, not another site's
  expect(real(md('[my files](http://localhost/files)'))).toBeNull()
  // a link that does not open adds nothing
  expect(md('[paypal.com](javascript:alert(1))')).not.toContain('data-real-address')
  // the check, alone
  expect(hiddenAddress('paypal.com', 'https://evil.example/')).toBe('evil.example')
  expect(hiddenAddress('PAYPAL.COM/x', 'https://www.paypal.com/x/')).toBeNull()
  expect(hiddenAddress('PayPal.com.', 'https://paypal.com/')).toBeNull()
  // a site before an "@" is not the host (round 3 of the review)
  for (const w of ['paypal.com@evil.example', 'paypal.com@evil.example/login', 'accounts.google.com@evil.example'])
    expect(hiddenAddress(w, 'https://evil.example/login')).toBe('evil.example')
  expect(md('[paypal.com@evil.example](https://evil.example)')).toContain('data-real-address')
  // Korean paths and hosts, a default port, a "#" on the root: the same address
  expect(hiddenAddress('https://ko.wikipedia.org/wiki/서울', 'https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8')).toBeNull()
  expect(hiddenAddress('https://한국.kr', 'https://xn--3e0b707e.kr/')).toBeNull()
  expect(hiddenAddress('https://example.com:443/x', 'https://example.com/x')).toBeNull()
  expect(hiddenAddress('example.com#x', 'https://example.com/#x')).toBeNull()
  expect(hiddenAddress('https://ko.wikipedia.org/wiki/부산', 'https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8')).toBe('https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8')
  expect(md('<https://ko.wikipedia.org/wiki/서울> [https://ko.wikipedia.org/wiki/서울](https://ko.wikipedia.org/wiki/서울)')).not.toContain('data-real-address')
  // words that name an address of their own (a scheme, a path) must be this one: else the whole real address
  expect(hiddenAddress('PAYPAL.COM/x', 'https://www.paypal.com/y')).toBe('https://www.paypal.com/y')
  expect(hiddenAddress('https://accounts.google.com/', 'https://accounts.google.com/o/oauth2/auth?client_id=evil')).toBe('https://accounts.google.com/o/oauth2/auth?client_id=evil')
  expect(hiddenAddress('google.com/maps', 'https://google.com/url?q=https://evil.example')).toBe('https://google.com/url?q=https://evil.example')
  expect(hiddenAddress('https://paypal.com', 'http://paypal.com/')).toBe('http://paypal.com/')
  // characters that reorder the screen: "paypal.com/oi.x" on the screen, x.io in fact
  expect(hiddenAddress('\u202ex.io/moc.lapyap', 'https://x.io/')).toBe('x.io')
  expect(hiddenAddress('\u2067x.io/nigol/moc.lapyap\u2069', 'https://x.io/a')).toBe('x.io')
  // mailto: with no address, or a "?" that sends it elsewhere too
  expect(hiddenAddress('ceo@company.com', 'mailto:?to=x@evil.example')).toBe('?to=x@evil.example')
  expect(hiddenAddress('ceo@company.com', 'mailto:ceo@company.com?bcc=x@evil.example')).toBe('ceo@company.com?bcc=x@evil.example')
  expect(hiddenAddress('x', 'mailto:')).toBe('mailto:')
  expect(hiddenAddress('paypal.comx', 'https://paypal.com/')).toBe('paypal.com')
  expect(hiddenAddress('a@b.c', 'mailto:A@B.C')).toBeNull()
  expect(hiddenAddress('call', 'tel:123')).toBe('123')
})

test('a picture inside a link is its words (no link inside a link)', () => {
  const h = md('[![paypal.com](https://evil.example/p.gif)](https://evil.example/x)')
  expect(h.match(/<a /g)?.length).toBe(1)
  expect(h).toMatch(/<a href="https:\/\/evil\.example\/x"[^>]*>paypal\.com<\/a> <span class="text-muted \[unicode-bidi:isolate\]" data-real-address="">\(evil\.example\)<\/span>/)
})

// ---- review of PR #514 (round 3): footnote definitions inside each other froze the room for seconds ----

/** the fastest of three renders, in ms (a loaded machine slows one now and then) */
const fastest = (f: () => unknown) => {
  let best = Infinity
  for (let r = 0; r < 3 && best >= 200; r++) {
    const t = performance.now()
    f()
    best = Math.min(best, performance.now() - t)
  }
  return best
}
const upTo = (unit: string, n = 10_000) => (unit.repeat(Math.ceil(n / unit.length))).slice(0, n - 1) + 'x'
const FOOTNOTE_BOMBS = ['[^a]:\n\n\t'.repeat(1427) + 'x', upTo('[^a]:\n\t'), upTo('[^1]:\n\t[^2]:\n\t'), upTo('[^a]: \n\t'), upTo('[^a]:\n    '), upTo('[^a]: x\n    '), upTo('- - [^a]:'), upTo('[^a]:- - ')]

test('footnote definitions inside each other read in milliseconds, in messages and in answers', () => {
  md('warm')
  answer('warm')
  for (const body of FOOTNOTE_BOMBS) {
    const ms = fastest(() => md(body.slice(0, 10_000)))
    if (ms >= 200) throw new Error(`message ${JSON.stringify(body.slice(0, 12))}: ${Math.round(ms)} ms`)
    const ma = fastest(() => answer(body.slice(0, 10_000)))
    if (ma >= 200) throw new Error(`answer ${JSON.stringify(body.slice(0, 12))}: ${Math.round(ma)} ms`)
    // (an answer's footnote marks are then its words: no hidden definition, no link to one)
    expect(answer(body.slice(0, 10_000))).not.toContain('user-content-fn')
  }
  // an answer's own footnotes are still footnotes
  expect(answer('Claim[^1] and more[^2]\n\n[^1]: First source\n[^2]: Second source')).toContain('href="/#user-content-fn-1"')
  expect(footnotesTooHeavy('Claim[^1]\n\n' + Array.from({ length: MAX_FOOTNOTES }, (_, i) => `[^${i}]: note`).join('\n'))).toBe(false)
  expect(footnotesTooHeavy(Array.from({ length: MAX_FOOTNOTES + 1 }, (_, i) => `[^${i}]: note`).join('\n'))).toBe(true)
  expect(footnotesTooHeavy('[^a]:\n\n\t[^b]:\n\n\t[^c]:\n\n\t[^d]:\n\n\tx')).toBe(true)
  // read without them, their marks are words, not a hidden definition
  const h = answer('Claim[^1]\n\n' + '> [^a]: q\n'.repeat(5) + '\n[^1]: real note')
  expect(h).toContain('Claim[^1]')
  expect(h).toContain('[^1]: real note')
  // escaped brackets in a label are still a footnote's (review round 3)
  for (const body of ['[^a\\]b]:\n\n\t'.repeat(1000), '[^\\]]:\n\n\t'.repeat(1300)]) {
    expect(footnotesTooHeavy(body)).toBe(true)
    const ma = fastest(() => answer(body.slice(0, 10_000)))
    if (ma >= 200) throw new Error(`answer ${JSON.stringify(body.slice(0, 12))}: ${Math.round(ma)} ms`)
  }
  // a footnote mark at a line's start counts as one of its signs (MAX_LINE_MARKS)
  expect(tooHeavyForMarkdown('[^a]: '.repeat(MAX_LINE_MARKS + 1) + 'x')).toBe(true)
  expect(tooHeavyForMarkdown('[^a]: x\n'.repeat(500))).toBe(false)
}, 60_000)

test('other text the parser reads slowly is its plain words; ordinary messages are not', () => {
  // each took 0.2-0.5 s to read as Markdown here
  for (const body of [
    '> x\n' + 'x\n'.repeat(4998), '- - x\n'.repeat(1666), '- > x\n'.repeat(1666), // lines a quote's or list's paragraph runs on to, lists of lists
    '*a'.repeat(5000), 'a*'.repeat(5000), '~*'.repeat(5000), '.*'.repeat(5000), '!_'.repeat(5000), 'x* * '.repeat(2000), '__*a'.repeat(2500), '-x_'.repeat(3333), '~~x'.repeat(3333), // marks that do not pair up
    '```~~x\\'.repeat(1250), // code spans that never end
    '[' + 'x<'.repeat(4999), '[-<' + '-<<'.repeat(3332), // words after a "[" never closed
  ]) {
    expect(tooHeavyForMarkdown(body.slice(0, 10_000))).toBe(true)
    expect(md(body.slice(0, 10_000))).toContain('data-plain=""')
  }
  for (const body of [
    'line\n'.repeat(MAX_LINES), '* item\n'.repeat(1000), '**x** '.repeat(1600), '*x* '.repeat(2500), '~~x~~ '.repeat(1666), '3~5분 '.repeat(1000), '_x_ '.repeat(2500),
    'a*b '.repeat(MAX_LOOSE), '`code` '.repeat(1400), 'see `a` and ``b`` '.repeat(500), '[draft ' + 'word '.repeat(MAX_AUTOLINK_TRIES - 1), ('[ ' + 'word '.repeat(500) + '\n\n').repeat(4),
    '|a|b|\n|-|-|\n' + '|x|y|\n'.repeat(900), 'snake_case_name '.repeat(500), '[a](https://a.b) '.repeat(500),
  ])
    expect(tooHeavyForMarkdown(body)).toBe(false)
  expect(tooHeavyForMarkdown('line\n'.repeat(MAX_LINES + 1))).toBe(true)
  expect(tooHeavyForMarkdown('a*b '.repeat(MAX_LOOSE + 1))).toBe(true)
  expect(tooHeavyForMarkdown('[draft ' + 'word '.repeat(MAX_AUTOLINK_TRIES + 1))).toBe(true)
})

test('fuzz: no message of up to 10,000 characters takes 200 ms to draw', () => {
  // (a fixed seed: the same cases every run)
  let seed = 514
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!
  const TOK = ['[^x]:', '[^a]: x', '>', '> ', '-', '- ', '*', '* ', '\t', '    ', '|a|b|\n|-|-|\n', '|x|y|\n', '[', ']', '](u)', '`', '```', '\n', '\n\n', ' ', 'x', 'ab', '_', '~~', '~', '(', ')', '!', '<', '#', '1. ', '=', '\\', 'http://a.b', 'www.', '@', '[a]: u\n', '[a]', '*a', 'a*', '.', '**', '__', '~~x', ':', '+ ', '\n=', '\n---', '&amp;', '<a>', '[x]', '- [ ] ', 'a\n', '> x\n']
  md('warm')
  for (let c = 0; c < 300; c++) {
    const len = 1 + Math.floor(rnd() * 10_000)
    let s = ''
    if (rnd() < 0.6) {
      // a few signs over and over (where the slow cases are), after a few others
      const unit = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pick(TOK)).join('')
      const head = rnd() < 0.3 ? Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(TOK)).join('') : ''
      s = head + unit.repeat(Math.ceil(len / unit.length))
    } else while (s.length < len) s += pick(TOK)
    s = s.slice(0, len)
    const ms = fastest(() => md(s))
    if (ms >= 200) throw new Error(`${Math.round(ms)} ms: ${JSON.stringify(s.slice(0, 120))}`)
  }
}, 120_000)

test('a table of millions of cells (a wide header, then short lines) is its words, in messages and in answers', () => {
  const wide = (cols: number, rows: number) => 'a|'.repeat(cols) + '\n' + '-|'.repeat(cols) + '\n' + 'x\n'.repeat(rows)
  md('warm')
  for (const body of [wide(2000, 998), wide(2400, 199), wide(1000, 998), wide(200, 998), (wide(500, 240) + '\n').repeat(4)]) {
    const s = body.slice(0, 10_000)
    expect(tableTooBig(s)).toBe(true)
    for (const [name, f] of [['message', () => md(s)], ['answer', () => answer(s)]] as const) {
      const ms = fastest(f)
      if (ms >= 200) throw new Error(`${name} ${JSON.stringify(s.slice(0, 12))}: ${Math.round(ms)} ms`)
    }
    expect(md(s)).toContain('data-plain=""')
    expect(answer(s)).not.toContain('<table')
  }
  // in a quote, with "\r" or "\r\n" line ends (review round 3, second pass)
  const quoted = (p: string, cols: number, rows: number) => p + 'a|'.repeat(cols) + '\n' + p + '-|'.repeat(cols) + '\n' + (p + 'x\n').repeat(rows)
  for (const body of [quoted('> ', 1200, 900), quoted('>', 1200, 900), quoted('> > ', 1000, 800), quoted('- ', 1200, 900).replace(/^- /gm, (m, i) => (i ? '  ' : m)), wide(2000, 998).replace(/\n/g, '\r'), wide(1500, 998).replace(/\n/g, '\r\n')]) {
    const s = body.slice(0, 10_000)
    expect(tableTooBig(s)).toBe(true)
    for (const [name, f] of [['message', () => md(s)], ['answer', () => answer(s)]] as const) {
      const ms = fastest(f)
      if (ms >= 200) throw new Error(`${name} ${JSON.stringify(s.slice(0, 12))}: ${Math.round(ms)} ms`)
    }
  }
  // "\r" ends lines for the other checks too
  expect(tooHeavyForMarkdown('> x\r' + 'x\r'.repeat(4998))).toBe(true)
  const crlf = md('**a**\r\n\r\n- b\r\n- c')
  expect(crlf).toContain('<strong>a</strong>')
  expect(crlf).toContain('<li>c</li>')
  // ordinary tables are tables
  const t = '|이름|부서|메모|\n|---|:-:|--:|\n' + '|김|영업|3~5분|\n'.repeat(150)
  expect(tableTooBig(t)).toBe(false)
  expect(md(t)).toContain('<table')
  expect(answer(t)).toContain('<table')
  expect(tableTooBig('a|'.repeat(20) + '\n' + '-|'.repeat(20) + '\n' + 'x\n'.repeat(Math.floor(MAX_TABLE_CELLS / 20) - 1))).toBe(false)
  // a line of dashes under words is a heading, a list item's dash no table
  expect(tableTooBig('Title\n---\n' + 'text\n'.repeat(900))).toBe(false)
}, 60_000)
