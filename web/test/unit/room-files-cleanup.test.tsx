// "Ask people to clean up" and "Files you sent" (docs/decisions/20261116-room-files-cleanup.md): the notice's words and
// where it opens, and the words of a delete there.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxNotification, uuidv7 } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { noticeLink, noticeText } from '../../src/components/settings/Notifications'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const notice = (by: string | null) => InboxNotification.parse({
  id: uuidv7(), eventType: 'storage.cleanup', sourceId: '2026-11-17', code: 'storage.cleanup', createdAt: '2026-11-17T01:00:00.000Z', readAt: null, chatId: null, link: 'sent_files', outcome: null, cleanup: { by },
})
const text = (item: InboxNotification) => renderToStaticMarkup(<>{noticeText(item, en, 'en')}</>)

test('the clean-up notice names who asked (or "An admin") and opens Files you sent; it names nobody else', () => {
  expect(text(notice('Mina Park'))).toBe('Mina Park asked the people whose files in conversations take the most space to delete what they no longer need. See the files you sent.')
  expect(text(notice(null))).toBe('An admin asked the people whose files in conversations take the most space to delete what they no longer need. See the files you sent.')
  expect(noticeLink(notice(null))).toEqual({ to: '/sent-files', testId: 'notification-sent-files-link' })
})

test('deleting a file says its message goes, and how many other files with it', () => {
  expect(en('sentFiles.confirmBody')).toBe('The message it was sent with is deleted too, for everyone in the conversation.')
  expect(en('sentFiles.confirmBodyOthers', { n: 1 })).toBe('The message it was sent with is deleted too, with 1 other file, for everyone in the conversation.')
  expect(en('sentFiles.confirmBodyOthers', { n: 3 })).toContain('3 other files')
  expect(en('storage.askConfirmBody')).toContain("You won't see who.")
})
