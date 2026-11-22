// QA TC-8071: the phone app showed no app version anywhere (Settings › About showed only the team server's). The app
// now hands the page its build number too (MobileConfig.appBuild, optional so older apps still validate), and About in
// the phone app shows "Phone app 1.0.10 (build 42)" above "Team server 0.9.0", in all 6 web languages.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { MOBILE_CAPABILITIES, validConfig } from '../../mobile/src/protocol'
import { DICTS, format, loadLocale } from '../../web/src/i18n'

const config = { protocol: 1, appVersion: '1.0.10', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: [...MOBILE_CAPABILITIES] }
const LOCALES = ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const

describe('the app build in the page config', () => {
  test('optional: an older app without it still validates; a build number validates; junk does not', () => {
    expect(validConfig(config)).toBe(true)
    expect(validConfig({ ...config, appBuild: '42' })).toBe(true)
    expect(validConfig({ ...config, appBuild: '1.0.10.3' })).toBe(true)
    for (const bad of [42, '', '<b>', 'x'.repeat(21), null]) expect(validConfig({ ...config, appBuild: bad })).toBe(false)
  })

  test('App.tsx sends the native build number with the version', () => {
    const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
    expect(app).toContain("import * as Application from 'expo-application'")
    expect(app).toContain('const BUILD = Application.nativeBuildVersion')
    expect(app).toContain('appVersion: VERSION, ...(BUILD ? { appBuild: BUILD } : {}),')
  })
})

describe('Settings › About in the phone app', () => {
  test('shows the app version and build above the team server version (web Settings.tsx)', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../web/src/pages/Settings.tsx'), 'utf8')
    const about = src.slice(src.indexOf('function About()'), src.indexOf('function Apps()'))
    expect(about).toContain('const app = mobileApp()')
    expect(about).toContain("t('about.appVersionBuild', { version: app.appVersion, build: app.appBuild })")
    expect(about).toContain("t('about.appVersion', { version: app.appVersion })")
    expect(about).toContain("t('about.serverVersion', { version })")
    expect(about.indexOf('about-app-version')).toBeLessThan(about.indexOf('about-version"'))
  })

  test('the words in all 6 languages carry the version and the build', async () => {
    for (const l of LOCALES) {
      await loadLocale(l)
      const d = DICTS[l]
      expect({ l, s: format(d['about.appVersionBuild'], { version: '1.0.10', build: '42' }, l).includes('1.0.10') && format(d['about.appVersionBuild'], { version: '1.0.10', build: '42' }, l).includes('42') }).toEqual({ l, s: true })
      expect({ l, s: format(d['about.appVersion'], { version: '1.0.10' }, l).includes('1.0.10') }).toEqual({ l, s: true })
      expect({ l, s: format(d['about.serverVersion'], { version: '0.9.0' }, l).includes('0.9.0') }).toEqual({ l, s: true })
    }
    expect(format(DICTS.en['about.appVersionBuild'], { version: '1.0.10', build: '42' }, 'en')).toBe('Phone app 1.0.10 (build 42)')
    expect(format(DICTS.en['about.serverVersion'], { version: '0.9.0' }, 'en')).toBe('Team server 0.9.0')
  })
})
