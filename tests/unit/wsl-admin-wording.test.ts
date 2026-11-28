// Windows QA 2026-11-28, a WSL server on a Windows PC (server/src/system/wsl.ts):
// - Admin › System › Connection: the status says `wsl`, and the page names "Office network only" "This PC only" there
//   (the office network cannot reach a WSL server), with one line why; a public address keeps its own name
// - the connected-folder form says "this Mac" and Finder's examples only where the server is a Mac (`mac` in the list)
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { connectionStatus } from '../../server/src/system/connection'
import { setWslForTests } from '../../server/src/system/wsl'
import { DICTS } from '../../web/src/i18n'
import type { AppContext } from '../../server/src/context'

const REPO = path.resolve(import.meta.dir, '../..')
const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')
const ctxOf = () => ({
  config: { relay: { url: null, teamName: null, officialAvailable: false }, tunnel: null, publicOrigins: [], tls: null, office: false },
  services: {},
}) as unknown as AppContext

afterEach(() => setWslForTests(null))

describe('connection status on a WSL server', () => {
  test('wsl: true inside WSL, false elsewhere', () => {
    setWslForTests(true)
    expect(connectionStatus(ctxOf()).wsl).toBe(true)
    setWslForTests(false)
    expect(connectionStatus(ctxOf()).wsl).toBe(false)
  })
  test('the page: "This PC only" and the WSL line for direct-only without a public address; the public name wins', () => {
    const page = read('web/src/pages/admin/System.tsx')
    expect(page).toContain("m === 'direct-only' && pub ? 'system.mode.direct-public' : m === 'direct-only' && wsl ? 'system.mode.this-pc'")
    expect(page).toContain("{wsl && c.mode === 'direct-only' && !pub && <p className=\"mt-2 text-xs text-muted\" data-testid=\"connection-wsl-note\">{t('system.wslNote')}</p>}")
    expect(page).toContain("{wsl && <p className=\"text-xs text-muted\" data-testid=\"connection-mode-wsl-note\">{t('system.wslNote')}</p>}")
  })
})

describe('connected folders: "this Mac" only on a Mac', () => {
  test('the list says whether the server is a Mac, and the form picks its words by it', () => {
    expect(read('server/src/routes/admin.ts')).toContain("available: true, mac: process.platform === 'darwin' }")
    const page = read('web/src/pages/admin/System.tsx')
    expect(page).toContain("setMac(r.mac !== false)")
    expect(page).toContain("t(mac ? 'connected.source' : 'connected.sourceOther')")
    expect(page).toContain("t(mac ? 'connected.sourceHint' : 'connected.sourceHintOther')")
    expect(page).toContain("t(mac ? 'connected.desc' : 'connected.descOther')")
  })
  test('the words for another computer in all six languages name no Mac, Finder or /Volumes', () => {
    for (const locale of ['en', 'ko', 'ja', 'es', 'id', 'zh'] as const) {
      const d = DICTS[locale] as Record<string, string>
      for (const k of ['connected.sourceOther', 'connected.sourceHintOther', 'connected.descOther', 'system.mode.this-pc', 'system.wslNote']) {
        expect(`${locale} ${k}: ${typeof d[k] === 'string' && d[k]!.length > 0}`).toBe(`${locale} ${k}: true`)
      }
      for (const k of ['connected.sourceOther', 'connected.sourceHintOther', 'connected.descOther']) expect(d[k]).not.toMatch(/Mac|맥|Finder|访达|\/Volumes/)
    }
    expect((DICTS.ko as Record<string, string>)['connected.sourceOther']).toBe('이 컴퓨터의 폴더 경로')
  })
})
