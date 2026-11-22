// Sharing findings from the multi-person scenario QA (docs/AGENTS/plan/20261121-2342-sharing-sq-findings.md): a share
// notice of a chat I lost says whose it was (TC-7047), the Share dialog's warning names only the picks it is about
// (TC-7042), and "Make it a project" says each reason a file stays in its own line (TC-7046).
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxNotification, uuidv7 } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { noticeText } from '../../src/components/settings/Notifications'
import { warnNamesOf } from '../../src/components/chat/ChatShareDialog'
import { stayCounts } from '../../src/components/rooms/MakeProjectDialog'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const shared = (chatShared: { name: string | null; title: string | null; gone?: true }) => InboxNotification.parse({
  id: uuidv7(), eventType: 'chat.shared', sourceId: '12', code: 'chat.shared', createdAt: '2026-11-22T01:00:00.000Z', readAt: null,
  chatId: chatShared.gone ? null : uuidv7(), link: chatShared.gone ? null : 'chat', outcome: null, chatShared,
})
const text = (item: InboxNotification, t = en, locale: 'en' | 'ko' = 'en') => renderToStaticMarkup(<>{noticeText(item, t, locale)}</>)

test('TC-7047: a share notice of a chat I lost says who shared it, or "A chat", never "This chat" alone', () => {
  expect(text(shared({ name: 'QA Owner', title: null, gone: true }))).toBe('A chat from QA Owner is no longer shared with you.')
  expect(text(shared({ name: null, title: null, gone: true }))).toBe('A chat is no longer shared with you.')
  expect(text(shared({ name: 'QA Owner', title: null, gone: true }), ko, 'ko')).toBe('QA Owner님이 공유했던 채팅이 더 이상 공유되어 있지 않아요.')
  expect(text(shared({ name: 'QA Owner', title: 'SQ3 Word offer' }))).toBe('QA Owner shared a chat with you.')
})

test('TC-7042: the warning names the picks at the places the check lists, in the list it was asked for', () => {
  const list = [
    { subjectType: 'group' as const, subjectId: 'g1' },
    { subjectType: 'user' as const, subjectId: 'erin' },
    { subjectType: 'user' as const, subjectId: 'bob' },
  ]
  const names: Record<string, string> = { g1: 'Sales', erin: 'Erin', bob: 'Bob' }
  const nameOf = (x: { subjectId: string }) => names[x.subjectId] ?? ''
  expect(warnNamesOf(en, list, [2], nameOf)).toBe('Bob')
  expect(warnNamesOf(en, list, [0, 2], nameOf)).toBe(['Sales', 'Bob'].join(en('rooms.nameSep')))
  // a place past the list (an older answer to another list): nothing named from it
  expect(warnNamesOf(en, list, [7], nameOf)).toBe('')
})

test('TC-7046: the files that stay, by why; an older server sends the total only', () => {
  expect(stayCounts({ filesStaying: 6, filesStayingCopies: 3, filesStayingOther: 1 })).toEqual({ unseen: 2, copies: 3, other: 1 })
  expect(stayCounts({ filesStaying: 3 })).toEqual({ unseen: 3, copies: 0, other: 0 })
  expect(en('rooms.makeProject.stayingCopies', { n: 3 })).toContain("people added to the project later won't get them")
  expect(ko('rooms.makeProject.staying', { n: 1 })).toContain('여기 있는 모두가 볼 수 있는 게 아니라서')
})

test('TC-7277/TC-7262: the warning names the files and where they are, says what dev answers and hidden answers mean', async () => {
  const { shareWarningLines, shareAtStake } = await import('../../src/components/ShareWarning')
  const base = { added: 1, memoryAnswers: 0, fileAnswers: 0, accountAnswers: 0, places: [], otherPlaces: false, roomsUnseen: false, unchecked: 0 }
  const lines = shareWarningLines(en, { ...base, fileAnswers: 1, fileNames: ['cost.xlsx · Sales › Pricing'] }, 'Seoyeon')
  expect(lines).toEqual(["1 answer used files Seoyeon can't open (cost.xlsx · Sales › Pricing). Seoyeon will see what those answers say."])
  expect(shareWarningLines(en, { ...base, devAnswers: 2 }, 'Doyoon')[0]).toContain('Doyoon and anyone added later will see those answers')
  expect(shareWarningLines(en, { ...base, hiddenAnswers: 3 }, 'Doyoon')[0]).toBe('3 earlier answers stay hidden from Doyoon: those answers used something only the people here then could see.')
  expect(shareAtStake({ ...base, devAnswers: 1 })).toBe(true)
  expect(shareAtStake({ ...base, hiddenAnswers: 1 })).toBe(true)
  expect(shareAtStake(base)).toBe(false)
})
