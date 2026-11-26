// The ask registry's findings on the web (docs/decisions/20261123-ask-registry-findings.md): Settings › Allowed for
// Trina lists a connection's send Always and, in the desktop app, this computer's browser sites; Settings › Connectors
// lists the programs connected on this computer with Remove; an edit or a new answer no longer asks first (one line says
// saved files stay); a restore with nobody else's edits lost goes at once; links in an Office preview open with no
// question; the office-network card follows the team's Always switch and a full dev-site list offers no Always.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { act, useEffect, useRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { AiAllowance, FileVersion, HistoryResponse, Integration, TurnRequest } from '@mycel/shared/api'
import type { DesktopBrowserSettings } from '@mycel/shared'
import { translate, useLocaleStore } from '../../src/i18n'
import { AiAllowances } from '../../src/components/settings/AiAllowances'
import { LocalProgramsHere } from '../../src/components/integrations/LocalProgramsHere'
import AskCard from '../../src/components/chat/AskCard'
import { HistoryModal } from '../../src/pages/Files'
import { guardLinks } from '../../src/lib/safeLinks'
import { savedFilesFrom } from '../../src/store/thread'
import { DialogHost } from '../../src/components/ui'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeElement, installDom, mount, removeDom } from './dom-host'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
let routes: Record<string, (body: unknown) => Response> = {}
let calls: { key: string; body: unknown }[] = []
let win: ReturnType<typeof installDom>
const before = { status: useSession.getState().status }

