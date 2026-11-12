// QA TC-348 / TC-350: the Inbox rows for the hosting service's copies of the team's key or data and for the team address
// moved to another server say what happened in plain words and open nothing (there is nothing to do on a page).
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxNotification, uuidv7 } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { noticeLink, noticeText } from '../../src/components/settings/Notifications'

const en = (k: Parameters<typeof translate>[1]) => translate('en', k)
const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
const notice = (code: 'hosting.key_copied' | 'hosting.exported' | 'relay.address_moved') => InboxNotification.parse({
  id: uuidv7(), eventType: code, sourceId: '42', code, createdAt: '2026-11-12T01:00:00.000Z', readAt: null, chatId: null, link: null, outcome: null,
})
const text = (item: InboxNotification, t = en, locale: 'en' | 'ko' = 'en') => renderToStaticMarkup(<>{noticeText(item, t, locale)}</>)

test('the three notices: their own words in English and Korean, no link', () => {
  expect(text(notice('hosting.key_copied'))).toBe("Trina hosting copied your team&#x27;s AI sign-in key for safekeeping, so your AI connections can be brought back if the server is lost.")
  expect(text(notice('hosting.exported'))).toContain('full copy of your team')
  expect(text(notice('relay.address_moved'))).toContain('now points to another server')
  for (const code of ['hosting.key_copied', 'hosting.exported', 'relay.address_moved'] as const) {
    expect(text(notice(code), ko, 'ko')).toBe(ko(`notifications.event.${code}`))
    expect(ko(`notifications.event.${code}`)).not.toBe(en(`notifications.event.${code}`))
    expect(noticeLink(notice(code))).toBeNull()
  }
})
