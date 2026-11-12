// Markdown that cannot be drawn costs that one text, not the page (components/Markdown.tsx MarkdownBoundary, around
// PersonMarkdown and the answers' Markdown; PR #514 review): its plain words instead, and a new text is tried again.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MarkdownBoundary } from '../../src/components/Markdown'
import { installDom, mount, removeDom } from './dom-host'

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

function Boom({ text }: { text: string }): never {
  throw new Error(`cannot draw ${text}`)
}

test('a renderer that throws shows the fallback for that text only; a new text is drawn again', async () => {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  const Item = ({ text, bad }: { text: string; bad: boolean }) => (
    <MarkdownBoundary resetKey={text} fallback={<p data-testid={`plain-${text}`}>{text}</p>}>
      {bad ? <Boom text={text} /> : <p data-testid={`md-${text}`}>{text}</p>}
    </MarkdownBoundary>
  )
  try {
    const m = await mount(
      <div>
        <Item text="before" bad={false} />
        <Item text="bad" bad />
        <Item text="after" bad={false} />
      </div>,
    )
    try {
      expect(m.find('md-before')).not.toBeNull()
      expect(m.find('plain-bad')).not.toBeNull()
      expect(m.find('md-after')).not.toBeNull()
    } finally { await m.unmount() }
  } finally {
    console.warn = warn
    console.error = error
  }
})
