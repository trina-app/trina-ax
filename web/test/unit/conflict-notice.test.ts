// The conflict copy notice (lib/conflictNotice.ts, QA TC-230): one notice per person, the saver in the first person,
// everyone else with the saver's name, the place as the file screen names it, never a disk path.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useLocaleStore } from '../../src/i18n'
import { conflictText, savedHere, savingHere, toldHere } from '../../src/lib/conflictNotice'
import { useSession } from '../../src/store/session'

const me = (id: string) => ({
  user: { id, username: id, name: id === 'choi' ? '최비' : '박에이', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
})

describe('conflict copy notice', () => {
  const before = { status: useSession.getState().status, locale: useLocaleStore.getState().locale }
  beforeEach(() => useLocaleStore.setState({ locale: 'ko' }))
  afterEach(() => {
    useSession.setState({ status: before.status })
    useLocaleStore.setState({ locale: before.locale })
  })

  test('the saver hears it in the first person, the other with the saver\'s name; the place in on-screen words', () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('choi') } } as never)
    const mine = conflictText('shared/Notes/memo.txt', { id: 'choi', name: '최비' })
    expect(mine).toBe('memo.txt이(가) 그사이 바뀌어서 내 내용은 사본으로 따로 저장했어요. (전사 공유 › Notes)')
    useSession.setState({ status: { kind: 'signed-in', me: me('park') } } as never)
    const other = conflictText('shared/Notes/memo.txt', { id: 'choi', name: '최비' })
    expect(other).toBe('memo.txt이(가) 동시에 바뀌어서 최비 님의 내용은 사본으로 따로 저장했어요. (전사 공유 › Notes)')
    for (const s of [mine, other]) expect(s).not.toContain('shared/')
    // the team root, and an unknown saver
    expect(conflictText('plan.md', null)).toBe('plan.md이(가) 동시에 바뀌어서 작성자 모름 님의 내용은 사본으로 따로 저장했어요. (팀 폴더)')
    useLocaleStore.setState({ locale: 'en' })
    expect(conflictText('shared/Notes/memo.txt', { id: 'park', name: 'Park' })).toBe('memo.txt changed in the meantime, so your version was saved as a separate copy. (Company-wide › Notes)')
  })

  test('a save from this window is told once: the live event for it is skipped, other conflicts are not', () => {
    savingHere('shared/a.md')
    expect(toldHere('shared/a.md')).toBe(true)
    expect(toldHere('shared/a.md')).toBe(false) // only once
    savingHere('shared/b.md')
    savedHere('shared/b.md') // saved without a conflict copy
    expect(toldHere('shared/b.md')).toBe(false)
    expect(toldHere('shared/c.md')).toBe(false)
  })
})
