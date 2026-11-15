// The warning before a group change (web/src/pages/admin/originKept.tsx; docs/DECISIONS.md "Folder access adds up like
// Google Drive (P2)", C1-A): a folder inside a team project offers no Remove (its members manage it); "Remove now" acts
// at once; a folder no longer in the list is an error, never "Removed" (review of #787).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { DialogHost } from '../../src/components/ui'
import { confirmOriginKept } from '../../src/pages/admin/originKept'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const en = (key: MessageKey) => translate('en', key)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const puts: string[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'POST /api/admin/groups/origin-check') return json(200, { kept: [
      { user: { id: 'kim', name: 'Kim' }, path: 'projects/Apollo/plans', access: 'read', groupId: 'g' },
      { user: { id: 'kim', name: 'Kim' }, path: 'shared/HR', access: 'read', groupId: 'g' },
    ] })
    // shared/HR is gone meanwhile
    if (key === 'GET /api/admin/folders') return json(200, { items: [] })
    if (key.startsWith('PUT ')) { puts.push(key); return json(200, {}) }
    return json(500, { error: { code: 'internal', message: key } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})

test('a project folder has no Remove; a folder gone meanwhile is an error, not "Removed"', async () => {
  const m = await mount(<DialogHost />)
  let answer: Promise<boolean> = Promise.resolve(false)
  await act(async () => { answer = confirmOriginKept([{ userId: 'kim', groupId: 'g' }], { title: 'T', confirm: 'Save' }) })
  const list = await m.until(() => m.find('origin-kept'), 'the warning')
  const rows = list.querySelectorAll('[data-testid="origin-kept-row"]')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.querySelector('[data-testid="origin-kept-remove"]')).toBeNull()
  const remove = rows[1]!.querySelector('[data-testid="origin-kept-remove"]')!
  expect(remove.textContent).toBe(en('groups.originRemove'))
  await m.click(remove)
  await m.until(() => useUi.getState().toasts.some((t) => t.level === 'error' && t.text === en('groups.originGone')), 'the error')
  expect(m.html()).not.toContain(en('groups.originRemoved'))
  expect(puts).toEqual([])
  await m.click(m.get('dialog-confirm'))
  expect(await answer).toBe(true)
  await m.unmount()
})
