// The file screen's upload rows (components/FileUploads.tsx, QA TC-223): a failed row offers 다시 시도 (before it had
// only ✕, and the file had to be picked again), and a row that waits for the connection says so and keeps its bar.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import FileUploads from '../../src/components/FileUploads'
import { useLocaleStore } from '../../src/i18n'
import { addFileUpload, patchFileUpload, useFileUploads } from '../../src/lib/fileUploads'
import { installDom, mount, removeDom } from './dom-host'

const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
})
afterAll(() => {
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})
afterEach(() => useFileUploads.setState({ items: [] }))

test('a failed row has 다시 시도, which runs the retry; a running or finished row has none', async () => {
  let retried = 0
  const a = addFileUpload('IMG_0001.jpg', 'shared')
  const b = addFileUpload('IMG_0002.jpg', 'shared')
  patchFileUpload(a.id, { status: 'failed', error: '팀 서버에 연결하지 못했어요.', retry: () => retried++ })
  const m = await mount(<FileUploads here="shared" />)
  try {
    const buttons = m.container.querySelectorAll('[data-testid="file-upload-retry"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('다시 시도')
    await m.click(buttons[0]!)
    expect(retried).toBe(1)
    patchFileUpload(b.id, { status: 'done' })
    await m.settle()
    expect(m.container.querySelectorAll('[data-testid="file-upload-retry"]')).toHaveLength(1)
  } finally {
    await m.unmount()
  }
})

test('a row waiting for the connection says so and keeps what had gone out on its bar', async () => {
  const a = addFileUpload('big.mov', 'shared')
  patchFileUpload(a.id, { progress: { phase: 'waiting', loaded: 40, total: 100 } })
  const m = await mount(<FileUploads here="shared" />)
  try {
    expect(m.container.textContent).toContain('연결을 기다리는 중')
    const bar = m.container.querySelectorAll('div').find((d) => d.getAttribute('class')?.startsWith('h-full bg-accent'))!
    expect((bar as unknown as { style: Record<string, string> }).style.width).toBe('40%')
  } finally {
    await m.unmount()
  }
})
