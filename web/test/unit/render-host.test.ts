// A Word or PowerPoint preview that draws again while its last drawing is still on its way (lib/renderHost.ts
// startDraw; owner 2026-11-22: a 12-slide deck began at slide 9 in a chat's file panel, at slide 5 in Files). The
// stand-in viewer below behaves like @aiden0z/pptx-renderer: it adds its slides in batches of 4 with a pause between
// them, open() ends after the last batch, and destroy() empties the element it drew into.
import { describe, expect, test } from 'bun:test'
import { startDraw } from '../../src/lib/renderHost'

class Box {
  children: Box[] = []
  parent: Box | null = null
  constructor(public name = '') {}
  appendChild(n: Box) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); return n }
  replaceChildren() { for (const c of this.children) c.parent = null; this.children = [] }
  get textContent(): string { return '' }
  set textContent(_v: string) { this.replaceChildren() }
  /** the slide names drawn under this box, in order */
  slides(): string[] { return this.children.flatMap((c) => (c.name.startsWith('slide') ? [c.name] : c.slides())) }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 1))

/** A viewer like the PowerPoint one: `slides` slides, 4 per batch, one tick between batches; `parse` ticks before the
 * first batch. */
const viewer = (slides: number, parse: number) => async (host: Box) => {
  for (let i = 0; i < parse; i++) await tick()
  for (let i = 0; i < slides; i++) {
    host.appendChild(new Box(`slide${i + 1}`))
    if ((i + 1) % 4 === 0) await tick()
  }
  return () => host.replaceChildren()
}

const quiet = { error: () => {}, done: () => {} }
const all = Array.from({ length: 12 }, (_, i) => `slide${i + 1}`)

describe('startDraw', () => {
  test('a drawing replaced while on its way: the box ends with every slide of the new one, from slide 1', async () => {
    // the old drawing finishes (and is destroyed) after the new one added 1 or 2 batches: the owner's slide 5 and 9
    for (const parseNew of [0, 1, 2, 3]) {
      const box = new Box()
      const stopOld = startDraw(box, () => new Box('host'), viewer(12, 1), quiet)
      await tick()
      await tick()
      stopOld()
      const stopNew = startDraw(box, () => new Box('host'), viewer(12, parseNew), quiet)
      for (let i = 0; i < 20; i++) await tick()
      expect(box.slides()).toEqual(all)
      stopNew()
    }
  })

  test('the stopped drawing: its undo runs once it finishes, its error and done are not heard', async () => {
    const box = new Box()
    const heard: string[] = []
    let undone = 0
    let signal: AbortSignal | null = null
    const stop = startDraw(box, () => new Box('host'), async (_h, s) => {
      signal = s
      await tick()
      return () => { undone++ }
    }, { error: (m) => heard.push(`error ${m}`), done: () => heard.push('done') })
    stop()
    expect(signal!.aborted).toBe(true)
    await tick()
    await tick()
    expect(undone).toBe(1)
    expect(heard).toEqual([])
    const stop2 = startDraw(box, () => new Box('host'), async () => { throw new Error('bad file') }, { error: (m) => heard.push(`error ${m}`), done: () => heard.push('done') })
    await tick()
    expect(heard).toEqual(['error bad file', 'done'])
    stop2()
  })

  test('a finished drawing: stop runs its undo at once', async () => {
    const box = new Box()
    let undone = 0
    const stop = startDraw(box, () => new Box('host'), async () => () => { undone++ }, quiet)
    await tick()
    stop()
    expect(undone).toBe(1)
    stop()
    expect(undone).toBe(1)
  })
})
