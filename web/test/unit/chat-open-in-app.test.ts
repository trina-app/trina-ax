// "Open in the app" in a chat's title menu (QA TC-2266, docs/DECISIONS.md "A chat link opens the desktop app on that
// chat"): who sees it, and the link it opens (the desktop app reads it with desktopPagePath, tests/unit/e-desktop-common).
import { describe, expect, test } from 'bun:test'
import { LOCALES, translate } from '../../src/i18n'
import { chatOpenInAppHref } from '../../src/lib/team-link'

const ID = '019a5c3e-7b2d-7c11-9f00-3a1b2c3d4e5f'
const at = { scheme: 'trina-ax', origin: 'https://acme.trina.app', chatId: ID, platform: 'mac' as const, client: 'web' as const, phone: false }

describe('"Open in the app" on a chat', () => {
  test('a computer browser on macOS, Windows or Linux: the desktop link to this chat on this team', () => {
    const href = `trina-ax://open?url=${encodeURIComponent(`https://acme.trina.app/c/${ID}`)}`
    expect(chatOpenInAppHref(at)).toBe(href)
    expect(chatOpenInAppHref({ ...at, platform: 'windows' })).toBe(href)
    // QA TC-5352: a Linux browser was "other" and never got the item
    expect(chatOpenInAppHref({ ...at, platform: 'linux' })).toBe(href)
  })
  test('nowhere else: phones, phone width, ChromeOS and unknown systems, inside the apps', () => {
    for (const platform of ['ios', 'android', 'other'] as const) expect(chatOpenInAppHref({ ...at, platform })).toBeNull()
    expect(chatOpenInAppHref({ ...at, phone: true })).toBeNull()
    for (const client of ['desktop', 'mobile'] as const) expect(chatOpenInAppHref({ ...at, client })).toBeNull()
  })
  test('only an https team: the desktop app opens no other link (a development http page shows nothing)', () => {
    for (const origin of ['', 'http://localhost:5173', 'http://acme.trina.app']) expect(chatOpenInAppHref({ ...at, origin })).toBeNull()
  })
  test('only an id-shaped chat id goes into the link', () => {
    for (const chatId of ['', '../admin', 'a/b', 'a?b', 'x'.repeat(65)]) expect(chatOpenInAppHref({ ...at, chatId })).toBeNull()
  })
  test('every locale has the label', () => {
    for (const l of LOCALES) expect(translate(l.id, 'auth.openInApp')).not.toBe('auth.openInApp')
  })
})
