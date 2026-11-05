// A demo server's replayed answer (server/src/demo/replay.ts) carries a `demo_replay` step. It is not a step of the work:
// never counted in "작업 N단계", never in the live tail, and only once the list is opened one small line says the result
// was prepared in advance for the demo (in the language on screen). Answers without it are unchanged.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps from '../../src/components/chat/Steps'
import { installDom, mount, removeDom } from './dom-host'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'read', label: 'read groups/마케팅팀/브랜드-가이드.md', status: 'ok', startedAt: '2026-11-05T10:00:00.000Z', endedAt: '2026-11-05T10:00:01.000Z', ...o })
const note = step({ id: 'n', tool: 'demo_replay', label: '데모용으로 미리 준비한 결과예요' })
const work = [step({ id: 'a' }), step({ id: 'b', tool: 'make_file', label: 'make_file users/jiwoo/카드뉴스.html' })]

describe('the demo replay note', () => {
  const before = useLocaleStore.getState().locale
  beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale: before }) })

  test('not counted, not live; one line in the opened list, translated', async () => {
    const live = renderToStaticMarkup(<Steps steps={[note, ...work]} streaming />)
    expect(live).not.toContain('데모용')
    const m = await mount(<Steps steps={[note, ...work]} streaming={false} />)
    try {
      expect(m.html()).toContain(translate('ko', 'steps.summary', { n: 2 }))
      expect(m.find('demo-replay-note')).toBeNull()
      await m.click(m.container.querySelector('button')!)
      expect(m.get('demo-replay-note').textContent).toBe('데모용으로 미리 준비한 결과예요')
    } finally { await m.unmount() }
    useLocaleStore.setState({ locale: 'en' })
    const en = await mount(<Steps steps={[note, ...work]} streaming={false} />)
    try {
      await en.click(en.container.querySelector('button')!)
      expect(en.get('demo-replay-note').textContent).toBe('Prepared in advance for the demo')
    } finally { await en.unmount(); useLocaleStore.setState({ locale: 'ko' }) }
  })

  test('an answer without the note is as before', async () => {
    const m = await mount(<Steps steps={work} streaming={false} />)
    try {
      await m.click(m.container.querySelector('button')!)
      expect(m.find('demo-replay-note')).toBeNull()
      expect(m.html()).toContain(translate('ko', 'steps.summary', { n: 2 }))
    } finally { await m.unmount() }
  })
})
