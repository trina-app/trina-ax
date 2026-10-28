import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { Markdown } from '../../src/components/Markdown'

const render = (text: string, streaming?: boolean) => renderToStaticMarkup(<MemoryRouter><Markdown text={text} streaming={streaming} /></MemoryRouter>)

describe('Markdown rendering', () => {
  test('bold followed by a Korean particle (remark-cjk-friendly)', () => {
    expect(render('각 일정을 **마일스톤(◆)**으로 표시')).toContain('<strong>마일스톤(◆)</strong>으로')
    expect(render('**중요**합니다')).toContain('<strong>중요</strong>합니다')
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
    expect(html).toContain('<blockquote>')
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
})
