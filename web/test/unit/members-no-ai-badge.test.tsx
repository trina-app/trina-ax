// Admin › Members "No AI" badge (pages/admin/Members.tsx NoAiBadge): plain "No AI" when nothing but a person fixes it;
// when only a limit keeps the person from AI (GET /api/admin/users noAiUntil), the same badge says until when, in the
// viewer's language, and its hint says it comes back by itself. Same link either way.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { formatShortDateTime } from '../../src/lib/format'
import { NoAiBadge } from '../../src/pages/admin/Members'
import { installDom, mount, removeDom } from './dom-host'

const before = useLocaleStore.getState().locale
beforeAll(() => { installDom() })
afterAll(() => { useLocaleStore.setState({ locale: before }); removeDom() })

const render = async (locale: Locale, until?: string) => {
  useLocaleStore.setState({ locale })
  const m = await mount(<MemoryRouter><NoAiBadge until={until} /></MemoryRouter>)
  const link = m.get('member-no-ai')
  const out = { text: link.textContent, title: link.getAttribute('title'), href: link.getAttribute('href') }
  await m.unmount()
  return out
}

describe('the No AI badge', () => {
  const END = '2026-11-07T15:59:00.000Z'
  test('no end time: plain "No AI" with the usual hint', async () => {
    for (const locale of ['ko', 'en'] as const) {
      const hint = translate(locale, 'members.noAiHint')
      expect(await render(locale)).toEqual({ text: translate(locale, 'members.noAi') + hint, title: hint, href: '/admin/providers' })
    }
  })
  for (const [locale, month] of [['ko', '11월'], ['en', 'Nov'], ['ja', '11月'], ['id', 'Nov'], ['es', 'nov']] as const) {
    test(`only a limit: "until …" in the viewer's language (${locale})`, async () => {
      const time = formatShortDateTime(END, locale)
      expect(time).toContain(month)
      const hint = translate(locale, 'members.noAiUntilHint', { time })
      // the badge, then the same hint for screen readers (sr-only)
      expect(await render(locale, END)).toEqual({ text: translate(locale, 'members.noAiUntil', { time }) + hint, title: hint, href: '/admin/providers' })
      expect(hint).not.toContain('{time')
    })
  }
})
