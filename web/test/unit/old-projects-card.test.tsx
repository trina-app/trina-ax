// Admin › Home: the card for team projects from before the update (src/pages/admin/OldProjectsCard.tsx; QA TC-360;
// docs/DECISIONS.md "Projects from before the update: one card, Add me to these"). No items: nothing at all. Items: how
// many and their names, one "Add me to these" that asks first (their members are told) and then joins all of them in
// one request, and a dismiss that hides it for good.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { noticeText } from '../../src/components/settings/Notifications'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { OldProjectsCard } from '../../src/pages/admin/OldProjectsCard'
import { DialogHost } from '../../src/components/ui'
import { installDom, mount, removeDom } from './dom-host'

const en = (k: MessageKey, p?: Params) => translate('en', k, p)

describe('the old projects card', () => {
  const realFetch = globalThis.fetch
  const before = useLocaleStore.getState().locale
  let items: { id: string; name: string }[] = []
  let calls: string[] = []
  const json = (body: unknown, code = 200) => new Response(code === 204 ? null : JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'en' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      calls.push(key)
      if (key === 'GET /api/projects/update-notice') return json({ items })
      if (key === 'POST /api/projects/update-notice/join') { const n = items.length; items = []; return json({ joined: n, skipped: 0 }) }
      if (key === 'POST /api/projects/update-notice/dismiss') { items = []; return json(null, 204) }
      return json({ error: { code: 'internal', message: `no route ${key}` } }, 500)
    }) as unknown as typeof fetch
  })
  beforeEach(() => { calls = [] })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: before })
  })

  test('nothing to say: no card', async () => {
    items = []
    const m = await mount(<MemoryRouter><OldProjectsCard /></MemoryRouter>)
    try {
      await m.until(() => calls.includes('GET /api/projects/update-notice'), 'the request')
      await m.settle()
      expect(m.find('admin-old-projects')).toBeNull()
    } finally { await m.unmount() }
  })

  test('how many and which, then Add me to these asks first and joins them in one go', async () => {
    items = [{ id: 'a', name: 'Finance' }, { id: 'b', name: 'Sales' }]
    const m = await mount(<MemoryRouter><OldProjectsCard /><DialogHost /></MemoryRouter>)
    try {
      const card = await m.until(() => m.find('admin-old-projects'), 'the card')
      expect(card.textContent).toContain(en('adminHome.oldProjects.title', { count: 2 }))
      expect(card.textContent).toContain('2 projects from before the update are for their members only now')
      expect(m.get('admin-old-projects-names').textContent).toBe('Finance, Sales')
      expect(card.textContent).toContain(en('adminHome.oldProjects.body'))
      // one main button and the dismiss
      expect(card.querySelectorAll('button').length).toBe(2)
      await m.click('admin-old-projects-add')
      const dialog = await m.until(() => m.find('dialog-confirm'), 'the confirm')
      expect(m.html()).toContain(en('adminHome.oldProjects.confirmTitle', { count: 2 }))
      expect(m.html()).toContain(en('projects.addMeBody'))
      expect(calls).not.toContain('POST /api/projects/update-notice/join')
      await m.click(dialog)
      await m.until(() => !m.find('admin-old-projects'), 'the card gone')
      expect(calls.filter((c) => c === 'POST /api/projects/update-notice/join')).toHaveLength(1)
    } finally { await m.unmount() }
  })

  test('dismiss: gone, without joining anything', async () => {
    items = [{ id: 'a', name: 'Finance' }]
    const m = await mount(<MemoryRouter><OldProjectsCard /></MemoryRouter>)
    try {
      await m.until(() => m.find('admin-old-projects'), 'the card')
      expect(m.get('admin-old-projects').textContent).toContain('1 project from before the update is for its members only now')
      await m.click('admin-old-projects-dismiss')
      await m.until(() => !m.find('admin-old-projects'), 'the card gone')
      expect(calls).toContain('POST /api/projects/update-notice/dismiss')
      expect(calls).not.toContain('POST /api/projects/update-notice/join')
    } finally { await m.unmount() }
  })
})

describe('a scheduled task paused because only the project\'s members can use it now', () => {
  const base = { id: 'n', eventType: 'schedule.failure', sourceId: 's', code: 'schedule.failure', createdAt: '2026-11-12T00:00:00.000Z', readAt: null, chatId: null, link: null, outcome: 'failed', projectGone: true } as unknown as InboxNotification
  const text = (item: InboxNotification) => renderToStaticMarkup(<>{noticeText(item, (k, p) => en(k, p), 'en')}</>)
  test('says it is paused and how it starts again; a project that is gone keeps its own words', () => {
    expect(text({ ...base, membersOnly: true, schedule: { title: 'Daily file index' } } as InboxNotification)).toContain('is paused: only the project&#x27;s members can use it now. Add yourself to the project in Projects and it starts again.')
    expect(text({ ...base, membersOnly: true } as InboxNotification)).toContain('Add yourself to the project in Projects')
    expect(text(base)).toBe(en('notifications.event.schedule.projectGone'))
  })
})
