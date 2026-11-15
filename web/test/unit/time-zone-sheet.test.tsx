// Admin › Team settings › General on a phone (components/settings/TimeZoneField.tsx PhoneTimeZoneRow): the team time
// zone is a row that opens the phone's sheet, with a search under the row. A search that finds nothing leaves only the
// current zone in the sheet, and the sheet covers the line under the search, so the sheet itself says that nothing
// matched (QA TC-1829). A search that finds something adds no such words to the sheet.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import { PhoneTimeZoneRow } from '../../src/components/settings/TimeZoneField'
import { installDom, mount, removeDom } from './dom-host'

const none = translate('en', 'teamSettings.timeZoneNone')

describe('the phone time zone sheet', () => {
  const before = useLocaleStore.getState().locale
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'en' })
  })
  afterAll(() => {
    removeDom()
    useLocaleStore.setState({ locale: before })
  })

  test('TC-1829: "zzz" finds nothing: the open sheet says "No time zone matches that." under the current zone', async () => {
    const m = await mount(<PhoneTimeZoneRow value="Asia/Ho_Chi_Minh" onChange={() => {}} />)
    try {
      await m.type('team-time-zone-search', 'zzz')
      await m.click('team-time-zone')
      const menu = await m.until(() => m.container.querySelectorAll('[role="menu"]')[0], 'the sheet')
      expect(menu.querySelectorAll('[role="menuitemradio"]').length).toBe(1)
      expect(menu.textContent).toContain(none)
    } finally { await m.unmount() }
  })

  test('a search that finds zones: the sheet lists them and has no "no match" words', async () => {
    const m = await mount(<PhoneTimeZoneRow value="Asia/Seoul" onChange={() => {}} />)
    try {
      await m.type('team-time-zone-search', 'tokyo')
      await m.click('team-time-zone')
      const menu = await m.until(() => m.container.querySelectorAll('[role="menu"]')[0], 'the sheet')
      expect(menu.querySelectorAll('[role="menuitemradio"]').length).toBe(2)
      expect(menu.textContent).not.toContain(none)
    } finally { await m.unmount() }
  })
})
