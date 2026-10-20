// Browser tool input schemas (shared/src/browser-tools.ts, component E).
import { describe, expect, test } from 'bun:test'
import { BROWSER_TOOLS, browserToolJsonSchema, parseBrowserToolInput } from '../../shared/src/browser-tools'
import { BrowserToolName } from '../../shared/src/api/browser'

describe('browser tool schemas', () => {
  test('every tool name of the wire contract has a schema, a description and a kind', () => {
    for (const name of BrowserToolName.options) {
      const spec = BROWSER_TOOLS[name]
      expect(spec).toBeDefined()
      expect(spec.description.length).toBeGreaterThan(20)
      expect(['reads-tab', 'mutates-tab', 'no-tab-target']).toContain(spec.kind)
    }
    expect(Object.keys(BROWSER_TOOLS).sort()).toEqual([...BrowserToolName.options].sort())
  })

  test('JSON Schema for the engine is an object schema without $schema', () => {
    for (const name of BrowserToolName.options) {
      const s = browserToolJsonSchema(name)
      expect(s.type).toBe('object')
      expect(s.$schema).toBeUndefined()
    }
    const computer = browserToolJsonSchema('computer') as { properties: Record<string, unknown>; required: string[] }
    expect(computer.required).toEqual(['action'])
    expect(Object.keys(computer.properties)).toContain('coordinate')
    expect((browserToolJsonSchema('navigate') as { required: string[] }).required).toEqual(['url'])
  })

  test('valid inputs parse; numeric tab ids become strings; unknown keys are dropped', () => {
    const r = parseBrowserToolInput('computer', { action: 'left_click', coordinate: [10, 20], tabId: 3, extra: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok && r.call.tool === 'computer') {
      expect(r.call.input.tabId).toBe('3')
      expect(r.call.input.coordinate).toEqual([10, 20])
      expect('extra' in r.call.input).toBe(false)
    }
    expect(parseBrowserToolInput('tabs_context', undefined).ok).toBe(true)
    expect(parseBrowserToolInput('form_input', { ref: 'ref_1', value: true }).ok).toBe(true)
    expect(parseBrowserToolInput('browser_batch', { actions: [{ name: 'computer', input: { action: 'screenshot' } }] }).ok).toBe(true)
  })

  test('invalid inputs give a short message the model can act on', () => {
    const unknown = parseBrowserToolInput('rm_rf', {})
    expect(unknown).toEqual({ ok: false, error: 'Unknown browser tool "rm_rf".' })
    const bad = parseBrowserToolInput('computer', { action: 'explode' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toStartWith('Invalid input for computer: action')
    const coord = parseBrowserToolInput('computer', { action: 'left_click', coordinate: [1] })
    expect(coord.ok).toBe(false)
    expect(parseBrowserToolInput('navigate', {}).ok).toBe(false)
    expect(parseBrowserToolInput('computer', { action: 'wait', duration: 60 }).ok).toBe(false)
    expect(parseBrowserToolInput('browser_batch', { actions: [] }).ok).toBe(false)
    expect(parseBrowserToolInput('javascript_tool', { action: 'eval', text: '1' }).ok).toBe(false)
  })
})
