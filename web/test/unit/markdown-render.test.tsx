import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { Markdown } from '../../src/components/Markdown'

const render = (text: string, streaming?: boolean) => renderToStaticMarkup(<MemoryRouter><Markdown text={text} streaming={streaming} /></MemoryRouter>)
/** an assistant answer in the chat (components/chat/Messages.tsx): its top-level quotes copy on their own */
const answer = (text: string) => renderToStaticMarkup(<MemoryRouter><Markdown text={text} copyQuotes /></MemoryRouter>)

describe('Markdown rendering', () => {
  test('bold followed by a Korean particle (remark-cjk-friendly)', () => {
    expect(render('각 일정을 **마일스톤(◆)**으로 표시')).toContain('<strong>마일스톤(◆)</strong>으로')
    expect(render('**중요**합니다')).toContain('<strong>중요</strong>합니다')
  })
  test('an answer keeps the answer size; "small" is the other size, not both on one element', () => {
    const classes = (html: string) => /class="(answer prose[^"]*)"/.exec(html)![1]!.split(' ')
    const answer = classes(render('text'))
    for (const c of ['text-[15px]', 'leading-7', 'prose-h1:text-lg', 'prose-h2:text-base', 'prose-h3:text-[15px]']) expect(answer).toContain(c)
    const small = classes(renderToStaticMarkup(<MemoryRouter><Markdown text="text" size="small" /></MemoryRouter>))
    for (const c of ['text-xs', 'leading-5']) expect(small).toContain(c)
    for (const c of ['text-[15px]', 'leading-7']) expect(small).not.toContain(c)
  })
  test('plain English emphasis is unchanged', () => {
    expect(render('a **bold** word and *italic*')).toContain('<strong>bold</strong>')
    expect(render('a **bold** word and *italic*')).toContain('<em>italic</em>')
  })

  test('hides block, multiline, inline and adjacent HTML comments, keeping surrounding text', () => {
    const html = render('# Before\n\n<!-- hidden block\nsecond hidden line -->\n\nleft<!-- hidden inline -->right<!-- hidden adjacent -->end\n\n<!-- hidden prefix -->suffix\n\nAfter')
    expect(html).not.toContain('hidden')
    expect(html).toContain('<h1>Before</h1>')
    expect(html).toContain('<p>leftrightend</p>')
    expect(html).toContain('suffix')
    expect(html).toContain('<p>After</p>')
  })

  test('hides an unfinished block comment, but leaves unparsed inline text alone', () => {
    expect(render('Before\n\n<!-- hidden\nstill hidden')).not.toContain('hidden')
    expect(render('Before\n\n<!-- hidden')).toContain('<p>Before</p>')
    // CommonMark does not recognize an unfinished inline comment as HTML.
    expect(render('Before <!-- unfinished')).toContain('Before &lt;!-- unfinished')
  })

  test('hides comments in nested Markdown and raw HTML, including template content', () => {
    const html = render('> Before<!-- nested sentinel -->after\n\n- item<!-- list sentinel -->end\n\n<div>before<!-- first sentinel --><template><!-- template sentinel --></template><!-- last sentinel -->after</div>')
    expect(html).not.toContain('sentinel')
    expect(html).toMatch(/<blockquote[ >]/)
    expect(html).toContain('Beforeafter')
    expect(html).toContain('itemend')
    expect(html).toContain('&lt;div&gt;before&lt;template&gt;&lt;/template&gt;after&lt;/div&gt;')
  })

  test('hides block comments while streaming, including before the closing delimiter arrives', () => {
    for (const text of ['Before\n\n<!-- streaming sentinel', 'Before\n\n<!-- streaming sentinel -->\n\nAfter']) {
      expect(render(text, true)).not.toContain('streaming sentinel')
      expect(render(text, true)).toContain('<p>Before</p>')
    }
  })

  test('keeps comment examples in fenced, indented and inline code, and escaped text', () => {
    for (const text of ['```html\n<!-- literal -->\n```', '~~~html\n<!-- literal -->\n~~~', '    <!-- literal -->', '`<!-- literal -->`']) {
      expect(render(text)).toContain('&lt;!-- literal --&gt;')
    }
    expect(render('\\<!-- literal -->')).toContain('&lt;!-- literal --&gt;')
  })

  test('keeps raw HTML escaped, including comment-like text inside attributes and scripts', () => {
    const html = render('<div title="<!-- attribute literal -->">body<!-- hidden --></div>\n\n<script>window.commentTest = "<!-- script literal -->"</script>\n\n<img src=x onerror="window.commentTest = true">')
    expect(html).not.toContain('hidden')
    expect(html).toContain('&lt;div title=')
    expect(html).toContain('&lt;!-- attribute literal --&gt;')
    expect(html).toContain('&lt;!-- script literal --&gt;')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=')
    expect(html).not.toMatch(/<(script|img|div title)[\s>]/)
  })

  test('keeps GFM and math rendering around comments', () => {
    const html = render('~~old~~<!-- comment sentinel --> **new**\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$x^2$\n\n$$\nx+1\n$$')
    expect(html).not.toContain('comment sentinel')
    expect(html).toContain('<del>old</del>')
    expect(html).toContain('<strong>new</strong>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<table')
    expect(html).toContain('class="katex"')
    expect(html).toContain('class="katex-display"')
  })

  test('each quote has its own quiet copy button (an ad option copies on its own); no frame is added', () => {
    const html = answer('### 1안\n\n> 제목: 월요일 아침\n> CTA: 지금 보기\n\n### 2안\n\n> 제목: 하루 5분')
    expect(html.match(/data-testid="copyable-quote"/g)?.length).toBe(2)
    expect(html.match(/data-testid="copy-quote"/g)?.length).toBe(2)
    expect(html).toMatch(/<blockquote[ >]/)
    // the button is a sibling of the quote, so the quote's text (what it copies) is only the option
    expect(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(html)![1]).not.toContain('button')
    // upright, without the typography's quote marks (an option to copy, not a citation)
    expect(/<blockquote class="([^"]*)"/.exec(html)![1]).toContain('not-italic')
    const wrap = /<div class="([^"]*)" data-testid="copyable-quote"/.exec(html)![1]!
    expect(wrap).not.toMatch(/\bborder\b|rounded/)
    // phones (no hover): always shown; pointer screens: on hover or focus
    const button = /<button[^>]*data-testid="copy-quote"[^>]*>/.exec(html)![0]
    expect(button).toContain('[@media(hover:hover)]:opacity-0')
    expect(button).toContain('group-hover/quote:opacity-100')
    expect(button).toContain('group-focus-within/quote:opacity-100')
  })

  test('copy buttons: only top-level quotes of an assistant answer, one per quote, each named for what it copies', () => {
    // named by the heading above, else the quote's first line; a name used twice gets a number
    const html = answer('### 1안 · 혜택\n\n> 제목: 첫 달 무료\n\n### 2안 · 고민\n\n> 제목: 아침 5분\n\n> 제목: 아침 5분')
    const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*data-testid="copy-quote"/g)].map((m) => m[1])
    expect(labels).toEqual(['Copy 1안 · 혜택', 'Copy 2안 · 고민', 'Copy 제목: 아침 5분'])
    const twice = answer('> 같은 문구\n\n> 같은 문구')
    expect([...twice.matchAll(/aria-label="([^"]*)"[^>]*data-testid="copy-quote"/g)].map((m) => m[1])).toEqual(['Copy 같은 문구', 'Copy 같은 문구 (2)'])
    // a quote inside a quote: one button, for the outer quote, and the inner one stays a plain quote
    const nested = answer('> 바깥\n>\n> > 안쪽')
    expect(nested.match(/data-testid="copy-quote"/g)?.length).toBe(1)
    expect(nested.match(/<blockquote/g)?.length).toBe(2)
    // a quote in a list item is not top-level: no button
    expect(answer('- 항목\n\n  > 인용')).not.toContain('copy-quote')
  })

  test('everywhere else (files, docs, artifacts, notes) a quote is a plain quote: no button, the usual styling', () => {
    const html = render('### 1안\n\n> 제목: 월요일 아침')
    expect(html).not.toContain('copy-quote')
    expect(html).not.toContain('copyable-quote')
    expect(html).not.toContain('not-italic')
    expect(html).toMatch(/<blockquote>/)
  })
})
