// The team's disk filling (docs/decisions/20261116-storage-full-notices.md): the Inbox notice's words and its link, and
// a file in a conversation refused for a full disk, worded by role.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError, InboxNotification, uuidv7 } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { noticeLink, noticeText } from '../../src/components/settings/Notifications'
import { isStorageFull, storageFullText } from '../../src/components/rooms/storageRefusal'
import { storagePlansUrl } from '../../src/components/StoragePlansLink'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const notice = (storage: { percent: number; roomsBytes: number | null } | undefined, link: 'admin_storage' | null = 'admin_storage') => InboxNotification.parse({
  id: uuidv7(), eventType: 'storage.filling', sourceId: '80:2026-11-17T01:00:00.000Z', code: 'storage.filling', createdAt: '2026-11-17T01:00:00.000Z', readAt: null, chatId: null, link, outcome: null,
  ...(storage ? { storage } : {}),
})
const text = (item: InboxNotification, t = en, locale: 'en' | 'ko' = 'en') => renderToStaticMarkup(<>{noticeText(item, t, locale)}</>)

test('the notice says how full, and the files in conversations once measured; it opens the storage card', () => {
  expect(text(notice({ percent: 82, roomsBytes: null }))).toBe('Storage is 82% full. See what uses the space.')
  expect(text(notice({ percent: 96, roomsBytes: 31 * 1024 ** 3 }))).toBe('Storage is 96% full. Files in conversations take 31 GB. See what uses the space.')
  expect(text(notice({ percent: 82, roomsBytes: null }), ko, 'ko')).toBe('저장 공간이 82% 찼어요. 무엇이 공간을 쓰는지 확인해 보세요.')
  expect(noticeLink(notice({ percent: 82, roomsBytes: null }))).toEqual({ to: '/admin/system/storage', testId: 'notification-storage-link' })
  // someone no longer an admin: the plain words, no number, no link
  expect(text(notice(undefined, null))).toBe("The team&#x27;s storage is nearly full.")
  expect(noticeLink(notice(undefined, null))).toBeNull()
})

test('the plan page goes with an upload session\'s 413 for the disk too (a small hosted disk)', () => {
  const url = 'https://trina.app/account/plans'
  expect(storagePlansUrl(new ApiError(413, { code: 'payload_too_large', message: 'x', params: { reason: 'disk_full', manageUrl: url } }), false)).toBe(url)
  expect(storagePlansUrl(new ApiError(413, { code: 'payload_too_large', message: 'x', params: { reason: 'room_file_too_large', manageUrl: url } }), false)).toBeUndefined()
})

test('a full disk in a conversation: told apart from the 1 GB limit; a member or guest is told to ask an admin', () => {
  expect(isStorageFull(new ApiError(507, { code: 'storage_full', message: 'x', params: { reason: 'storage_full', freeBytes: 0 } }))).toBe(true)
  expect(isStorageFull(new ApiError(413, { code: 'payload_too_large', message: 'x', params: { reason: 'disk_full' } }))).toBe(true)
  expect(isStorageFull(new ApiError(413, { code: 'payload_too_large', message: 'x', params: { reason: 'room_file_too_large', maxBytes: 1 } }))).toBe(false)
  expect(isStorageFull(new ApiError(413, { code: 'payload_too_large', message: 'x' }))).toBe(false)
  expect(isStorageFull(new TypeError('Failed to fetch'))).toBe(false)
  expect(storageFullText(false, 'en')).toBe("There isn't enough space on the team's storage for this file. Ask an admin to free some space.")
  expect(storageFullText(true, 'en')).toBe("There isn't enough space on the team's storage for this file.")
  // never the trash sentence a member cannot act on
  for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) expect(storageFullText(false, l)).not.toBe(translate(l, 'rooms.storageFull'))
})
