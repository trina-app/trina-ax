import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { Markdown } from '../../src/components/Markdown'

const render = (text: string) => renderToStaticMarkup(<MemoryRouter><Markdown text={text} /></MemoryRouter>)

describe('Markdown rendering', () => {
  test('bold followed by a Korean particle (remark-cjk-friendly)', () => {
    expect(render('각 일정을 **마일스톤(◆)**으로 표시')).toContain('<strong>마일스톤(◆)</strong>으로')
    expect(render('**중요**합니다')).toContain('<strong>중요</strong>합니다')
  })
  test('plain English emphasis is unchanged', () => {
    expect(render('a **bold** word and *italic*')).toContain('<strong>bold</strong>')
    expect(render('a **bold** word and *italic*')).toContain('<em>italic</em>')
  })
})
