// QA after batch #634: the AI defaults' unsaved changes ask before a reload (TeamAiSettings.tsx GroupSave), and Admin ›
// Usage names a Claude row without a version as an earlier one, in its rows, chart and filter alike (Usage.tsx
// usageModelName).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { isUnversionedClaude } from '@mycel/shared'
import { useLocaleStore } from '../../src/i18n'
import { isBusy } from '../../src/lib/busy'
import { GroupSave } from '../../src/pages/admin/TeamAiSettings'
import { usageModelName } from '../../src/pages/admin/Usage'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'ko' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

test('while Cancel and Save show, a reload asks first and the app does not reload by itself', async () => {
  const reload = () => { const e = new FakeEvent('beforeunload', { cancelable: true }); dispatchEvent(e as unknown as Event); return e.defaultPrevented }
  expect(reload()).toBe(false)
  const m = await mount(<GroupSave onSave={() => {}} onCancel={() => {}} testId="engine-defaults-save" />)
  try {
    expect(m.get('engine-defaults-save-bar').textContent).toContain('저장하지 않은 변경 사항')
    expect(reload()).toBe(true)
    expect(isBusy('draft')).toBe(true)
  } finally { await m.unmount() }
  expect(reload()).toBe(false)
  expect(isBusy('draft')).toBe(false)
})

test('a Claude id with no version reads as an earlier row; a versioned one and other models as they are', () => {
  expect(['haiku', 'claude-haiku', 'opus', 'claude-haiku-5-5', 'claude-opus-4-5-20251101', 'gpt-5.5', ''].map(isUnversionedClaude))
    .toEqual([true, true, true, false, false, false, false])
  const words: Record<string, string> = { 'composer.defaultModel': 'Default model', 'usage.modelNoVersion': '{name} (earlier, version not recorded)' }
  const t = (k: string, p?: { name: string }) => words[k]!.replace('{name}', p?.name ?? '')
  expect(usageModelName('haiku', 'Claude Haiku', t)).toBe('Claude Haiku (earlier, version not recorded)')
  expect(usageModelName('claude-haiku-5-5', 'Claude Haiku 5.5', t)).toBe('Claude Haiku 5.5')
  expect(usageModelName('', '(default)', t)).toBe('Default model')
  // a label the server already told apart by its id keeps it
  expect(usageModelName('claude-haiku', 'Claude Haiku (claude-haiku)', t)).toBe('Claude Haiku (claude-haiku)')
  expect(usageModelName('my-model', 'my-model', t)).toBe('my-model')
})
