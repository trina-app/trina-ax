// TC-4483: a folder dropped on a message box with a file beside it. The file is attached as usual; the folders add no
// chip and nothing is uploaded for them, and one line says once that folders cannot be sent (the room's box: a toast; the
// AI chat's box: the line under the box). A folder dragged from the computer cannot be made in a test, so the drag here is
// a real DataTransfer holding the file and three empty Files named like folders, and each item's entry
// (DataTransferItem.webkitGetAsEntry) says which is a folder, as the browser's does for a real one.
// SHOTS_DIR=<folder>: the room and the AI chat after the drop, at 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type JSHandle, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// English screen text; the room's answers come through page.route, which does not see the service worker's fetches
test.use({ serviceWorkers: 'block', locale: 'en-US' })

const FOLDERS = ['photos', 'drafts', 'old']
const LINE = "Folders can't be sent here. Pick the files inside, or zip the folder first."
const NETWORK = "Couldn't reach the team server"
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** each drag item's entry: a folder for the names in window.__folders, else a file (the browser's own answer for a real
 * folder; Playwright cannot drag one from the computer) */
async function folderEntries(page: Page) {
  await page.addInitScript((names) => {
    const own = DataTransferItem.prototype.webkitGetAsEntry
    DataTransferItem.prototype.webkitGetAsEntry = function (this: DataTransferItem) {
      const file = this.getAsFile()
      if (file && names.includes(file.name)) return { isDirectory: true, isFile: false, name: file.name } as unknown as FileSystemEntry
      return own.call(this) ?? (file ? ({ isDirectory: false, isFile: true, name: file.name } as unknown as FileSystemEntry) : null)
    }
  }, FOLDERS)
}

/** a drop of one text file and the three folders */
function transfer(page: Page): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle((names) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['meeting notes'], 'notes.txt', { type: 'text/plain' }))
    for (const n of names) dt.items.add(new File([], n))
    return dt
  }, FOLDERS)
}
async function dropOn(target: Locator, dt: JSHandle<DataTransfer>) {
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  await target.dispatchEvent('drop', { dataTransfer: dt })
}
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the room's box: the file attached, no chip and no upload for the folders, one line (${width}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await folderEntries(page)
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await routeRoom(page, { members: [{ id: 'ben', name: 'Ben' }], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: { id: 'ben', name: 'Ben' }, body: 'Can you send the meeting notes?' }] })
      const uploads: string[] = []
      await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), (route) => {
        const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
        uploads.push(/filename="([^"]+)"/.exec(body)?.[1] ?? '?')
        return route.fulfill(json({ id: '019a5f00-0000-7000-8000-00000000f101', name: 'notes.txt', size: 13, mime: 'text/plain', kind: 'text', thumb: false }, 201))
      })
      await page.goto(`/rooms/${ROOM_ID}`)
      await expect(page.getByTestId('room-message').first()).toBeVisible()
      await page.mouse.move(0, height - 1)
      await dropOn(page.getByTestId('room-scroller'), await transfer(page))
      const chips = page.getByTestId('room-composer').getByTestId('room-file-chip')
      await expect(chips).toHaveCount(1)
      await expect(chips.first()).toHaveAttribute('data-status', 'done')
      await expect(page.getByText(LINE)).toHaveCount(1)
      await expect(page.getByText(NETWORK)).toHaveCount(0)
      expect(uploads).toEqual(['notes.txt'])
      await shot(page, `folder-drop-room-${width}-${scheme}.png`)
    })

    test(`the AI chat's box: the file attached, no chip for the folders, one line under the box (${width}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await folderEntries(page)
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await page.mouse.move(width - 1, height - 1)
      const drop = page.getByTestId('composer-input')
      await expect(drop).toBeVisible()
      await dropOn(drop, await transfer(page))
      const chips = page.getByTestId('attachment-chip')
      await expect(chips).toHaveCount(1)
      await expect(chips.first()).toHaveAttribute('data-status', 'done')
      await expect(chips.first()).toContainText('notes.txt')
      await expect(page.getByText(LINE)).toHaveCount(1)
      await expect(page.getByText(NETWORK)).toHaveCount(0)
      await shot(page, `folder-drop-chat-${width}-${scheme}.png`)
    })
  }
}
