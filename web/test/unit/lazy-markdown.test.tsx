// The formatted-text code is its own file, loaded when something needs it (components/LazyMarkdown.tsx; docs/
// DECISIONS.md "First load: compressed files, one language, formatting on demand"). Until it is here the text shows as it is; then the
// same component draws it formatted. The test preload (test/unit/preload.ts) loads it for every other file.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { answerHtml, forgetMarkdownForTest, loadMarkdown, Markdown, PersonMarkdown } from '../../src/components/LazyMarkdown'
import { installDom, mount, removeDom } from './dom-host'
import { MAX_BLANK_LINES } from '../../src/lib/blankLines'

beforeAll(() => { installDom() })
afterAll(async () => {
  await loadMarkdown()
  removeDom()
})

test('before the code is here: the text as it is, its lines kept, and what comes after a person message', () => {
  forgetMarkdownForTest()
  const html = renderToStaticMarkup(<Markdown text={'**bold** and\nmore'} className="x" />)
  expect(html).toContain('data-testid="md-plain"')
  expect(html).toContain('whitespace-pre-wrap')
  expect(html).toContain('**bold** and\nmore')
  const person = renderToStaticMarkup(<PersonMarkdown text="hi" mentions={[]} after={<span data-testid="after">10:00</span>} />)
  expect(person).toContain('hi')
  expect(person).toContain('data-testid="after"')
  // blank lines as typed, a long run cut to MAX_BLANK_LINES (lib/blankLines.ts; QA TC-4964)
  expect(renderToStaticMarkup(<PersonMarkdown text={'hei\n\nI test\n\n\nyou'} mentions={[]} />)).toContain('hei\n\nI test\n\n\nyou')
  expect(renderToStaticMarkup(<PersonMarkdown text={'a' + '\n'.repeat(5000) + 'b'} mentions={[]} />)).toContain('a' + '\n'.repeat(MAX_BLANK_LINES + 1) + 'b<')
})

test('the component loads the code and draws the text formatted', async () => {
  forgetMarkdownForTest()
  const m = await mount(<Markdown text={'**bold** and more'} />)
  // the load the component started, ended inside act (its state change is React's to apply)
  await act(async () => { await loadMarkdown() })
  await m.settle()
  expect(m.find('md-plain')).toBeNull()
  expect(m.container.querySelector('strong')?.textContent).toBe('bold')
  await m.unmount()
})

test('copy as formatted text needs the code; without it the copy is the Markdown only', async () => {
  forgetMarkdownForTest()
  expect(() => answerHtml('**x**', 'http://x', renderToStaticMarkup)).toThrow()
  await loadMarkdown()
  expect(answerHtml('**x**', 'http://x', renderToStaticMarkup)).toContain('<strong>x</strong>')
})
