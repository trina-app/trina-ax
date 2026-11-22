// "Folders your AI can see" (components/chat/MyFoldersCard.tsx; server/src/chat/my-folders.ts; docs/decisions/
// 20261122-demo-permission-scene.md): drawn from the step's record alone, one row per folder in Files' words with its
// access (Can edit / Read only), each opening the folder in Files, and a count for any beyond the list. It only ever has
// what the server put there: folders the person can open. Every language.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Step } from '@mycel/shared/api'
import MyFoldersCard from '../../src/components/chat/MyFoldersCard'
import { useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const folders: NonNullable<Step['folders']> = [
  { path: 'shared', access: 'edit' },
  { path: 'groups/Sales', access: 'edit' },
  { path: 'skills', access: 'view' },
]

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

const rows = (m: Awaited<ReturnType<typeof mount>>) => [...m.container.querySelectorAll('[data-testid="my-folders-card-folder"]')]

test('the title, one row per folder with its access, each a link to the folder in Files; nothing else', async () => {
  useLocaleStore.setState({ locale: 'en' })
  const m = await mount(<MemoryRouter><MyFoldersCard folders={folders} /></MemoryRouter>)
  try {
    expect(m.get('action-card-title').textContent).toBe('Folders your AI can see')
    const r = rows(m)
    expect(r.length).toBe(3)
    expect(r.map((x) => x.querySelector('[data-testid="my-folders-card-access"]')?.textContent)).toEqual(['Can edit', 'Can edit', 'Read only'])
    expect(r[1]!.textContent).toContain('Sales')
    expect(m.container.querySelector('a[href="/files?path=groups%2FSales"]')).not.toBeNull()
    expect(m.find('my-folders-card-more')).toBeNull()
    expect(m.find('action-card-footer')).toBeNull()
    // the card names nothing beyond its record: no "not open to you", no lock
    expect(m.container.textContent).not.toMatch(/not open|locked|management/i)
  } finally { await m.unmount() }
})

test('more folders than the record keeps: one plain count', async () => {
  useLocaleStore.setState({ locale: 'en' })
  const m = await mount(<MemoryRouter><MyFoldersCard folders={folders} more={4} /></MemoryRouter>)
  try { expect(m.get('my-folders-card-more').textContent).toBe('4 more') } finally { await m.unmount() }
})

test('every language has the words (no key falls back to its name)', async () => {
  for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) {
    useLocaleStore.setState({ locale: l })
    const m = await mount(<MemoryRouter><MyFoldersCard folders={folders} more={2} /></MemoryRouter>)
    try {
      expect(m.container.textContent, l).not.toContain('myFoldersCard.')
      expect(rows(m).length).toBe(3)
    } finally { await m.unmount() }
  }
  useLocaleStore.setState({ locale: 'en' })
})