beforeAll(() => {
  win = installDom()
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
afterAll(() => {
  removeDom()
  useSession.setState({ status: before.status })
})
beforeEach(() => {
  routes = {}
  calls = []
  useLocaleStore.setState({ locale: 'en' })
  useUi.setState({ toasts: [] })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${decodeURIComponent(new URL(String(input), 'http://team.localhost').pathname)}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json({ error: { code: 'not_found', message: `no route ${key}` } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

const rows = (m: Awaited<ReturnType<typeof mount>>) => m.container.querySelectorAll('[data-testid="allowance-row"]')

describe('Settings › Allowed for Trina', () => {
  test('a connection\'s send Always is a row "Gmail · Send without asking"; Delete takes it back', async () => {
    const items: AiAllowance[] = [{ kind: 'connector_send', id: 'send:c1', connection: 'Gmail', scope: 'personal', createdAt: '2026-11-22T10:00:00.000Z' }]
    routes = { 'GET /api/ai-allowances': () => json({ items }), 'DELETE /api/ai-allowances/send:c1': () => new Response(null, { status: 204 }) }
    const m = await mount(<AiAllowances bridge={null} />)
    try {
      await m.until(() => rows(m).length === 1, 'the row')
      expect(m.get('allowance-send').textContent).toBe(`Gmail·${en('allowances.connectorSend')}`)
      await m.click('allowance-delete')
      await m.until(() => rows(m).length === 0, 'the row gone')
      expect(calls.some((c) => c.key === 'DELETE /api/ai-allowances/send:c1')).toBe(true)
    } finally { await m.unmount() }
  })

  const sites = (o: Partial<DesktopBrowserSettings> = {}): DesktopBrowserSettings => ({ siteAccess: 'ask', always: ['example.com'], privateAlways: ['10.0.0.5'], teamAllowsAll: true, ...o })
  const fakeBridge = (s: DesktopBrowserSettings) => {
    const removed: string[] = []
    let push: ((x: DesktopBrowserSettings) => void) | null = null
    const bridge = {
      get: async () => s,
      onChange: (cb: (x: DesktopBrowserSettings) => void) => { push = cb; return () => { push = null } },
      setAccess: async () => 'changed' as const,
      removeSite: async (host: string) => { removed.push(host); s = { ...s, always: s.always.filter((h) => h !== host), privateAlways: s.privateAlways.filter((h) => h !== host) }; return s },
      clearSites: async () => s,
    }
    return { bridge, removed, push: (x: DesktopBrowserSettings) => push?.(x) }
  }

  test('in the desktop app: this computer\'s browser sites are rows of their own, removed through the app', async () => {
    routes = { 'GET /api/ai-allowances': () => json({ items: [] }) }
    const b = fakeBridge(sites())
    const m = await mount(<AiAllowances bridge={b.bridge} />)
    try {
      await m.until(() => rows(m).length === 2, 'two device rows')
      expect(m.find('allowances-empty')).toBeNull()
      const lines = m.container.querySelectorAll('[data-testid="allowance-device-site"]').map((e) => e.textContent)
      expect(lines).toEqual([`example.com·${en('allowances.deviceSite')}`, `10.0.0.5·${en('allowances.deviceOffice')}`])
      await m.click(m.container.querySelectorAll('[data-testid="allowance-delete"]')[0]!)
      await m.until(() => rows(m).length === 1, 'one left')
      expect(b.removed).toEqual(['example.com'])
      // a change made elsewhere (the pane's ⚙) arrives as an event
      await act(async () => b.push(sites({ always: ['a.example', 'b.example'], privateAlways: [] })))
      await m.until(() => rows(m).length === 2, 'the new list')
      // nothing went to the team server for them
      expect(calls.filter((c) => c.key.startsWith('DELETE'))).toEqual([])
    } finally { await m.unmount() }
  })

  test('not on a phone\'s folded page (its Browser part lists them), and not outside the desktop app', async () => {
    routes = { 'GET /api/ai-allowances': () => json({ items: [] }) }
    for (const el of [<AiAllowances key="f" folded bridge={fakeBridge(sites()).bridge} />, <AiAllowances key="w" bridge={null} />]) {
      const m = await mount(el)
      try {
        await m.until(() => m.find('allowances-empty'), 'the empty line')
        expect(rows(m).length).toBe(0)
      } finally { await m.unmount() }
    }
  })
})

describe('Settings › Connectors: programs connected on this computer', () => {
  const local = (id: string, name: string) => ({ id, name, kind: 'local' }) as unknown as Integration
  const bridgeWith = (ids: string[], o: { forget?: boolean } = {}) => {
    const forgot: string[] = []
    const bridge = {
      connected: async () => ids,
      ...(o.forget === false ? {} : { forget: async (id: string) => { forgot.push(id); ids = ids.filter((x) => x !== id); return true } }),
      onConfirmed: () => () => {},
    }
    return { bridge: bridge as never, forgot }
  }

  test('named from the connection list (unknown ids left out), Remove calls forget', async () => {
    const b = bridgeWith(['c1', 'c2', 'gone'])
    const m = await mount(<LocalProgramsHere items={[local('c1', 'Aside'), local('c2', 'Playwright')]} bridge={b.bridge} />)
    try {
      await m.until(() => m.find('local-programs-here'), 'the list')
      const names = () => m.container.querySelectorAll('[data-testid="local-program-here"]').map((e) => e.querySelector('span')!.textContent)
      expect(names()).toEqual(['Aside', 'Playwright'])
      expect(m.html()).toContain(en('localApps.here.title'))
      await m.click(m.container.querySelectorAll('[data-testid="local-program-remove"]')[0]!)
      await m.until(() => names().length === 1, 'one left')
      expect(b.forgot).toEqual(['c1'])
      expect(names()).toEqual(['Playwright'])
    } finally { await m.unmount() }
  })

  test('nothing without the calls (an older desktop app, or the web)', async () => {
    for (const bridge of [bridgeWith(['c1'], { forget: false }).bridge, null]) {
      const m = await mount(<LocalProgramsHere items={[local('c1', 'Aside')]} bridge={bridge} />)
      try {
        await m.settle(20)
        expect(m.find('local-programs-here')).toBeNull()
      } finally { await m.unmount() }
    }
  })
})

describe('an edit or a new answer goes ahead at once', () => {
  test('the replaced part saved files: the notice says so; no confirm in the page', () => {
    const msgs = [{ id: 'q1', files: undefined }, { id: 'a1', files: { saved: [{ path: 'a.md' }] } }, { id: 'q2' }, { id: 'a2', files: { saved: [] } }] as never
    expect(savedFilesFrom(msgs, 'q1')).toBe(true)
    expect(savedFilesFrom(msgs, 'q2')).toBe(false)
    expect(savedFilesFrom(msgs, 'nope')).toBe(false)
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/pages/Chat.tsx'), 'utf8')
    expect(src).not.toContain('confirmDialog')
    expect(src).toContain("t('chat.branchNotice')")
    for (const L of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) expect(translate(L, 'chat.branchNotice')).not.toBe('chat.branchNotice')
  })
})

describe('Files › version history: restore', () => {
  const FILE = 'docs/plan.md'
  const ver = (n: number, savedBy: { id: string; name: string }, author: { id: string; name: string } | null): FileVersion => ({ id: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`, path: FILE, version: n, sha256: `s${n}`, size: 10, author, turnId: null, kind: 'edit', conflictPath: null, createdAt: '2026-11-21T10:00:00.000Z', savedBy })
  const history = (author: { id: string; name: string }): HistoryResponse => ({ path: FILE, items: [ver(1, { id: 'mia', name: 'Mia' }, author)], currentSha256: 'now', canRestore: true, restoreBlocked: null, current: { version: 2, sha256: 'now', size: 10, author, turnId: null, at: '2026-11-22T10:00:00.000Z' }, events: [] } as HistoryResponse)
  const open = () => mount(<MemoryRouter><HistoryModal path={FILE} onClose={() => {}} onRestored={() => {}} /><DialogHost /></MemoryRouter>)
  const dialog = () => document.body.querySelector('[data-testid="dialog-confirm"]')

  test('nobody else\'s edits drop out: no confirm, the restore goes at once', async () => {
    routes = { 'GET /api/files/history': () => json(history({ id: 'mia', name: 'Mia' })), 'POST /api/files/restore': () => json({ path: FILE, conflict: false, entry: {} }) }
    const m = await open()
    try {
      await m.click(await m.until(() => m.find('history-restore'), 'Restore'))
      await m.until(() => calls.some((c) => c.key === 'POST /api/files/restore'), 'the restore')
      expect(calls.find((c) => c.key === 'POST /api/files/restore')!.body).toEqual({ path: FILE, versionId: ver(1, { id: 'mia', name: 'Mia' }, null).id })
      expect(dialog()).toBeNull()
      expect(document.body.querySelectorAll('[role="dialog"]').length).toBe(1)
    } finally { await m.unmount() }
  })

  test('someone else\'s edits drop out: the confirm names them first', async () => {
    routes = { 'GET /api/files/history': () => json(history({ id: 'jiwoo', name: 'Jiwoo' })), 'POST /api/files/restore': () => json({ path: FILE, conflict: false, entry: {} }) }
    const m = await open()
    try {
      await m.click(await m.until(() => m.find('history-restore'), 'Restore'))
      await m.until(() => dialog(), 'the confirm')
      expect([...document.body.querySelectorAll('[role="dialog"]')].at(-1)!.textContent).toContain(en('files.restoreBodyNames', { names: 'Jiwoo' }))
      expect(calls.some((c) => c.key === 'POST /api/files/restore')).toBe(false)
      await m.click('dialog-confirm')
      await m.until(() => calls.some((c) => c.key === 'POST /api/files/restore'), 'the restore')
    } finally { await m.unmount() }
  })
})

describe('Office preview links', () => {
  function Doc({ href }: { href: string }) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => guardLinks(ref.current!), [])
    return <div ref={ref}><a href={href} data-testid="doc-link">link</a></div>
  }
  const g = globalThis as Record<string, unknown>
  let realMO: unknown, realConfirm: unknown
  // the small DOM has no namespaced attributes (an SVG link's xlink:href): none here
  const P = FakeElement.prototype as unknown as Record<string, unknown>
  const ns: Record<string, () => unknown> = { hasAttributeNS: () => false, getAttributeNS: () => null, removeAttributeNS: () => {} }
  for (const [k, f] of Object.entries(ns)) P[k] ??= f
  beforeEach(() => {
    realMO = g.MutationObserver; realConfirm = g.confirm
    g.MutationObserver = class { observe() {} disconnect() {} }
    g.confirm = () => { throw new Error('no question expected') }
  })
  afterEach(() => { g.MutationObserver = realMO; g.confirm = realConfirm })

  test('an http(s) link opens in a new tab with no question; anything else does not open', async () => {
    win.opened.length = 0
    let m = await mount(<Doc href="https://example.com/a" />)
    try {
      await m.click('doc-link')
      expect(win.opened.map((o) => o.url)).toEqual(['https://example.com/a'])
    } finally { await m.unmount() }
    m = await mount(<Doc href="javascript:alert(1)" />)
    try {
      await m.click('doc-link')
      expect(win.opened.length).toBe(1)
    } finally { await m.unmount() }
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/components/viewers/OfficeView.tsx'), 'utf8')
    expect(src).not.toContain('window.confirm')
  })
})

describe('site cards without Always', () => {
  const choices = (m: Awaited<ReturnType<typeof mount>>) => m.get('ask-choices').querySelectorAll('button').map((b) => b.textContent)
  test('the office-network card with the team switch off (noAlways): Allow once and Deny only', async () => {
    const req: TurnRequest = { kind: 'browser_site', requestId: 'r1', url: 'http://10.0.0.5/', host: '10.0.0.5', noAlways: true }
    let m = await mount(<AskCard req={{ request: req }} onAnswer={async () => {}} />)
    try {
      expect(m.find('site-card-always')).toBeNull()
      expect(choices(m)).toEqual([en('browser.allowOnce'), en('devEnvSite.deny')])
    } finally { await m.unmount() }
    m = await mount(<AskCard req={{ request: { ...req, noAlways: undefined } }} onAnswer={async () => {}} />)
    try { expect(m.find('site-card-always')).not.toBeNull() } finally { await m.unmount() }
  })

  test('a full dev-site list (listFull): no Always, one line says where to make room', async () => {
    const req: TurnRequest = { kind: 'dev_env_site', requestId: 'r2', host: 'registry.example', listFull: true }
    let m = await mount(<AskCard req={{ request: req }} onAnswer={async () => {}} />)
    try {
      expect(m.find('dev-env-site-always')).toBeNull()
      expect(m.get('dev-env-site-full').textContent).toBe(en('devEnvSite.listFull'))
      expect(en('devEnvSite.listFull')).toContain(en('settings.devEnvSites'))
    } finally { await m.unmount() }
    m = await mount(<AskCard req={{ request: { ...req, listFull: undefined } }} onAnswer={async () => {}} />)
    try {
      expect(m.find('dev-env-site-always')).not.toBeNull()
      expect(m.find('dev-env-site-full')).toBeNull()
    } finally { await m.unmount() }
  })

  test('every app language has the new words', () => {
    for (const L of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      for (const k of ['allowances.connectorSend', 'allowances.deviceSite', 'allowances.deviceOffice', 'devEnvSite.listFull', 'localApps.here.title', 'localApps.here.hint', 'localApps.here.remove', 'localApps.here.removeLabel'] as const) expect(translate(L, k)).not.toBe(k)
      // the Settings section the line names is the one the app shows
      expect(translate(L, 'devEnvSite.listFull')).toContain(translate(L, 'settings.devEnvSites'))
    }
  })
})
