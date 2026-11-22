// S-110 (scenario QA 11-22): after a guest was removed her old room messages showed a plain "정하늘". A message whose
// author's account is turned off or removed (RoomMessage.authorLeft) shows a quiet tag by the name: "나감", or
// "게스트 · 나감" for a guest (components/rooms/MessageRun.tsx RunName). And S-118: the group editors say that a change of
// groups changes folder access at once (Admin › Groups, a member's groups editor).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { RunName } from '../../src/components/rooms/MessageRun'
import { usePeople } from '../../src/store/people'
import { installDom, mount, removeDom } from './dom-host'

describe('a run name of someone who left', () => {
  const locale = useLocaleStore.getState().locale
  beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }); usePeople.setState({ guestIds: { haneul: true } } as never) })
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); usePeople.setState({ guestIds: {} } as never) })
  const shown = async (left?: 'member' | 'guest') => {
    const m = await mount(<MemoryRouter><RunName user={{ id: 'haneul', name: '정하늘' }} left={left} /></MemoryRouter>)
    const out = { left: m.find('left-tag')?.textContent ?? null, guest: m.find('guest-tag')?.textContent ?? null, name: m.container.textContent?.includes('정하늘') ?? false }
    await m.unmount()
    return out
  }
  test('a removed guest: "게스트 · 나감" in place of the guest tag', async () => {
    expect(await shown('guest')).toEqual({ left: '게스트 · 나감', guest: null, name: true })
  })
  test('a member who left: "나감"', async () => {
    expect((await shown('member')).left).toBe('나감')
  })
  test('an active guest: the guest tag only', async () => {
    expect(await shown()).toMatchObject({ left: null, guest: '게스트' })
  })
  test('every language has both tags', () => {
    for (const L of ['en', 'ko', 'ja', 'id', 'es', 'zh'] as const) {
      expect(translate(L, 'rooms.authorLeft')).not.toBe('rooms.authorLeft')
      expect(translate(L, 'rooms.authorLeftGuest')).toContain(translate(L, 'role.guest'))
    }
  })
})

describe('the group editors say folder access follows', () => {
  test('the line, in every language, in Admin › Groups and the member editor', () => {
    expect(translate('ko', 'groups.accessNote')).toBe('부서를 바꾸면 폴더 접근도 바로 바뀌어요.')
    expect(translate('en', 'groups.accessNote')).toBe('Changing groups changes folder access right away.')
    for (const L of ['ja', 'id', 'es', 'zh'] as const) expect(translate(L, 'groups.accessNote')).not.toBe(translate('en', 'groups.accessNote'))
    for (const f of ['Groups.tsx', 'Members.tsx']) expect(fs.readFileSync(path.join(import.meta.dir, '../../src/pages/admin', f), 'utf8')).toContain("t('groups.accessNote')")
  })
})
