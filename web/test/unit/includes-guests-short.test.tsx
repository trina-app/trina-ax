// "Includes 1 guest" in a room's header; on a phone the short "1 guest" keeps the header on one line (QA TC-6127).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { IncludesGuests } from '../../src/components/GuestTag'
import { translate } from '../../src/i18n'
import { usePeople } from '../../src/store/people'
import { installDom, mount, removeDom } from './dom-host'

beforeAll(() => installDom())
afterAll(() => removeDom())

describe('IncludesGuests', () => {
  test('short is the phone form; both say nothing without a guest', async () => {
    usePeople.setState({ byId: {}, guestIds: { g1: true } } as never)
    const full = await mount(<IncludesGuests ids={['g1', 'x']} prefix=" · " />)
    expect(full.html()).toContain('Includes 1 guest')
    await full.unmount()
    const short = await mount(<IncludesGuests ids={['g1', 'x']} prefix=" · " short />)
    expect(short.html()).toContain(' · 1 guest<')
    expect(short.html()).not.toContain('Includes')
    await short.unmount()
    const none = await mount(<IncludesGuests ids={['x']} short />)
    expect(none.html()).not.toContain('guest')
    await none.unmount()
    expect(translate('ko', 'guest.includesShort', { n: 2 })).toBe('게스트 2명')
  })
})
