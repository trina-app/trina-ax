// The 활동 line of a file shared with me that no longer opens (components/settings/Notifications.tsx fileShareText;
// docs/decisions/20261120-file-share-gone-notice.md): who shared it and why when the server says, never a file name.
import { expect, test } from 'bun:test'
import type { InboxNotification } from '@mycel/shared/api'
import { fileShareText } from '../../src/components/settings/Notifications'
import { ko } from '../../src/i18n/ko'
import { en } from '../../src/i18n/en'

const tOf = (dict: Record<string, string>) => ((k: string, v?: Record<string, unknown>) => dict[k]!.replace(/\{(\w+)\}/g, (_, x: string) => String(v?.[x]))) as unknown as Parameters<typeof fileShareText>[1]
const item = (fileShare: InboxNotification['fileShare']): InboxNotification => ({ id: 'n', eventType: 'file.shared', code: 'file.shared', sourceId: 's', createdAt: '', readAt: null, chatId: null, link: null, outcome: null, fileShare })
const gone = { name: null, linkId: null, gone: true as const }

test('who shared it and why, in Korean', () => {
  const t = tOf(ko)
  expect(fileShareText(item({ ...gone, by: 'test', why: 'stopped' }), t)).toBe('test님이 공유한 파일을 이제 열 수 없어요. 공유가 중지됐어요.')
  expect(fileShareText(item({ ...gone, by: 'test', why: 'deleted' }), t)).toBe('test님이 공유한 파일을 이제 열 수 없어요. 삭제됐어요.')
  expect(fileShareText(item({ ...gone, by: 'test', why: 'moved' }), t)).toBe('test님이 공유한 파일을 이제 열 수 없어요. 다른 곳으로 옮겨졌어요.')
  expect(fileShareText(item({ ...gone, by: 'test' }), t)).toBe('test님이 공유한 파일을 이제 열 수 없어요.')
  expect(fileShareText(item({ ...gone, by: null }), t)).toBe('공유받은 파일을 더 이상 열 수 없어요.')
  expect(fileShareText(item({ ...gone, by: '민준', folder: 'shared' }), t)).toBe('민준님이 공유한 폴더를 이제 열 수 없어요.')
})

test('English, and an older server with no fileShare', () => {
  const t = tOf(en)
  expect(fileShareText(item({ ...gone, by: 'Mina', folder: 'shared', why: 'moved' }), t)).toBe('You can no longer open the folder Mina shared with you. It was moved.')
  expect(fileShareText(item(undefined), t)).toBe('You can no longer open a file that was shared with you.')
})

test('a file that still opens keeps its name', () => {
  expect(fileShareText(item({ by: 'Mina', name: 'quote.xlsx', linkId: 'x' }), tOf(en))).toBe('Mina shared "quote.xlsx" with you')
})
