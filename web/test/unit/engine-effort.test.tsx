// The depth row of the composer's AI picker (docs/decisions/20261126-model-effort-choice.md): 빠르게 · 보통 · 꼼꼼하게
// under the models, only for an engine that takes a depth (Claude Code, Codex; never the API engine). A pick keeps the
// model and names the depth; a model pick keeps the depth; the button names the depth only when it is not 보통; each
// Claude model has one plain hint, in limit words on a subscription and cost words on an API key.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Attachment, EngineId } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useEngines } from '../../src/store/engines'
import Composer, { type EngineChoice } from '../../src/components/chat/Composer'
import { modelHintKey } from '../../src/components/chat/EngineMenu'
import { CHAT } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const g = globalThis as Record<string, unknown>
const before = useLocaleStore.getState().locale
const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  g.matchMedia = (q: string) => ({ matches: q === '(pointer: fine)' || q.includes('min-width'), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})
beforeEach(() => {
  useEngines.setState({ loaded: true, canChoose: true, effort: { 'claude-code': true, codex: true }, billing: { 'claude-code': 'limit' }, defaultEffort: null, defaultEngine: 'claude-code' })
})

const m = (id: string, label = id) => ({ id, label })
const MODELS: Partial<Record<EngineId, { id: string; label: string }[]>> = { 'claude-code': [m('opus', 'Claude Opus'), m('sonnet', 'Claude Sonnet'), m('haiku', 'Claude Haiku')], api: [m('gpt-x'), m('gpt-y')] }

const composer = async (engines: EngineId[], engine: EngineChoice, picks: EngineChoice[]) => mount(
  <Composer draftId="new" ensureChat={async () => CHAT} running={false} onSend={async (_t: string, _a: Attachment[]) => {}} onStop={async () => {}}
    engine={engine} onEngine={(e) => picks.push(e)} engines={engines} models={MODELS} />,
)

describe('the depth row', () => {
  test('shown under the models for Claude Code; picking 꼼꼼하게 keeps the model and sends the depth', async () => {
    const picks: EngineChoice[] = []
    const box = await composer(['claude-code'], { engine: 'claude-code', model: 'opus' }, picks)
    try {
      await box.click('engine-picker')
      expect(box.find('effort-row')).not.toBeNull()
      expect(box.get('effort-normal').getAttribute('aria-selected')).toBe('true')
      await box.click('effort-thorough')
      expect(picks).toEqual([{ engine: 'claude-code', model: 'opus', effort: 'thorough' }])
    } finally { await box.unmount() }
  })

  test('not for the API engine', async () => {
    const box = await composer(['api'], { engine: 'api', model: 'gpt-x' }, [])
    try {
      await box.click('engine-picker')
      expect(box.find('effort-row')).toBeNull()
    } finally { await box.unmount() }
  })

  test('the button names the depth only when it is not 보통', async () => {
    let box = await composer(['claude-code'], { engine: 'claude-code', model: 'opus', effort: 'thorough' }, [])
    try { expect(box.get('engine-picker').textContent).toContain('Claude Opus · 꼼꼼하게') } finally { await box.unmount() }
    box = await composer(['claude-code'], { engine: 'claude-code', model: 'opus', effort: 'normal' }, [])
    try { expect(box.get('engine-picker').textContent).not.toContain('보통') } finally { await box.unmount() }
  })

  test('a model pick keeps the chosen depth', async () => {
    const picks: EngineChoice[] = []
    const box = await composer(['claude-code'], { engine: 'claude-code', model: 'opus', effort: 'quick' }, picks)
    try {
      await box.click('engine-picker')
      const sonnet = [...box.container.querySelectorAll('[role="option"]')].find((b) => b.textContent.startsWith('Claude Sonnet'))!
      await box.click(sonnet)
      expect(picks).toEqual([{ engine: 'claude-code', model: 'sonnet', effort: 'quick' }])
    } finally { await box.unmount() }
  })

  test('the team default depth is ticked when the chat has none', async () => {
    useEngines.setState({ defaultEffort: 'quick' })
    const box = await composer(['claude-code'], { engine: 'claude-code', model: 'opus' }, [])
    try {
      await box.click('engine-picker')
      expect(box.get('effort-quick').getAttribute('aria-selected')).toBe('true')
    } finally { await box.unmount() }
  })
})

describe('model hints', () => {
  test('limit words on a subscription, cost words on an API key, none for other models', () => {
    expect(modelHintKey('opus', 'limit')).toBe('composer.modelHint.opus.limit')
    expect(modelHintKey('claude-sonnet-5-5-20261101', 'cost')).toBe('composer.modelHint.sonnet.cost')
    expect(modelHintKey('haiku', undefined)).toBe('composer.modelHint.haiku.limit')
    expect(modelHintKey('gpt-5.5-codex', 'limit')).toBeNull()
  })
  test('the hint line shows under each Claude model', async () => {
    const box = await composer(['claude-code'], { engine: 'claude-code', model: 'opus' }, [])
    try {
      await box.click('engine-picker')
      expect(box.html()).toContain('가장 똑똑해요, 한도를 빨리 써요')
    } finally { await box.unmount() }
  })
})
