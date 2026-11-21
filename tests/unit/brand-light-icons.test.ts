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
  // the Linux app's sizes (QA TC-5353: GNOME's hicolor lookup stops at 512, so each size is its own file); every file is
  // the size its name says
  const linux = path.join(root, 'desktop/build-resources/linux-icons')
  const sizes = fs.readdirSync(linux).map((n) => Number(/^(\d+)x\1\.png$/.exec(n)?.[1])).sort((a, b) => a - b)
  expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256, 512])
  for (const n of sizes) {
    const img = decodePng(new Uint8Array(fs.readFileSync(path.join(linux, `${n}x${n}.png`))))!
    expect({ n, w: img.width, h: img.height }).toEqual({ n, w: n, h: n })
    if (n >= 48) lightAt(path.join(linux, `${n}x${n}.png`), [[0.5, 0.14], [0.5, 0.86]])
  }
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

// QA TC-5587: the iPhone icon has no alpha channel at all (iOS fills transparency with black), and the release script
// refuses a build whose compiled icon lacks the opaque light tile in the dark or tinted appearance (1.0.8 had neither).
test('the iPhone icon file has no alpha channel', () => {
  const png = fs.readFileSync(path.join(root, 'editions/trina/branding/mobile/icon.png'))
  // IHDR colour type at byte 25: 0 grey, 2 RGB (no alpha); 4 and 6 carry alpha, 3 may (tRNS)
  expect([0, 2]).toContain(png[25])
  expect(png.includes(Buffer.from('tRNS'))).toBe(false)
})

test('ios-release.sh checks the compiled icon: opaque light tile in light, dark and tinted', async () => {
  const { iconProblems } = await import(path.join(root, 'mobile/scripts/check-ios-icon.mjs')) as { iconProblems: (i: unknown) => string[] }
  const icon = (name: string, Appearance: string | undefined, SizeOnDisk = 19794, Opaque = true) =>
    ({ Name: 'AppIcon', AssetType: 'Icon Image', RenditionName: name, Idiom: 'phone', Opaque, SizeOnDisk, ...(Appearance ? { Appearance } : {}) })
  const stack = { Name: 'AppIcon', AssetType: 'MultiSized Image', SizeOnDisk: 236 }
  // 1.0.9 build 14 (assetutil output, trimmed): right
  const build14 = [icon('App-Icon-1024x1024@1x.png', undefined), icon('App-Icon-dark-1024x1024@1x.png', 'UIAppearanceDark'), icon('App-Icon-tinted-1024x1024@1x.png', 'ISAppearanceTintable'), stack]
  expect(iconProblems(build14)).toEqual([])
  // 1.0.8 build 13: only the light icon, the black tile in every dark-mode notification
  expect(iconProblems([icon('App-Icon-1024x1024@1x.png', undefined), stack])).toEqual(['no dark AppIcon in Assets.car', 'no tinted AppIcon in Assets.car'])
  // a dark icon that is another picture (a dark tile), or a tinted one with transparency
  expect(iconProblems([build14[0], icon('d', 'UIAppearanceDark', 18000), build14[2]])).toEqual(['the dark AppIcon is not the light tile'])
  expect(iconProblems([build14[0], build14[1], icon('t', 'ISAppearanceTintable', 19794, false)])).toEqual(['the tinted AppIcon has transparency (iOS fills it with black)'])
  const script = fs.readFileSync(path.join(root, 'mobile/scripts/ios-release.sh'), 'utf8')
  expect(script).toMatch(/xcrun assetutil --info "\$out\/Assets\.car" > "\$out\/assets\.json"\nnode scripts\/check-ios-icon\.mjs < "\$out\/assets\.json"/)
})
