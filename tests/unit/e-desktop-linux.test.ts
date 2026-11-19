// The desktop app on Linux (docs/decisions/20261119-linux-desktop-app.md): the electron-builder settings that make the
// .deb and the AppImage, the AppImage that refuses to run without the sandbox and registers no link handler, the
// environment a program started from the AppImage gets, the search path, settings that are never "sealed" with
// Electron's fixed-key fallback, and the page's keyring hint.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import builderConfig, { LINUX_EXECUTABLE } from '../../desktop/electron-builder.config'
import { PRODUCT } from '../../shared/src/product'
import { insideAppDir, refusesUnsandboxed, registersLinkHandler, runsAsAppImage, withoutAppImage } from '../../desktop/src/common/linux'
import { defaultSearchPath, envFor, sealable } from '../../desktop/src/common/local-apps'
import { STRINGS } from '../../desktop/src/common/i18n'
import { settingsNotKeptKey as notKeptKey } from '../../web/src/lib/desktop'

const ROOT = path.join(import.meta.dir, '..', '..')
type Linux = { target: { target: string; arch: string[] }[]; category: string; executableName: string; syncDesktopName: boolean; artifactName: string; icon: string; synopsis: string; maintainer: string }
const cfg = builderConfig as unknown as { linux: Linux; extraMetadata: Record<string, string>; protocols: { schemes: string[] }[]; deb?: unknown; directories: { buildResources: string } }

describe('Linux packages: electron-builder settings', () => {
  test('a .deb and an AppImage, each for x64 and arm64', () => {
    expect(cfg.linux.target).toEqual([{ target: 'deb', arch: ['x64', 'arm64'] }, { target: 'AppImage', arch: ['x64', 'arm64'] }])
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['dist:linux']).toContain('--linux deb AppImage --x64 --arm64 --publish never')
    expect(pkg.scripts['dist:linux']).toContain('--config electron-builder.config.ts')
  })

  test('the program, the menu entry and the link handler share one name', () => {
    expect(LINUX_EXECUTABLE).toBe(PRODUCT.artifactBase.toLowerCase())
    expect(LINUX_EXECUTABLE).toMatch(/^[a-z0-9-]+$/)
    expect(cfg.linux.executableName).toBe(LINUX_EXECUTABLE)
    // without these Electron registers "<productName>.desktop" as the handler, a file the .deb does not install
    expect(cfg.extraMetadata.desktopName).toBe(`${LINUX_EXECUTABLE}.desktop`)
    expect(cfg.linux.syncDesktopName).toBe(true)
    // the menu entry's MimeType comes from protocols
    expect(cfg.protocols[0]!.schemes).toEqual([PRODUCT.linkScheme])
  })

  test('file names start with the product, the menu category and the icon', () => {
    expect(cfg.linux.artifactName).toBe(`${PRODUCT.artifactBase}-\${version}-linux-\${arch}.\${ext}`)
    expect(cfg.linux.category).toBe('Office')
    expect(fs.existsSync(path.join(ROOT, 'desktop', cfg.linux.icon))).toBe(true)
    expect(cfg.linux.synopsis).toBeTruthy()
    expect(cfg.linux.maintainer).toMatch(/<[^@>\s]+@[^>\s]+>$/)
  })

  test('the .deb: only its package name is set, so the default dependencies and the AppArmor profile stay', () => {
    expect(cfg.deb).toEqual({ packageName: LINUX_EXECUTABLE })
  })
})

describe('Linux: the AppImage', () => {
  const env = { APPIMAGE: '/home/u/Trina-AX.AppImage', APPDIR: '/tmp/.mount_TrinaX' }
  test('started without the sandbox: refused; with it: runs', () => {
    expect(refusesUnsandboxed({ platform: 'linux', packaged: true, env, noSandbox: true })).toBe(true)
    expect(refusesUnsandboxed({ platform: 'linux', packaged: true, env, noSandbox: false })).toBe(false)
  })
  test('only a packaged AppImage on Linux: the .deb, a development run and other systems are left alone', () => {
    expect(refusesUnsandboxed({ platform: 'linux', packaged: true, env: {}, noSandbox: true })).toBe(false)
    expect(refusesUnsandboxed({ platform: 'linux', packaged: false, env, noSandbox: true })).toBe(false)
    expect(refusesUnsandboxed({ platform: 'darwin', packaged: true, env, noSandbox: true })).toBe(false)
    expect(runsAsAppImage({ platform: 'win32', packaged: true, env })).toBe(false)
  })
  test('the link handler: the .deb (and the Mac and Windows apps) register it, the AppImage and a development run do not', () => {
    expect(registersLinkHandler({ platform: 'linux', packaged: true, env: {} })).toBe(true)
    expect(registersLinkHandler({ platform: 'linux', packaged: true, env })).toBe(false)
    expect(registersLinkHandler({ platform: 'darwin', packaged: true, env: {} })).toBe(true)
    expect(registersLinkHandler({ platform: 'win32', packaged: true, env: {} })).toBe(true)
    expect(registersLinkHandler({ platform: 'linux', packaged: false, env: {} })).toBe(false)
  })
  test('the dialog has its words in every language', () => {
    for (const [lang, s] of Object.entries(STRINGS)) {
      for (const k of ['sandbox.title', 'sandbox.message', 'sandbox.detail', 'sandbox.download', 'sandbox.quit'] as const) expect(s[k], `${lang} ${k}`).toBeTruthy()
      expect(s['sandbox.message'], lang).toContain('{app}')
      expect(s['sandbox.detail'], lang).toContain('.deb')
    }
  })
})

