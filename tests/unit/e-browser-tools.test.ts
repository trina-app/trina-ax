// Browser tool input schemas (shared/src/browser-tools.ts, component E).
import { describe, expect, test } from 'bun:test'
import { BROWSER_TOOLS, browserToolJsonSchema, parseBrowserToolInput } from '../../shared/src/browser-tools'
import { BrowserToolName } from '../../shared/src/api/browser'
import { PANE_TOOLS, TOOL_KIND } from '../../server/src/realtime/browser-tools'
import { BROWSER_BRIDGE_VERSION } from '../../shared/src/desktop-bridge'
import fs from 'node:fs'

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

  test('file_upload: the desktop takes 1–20 tickets with name, size and sha256; the engine names team paths; mutates-tab on both sides', () => {
    const ticket = 'A'.repeat(43)
    const file = { ticket, name: '견적서.pdf', size: 10, sha256: 'a'.repeat(64) }
    expect(parseBrowserToolInput('file_upload', { ref: 'ref_3', files: [file] }).ok).toBe(true)
    expect(parseBrowserToolInput('file_upload', { coordinate: [10, 20], how: 'drop', files: [file, { ...file, ticket: 'B'.repeat(43) }] }).ok).toBe(true)
    for (const bad of [
      { ref: 'ref_3', files: [] },
      { ref: 'ref_3', files: Array.from({ length: 21 }, () => file) },
      { ref: 'ref_3', files: [{ ...file, ticket: 'short' }] },
      { ref: 'ref_3', files: [{ ...file, sha256: 'xyz' }] },
      { ref: 'ref_3', files: [{ ...file, size: 100_000_001 }] },
      // the AI's own team path never reaches the desktop as a file
      { ref: 'ref_3', files: ['shared/견적서.pdf'] },
      { ref: 'ref_3', how: 'paste', files: [file] },
    ]) expect(parseBrowserToolInput('file_upload', bad).ok).toBe(false)
    expect(BROWSER_TOOLS.file_upload.kind).toBe('mutates-tab')
    expect(TOOL_KIND.file_upload).toBe('mutates-tab')
    const engine = PANE_TOOLS.find((t) => t.name === 'file_upload')!
    expect((engine.inputSchema as unknown as { required: string[] }).required).toEqual(['files'])
    expect((engine.inputSchema as unknown as { properties: { files: { items: { type: string }; maxItems: number } } }).properties.files).toMatchObject({ items: { type: 'string' }, maxItems: 20 })
    expect(engine.description).toContain('Not in browser_batch')
  })

  test('file_upload is never run inside browser_batch (desktop refusal), and the bridge version names it', () => {
    const pane = fs.readFileSync(new URL('../../desktop/src/main/pane/pane.ts', import.meta.url), 'utf8')
    expect(pane).toContain("if (actions.some((a) => a.name === 'file_upload')) return err('file_upload is not batchable; call it on its own.')")
    expect(BROWSER_BRIDGE_VERSION).toBe(1)
    // the Windows cadence rule ships the Windows app when a *_BRIDGE_VERSION constant changes (scripts/release/windows-inputs.ts)
    expect(fs.readFileSync(new URL('../../shared/src/desktop-bridge.ts', import.meta.url), 'utf8')).toMatch(/^export const BROWSER_BRIDGE_VERSION = 1\b/m)
    const main = fs.readFileSync(new URL('../../desktop/src/main/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('paneVersion: BROWSER_BRIDGE_VERSION')
    expect(fs.readFileSync(new URL('../../desktop/src/preload/app.ts', import.meta.url), 'utf8')).toContain('version: info?.paneVersion ?? 0')
  })
})
