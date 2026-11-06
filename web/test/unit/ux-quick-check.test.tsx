// The small layout fixes of the quick UX check (2026-11-04): a row of tabs that scrolls sideways fades only at an edge
// with more behind it (lib/edgeFade.ts); a plugin's long licence list is "Licenses", with the list in its tooltip and
// under the line when pressed (admin/Plugins.tsx); a member card's actions on a phone sit behind "…" (admin/Members.tsx).
// The phone layouts themselves are checked in the browser (e2e/admin.spec.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { translate } from '../../src/i18n'
import { edgeFade } from '../../src/lib/edgeFade'
import { longLicense, PluginMeta } from '../../src/pages/admin/Plugins'
import { MemberMenu } from '../../src/pages/admin/Members'
import { installDom, mount, removeDom } from './dom-host'

describe('edge fade of a sideways row', () => {
  test('a row that fits never fades', () => {
    expect(edgeFade(0, 300, 300)).toEqual({ start: false, end: false })
    expect(edgeFade(0, 301, 300)).toEqual({ start: false, end: false })
  })
  test('at the start: only the end fades; in the middle: both; at the end: only the start', () => {
    expect(edgeFade(0, 600, 300)).toEqual({ start: false, end: true })
    expect(edgeFade(150, 600, 300)).toEqual({ start: true, end: true })
    expect(edgeFade(300, 600, 300)).toEqual({ start: true, end: false })
    expect(edgeFade(299, 600, 300)).toEqual({ start: true, end: false })
  })
  test('a right-to-left row (negative scrollLeft) fades the same way', () => {
    expect(edgeFade(-150, 600, 300)).toEqual({ start: true, end: true })
    expect(edgeFade(-300, 600, 300)).toEqual({ start: true, end: false })
  })
})

describe('plugin licence line', () => {
  const LIST = 'MIT AND Apache-2.0 AND BSD-3-Clause AND MPL-2.0 AND OFL-1.1 AND LicenseRef-HWP-Notices'
  test('one licence stays on the line', () => {
    expect(longLicense('MIT')).toBe(false)
    const html = renderToStaticMarkup(<PluginMeta text="by Trina · Runs on: macOS arm64" license="MIT" />)
    expect(html).toContain('by Trina · Runs on: macOS arm64 · MIT')
    expect(html).not.toContain('plugin-licenses')
  })
  test('a list is "Licenses", the full list in the tooltip and closed at first', () => {
    expect(longLicense(LIST)).toBe(true)
    expect(longLicense('GPL-2.0-only OR MIT')).toBe(true)
    const html = renderToStaticMarkup(<PluginMeta text="by Trina" license={LIST} />)
    const button = /<button[^>]*data-testid="plugin-licenses"[^>]*>([^<]*)</.exec(html)
    expect(button?.[1]).toBe(translate('en', 'plugins.licenses'))
    expect(button?.[0]).toContain(`title="${LIST}"`)
    expect(button?.[0]).toContain('aria-expanded="false"')
    expect(html).not.toContain('plugin-license-list')
  })
})

describe('member actions on a phone', () => {
  beforeAll(() => { installDom() })
  afterAll(() => removeDom())

  test('"…" opens the actions; choosing one runs it and closes the menu', async () => {
    const ran: string[] = []
    const items = ['edit', 'reset', 'delete'].map((id) => ({ label: id, icon: null, onSelect: () => ran.push(id), testId: `item-${id}`, danger: id === 'delete' }))
    const m = await mount(<MemberMenu name="Bob" items={items} />)
    const more = m.get('member-more')
    expect(more.getAttribute('aria-label')).toBe(translate('en', 'members.actionsFor', { name: 'Bob' }))
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(m.find('item-edit')).toBeNull()
    await m.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(m.get('item-delete').getAttribute('class')).toContain('text-danger')
    await m.click('item-reset')
    expect(ran).toEqual(['reset'])
    expect(m.find('item-edit')).toBeNull()
    await m.unmount()
  })
})
