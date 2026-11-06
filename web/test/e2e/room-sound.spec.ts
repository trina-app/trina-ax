// The room sound's switch (Settings › Notifications, "알림 소리"; store/roomSound.ts): on by default, kept on this
// device only, and turning it on plays the chime once (the click unlocks the browser's audio). Web Audio is stubbed:
// the test counts the notes started instead of listening.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

test('the sound switch is on by default, stays on this device, and plays the chime once when turned on', async ({ page }) => {
  await reset(page)
  await page.addInitScript(() => {
    const notes: number[] = []
    ;(window as any).__notes = notes
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} })
    class FakeContext {
      state = 'suspended'
      currentTime = 0
      destination = {}
      async resume() { this.state = 'running' }
      async suspend() { this.state = 'suspended' }
      createGain() { return { gain: param(), connect() {} } }
      createOscillator() { const frequency = param(); return { type: '', frequency, connect() {}, start() { notes.push(frequency.value) }, stop() {} } }
      createBuffer() { return {} }
      createBufferSource() { return { buffer: null, connect() {}, start() {} } }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeContext })
  })
  await signIn(page)
  const writes: string[] = []
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/notification')) writes.push(r.url()) })
  await page.goto('/settings/notifications')
  const sound = page.getByTestId('notification-sound')
  await expect(sound).toBeChecked()
  expect(await page.evaluate(() => localStorage.getItem('mycel.roomSound'))).toBeNull()

  // the switch's track sits over its hidden checkbox (ui.tsx Switch): a click there is what a person does
  await sound.uncheck({ force: true })
  expect(await page.evaluate(() => localStorage.getItem('mycel.roomSound'))).toBe('off')
  // nothing went to the server: it is this device's setting
  expect(writes).toEqual([])
  await page.reload()
  await expect(page.getByTestId('notification-sound')).not.toBeChecked()
  expect(await page.evaluate(() => (window as any).__notes.length)).toBe(0)

  await page.getByTestId('notification-sound').check({ force: true })
  await expect.poll(() => page.evaluate(() => (window as any).__notes.length)).toBe(4)
  expect(await page.evaluate(() => localStorage.getItem('mycel.roomSound'))).toBeNull()
})
