// The one message box (components/composer/ComposerShell.tsx, docs/decisions/20261126-composer-shell.md) in each of its
// four places, at 1440 and 390, light and dark: the AI chat, the ✦ side chat, a room and an AI answer's thread. Every
// box has the same round send and the same + attach (a menu with Team files on a computer, the attach sheet on a
// phone; none in a thread); a running answer has Stop, the clock beside it only with text, and Esc in the box stops
// it on a computer; the side chat holds a key-looking text for "Send anyway" and keeps its draft after a reload; a
// thread has the mic and keeps a reply after closing. Against the mock (test/mock/server.ts: "slow" answers slowly).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const H = { [CSRF_HEADER]: '1' }
const BEN = { id: 'ben', name: '벤' }
// joined at run time, so secret scanners do not take this file for a leak
const KEY = ['sk-', 'proj-', 'Ab12Cd34Ef56Gh78Ij90KlMnOp'].join('')

/** the round accent send, as tall as Stop: the same in every box */
async function roundSend(button: Locator) {
  await expect(button).toHaveClass(/rounded-full/)
  const b = (await button.boundingBox())!
  expect(Math.round(b.width)).toBeGreaterThanOrEqual(36)
  expect(Math.round(b.width)).toBe(Math.round(b.height))
}

/** the + attach: on a computer a menu with this computer and Team files; on a phone the attach sheet */
async function plusAttach(page: Page, button: Locator, phone: boolean) {
  await button.click()
  if (phone) {
    await expect(page.getByTestId('attach-team')).toBeVisible()
    await page.keyboard.press('Escape')
  } else {
    await expect(page.getByTestId('attach-menu')).toBeVisible()
    await expect(page.getByTestId('attach-computer')).toBeVisible()
    await expect(page.getByTestId('attach-team')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('attach-menu')).toHaveCount(0)
  }
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    const phone = width < 768
    const where = `${width} ${scheme}`

    test(`${where}: the AI chat's box: round send, + attach, Stop with the clock, Esc stops`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page)
      await signIn(page)
      const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
      await page.goto(`/c/${chat.id}`)
      const box = page.getByTestId('composer')
      const input = box.getByTestId('composer-input')
      await expect(input).toBeVisible()
      await roundSend(box.getByTestId('send'))
      await plusAttach(page, box.getByTestId('attach-button'), phone)
      await input.fill('slow answer please, a long one')
      await box.getByTestId('send').click()
      const stop = box.getByTestId('stop')
      await expect(stop).toBeVisible()
      // the clock only once there is something to send
      await expect(box.getByTestId('send-later')).toHaveCount(0)
      await input.fill('and then this')
      await expect(box.getByTestId('send-later')).toBeVisible()
      await roundSend(box.getByTestId('send-later'))
      await input.fill('')
      const stopped = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/chats\/[^/]+\/stop$/.test(new URL(r.url()).pathname))
      if (phone) await stop.click()
      else {
        await input.focus()
        await page.keyboard.press('Escape')
      }
      expect((await stopped).ok()).toBe(true)
      await expect(stop).toHaveCount(0, { timeout: 15_000 })
      await page.screenshot({ path: `test-results/composer-shell/chat-${width}-${scheme}.png` })
    })

    test(`${where}: the side chat's box: + attach, the key warning, Stop and Esc, the draft after a reload`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page)
      await signIn(page)
      await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '로고 시안 언제까지?' }] })
      await page.goto(`/rooms/${ROOM_ID}`)
      await page.getByTestId('room-side-chat-button').click()
      const side = page.getByTestId('room-side-chat')
      const input = side.getByTestId('side-chat-input')
      await expect(input).toBeVisible()
      await roundSend(side.getByTestId('side-chat-send'))
      await plusAttach(page, side.getByTestId('side-chat-attach'), phone)
      // a key-looking question waits for "Send anyway"
      await input.fill(`here is my key ${KEY}`)
      await side.getByTestId('side-chat-send').click()
      await expect(side.getByTestId('secret-warning')).toBeVisible()
      await side.getByTestId('secret-edit').click()
      await input.fill('slow answer please, a long one')
      await side.getByTestId('side-chat-send').click()
      const stop = side.getByTestId('side-chat-stop')
      await expect(stop).toBeVisible()
      const stopped = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/chats\/[^/]+\/stop$/.test(new URL(r.url()).pathname))
      if (phone) await stop.click()
      else {
        await input.focus()
        // the first Esc stops the answer; the panel stays open
        await page.keyboard.press('Escape')
      }
      expect((await stopped).ok()).toBe(true)
      await expect(stop).toHaveCount(0, { timeout: 15_000 })
      await expect(side).toBeVisible()
      // what is typed comes back after a reload, in the same chat
      await input.fill('a draft to keep')
      await page.reload()
      // (open again after a reload when it was open: 20261118-side-chat-reload)
      const again = page.getByTestId('side-chat-input')
      const button = page.getByTestId('room-side-chat-button')
      await expect.poll(async () => (await again.isVisible()) || (await button.isVisible())).toBe(true)
      if (!(await again.isVisible())) await button.click()
      await expect(again).toHaveValue('a draft to keep')
      await page.screenshot({ path: `test-results/composer-shell/side-${width}-${scheme}.png` })
    })

    test(`${where}: a room's box: round send, + attach with Team files`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page)
      await signIn(page)
      await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '로고 시안 언제까지?' }] })
      await page.goto(`/rooms/${ROOM_ID}`)
      const box = page.getByTestId('room-composer')
      await expect(box.getByTestId('room-input')).toBeVisible()
      await roundSend(box.getByTestId('room-send'))
      await plusAttach(page, box.getByTestId('room-attach'), phone)
      // a phone: one line (attach, text, mic, send)
      if (phone) {
        const [a, s] = [(await box.getByTestId('room-attach').boundingBox())!, (await box.getByTestId('room-send').boundingBox())!]
        expect(Math.abs(a.y + a.height / 2 - (s.y + s.height / 2))).toBeLessThanOrEqual(2)
      }
      await page.screenshot({ path: `test-results/composer-shell/room-${width}-${scheme}.png` })
    })

    test(`${where}: an answer thread's box: round send, the mic, no attach, the reply kept after closing`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page, { teamLocale: 'en' })
      await signIn(page)
      const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
      expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: 'Which seal goes on the quote?', clientMessageId: uuidv7() } })).status()).toBe(202)
      await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
      expect((await page.request.post('/__test/people-chat', { data: { chatId: chat.id, by: 'olga', audience: 3 } })).ok()).toBeTruthy()
      const msgs = (await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }
      const answerId = msgs.items.find((m) => m.role === 'assistant')!.id
      await page.goto(`/c/${chat.id}/t/${answerId}`)
      const panel = page.getByTestId('chat-thread')
      const box = panel.getByTestId('chat-thread-box')
      await expect(box).toBeVisible()
      await roundSend(box.getByTestId('chat-thread-send'))
      await expect(box.getByTestId('voice-button')).toBeVisible()
      await expect(box.getByTestId('attach-button')).toHaveCount(0)
      await box.getByTestId('chat-thread-input').fill('Use the corporate seal.')
      await page.goto(`/c/${chat.id}`)
      await page.goto(`/c/${chat.id}/t/${answerId}`)
      await expect(panel.getByTestId('chat-thread-input')).toHaveValue('Use the corporate seal.')
      await page.screenshot({ path: `test-results/composer-shell/thread-${width}-${scheme}.png` })
    })
  }
}
