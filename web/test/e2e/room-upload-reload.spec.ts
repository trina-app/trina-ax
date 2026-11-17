// A room box's files and a page reload (QA TC-4327; store/roomUploads.ts, lib/reload-guard.ts).
// - A file that is up and not sent holds the reload the page makes by itself after an update ("새 버전이 준비됐어요"
//   stays, with its 새로 고침 button). Before: the page reloaded within a minute and the chip was gone.
// - The reload the person makes brings the chip back, ready to send; sent, the page reloads by itself again.
// - A file that was still on its way comes back saying it stopped; the same file chosen again takes its place.
// At a computer's width and a phone's. The room is answered through page.route (rooms-mock.ts), the new version and
// the live connection by the mock team server. SHOTS_DIR=<folder>: the box in each state.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block' })

const BEN = { id: 'ben', name: '벤' }
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
/** a room file's id made now (UUID v7: the time first), as the server makes it */
const fileId = () => { const h = Date.now().toString(16).padStart(12, '0'); return `${h.slice(0, 8)}-${h.slice(8)}-7000-8000-00000000f101` }
const REPORT = { name: '3분기 보고서.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 report') }
const STOPPED = '페이지를 새로 고치면서 업로드가 멈췄어요. 같은 파일을 다시 선택하면 이어서 올려요.'

async function openRoom(page: Page) {
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '보고서 올려 주세요' }] })
  const state = { hang: false, uploads: 0, sent: [] as { body: string; fileIds: string[] }[], file: { id: fileId(), name: REPORT.name, size: REPORT.buffer.length, mime: REPORT.mimeType, kind: 'pdf', thumb: false } }
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), async (route) => {
    state.uploads++
    // an upload that never ends (a large file on its way): the reload cuts it
    if (state.hang) return
    return route.fulfill(json(state.file, 201))
  })
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/messages$`), (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const b = route.request().postDataJSON() as (typeof state.sent)[number]
    state.sent.push(b)
    return route.fulfill(json({
      id: '019a5f00-0000-7000-8000-0000000000aa', roomId: ROOM_ID, seq: 50, authorKind: 'user', author: { id: 'olga', name: 'Olga' }, askedBy: null, visibility: 'room',
      body: b.body, replyTo: null, mentions: [], files: b.fileIds.map(() => state.file), createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
    }, 201))
  })
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  return state
}

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
/** the page as it is loaded now is marked: a reload takes the mark away */
const mark = (page: Page) => page.evaluate(() => { (window as unknown as { __here?: boolean }).__here = true })
const marked = (page: Page) => page.evaluate(() => (window as unknown as { __here?: boolean }).__here === true)
let version = 1
/** the team server updated: the page hears the new version on its next connection */
async function newVersion(page: Page) {
  await page.request.post('/__test/server-version', { data: { version: `0.${++version}.0` } })
  await page.request.post('/__test/drop-ws')
  await expect(page.getByText('새 버전이 준비됐어요.')).toBeVisible({ timeout: 8000 })
}

for (const size of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
  test.describe(`${size.name} px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('a file that is up and not sent holds the update\'s reload; my own reload brings it back, and it sends', async ({ page }) => {
      const state = await openRoom(page)
      await page.clock.install({ time: new Date() })
      await page.getByTestId('room-file-input').setInputFiles(REPORT)
      const chip = page.getByTestId('room-file-chip')
      await expect(chip).toHaveAttribute('data-status', 'done')
      await mark(page)
      await newVersion(page)
      // the page asks every minute whether it may reload: three times, and it has not
      await page.clock.fastForward('03:05')
      expect(await marked(page)).toBe(true)
      await expect(chip).toHaveAttribute('data-status', 'done')
      await shot(page, `held-${size.name}.png`)

      // the person reloads (the notice's button): the file is in the box again, as it was
      await page.getByRole('button', { name: '새로 고침' }).click()
      await expect.poll(() => marked(page).catch(() => true)).toBe(false)
      await expect(chip).toHaveCount(1)
      await expect(chip).toHaveAttribute('data-status', 'done')
      await expect(chip).toContainText(REPORT.name)
      await shot(page, `back-${size.name}.png`)
      expect(state.uploads).toBe(1)
      await page.getByTestId('room-input').fill('3분기 보고서입니다')
      await page.getByTestId('room-send').click()
      await expect.poll(() => state.sent).toEqual([expect.objectContaining({ body: '3분기 보고서입니다', fileIds: [state.file.id] })])
      await expect(chip).toHaveCount(0)

      // nothing is held any more: the next update reloads the page by itself, and no chip comes back
      await mark(page)
      await newVersion(page)
      await page.clock.fastForward('01:05')
      await expect.poll(() => marked(page).catch(() => true)).toBe(false)
      await expect(page.getByTestId('room-message').first()).toBeVisible()
      await expect(chip).toHaveCount(0)
    })

    test('a file still on its way when the page reloads comes back saying it stopped; the same file chosen again goes up', async ({ page }) => {
      const state = await openRoom(page)
      state.hang = true
      await page.getByTestId('room-file-input').setInputFiles(REPORT)
      const chip = page.getByTestId('room-file-chip')
      await expect(chip).toHaveAttribute('data-status', 'uploading')
      // (the browser asks "leave this page?" while a file is on its way: yes)
      page.on('dialog', (d) => void d.accept())
      await page.reload()
      await expect(chip).toHaveCount(1)
      await expect(chip).toHaveAttribute('data-status', 'failed')
      await expect(chip).toContainText(REPORT.name)
      await expect(chip).toContainText(STOPPED)
      await expect(page.getByTestId('room-send')).toBeDisabled()
      await shot(page, `stopped-${size.name}.png`)

      // the same file again: it takes the stopped chip's place
      state.hang = false
      await page.getByTestId('room-file-input').setInputFiles(REPORT)
      await expect(chip).toHaveCount(1)
      await expect(chip).toHaveAttribute('data-status', 'done')
      await page.getByTestId('room-send').click()
      await expect.poll(() => state.sent.map((s) => s.fileIds)).toEqual([[state.file.id]])

      // taken out instead: nothing comes back after the next reload
      state.hang = true
      await page.getByTestId('room-file-input').setInputFiles(REPORT)
      await expect(chip).toHaveAttribute('data-status', 'uploading')
      await page.reload()
      await expect(chip).toHaveAttribute('data-status', 'failed')
      await chip.getByRole('button').click()
      await expect(chip).toHaveCount(0)
      await page.reload()
      await expect(page.getByTestId('room-message').first()).toBeVisible()
      await expect(chip).toHaveCount(0)
    })
  })
}
