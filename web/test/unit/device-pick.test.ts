// Adding a file on a phone starts from our sheet (components/DevicePick.tsx; docs/decisions/20261118-our-file-picker-everywhere.md):
// the rows each place gets, what the 파일 row asks iOS for, and every file input of the web app named here, so a new one
// is looked at (a bare input on a phone shows iOS's raw English menu).
import { afterEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { deviceRows, filesAccept } from '../../src/components/DevicePick'

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const asPhone = (userAgent: string, maxTouchPoints = 5) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent, maxTouchPoints }, configurable: true })
afterEach(() => { if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator) })

test('a place for files: 사진 보관함 and 파일 take several, 사진 찍기 one', () => {
  expect(deviceRows(false)).toEqual([{ id: 'photos', multiple: true }, { id: 'camera', multiple: false }, { id: 'files', multiple: true }])
})

test('a place for one picture takes one from each row; a logo or an icon has no camera row', () => {
  expect(deviceRows(true)).toEqual([{ id: 'photos', multiple: false }, { id: 'camera', multiple: false }, { id: 'files', multiple: false }])
  expect(deviceRows(true, false).map((r) => r.id)).toEqual(['photos', 'files'])
})

test('the 파일 row asks iOS for any data file (the Files browser at once), elsewhere what the place takes', () => {
  asPhone('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15')
  expect(filesAccept()).toBe('application/octet-stream')
  expect(filesAccept('image/png,image/jpeg,image/webp')).toBe('application/octet-stream')
  // an iPad's Safari says it is a Mac, with touch
  asPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
  expect(filesAccept()).toBe('application/octet-stream')
  asPhone('Mozilla/5.0 (Linux; Android 14; SM-N970N) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36')
  expect(filesAccept()).toBeUndefined()
  expect(filesAccept('image/png')).toBe('image/png')
  asPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)
  expect(filesAccept()).toBeUndefined()
})

// Every file input of the web app and why it may be there. A new one: on a phone it goes through useDevicePick
// (components/DevicePick.tsx), or it names only types that are no picture (iOS then opens the Files browser at once),
// or it is a computer's (a folder picker, a computer's button).
const KNOWN: Record<string, string> = {
  'components/DevicePick.tsx': "the device rows' own inputs",
  'components/chat/Composer.tsx': "the computer's attach menu (a phone: AttachSheet)",
  'components/rooms/RoomComposer.tsx': "the computer's clip (a phone: AttachSheet)",
  'components/rooms/SideChatPanel.tsx': "the computer's clip (a phone: AttachSheet)",
  'components/rooms/apps/AppsDialog.tsx': "the computer's Upload an image row (a phone: the device rows)",
  'components/onboarding/MemberWelcome.tsx': "the computer's photo button (a phone: the device rows)",
  'components/onboarding/TeamFilesStep.tsx': "a folder picker, and the computer's file button (a phone: the device rows)",
  'components/integrations/DriveConnector.tsx': 'a .json key only (iOS: the Files browser at once)',
  'components/skills/BringSkillsSheet.tsx': "a folder picker (a computer's .claude folder)",
  'components/skills/ContributeSheet.tsx': "a folder picker (a computer's .claude folder)",
  'pages/RecentFiles.tsx': "the computer's Upload to 내 파일 (a phone: the device rows)",
  'pages/Files.tsx': "the computer's Upload (its menu: Upload files, Upload folder) (a phone: ⊕ and an empty folder's 올리기, the device rows)",
  'pages/Settings.tsx': "the computer's photo button (a phone: the device rows)",
  'pages/Welcome.tsx': "the computer's file link (a phone: the device rows)",
  'pages/admin/Plugins.tsx': 'a .trinaplugin only (iOS: the Files browser at once)',
  'pages/admin/TeamSettings.tsx': "the computer's logo button (a phone: the device rows)",
}

test('every file input of the web app is one of the known places', () => {
  const root = join(import.meta.dir, '../../src')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name) && /type=\{?["'`]file["'`]|\.type = ["']file["']/.test(readFileSync(p, 'utf8'))) found.push(relative(root, p).split('\\').join('/'))
    }
  }
  walk(root)
  expect(found.sort()).toEqual(Object.keys(KNOWN).sort())
})
