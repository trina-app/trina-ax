// QA AP-033 (docs/decisions/20261120-ap033-thinking-text.md): a "Thinking" step carries the AI's thinking text as its
// detail. The row is closed until the person clicks it, then shows the text; a thinking step without text (an older
// answer, an empty block) is a plain row, as before.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps from '../../src/components/chat/Steps'
import { installDom, mount, removeDom } from './dom-host'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'thinking', label: 'Thinking', status: 'ok', startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:00:02.000Z', ...o })
const THOUGHT = 'The person wants the March invoices.\nFirst list the finance folder.'

describe('the thinking text under a "Thinking" step', () => {
  const before = useLocaleStore.getState().locale
  beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale: before }) })

  test('closed by default, opens on click, closes again', async () => {
    const m = await mount(<Steps steps={[step({ detail: THOUGHT })]} streaming />)
    try {
      const row = m.get('step-thinking')
      expect(row.getAttribute('aria-expanded')).toBe('false')
      expect(row.getAttribute('aria-label')).toBe(`Thinking · ${translate('en', 'steps.thinkingShow')}`)
      expect(m.find('step-thinking-text')).toBeNull()
      await m.click(row)
      expect(m.get('step-thinking').getAttribute('aria-expanded')).toBe('true')
      expect(m.get('step-thinking-text').textContent).toBe(THOUGHT)
      await m.click(m.get('step-thinking'))
      expect(m.find('step-thinking-text')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a thinking step without text is a plain row', async () => {
    const m = await mount(<Steps steps={[step({})]} streaming />)
    try {
      expect(m.find('step-thinking')).toBeNull()
      expect(m.html()).toContain('Thinking')
    } finally { await m.unmount() }
  })
})
