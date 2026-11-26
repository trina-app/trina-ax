// Stop (답변 멈추기) in the ✦ side chat beside a room (components/rooms/SideChatPanel.tsx), the same button as the full
// chat's box (components/chat/StopButton.tsx): while my answer runs it is at the end of the box's row, a press stops the
// turn on the server (POST /api/chats/:id/stop), the answer ends as stopped, and send is back. At 1440 and on a phone
// (390). The room through page.route (rooms-mock.ts), the side chat's answers by the mock server ("slow": a long answer).
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const BEN = { id: 'ben', name: '벤' }

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`side chat at ${width}: Stop shows while my answer runs and stops the turn`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await reset(page)
    await signIn(page)
    await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '로고 시안 언제까지?' }] })
    await page.goto(`/rooms/${ROOM_ID}`)
    await page.getByTestId('room-side-chat-button').click()
    const side = page.getByTestId('room-side-chat')
    await expect(side.getByTestId('side-chat-input')).toBeVisible()
    // nothing running: send, no Stop
    await expect(side.getByTestId('side-chat-stop')).toHaveCount(0)
    await side.getByTestId('side-chat-input').fill('slow answer please, a long one')
    await side.getByTestId('side-chat-send').click()
    const stop = side.getByTestId('side-chat-stop')
    await expect(stop).toBeVisible()
    await expect(stop).toHaveAccessibleName('답변 멈추기')
    // in the box's row, inside the panel (not cut off on a phone)
    const [b, p] = [await stop.boundingBox(), await side.boundingBox()]
    expect(b!.x + b!.width).toBeLessThanOrEqual(p!.x + p!.width)
    expect(b!.width).toBeGreaterThanOrEqual(36)
    const answer = side.locator('[data-testid="assistant-message"]').last()
    await expect(answer).toHaveAttribute('data-status', 'streaming')
    const stopped = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/chats\/[^/]+\/stop$/.test(new URL(r.url()).pathname))
    await stop.click()
    const r = await stopped
    expect(r.ok()).toBe(true)
    expect(await r.json()).toMatchObject({ stopped: true })
    // the turn ends as stopped: Stop goes, send is back
    await expect(answer).toHaveAttribute('data-status', 'stopped', { timeout: 15_000 })
    await expect(stop).toHaveCount(0)
    await expect(side.getByTestId('side-chat-send')).toBeVisible()
  })
}
