// Several pictures in one room message as an even gallery, like Slack's (lib/imageGallery.ts, RoomMessages.tsx Files;
// docs/AGENTS/plan/20261122-0419-image-gallery-rows.md): rows of 2 or 3, one height per row, both edges lined up.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { uuidv7 } from '@mycel/shared/api'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { GALLERY_GAP_PX, GALLERY_PX, galleryRows, rowSizes } from '../../src/lib/imageGallery'
import { BEN, ME, message } from './rooms-fixtures'

const R = uuidv7()
const pic = (width?: number, height?: number, name = 'shot.png') => ({ id: uuidv7(), name, size: 1000, mime: 'image/png', kind: 'image', width, height, thumb: true })
/** a row's height at the gallery's widest, from its ratios */
const height = (row: { ratio: number }[]) => (GALLERY_PX - GALLERY_GAP_PX * (row.length - 1)) / row.reduce((a, t) => a + t.ratio, 0)

test('rows of 2 or 3, threes first, never a picture alone on a row', () => {
  expect(rowSizes(1)).toEqual([1])
  expect(rowSizes(2)).toEqual([2])
  expect(rowSizes(3)).toEqual([3])
  expect(rowSizes(4)).toEqual([2, 2])
  expect(rowSizes(5)).toEqual([3, 2])
  expect(rowSizes(6)).toEqual([3, 3])
  expect(rowSizes(7)).toEqual([3, 2, 2])
  expect(rowSizes(10)).toEqual([3, 3, 2, 2])
})

test('a wide and a tall picture: a wide tile and a narrow tile, at one height between the limits', () => {
  const [row] = galleryRows([pic(1920, 1080), pic(1080, 1920)])
  expect(row[0].ratio).toBeGreaterThan(row[1].ratio)
  expect(height(row)).toBeLessThanOrEqual(240.01)
  expect(height(row)).toBeGreaterThanOrEqual(119.99)
})

test('no sliver: a very tall or very wide picture is cropped; tall pairs widen, wide threes narrow to fit the height', () => {
  const [tall] = galleryRows([pic(100, 2000), pic(100, 2000)])
  expect(height(tall)).toBeCloseTo(240, 0)
  const [wide] = galleryRows([pic(4000, 300), pic(4000, 300), pic(4000, 300)])
  expect(height(wide)).toBeCloseTo(120, 0)
  const [mixed] = galleryRows([pic(4000, 300), pic(300, 4000), pic(1200, 800)])
  expect(Math.max(...mixed.map((t) => t.ratio)) / Math.min(...mixed.map((t) => t.ratio))).toBeLessThanOrEqual(1.9 / 0.6 + 0.01)
  // a picture without a stored size counts as square
  const [plain] = galleryRows([pic(), pic()])
  expect(plain[0].ratio).toBe(plain[1].ratio)
})

test('a message with three pictures and a file: one gallery row, its tiles hold their space; the file stays a chip', () => {
  const doc = { id: uuidv7(), name: 'brief.pdf', size: 2000, mime: 'application/pdf', kind: 'document', thumb: false }
  const html = renderToStaticMarkup(
    <RoomMessages roomId={R} messages={[message({ roomId: R, seq: 1, author: BEN, body: '', files: [pic(1920, 1080, 'a.png'), doc, pic(1080, 1920, 'b.png'), pic(1200, 900, 'c.png')] as never })]} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} />,
  )
  expect(html).toContain('data-testid="room-gallery" data-count="3"')
  expect(html.split('data-testid="room-gallery-row"').length - 1).toBe(1)
  expect(html.split('data-testid="room-image"').length - 1).toBe(3)
  expect(html).toMatch(/aspect-ratio:[\d.]+;flex-grow:[\d.]+;flex-basis:0/)
  expect(html).toContain('object-cover')
  expect(html).toContain('brief.pdf')
  // the pictures keep their labels (the viewer opens each one)
  expect(html).toContain('aria-label="Open a.png"')
})

test('one picture: no gallery, its own shape as before', () => {
  const html = renderToStaticMarkup(<RoomMessages roomId={R} messages={[message({ roomId: R, seq: 1, author: BEN, body: '', files: [pic(1600, 1200)] as never })]} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} />)
  expect(html).not.toContain('room-gallery')
  expect(html).toContain('width:320px;height:240px')
})

test('rows of a taller gallery stay close in height: three wide over a tall and a wide', () => {
  const rows = galleryRows([pic(1440, 900), pic(1440, 900), pic(1440, 900), pic(750, 1334), pic(1200, 900)])
  const hs = rows.map(height)
  for (const h of hs) {
    expect(h).toBeGreaterThanOrEqual(149.9)
    expect(h).toBeLessThanOrEqual(190.1)
  }
})
