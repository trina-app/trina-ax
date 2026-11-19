// Every app icon is the light paper tile (owner 2026-11-16, editions/trina/branding/logo/README.md): the home screen,
// the iPhone's Dark and Tinted icon styles, Notification Center and the lock screen, Android's launcher, web push, the
// desktop app and the Microsoft Store. iOS 18+ darkens an icon that has no dark appearance into a black tile, which is
// what the iPhone's notifications showed (QA TC-5234..5238), so the dark and tinted slots are named here too.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import appConfig from '../../mobile/app.config'
import { decodePng } from '../../server/src/intro-deck/png'

const root = path.resolve(import.meta.dir, '../..')
const mobileRoot = path.join(root, 'mobile')
const env = { ...process.env }
afterEach(() => { process.env = { ...env } })

/** The pixel at (fx, fy) of the picture's size is opaque and light (the paper tile, not the warm black #14110f). */
function lightAt(file: string, points: [number, number][]) {
  const img = decodePng(new Uint8Array(fs.readFileSync(file)))
  expect(img, file).not.toBeNull()
  for (const [fx, fy] of points) {
    const x = Math.min(img!.width - 1, Math.floor(fx * img!.width)), y = Math.min(img!.height - 1, Math.floor(fy * img!.height))
    const [r, g, b, a] = img!.data.subarray((y * img!.width + x) * 4, (y * img!.width + x) * 4 + 4)
    expect({ file, fx, fy, light: a! > 250 && Math.min(r!, g!, b!) > 200 }).toEqual({ file, fx, fy, light: true })
  }
}
// full-bleed squares: the four corners are tile; rounded tiles: just under the top edge, above the mark
const CORNERS: [number, number][] = [[0.03, 0.03], [0.97, 0.03], [0.03, 0.97], [0.97, 0.97]]

test('the Trina phone app gives iOS the light tile for its light, dark and tinted icons, and Android a light background', () => {
  process.env.MYCEL_MOBILE_EDITION = 'trina'
  delete process.env.MYCEL_MOBILE_GOOGLE_SERVICES; delete process.env.MYCEL_MOBILE_BUILD_NUMBER
  const c = appConfig({ config: {}, projectRoot: mobileRoot } as never)
  const icon = c.icon as string
  expect(icon).toBe('../editions/trina/branding/mobile/icon.png')
  // all three appearances: a missing dark slot is the black tile in Notification Center while the phone is dark
  expect(c.ios?.icon).toEqual({ light: icon, dark: icon, tinted: icon })
  lightAt(path.join(mobileRoot, icon), CORNERS)
  const adaptive = c.android?.adaptiveIcon
  expect(adaptive?.backgroundImage).toBe('../editions/trina/branding/mobile/adaptive-background.png')
  lightAt(path.join(mobileRoot, adaptive!.backgroundImage), CORNERS)
  expect(adaptive?.backgroundColor).toBe('#f6f2ea')
  // Android's notification: the white silhouette (platform rule) in the orange accent, never a black tile
  const notifications = (c.plugins as unknown[]).find((p): p is [string, { icon: string; color: string }] => Array.isArray(p) && p[0] === 'expo-notifications')
  expect(notifications?.[1].color).toBe('#e8521a')
  const silhouette = decodePng(new Uint8Array(fs.readFileSync(path.join(mobileRoot, notifications![1].icon))))!
  const opaque = []
  for (let i = 3; i < silhouette.data.length; i += 4) if (silhouette.data[i]! > 0) opaque.push(i)
  expect(opaque.length).toBeGreaterThan(0)
  expect(opaque.length).toBeLessThan(silhouette.width * silhouette.height * 0.8) // a shape, not a filled square
})

test('every icon file make.py and make-icons.ts write is the light tile', () => {
  const M = path.join(root, 'editions/trina/branding/mobile'), L = path.join(root, 'editions/trina/branding/logo')
  const appx = path.join(root, 'editions/trina/microsoft-store/build-resources/appx')
  for (const f of [`${M}/icon.png`, `${M}/adaptive-background.png`, `${L}/app-icon-512.png`, `${L}/app-icon-1024.png`]) lightAt(f, CORNERS)
  for (const f of fs.readdirSync(appx).filter((n) => n.endsWith('.png'))) lightAt(path.join(appx, f), CORNERS)
  const icons = path.join(root, 'web/public/icons')
  for (const f of ['apple-touch-icon.png', 'icon-maskable-512.png']) lightAt(path.join(icons, f), CORNERS)
  for (const f of ['icon-192.png', 'icon-512.png']) lightAt(path.join(icons, f), [[0.5, 0.07], [0.5, 0.93]])
  // the desktop app: the macOS grid's 824 px tile on a 1024 px canvas
  lightAt(path.join(root, 'desktop/build-resources/icon.png'), [[0.5, 0.12], [0.5, 0.88]])
  // make.py draws the dark mark only for the launch screen's dark-mode twin (a mark on nothing), never on a tile
  const make = fs.readFileSync(path.join(L, 'make.py'), 'utf8').split('\n')
  expect(make.filter((line) => /scaled\(['"]dark['"]/.test(line)).map((line) => line.match(/write\(f'\{M\}\/([\w-]+)\.svg'/)?.[1])).toEqual(['splash-icon-dark'])
})

test('web push and the installed web app show the light tile', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web/pwa/manifest.webmanifest'), 'utf8')) as { icons: { src: string }[] }
  expect(manifest.icons.map((i) => i.src)).toEqual(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'])
  // without an icon a push shows the browser's own; every showNotification names the light tile
  const sw = fs.readFileSync(path.join(root, 'web/pwa/sw.js'), 'utf8')
  const calls = sw.match(/showNotification\([^,]+, \{[^\n]*/g) ?? []
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) expect(call).toContain("icon: '/icons/icon-192.png'")
})
