/// <reference path="../../chrome-extension/src/chrome.d.ts" />
// Small pure parts of the person's Chrome extension: AI tab ids, the pairing's PKCE pair and done-page code, the
// browser's label, the manifest's permissions, the words in six languages.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { aiTabId, base64url, browserLabel, codeFromDoneUrl, parseAiTabId, pkceChallenge, pkcePair } from '../../chrome-extension/src/ids'
import { chromeMessages, LOCALES, MESSAGES } from '../../chrome-extension/src/messages'
import { manifest } from '../../chrome-extension/build'
import { ChromeSecret } from '../../shared/src/api/chrome'
import { PRODUCT } from '../../shared/src/product'

describe('tab ids', () => {
  test('c<chrome tab id>, also a bare number', () => {
    expect(aiTabId(42)).toBe('c42')
    expect(parseAiTabId('c42')).toBe(42)
    expect(parseAiTabId('42')).toBe(42)
    for (const bad of ['tab-3', 'c', 'c-1', 'c0', 'c1.5', 'x42', 'c99999999999', undefined]) expect(parseAiTabId(bad)).toBeNull()
  })
})

describe('PKCE', () => {
  test('verifier and challenge are 43-character base64url secrets; challenge = sha256(verifier)', async () => {
    const { verifier, challenge } = await pkcePair()
    expect(ChromeSecret.safeParse(verifier).success).toBe(true)
    expect(ChromeSecret.safeParse(challenge).success).toBe(true)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(await pkceChallenge(verifier)).toBe(challenge)
    expect((await pkcePair()).verifier).not.toBe(verifier)
  })
  test('base64url without padding', () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-')
  })
  test('the code comes only from the team origin\'s done page fragment', () => {
    const code = 'a'.repeat(43)
    const o = 'https://acme.trina.app'
    expect(codeFromDoneUrl(`${o}/connect-chrome/done#code=${code}`, o, '/connect-chrome/done')).toBe(code)
    expect(codeFromDoneUrl(`${o}/connect-chrome/done?code=${code}`, o, '/connect-chrome/done')).toBeNull()
    expect(codeFromDoneUrl(`https://evil.test/connect-chrome/done#code=${code}`, o, '/connect-chrome/done')).toBeNull()
    expect(codeFromDoneUrl(`${o}/elsewhere#code=${code}`, o, '/connect-chrome/done')).toBeNull()
    expect(codeFromDoneUrl(`${o}/connect-chrome/done#code=short`, o, '/connect-chrome/done')).toBeNull()
  })
})

describe('browser label', () => {
  test('browser and system', () => {
    expect(browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140', { brands: [{ brand: 'Google Chrome' }], platform: 'macOS' })).toBe('Chrome on Mac')
    expect(browserLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Edg/140', { brands: [{ brand: 'Microsoft Edge' }], platform: 'Windows' })).toBe('Edge on Windows')
    expect(browserLabel('Mozilla/5.0 (X11; Linux x86_64) Chrome/140', undefined, true)).toBe('Brave on Linux')
    expect(browserLabel('', {})).toBe('Chrome on a computer')
  })
})

describe('manifest', () => {
  test('exactly the permissions the listing explains, no host access by default, no content scripts', () => {
    const m = manifest('0.1.0') as Record<string, unknown>
    expect(m.manifest_version).toBe(3)
    expect(m.permissions).toEqual(['debugger', 'tabGroups', 'storage', 'alarms', 'activeTab'])
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'])
    for (const k of ['host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources']) expect(m[k]).toBeUndefined()
    expect(m.name).toBe('__MSG_extName__')
    expect((m.background as { type: string }).type).toBe('module')
  })
})

describe('messages', () => {
  const keys = Object.keys(MESSAGES.en).sort()
  test.each([...LOCALES])('%s has every key, the same placeholders, and Chrome\'s length limits', (loc) => {
    expect(Object.keys(MESSAGES[loc]).sort()).toEqual(keys)
    for (const k of keys) {
      const ph = (s: string) => [...s.matchAll(/\$\d/g)].map((m) => m[0]).sort()
      expect(ph(MESSAGES[loc][k as keyof typeof MESSAGES.en])).toEqual(ph(MESSAGES.en[k as keyof typeof MESSAGES.en]))
    }
    const out = chromeMessages(loc, PRODUCT.displayName)
    expect(out.extName.message.length).toBeLessThanOrEqual(75)
    expect(out.extDescription.message.length).toBeLessThanOrEqual(132)
    expect(out.extName.message).toContain(PRODUCT.displayName)
    expect(out.connectTo.message).toContain('$P1$')
    expect(out.connectTo.placeholders).toEqual({ p1: { content: '$1' } })
  })
})
