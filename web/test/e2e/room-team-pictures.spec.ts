// Pictures kept in the team folder show as pictures (docs/AGENTS/plan/20261122-0840-team-folder-room-pictures.md): a
// picture pasted in a department's group channel ("leads", its files in "leads › Chat attachments") or a project's room
// is a team file (RoomFile.teamFile) the server now marks thumb: true. It shows as a picture alone and in the gallery,
// opens the viewer on click, and names its place in its label; a file renamed to a non-picture name stays a chip, a
// deleted one the gone state. SHOTS_DIR=<folder>: screens at 1440 and 390, light and dark.
import zlib from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: 'Sora Kim' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(700 + n).padStart(12, '0')}`
const PROJECT = '019a5f00-0000-7000-8000-000000000555'

/** a plain test picture: a two-colour gradient with a light box, w × h, as a PNG */
function png(w: number, h: number, hue: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const box = x > w * 0.15 && x < w * 0.85 && y > h * 0.3 && y < h * 0.7
      const t = (x / w + y / h) / 2
      const c = box ? [244, 246, 248] : [Math.round(60 + 150 * t), Math.round(90 + (hue % 120)), Math.round(200 - 120 * t)]
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3)
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0 })
  const crc = (b: Buffer) => { let k = 0xffffffff; for (const v of b) k = table[(k ^ v) & 0xff]! ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0 }
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

type Where = 'group' | 'project'
async function openRoom(page: Page, where: Where) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const folder = where === 'group' ? 'groups/leads/Chat attachments' : `projects/Launch site/Chat attachments`
  const images = new Map<string, Buffer>()
  const pic = (n: number, name: string, w: number, h: number) => {
    images.set(id(n), png(Math.round(w / 3), Math.round(h / 3), n * 37))
    return { id: id(n), name, size: 37_068, mime: 'image/png', kind: 'image', width: w, height: h, thumb: true, teamFile: true, teamPath: `${folder}/${name}` }
  }
  const messages = [
    { id: id(1), author: SORA, body: 'The new header', extra: { files: [pic(11, 'image.png', 1200, 700)] } },
    { id: id(2), author: SORA, body: 'Three screens from QA', extra: { files: [pic(21, 'qa-1.png', 1440, 900), pic(22, 'qa-2.png', 750, 1334), pic(23, 'qa-3.png', 1280, 800)] } },
    {
      id: id(3), author: SORA, body: 'Renamed and removed',
      extra: { files: [
        { id: id(31), name: 'notes.txt', size: 900, mime: 'text/plain', kind: 'text', thumb: false, teamFile: true, teamPath: `${folder}/notes.txt` },
        { id: id(32), name: '', size: 0, mime: 'application/octet-stream', kind: 'other', thumb: false, teamFile: true, state: 'deleted' },
      ] },
    },
  ]
  const room = where === 'group'
    ? { kind: 'team' as const, room: { name: 'leads', groupId: '019a5f00-0000-7000-8000-000000000444', groupFolder: 'groups/leads' } }
    : { kind: 'group' as const, room: { name: 'Launch site', project: { id: PROJECT, name: 'Launch site', folderPath: 'projects/Launch site', canSave: true, room: true, attach: 'ok' } } }
  await routeRoom(page, { members: [SORA], messages, ...room })
  const asked: string[] = []
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => {
    const u = new URL(route.request().url())
    const fid = u.pathname.split('/').pop()!
    asked.push(`${fid}${u.searchParams.get('thumb') ? '?thumb' : ''}`)
    const body = images.get(fid)
    return body ? route.fulfill({ status: 200, body, headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' } }) : route.fulfill({ status: 404 })
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(3)
  return { asked }
}

for (const where of ['group', 'project'] as const) {
  test(`${where === 'group' ? 'group channel' : 'project room'}: a team-folder picture is a picture, three are a gallery, the viewer opens; renamed and deleted stay chips`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const { asked } = await openRoom(page, where)
    const [single, gallery, rest] = await page.getByTestId('room-message').all()
    // one picture: its own picture, not a file chip, its place in its label
    await expect(single!.getByTestId('room-file')).toHaveCount(0)
    const img = single!.getByTestId('room-image')
    await expect(img).toHaveCount(1)
    await expect(img).toHaveAttribute('data-team-file', '')
    const place = where === 'group' ? 'leads › Chat attachments' : 'Chat attachments'
    expect(await img.getAttribute('aria-label')).toContain(place)
    await expect.poll(() => img.locator('img').evaluate((im) => (im as HTMLImageElement).complete && (im as HTMLImageElement).naturalWidth > 0)).toBe(true)
    expect(asked).toContain(`${id(11)}?thumb`)
    // three: the even gallery, each tile a picture
    await expect(gallery!.getByTestId('room-gallery')).toHaveCount(1)
    await expect(gallery!.getByTestId('room-image')).toHaveCount(3)
    await expect(gallery!.getByTestId('room-file')).toHaveCount(0)
    // a file renamed to a non-picture name: a chip; a deleted one: the gone state
    await expect(rest!.getByTestId('room-image')).toHaveCount(0)
    await expect(rest!.getByTestId('room-file')).toHaveCount(1)
    await expect(rest!.getByTestId('room-file-gone')).toHaveAttribute('data-state', 'deleted')
    // a click opens the viewer with the whole picture, ← → through the gallery
    await gallery!.getByTestId('room-image').first().click()
    const viewer = page.getByTestId('image-viewer')
    await expect(viewer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
  })
}

const dir = process.env.SHOTS_DIR
for (const width of [1440, 390] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`screens: team-folder pictures (${width}, ${scheme})`, async ({ page }) => {
      test.skip(!dir, 'SHOTS_DIR not set')
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      for (const where of ['group', 'project'] as const) {
        await openRoom(page, where)
        await expect(page.getByTestId('room-image')).toHaveCount(4)
        for (const msg of await page.getByTestId('room-message').all()) {
          await msg.scrollIntoViewIfNeeded()
          await expect.poll(() => msg.locator('img').evaluateAll((ims) => ims.every((im) => (im as HTMLImageElement).complete && (im as HTMLImageElement).naturalWidth > 0))).toBe(true)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await page.mouse.move(0, 0)
        await page.getByTestId('room-message').first().scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${dir}/${where}-${width}-${scheme}.png` })
      }
    })
  }
}
