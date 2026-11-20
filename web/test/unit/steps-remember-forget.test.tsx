// A "Remembered: …" step (chat/tools.ts remember) carries the new memory's id as its detail ("memory:<id>"). The screen
// never shows that id as words: the step gets its own [Forget] (DECISIONS.md "도구가 자기 단계에 덧붙이는 정보", the
// screen's undo = DELETE /api/memories/:id). Before (QA AP-065) the row opened onto a raw "memory:01a1…" line and there
// was no way to take the memory back from the chat.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps, { rememberedMemoryId } from '../../src/components/chat/Steps'
import { installDom, mount, removeDom } from './dom-host'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'remember', label: 'Remembered: Prefers short answers.', status: 'ok', startedAt: '2026-11-19T10:00:00.000Z', endedAt: '2026-11-19T10:00:01.000Z', ...o })
const kept = step({ detail: 'memory:01a1f297-e2a3-702f-a6ae-777609575bf0' })

const realFetch = globalThis.fetch
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let calls: { method: string; path: string }[] = []
let known = new Set<string>()

describe('remember step: Forget in place', () => {
  const before = useLocaleStore.getState().locale
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'en' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      calls.push({ method, path: url.pathname })
      const del = /^\/api\/memories\/([^/]+)$/.exec(url.pathname)
      if (method === 'DELETE' && del && known.delete(decodeURIComponent(del[1]!))) return new Response(null, { status: 204 })
      return json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    }) as unknown as typeof fetch
  })
  beforeEach(() => { calls = []; known = new Set(['01a1f297-e2a3-702f-a6ae-777609575bf0']) })
  afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale: before }) })

  test('the id is read only from a remember step that kept something', () => {
    expect(rememberedMemoryId(kept)).toBe('01a1f297-e2a3-702f-a6ae-777609575bf0')
    expect(rememberedMemoryId(step({ detail: undefined }))).toBeNull()
    expect(rememberedMemoryId(step({ detail: 'No answer' }))).toBeNull()
    expect(rememberedMemoryId({ tool: 'read', detail: 'memory:abc' })).toBeNull()
    expect(rememberedMemoryId(step({ detail: 'memory:../x' }))).toBeNull()
  })

  test('no raw id on screen; Forget deletes the memory and says so', async () => {
    const m = await mount(<Steps steps={[kept]} streaming={false} />)
    try {
      await m.click(m.container.querySelector('button')!) // "1 step"
      expect(m.html()).not.toContain('memory:01a1')
      const forget = m.get('step-memory-forget')
      expect(forget.textContent).toBe(translate('en', 'memory.forget'))
      await m.click(forget)
      await new Promise((r) => setTimeout(r, 20))
      expect(calls).toEqual([{ method: 'DELETE', path: '/api/memories/01a1f297-e2a3-702f-a6ae-777609575bf0' }])
      expect(m.get('step-memory-forgotten').textContent).toBe(translate('en', 'steps.memoryForgotten'))
      expect(m.find('step-memory-forget')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a memory already gone (Settings, or not the viewer\'s) says it is not in their memories', async () => {
    known.clear()
    const m = await mount(<Steps steps={[kept]} streaming={false} />)
    try {
      await m.click(m.container.querySelector('button')!)
      await m.click(m.get('step-memory-forget'))
      await new Promise((r) => setTimeout(r, 20))
      expect(m.get('step-memory-forgotten').textContent).toBe(translate('en', 'steps.memoryGone'))
    } finally { await m.unmount() }
  })

  test('a step that did not keep anything (declined card) has no Forget', async () => {
    const m = await mount(<Steps steps={[step({ label: 'Not remembered: Prefers short answers.', detail: undefined })]} streaming={false} />)
    try {
      await m.click(m.container.querySelector('button')!)
      expect(m.find('step-memory-forget')).toBeNull()
    } finally { await m.unmount() }
  })
})
