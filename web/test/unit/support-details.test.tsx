// Admin › AI providers (QA TC-4837): a failed check's raw output for support is closed by default under the plain line,
// opens with "Show details" (and closes again), and its copy button puts the text on the clipboard.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { SupportDetails } from '../../src/components/SupportDetails'
import { translate, useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const copied: string[] = []
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom() })
beforeEach(() => {
  copied.length = 0
  useLocaleStore.setState({ locale: 'en' })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (s: string) => void copied.push(s) } } })
})
afterEach(() => {
  useLocaleStore.setState({ locale })
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
})
afterAll(() => removeDom())

const TEXT = '{"type":"system","subtype":"init","session_id":"[hidden]"}'

test('closed by default, opens and closes with the toggle, and the copy button copies the text', async () => {
  const m = await mount(<SupportDetails text={TEXT} testId="engine-error-detail" />)
  try {
    const toggle = m.get('engine-error-detail-toggle')
    const box = () => m.get('engine-error-detail-text').parentNode as unknown as FakeElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe(translate('en', 'system.showDetails'))
    expect(box().hasAttribute('hidden')).toBe(true)
    await m.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe(translate('en', 'system.hideDetails'))
    expect(box().hasAttribute('hidden')).toBe(false)
    expect(m.get('engine-error-detail-text').textContent).toBe(TEXT)
    const copy = m.container.querySelector(`[aria-label="${translate('en', 'common.copy')}"]`) as unknown as FakeElement
    expect(copy).toBeTruthy()
    await m.click(copy)
    await m.until(() => copied.length > 0, 'the copy')
    expect(copied).toEqual([TEXT])
    await m.click(toggle)
    expect(box().hasAttribute('hidden')).toBe(true)
  } finally { await m.unmount() }
})
