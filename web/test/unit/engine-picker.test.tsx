// The composer's AI picker shows only with two or more engines (components/chat/EngineMenu.tsx showsEnginePicker, owner
// 2026-11-12, QA TC-182): one engine has no picker however many models it has (Claude with 3 models showed 4 rows);
// the model is still chosen in Settings › "AI for new chats" and Admin › Team settings › AI defaults.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Attachment, EngineId } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import Composer from '../../src/components/chat/Composer'
import { showsEnginePicker } from '../../src/components/chat/EngineMenu'
import { CHAT } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const g = globalThis as Record<string, unknown>
const before = useLocaleStore.getState().locale
const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  // a computer: a mouse, a wide window (the picker sits in the row under the box)
  g.matchMedia = (q: string) => ({ matches: q === '(pointer: fine)' || q.includes('min-width'), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

const m = (id: string) => ({ id, label: id })
const ONE_MODEL = { 'claude-code': [m('sonnet')] }
const THREE_MODELS = { 'claude-code': [m('opus'), m('sonnet'), m('haiku')] }

/** the number of rows in the picker (null: no picker) in the composer of someone who may pick the engine (onEngine given), with these engines and models */
const pickerRows = async (engines: EngineId[], models: Partial<Record<EngineId, { id: string; label: string }[]>>) => {
  const box = await mount(
    <Composer draftId="new" ensureChat={async () => CHAT} running={false} onSend={async (_t: string, _a: Attachment[]) => {}} onStop={async () => {}}
      engine={{ engine: undefined, model: undefined }} onEngine={() => {}} engines={engines} models={models} />,
  )
  try {
    const picker = box.find('engine-picker')
    if (!picker) return null
    // open: its rows (per engine its "Default model" and each model)
    await box.click(picker)
    return box.container.querySelectorAll('[role="option"]').length
  } finally {
    await box.unmount()
  }
}

describe('showsEnginePicker', () => {
  test('no engine or one engine (whatever its models): no picker', () => {
    expect(showsEnginePicker([])).toBe(false)
    expect(showsEnginePicker(['claude-code'])).toBe(false)
    expect(showsEnginePicker(['api'])).toBe(false)
  })
  test('two or more engines: the picker', () => {
    expect(showsEnginePicker(['claude-code', 'codex'])).toBe(true)
    expect(showsEnginePicker(['claude-code', 'codex', 'api'])).toBe(true)
  })
})

describe('the composer (a computer)', () => {
  test('one engine with one model: no picker', async () => expect(await pickerRows(['claude-code'], ONE_MODEL)).toBeNull())
  test('one engine with three models: no picker (was 4 rows before)', async () => expect(await pickerRows(['claude-code'], THREE_MODELS)).toBeNull())
  test('two engines: the picker, Claude default + 3 models + ChatGPT default', async () => expect(await pickerRows(['claude-code', 'codex'], THREE_MODELS)).toBe(5))
})
