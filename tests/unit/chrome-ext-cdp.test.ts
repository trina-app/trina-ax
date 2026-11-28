/// <reference path="../../chrome-extension/src/chrome.d.ts" />
// The person's Chrome runs a fixed list of DevTools Protocol methods (chrome-extension/src/cdp-methods.ts): every
// method the source sends through cdp( is on it, nothing else calls chrome.debugger.sendCommand, and the list never
// holds a cookie, storage or browser-wide method.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CDP_METHODS } from '../../chrome-extension/src/cdp-methods'

const SRC = join(import.meta.dir, '../../chrome-extension/src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
/** the code without its comment lines (they name cdp() in prose) */
const source = (f: string) => readFileSync(join(SRC, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

describe('CDP allowlist', () => {
  test('every method sent through cdp( is listed', () => {
    const used = new Set<string>()
    for (const f of files) {
      for (const m of source(f).matchAll(/\bcdp(?:<[^>]*>)?\(\s*(?:\{[^{}]*\}|[\w.]+)\s*,\s*(['"`])([^'"`]+)\1/g)) used.add(m[2])
    }
    expect(used.size).toBeGreaterThan(20)
    const unknown = [...used].filter((m) => !CDP_METHODS.has(m))
    expect(unknown).toEqual([])
  })
  test('cdp( is never called with a method that is not a string literal', () => {
    for (const f of files) {
      for (const m of source(f).matchAll(/\bcdp(?:<[^>]*>)?\(([^\n]*)/g)) {
        if (/^\s*target: Target, method: string/.test(m[1])) continue // the wrapper itself
        expect(m[1]).toMatch(/^\s*(?:\{[^{}]*\}|[\w.]+)\s*,\s*['"`][A-Z][A-Za-z]+\.[a-zA-Z]+['"`]/)
      }
    }
  })
  test('only cdp.ts talks to chrome.debugger.sendCommand', () => {
    for (const f of files) if (f !== 'cdp.ts' && f !== 'chrome.d.ts') expect(source(f)).not.toContain('sendCommand')
  })
  test('no cookie, storage or browser-wide method', () => {
    for (const m of CDP_METHODS) {
      expect(m).not.toMatch(/cookie/i)
      expect(m).not.toMatch(/^(Storage|IndexedDB|CacheStorage|DOMStorage|Browser|SystemInfo|Tethering|ServiceWorker|Security)\./)
      expect(m).not.toMatch(/^Target\.(?!(setAutoAttach|closeTarget)$)/)
      expect(m).not.toMatch(/Network\.(getAllCookies|getCookies|setCookie|getRequestPostData|setExtraHTTPHeaders)|Fetch\.(fulfillRequest|getResponseBody)|Page\.(setDownloadBehavior|addScriptToEvaluateOnNewDocument)/)
    }
  })
  test('the wrapper refuses a method off the list', async () => {
    const { cdp } = await import('../../chrome-extension/src/cdp')
    await expect(cdp({ tabId: 1 }, 'Network.getAllCookies')).rejects.toThrow('does not send')
  })
})
