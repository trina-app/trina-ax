// The hands-on demo's story engine (web/demo/engine.ts): triggers, story messages, the guide line, the end card, the
// canned answers and the suggestions after free typing, on the example story (web/demo/example/index.ts).
import { describe, expect, test } from 'bun:test'
import { StoryEngine } from '../../demo/engine'
import example from '../../demo/example/index'
import type { DemoEvent } from '../../demo/script'

function engine() {
  const posted: DemoEvent[] = []
  const waits: { fn: () => void; ms: number }[] = []
  const e = new StoryEngine(example, (ev) => posted.push(ev), (fn, ms) => waits.push({ fn, ms }))
  const flush = () => { while (waits.length) waits.shift()!.fn() }
  // a posted story message counts as happened, as the server says it does
  const run = () => { flush(); for (const ev of posted.splice(0)) e.fire({ event: ev.id }); flush() }
  return { e, posted, waits, flush, run }
}

describe('demo story engine', () => {
  test('the guide follows the story and waits between steps', () => {
    const { e, waits, flush, posted } = engine()
    e.fire({ start: true })
    expect(e.guide()?.id).toBe('ask')
    e.answered('company')
    // the DM step waits for the lead's message
    expect(e.guide()).toBeNull()
    expect(waits.map((w) => w.ms)).toEqual([2000])
    flush()
    expect(posted.map((p) => p.id)).toEqual(['dm-1'])
    e.fire({ event: 'dm-1' })
    expect(e.guide()?.id).toBe('dm')
    e.fire({ opened: { project: 'winter' } })
    expect(e.guide()?.id).toBe('banner')
    // either banner answer ends the step
    e.answered('new-bg')
    expect(e.guide()?.id).toBe('share')
  })

  test('a trigger happens once: its messages are sent once', () => {
    const { e, posted, flush } = engine()
    e.answered('company')
    e.answered('company')
    flush()
    expect(posted.map((p) => p.id)).toEqual(['dm-1'])
  })

  test('chained messages, then the end card after the last answer', () => {
    const { e, posted, run } = engine()
    e.fire({ shared: 'mkt-room' })
    run(); run(); run()
    expect(posted).toEqual([])
    expect(e.has({ event: 'gmail' })).toBe(true)
    expect(e.endShown).toBe(false)
    e.answered('mail')
    run()
    expect(e.endShown).toBe(true)
    e.closeEnd()
    expect(e.endClosed).toBe(true)
  })

  test('answers match their prompt exactly (spaces and Unicode forms aside), the place first', () => {
    const { e } = engine()
    expect(e.answerFor('  우리 회사는   뭐 하는 회사예요? ', 'home')?.id).toBe('company')
    expect(e.answerFor('우리 회사는 뭐 하는 회사예요?'.normalize('NFD'), 'home')?.id).toBe('company')
    // asked somewhere else, still answered (never a failure)
    expect(e.answerFor('우리 회사는 뭐 하는 회사예요?', { project: 'winter' })?.id).toBe('company')
    expect(e.answerFor('날씨 어때?', 'home')).toBeNull()
  })

  test('after free typing: the guide\'s suggestions when it points here, else this place\'s prompts', () => {
    const { e, run } = engine()
    expect(e.suggestionsFor('home').map((a) => a.id)).toEqual(['company'])
    e.answered('company')
    run()
    e.fire({ opened: { project: 'winter' } })
    expect(e.suggestionsFor({ project: 'winter' }).map((a) => a.id)).toEqual(['fix-banner', 'new-bg'])
    expect(e.suggestionsFor({ side: 'mkt-room' }).map((a) => a.id)).toEqual(['mail'])
  })

  test('a file follows the visitor\'s choice (DemoFile.pick)', () => {
    const { e } = engine()
    const f = { path: 'x.png', asset: 'a.png', pick: { 'fix-banner': 'a.png', 'new-bg': 'b.png' } }
    expect(e.pickAsset(f)).toBe('a.png')
    e.answered('new-bg')
    expect(e.pickAsset(f)).toBe('b.png')
    e.answered('fix-banner')
    expect(e.pickAsset(f)).toBe('a.png')
    expect(e.pickAsset({ path: 'y.md', text: 'hi' })).toBeUndefined()
  })

  test('a step the visitor went past is over (a later step already happened)', () => {
    const { e, flush } = engine()
    e.answered('company')
    flush()
    e.fire({ event: 'dm-1' })
    // the DM step waits for its room to be opened; the project was opened first (its link followed at once)
    e.fire({ opened: { project: 'winter' } })
    expect(e.guide()?.id).toBe('banner')
  })
})
