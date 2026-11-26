// lib/destructive.ts, the one way to delete, trash, hide and leave (docs/decisions/20261126-shared-menus.md):
// - a confirm only when the caller passes one; cancelled, nothing runs and nothing is said;
// - done: one toast with the result's words, and "실행 취소" (common.undo) only when an undo is given; the undo runs;
// - a run that did not happen (false or null: it said why itself) shows no toast.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { destructive } from '../../src/lib/destructive'
import { DialogHost } from '../../src/components/ui'
import { translate, useLocaleStore } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
})
beforeEach(() => useUi.setState({ toasts: [] }))
afterAll(() => {
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

test('no confirm: it runs, then one toast with Undo that runs the undo', async () => {
  let undone = 0
  const r = await destructive({ run: async () => 'ok' as const, done: () => ({ text: 'Hidden', undo: () => undone++ }) })
  expect(r).toBe('ok')
  const toast = useUi.getState().toasts.at(-1)!
  expect(toast.text).toBe('Hidden')
  expect(toast.action?.label).toBe(translate('ko', 'common.undo'))
  expect(toast.action?.label).toBe('실행 취소')
  toast.action!.run()
  expect(undone).toBe(1)
})

test('no undo given: the toast has no button; a run that did not happen says nothing', async () => {
  await destructive({ run: async () => true, done: () => ({ text: 'Left' }) })
  expect(useUi.getState().toasts.at(-1)!.action).toBeUndefined()
  useUi.setState({ toasts: [] })
  expect(await destructive({ run: async () => false, done: () => ({ text: 'never' }) })).toBe(false)
  expect(await destructive({ run: async () => null, done: () => ({ text: 'never' }) })).toBe(false)
  expect(useUi.getState().toasts).toEqual([])
})

test('a confirm: the danger dialog first; cancelled, nothing runs; confirmed, it runs', async () => {
  const m = await mount(<DialogHost />)
  try {
    let ran = 0
    const ask = { title: 'Delete it?', body: 'It goes to the trash.', confirm: 'Delete' }
    const first = destructive({ confirm: ask, run: async () => (ran++, true), done: () => ({ text: 'Deleted' }) })
    await m.until(() => m.find('dialog-cancel'), 'the confirm')
    expect(m.html()).toContain('Delete it?')
    await m.click('dialog-cancel')
    expect(await first).toBe(false)
    expect(ran).toBe(0)
    expect(useUi.getState().toasts).toEqual([])
    const second = destructive({ confirm: ask, run: async () => (ran++, true), done: () => ({ text: 'Deleted' }) })
    await m.until(() => m.find('dialog-confirm'), 'the confirm again')
    await m.click('dialog-confirm')
    expect(await second).toBe(true)
    expect(ran).toBe(1)
    expect(useUi.getState().toasts.at(-1)!.text).toBe('Deleted')
  } finally {
    await m.unmount()
  }
})
