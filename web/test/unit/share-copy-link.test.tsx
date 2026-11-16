// Copy link in the Share dialogs (docs/decisions/20261116-chat-share-copy-link.md, QA TC-3933;
// components/ShareCopyLink.tsx): one button with the file dialog's words, the line while people are picked and not saved
// (it names the save button), and a project's copy: its page's address alone, with who opens it (a personal project:
// only me until it is shared). The words exist in every language and say the same thing.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { ShareCopyLink, projectLink, useCopyProjectLink } from '../../src/components/ShareCopyLink'
import { translate, useLocaleStore } from '../../src/i18n'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const ORIGIN = 'https://team.acme.example'
const ID = '01900000-0000-7000-8000-0000000000p1'
const copied: string[] = []
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const locale = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  ;(globalThis as Record<string, unknown>).location = { origin: ORIGIN }
})
beforeEach(() => {
  copied.length = 0
  useLocaleStore.setState({ locale: 'en' })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (s: string) => void copied.push(s) } } })
})
afterEach(() => {
  useLocaleStore.setState({ locale })
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).location
  removeDom()
})

test('the words: the button is the file dialog\'s "Copy link", the unsaved line names the button, in every language', () => {
  expect(translate('en', 'share.linkAfterSave', { button: 'Share' })).toBe('People you add can open the link after you press Share.')
  expect(translate('ko', 'share.linkAfterSave', { button: '공유' })).toBe('공유 버튼을 누르면 추가한 사람도 링크를 열 수 있어요.')
  for (const l of ['es', 'id', 'ja', 'zh'] as const) {
    const s = translate(l, 'share.linkAfterSave', { button: 'XYZ' })
    expect(s).toContain('XYZ')
    expect(s).not.toBe(translate('en', 'share.linkAfterSave', { button: 'XYZ' }))
  }
})

test('the button, and the line only while people are picked and not saved', async () => {
  let n = 0
  const m = await mount(<ShareCopyLink onCopy={() => void n++} testId="x-copy" />)
  try {
    expect(m.get('x-copy').textContent?.trim()).toBe('Copy link')
    expect(m.container.querySelector('[data-testid="x-copy-unsaved"]')).toBeNull()
    await m.click('x-copy')
    expect(n).toBe(1)
  } finally {
    await m.unmount()
  }
  const u = await mount(<ShareCopyLink onCopy={() => {}} unsaved="Save" testId="x-copy" />)
  try {
    expect(u.get('x-copy-unsaved').textContent).toBe('People you add can open the link after you press Save.')
  } finally {
    await u.unmount()
  }
})

for (const [folderPath, words] of [['projects/launch', 'fileLink.copied'], ['users/alex/notes', 'fileLink.copiedOnlyYou']] as const) {
  test(`a project's Copy link (${folderPath}): its page's address alone, and who opens it`, async () => {
    function Probe() {
      const copy = useCopyProjectLink()
      return <button type="button" data-testid="probe" onClick={() => void copy({ id: ID, folderPath })}>copy</button>
    }
    const m = await mount(<Probe />)
    try {
      await m.click('probe')
      await m.until(() => copied.length, 'the copy')
      expect(copied).toEqual([`${ORIGIN}/projects/${ID}`])
      expect(projectLink(ID)).toBe(`${ORIGIN}/projects/${ID}`)
      expect(useUi.getState().toasts.at(-1)?.text).toBe(translate('en', words))
      await m.settle(1600)
    } finally {
      await m.unmount()
    }
  })
}
