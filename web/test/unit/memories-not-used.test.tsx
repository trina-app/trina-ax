// Settings › 메모리 (pages/Settings.tsx; QA TC-213): the AI gets only the person's newest memories that fit its memory
// block, so the page says how many it uses and how many older ones it does not use now, and marks those rows (the
// server says which: GET /api/memories `inUse`, `total`, `unused`). Nothing is said while all are in use.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryPage } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { MemoriesNotUsed } from '../../src/pages/Settings'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

test('some not used: how many the AI uses and how many older ones it does not, with what to do', async () => {
  const m = await mount(<MemoriesNotUsed use={{ inUse: 54, total: 110 }} />)
  try {
    expect(m.find('memory-not-used')?.textContent).toBe(translate('ko', 'memory.notUsed', { used: 54, count: 56 }))
    expect(m.find('memory-not-used')?.textContent).toContain('54')
    expect(m.find('memory-not-used')?.textContent).toContain('56')
  } finally { await m.unmount() }
})

test('all in use, or not said (an older server): nothing', async () => {
  for (const use of [{ inUse: 3, total: 3 }, null]) {
    const m = await mount(<MemoriesNotUsed use={use} />)
    try { expect(m.find('memory-not-used')).toBeNull() } finally { await m.unmount() }
  }
})

test('the list answer carries the counts and the marks; without them it still parses', () => {
  const item = { id: '01900000-0000-7000-8000-000000000001', text: '사실 001', sourceChatId: null, createdAt: '2026-11-11T00:00:00.000Z' }
  expect(MemoryPage.parse({ items: [{ ...item, unused: true }], nextCursor: null, inUse: 54, total: 110 }).items[0]!.unused).toBe(true)
  expect(MemoryPage.parse({ items: [item], nextCursor: null }).inUse).toBeUndefined()
  expect(translate('en', 'memory.notUsed', { used: 54, count: 1 })).toContain('1 older one is')
})
