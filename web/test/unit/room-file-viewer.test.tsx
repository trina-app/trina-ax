// The viewer mounted (components/ImageViewer.tsx with its document stage): it settles after it opens with no pane (the
// side panel's own picture, a Markdown picture in Files), and a document it shows is read once while the room around
// it draws again (a reaction, a new file in the pane): the chip builds its item anew on every render, and the viewer
// must not take that for another file.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, Profiler, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { RoomFile } from '@mycel/shared/api'
import { ImageGroup, ImageViewerHost, useViewerItem } from '../../src/components/ImageViewer'
import { closeImageViewer, openImageViewer, roomFileItem } from '../../src/lib/imageViewer'
import { FakeNode, installDom, mount, removeDom } from './dom-host'

const ROOM = '019a5f00-0000-7000-8000-000000000001'
const file = (n: number, name: string): RoomFile => ({ id: `019a5f00-0000-7000-8000-0000000000${n}`, name, size: 10, mime: 'text/plain', kind: 'text', thumb: false })
const F1 = file(11, 'notes.txt')
const F2 = file(12, 'other.txt')

// document order for the fake DOM (a pane lists what is on the page in the order it is drawn)
const pathOf = (n: FakeNode) => {
  const p: number[] = []
  for (let x: FakeNode = n; x.parentNode; x = x.parentNode) p.unshift(x.parentNode.childNodes.indexOf(x))
  return p
}
const proto = FakeNode.prototype as unknown as { compareDocumentPosition?: (o: FakeNode) => number }
const saved = { fetch: globalThis.fetch, ResizeObserver: (globalThis as { ResizeObserver?: unknown }).ResizeObserver, compare: proto.compareDocumentPosition }
const reads: string[] = []

beforeAll(() => {
  installDom()
  proto.compareDocumentPosition = function (this: FakeNode, o: FakeNode) {
    const a = pathOf(this), b = pathOf(o)
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? 4 : 2
    return a.length < b.length ? 4 | 16 : 2 | 8
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  let state: unknown = null
  Object.defineProperty(globalThis.window, 'history', { configurable: true, writable: true, value: { get state() { return state }, pushState(s: unknown) { state = s }, replaceState(s: unknown) { state = s }, back() {}, forward() {} } })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reads.push(String(input instanceof Request ? input.url : input))
    return new Response('hello text', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '10' } })
  }) as typeof fetch
})
afterEach(() => closeImageViewer(false))
afterAll(() => {
  globalThis.fetch = saved.fetch
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved.ResizeObserver
  proto.compareDocumentPosition = saved.compare
  removeDom()
})

test('opened with no pane (a picture of its own), it settles: no render after render', async () => {
  let commits = 0
  const page = await mount(<MemoryRouter><Profiler id="v" onRender={() => { commits++ }}><ImageViewerHost /></Profiler></MemoryRouter>)
  try {
    const before = commits
    await act(async () => openImageViewer({ group: null, entry: { item: { key: 'local:x', name: 'x.png', original: null }, el: null }, opener: null, openerKey: 'local:x' }))
    await page.settle(300)
    expect(commits - before).toBeLessThan(20)
  } finally {
    await page.unmount()
  }
})

let bump = () => {}
let addSecond = () => {}
function Chip({ f, n }: { f: RoomFile; n: number }) {
  const v = useViewerItem((meta) => roomFileItem(ROOM, f, null, meta))
  return <button type="button" ref={v.ref} onClick={v.open} data-testid={`chip-${f.id}`} data-n={n}>{f.name}</button>
}
function Pane() {
  const [n, setN] = useState(0)
  const [two, setTwo] = useState(false)
  bump = () => setN((x) => x + 1)
  addSecond = () => setTwo(true)
  return <ImageGroup><Chip f={F1} n={n} />{two && <Chip f={F2} n={n} />}</ImageGroup>
}

test('the open document is read once while the room draws again around it', async () => {
  const page = await mount(<MemoryRouter><Pane /><ImageViewerHost /></MemoryRouter>)
  try {
    await page.click(`chip-${F1.id}`)
    await page.until(() => reads.some((u) => u.includes(F1.id)), 'the document read')
    await page.settle(50)
    const first = reads.filter((u) => u.includes(F1.id)).length
    expect(first).toBe(1)
    // a reaction or an edit draws the chip again; a new file arrives in the pane
    await act(async () => bump())
    await page.settle(50)
    await act(async () => addSecond())
    await page.settle(100)
    expect(reads.filter((u) => u.includes(F1.id))).toHaveLength(first)
    // the new file is in the list: "1 / 2"
    expect(page.get('image-viewer-count').textContent).toBe('1 / 2')
  } finally {
    await page.unmount()
  }
})