describe('Linux: what a program started from the app gets', () => {
  const appDir = '/tmp/.mount_TrinaX'
  test('inside the mount: the mount and below, not a folder that only starts with its name', () => {
    expect(insideAppDir(appDir, appDir)).toBe(true)
    expect(insideAppDir(`${appDir}/usr/lib`, appDir)).toBe(true)
    expect(insideAppDir(`${appDir}x/usr/lib`, appDir)).toBe(false)
    expect(insideAppDir('/usr/lib', appDir)).toBe(false)
    expect(insideAppDir('/usr/lib', undefined)).toBe(false)
    expect(insideAppDir('/anything', '/')).toBe(false)
    expect(insideAppDir('/x', 'relative')).toBe(false)
  })
  test("the AppImage's variables and its libraries are left out; the person's own stay", () => {
    const out = withoutAppImage({ APPIMAGE: '/home/u/a.AppImage', APPDIR: appDir, ARGV0: 'a', OWD: '/home/u', HOME: '/home/u', LD_LIBRARY_PATH: `${appDir}/usr/lib:/opt/mine/lib:${appDir}/lib` })
    expect(out).toEqual({ HOME: '/home/u', LD_LIBRARY_PATH: '/opt/mine/lib' })
    expect(withoutAppImage({ APPDIR: appDir, LD_LIBRARY_PATH: `${appDir}/usr/lib` })).toEqual({})
  })
  test('outside an AppImage nothing changes', () => {
    expect(withoutAppImage({ HOME: '/h', LD_LIBRARY_PATH: '/opt/lib', PATH: '/usr/bin' })).toEqual({ HOME: '/h', LD_LIBRARY_PATH: '/opt/lib', PATH: '/usr/bin' })
  })
  test('envFor: no AppImage or Electron variables, PATH without the mount, the setting values on top', () => {
    const base = { APPIMAGE: '/a', APPDIR: appDir, ELECTRON_RUN_AS_NODE: '1', MYCEL_DESKTOP_X: '1', HOME: '/home/u', LD_LIBRARY_PATH: `${appDir}/usr/lib`, PATH: `${appDir}/usr/bin:/usr/bin` }
    const env = envFor({ TOKEN: 'v' }, [`${appDir}/usr/bin`, '/usr/bin', '/snap/bin'], base)
    expect(env).toEqual({ HOME: '/home/u', PATH: '/usr/bin:/snap/bin', TOKEN: 'v' })
  })
  test('the search path adds /snap/bin on Linux and never looks inside the mount', () => {
    const dirs = defaultSearchPath({ PATH: `${appDir}/usr/bin:/usr/bin`, APPDIR: appDir }, '/home/u', 'linux')
    expect(dirs).toContain('/snap/bin')
    expect(dirs).toContain('/home/u/.local/bin')
    expect(dirs.some((d) => d.startsWith(appDir))).toBe(false)
    expect(defaultSearchPath({ PATH: '/usr/bin' }, '/Users/u', 'darwin')).not.toContain('/snap/bin')
    expect(defaultSearchPath({ PATH: 'C:\\bin' }, 'C:\\Users\\u', 'win32')).not.toContain('/snap/bin')
  })
})

describe('Linux: setting values are sealed only with a keyring', () => {
  test("Electron's fixed-key fallback (basic_text) is not sealed", () => {
    expect(sealable('linux', () => true, () => 'basic_text')).toBe(false)
    expect(sealable('linux', () => true, () => 'gnome_libsecret')).toBe(true)
    expect(sealable('linux', () => true, () => 'kwallet6')).toBe(true)
    expect(sealable('linux', () => false, () => 'gnome_libsecret')).toBe(false)
    expect(sealable('linux', () => true, () => { throw new Error('no backend') })).toBe(false)
  })
  test('the Mac and Windows ask only whether encryption is there (no backend to read)', () => {
    expect(sealable('darwin', () => true, () => { throw new Error('Linux only') })).toBe(true)
    expect(sealable('win32', () => false, () => 'basic_text')).toBe(false)
  })
  test('the page adds the keyring hint on Linux only, and only when the keychain was missing', () => {
    expect(notKeptKey('unavailable', 'linux')).toBe('localApps.settingsNotKeptLinux')
    expect(notKeptKey('unavailable', 'darwin')).toBe('localApps.settingsNotKept')
    expect(notKeptKey('invalid', 'linux')).toBe('localApps.settingsNotKept')
    expect(notKeptKey(undefined, undefined)).toBe('localApps.settingsNotKept')
  })
})
