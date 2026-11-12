// A post the AI made to a room (post_to_room, Step.posted) has 보기 on its step, like the button's sent line: the room at
// the message, or the thread at the reply; a room's side chat passes its own way there (StepPostView). Any other step
// has none.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps, { StepPostView } from '../../src/components/chat/Steps'
import { setNavigator } from '../../src/lib/nav'
import { installDom, mount, removeDom } from './dom-host'

const ROOM = '019a6f00-0000-7000-8000-000000000001', MSG = '019a6f00-0000-7000-8000-000000000002', ROOT = '019a6f00-0000-7000-8000-000000000003'
const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'post_to_room', label: '대화방에 보내기 · #영업팀', status: 'ok', startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:00:05.000Z', ...o })
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale

describe('보기 on a post\'s step', () => {
  afterEach(() => setLocale(before))

  test('a posted step has it, in the language on screen; a step that did not post has none', () => {
    for (const locale of ['ko', 'en'] as const) {
      setLocale(locale)
      const rows = renderToStaticMarkup(<Steps steps={[step({ posted: { roomId: ROOM, messageId: MSG } })]} streaming />)
      expect(rows).toContain('data-testid="step-post-view"')
      expect(rows).toContain(`aria-label="${translate(locale, 'steps.postViewLabel')}"`)
      expect(rows).toContain(`>${translate(locale, 'steps.postView')}</button>`)
    }
    expect(renderToStaticMarkup(<Steps steps={[step({ detail: '보내지 않았어요' })]} streaming />)).not.toContain('step-post-view')
    expect(renderToStaticMarkup(<Steps steps={[step({ tool: 'read', label: 'Read · a.md' })]} streaming />)).not.toContain('step-post-view')
  })
})

describe('where it goes', () => {
  const went: string[] = []
  beforeEach(() => { installDom(); setNavigator((to) => went.push(to)) })
  afterEach(() => { setNavigator(null); went.length = 0; removeDom() })

  test('the room at the message, or the thread at the reply', async () => {
    const m = await mount(<Steps steps={[step({ posted: { roomId: ROOM, messageId: MSG } }), step({ id: 's2', posted: { roomId: ROOM, messageId: MSG, threadRootId: ROOT } })]} streaming />)
    try {
      const views = m.container.querySelectorAll('[data-testid="step-post-view"]')
      expect(views.length).toBe(2)
      await m.click(views[0]!)
      await m.click(views[1]!)
      expect(went).toEqual([`/rooms/${ROOM}?m=${MSG}`, `/rooms/${ROOM}/t/${ROOT}?m=${MSG}`])
    } finally { await m.unmount() }
  })

  test('a side chat: its own way there', async () => {
    const seen: unknown[] = []
    const m = await mount(<StepPostView.Provider value={(p) => seen.push(p)}><Steps steps={[step({ posted: { roomId: ROOM, messageId: MSG, threadRootId: ROOT } })]} streaming /></StepPostView.Provider>)
    try {
      await m.click('step-post-view')
      expect(seen).toEqual([{ roomId: ROOM, messageId: MSG, threadRootId: ROOT }])
      expect(went).toEqual([])
    } finally { await m.unmount() }
  })
})
