// @트리나's face in rooms (components/rooms/AiFace.tsx) and Trina's star (components/TrinaStar.tsx): where the product
// is named after its AI, the star of trina.app on the neutral circle, one gradient per drawing; elsewhere the sparkle on
// the accent circle. Beside the AI's answers and in the head of an answer shared into a room, on the AI chat's row of
// the rooms list (not the app icon), never beside people. Always decorative.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { TRINA_STAR, TrinaStar } from '../../src/components/TrinaStar'
import { AiFace, AiFaceInline } from '../../src/components/rooms/AiFace'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import RoomsPage from '../../src/pages/Rooms'
import { useRooms } from '../../src/store/rooms'
import { BEN, ME, message } from './rooms-fixtures'

const count = (html: string, s: string) => html.split(s).length - 1

test('the star: trina.app\'s shape and gradient, centred on the crossing of its arms, one gradient per drawing; decorative', () => {
  // the shape of the site's mark, as it is
  expect(TRINA_STAR).toBe('M256 40 L296 196 L452 236 L296 276 L256 472 L216 276 L60 236 L216 196 Z')
  const html = renderToStaticMarkup(<div><TrinaStar size={22} /><TrinaStar size={14} /></div>)
  expect(count(html, 'aria-hidden="true"')).toBe(2)
  expect(count(html, '<stop offset="0" stop-color="#FFB060"></stop><stop offset="1" stop-color="#FF7A1A"></stop>')).toBe(2)
  // top left to bottom right of the star, as on the site
  expect(count(html, 'x1="0" y1="0" x2="1" y2="1"')).toBe(2)
  // a square box whose middle is the crossing (256, 236), the whole star inside it
  const [x, y, w, h] = /viewBox="([^"]+)"/.exec(html)![1]!.split(' ').map(Number) as [number, number, number, number]
  expect(w).toBe(h)
  expect([x + w / 2, y + h / 2]).toEqual([256, 236])
  expect(x <= 60 && x + w >= 452 && y <= 40 && y + h >= 472).toBe(true)
  // two drawings, two gradients, each star filled with its own
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]!)
  const used = [...html.matchAll(/fill="url\(#([^)]+)\)"/g)].map((m) => m[1]!)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
  expect(used).toEqual(ids)
  for (const id of ids) expect(id).toMatch(/^[\w-]+$/)
})

test('@트리나 in a room: the star on the neutral circle where the product is named after its AI, the old sparkle elsewhere; decorative', () => {
  for (const [size, star, sparkle] of [[22, 16, 12], [32, 22, 15], [36, 26, 16], [40, 28, 18]] as const) {
    // named after its AI (Trina): the star on the neutral circle
    const named = renderToStaticMarkup(<AiFace size={size} named />)
    expect(named).toStartWith('<span aria-hidden="true"')
    expect(named).toContain('items-center justify-center rounded-full')
    expect(named).toContain('bg-hover')
    expect(named).toContain(`<svg width="${star}" height="${star}"`)
    expect(named).toContain('data-trina-star')
    expect(named).not.toContain('lucide-sparkles')
    // not named after it: the sparkle on the accent circle, as before
    const plain = renderToStaticMarkup(<AiFace size={size} named={false} />)
    expect(plain).toStartWith('<span aria-hidden="true"')
    expect(plain).toContain('rounded-full')
    expect(plain).toContain('bg-accent-soft text-accent-text')
    expect(plain).toMatch(new RegExp(`<svg[^>]* width="${sparkle}" height="${sparkle}"[^>]*lucide-sparkles`))
    expect(plain).not.toContain('data-trina-star')
    // this build: the one its product name says
    expect(renderToStaticMarkup(<AiFace size={size} />)).toBe(PRODUCT_NAMED_AFTER_AI ? named : plain)
  }
  // beside a line of small text: no circle
  const inline = renderToStaticMarkup(<AiFaceInline named />)
  expect(inline).toContain('<svg width="14" height="14"')
  expect(inline).toContain('aria-hidden="true"')
  expect(inline).not.toContain('rounded-full')
  const inlinePlain = renderToStaticMarkup(<AiFaceInline named={false} />)
  expect(inlinePlain).toMatch(/<svg[^>]* width="12" height="12"[^>]*lucide-sparkles\b[^"]* shrink-0 text-accent-text"[^>]*aria-hidden="true"/)
  expect(renderToStaticMarkup(<AiFaceInline />)).toBe(PRODUCT_NAMED_AFTER_AI ? inline : inlinePlain)
})

test('a room shows the face beside an answer of the AI and in the head of a shared answer, not beside people', () => {
  const R = uuidv7()
  const note = 'please read'
  const html = renderToStaticMarkup(
    <RoomMessages roomId={R} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} messages={[
      message({ roomId: R, seq: 1, author: BEN, body: '@트리나 Q3 spend?' }),
      message({ roomId: R, seq: 2, authorKind: 'ai', author: null, askedBy: BEN, body: 'About 48M.' }),
      message({ roomId: R, seq: 3, author: ME, body: `${note}\n\n**Summary**`, sharedAnswer: { at: note.length + 2, cut: false } }),
    ]} />,
  )
  // one face for the AI's run; the people's runs keep their letters
  expect(count(html, 'data-testid="ai-face"')).toBe(1)
  const head = /data-testid="room-shared-answer-head"[^>]*>([\s\S]*?)<\/figcaption>/.exec(html)![1]!
  expect(head).toContain(PRODUCT_NAMED_AFTER_AI ? 'data-trina-star' : 'lucide-sparkles')
  expect(count(html, PRODUCT_NAMED_AFTER_AI ? 'data-trina-star' : 'lucide-sparkles')).toBe(2)
})

test('the rooms list: the AI chat\'s pinned row has the face of rooms, at the 40px of the rooms\' pictures, not the app icon', () => {
  useRooms.setState({ rooms: [], loaded: true, failed: null })
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/rooms']}><RoomsPage /></MemoryRouter>)
  // the gradient's id is one per drawing (TrinaStar)
  const sameIds = (h: string) => h.replace(/trina-star[\w-]*/g, 'trina-star')
  const row = sameIds(/data-testid="rooms-ai"[^>]*>([\s\S]*?)<\/a>/.exec(html)![1]!)
  expect(row).toStartWith(sameIds(renderToStaticMarkup(<AiFace size={40} />)))
  expect(row).toContain('size-10')
  expect(row).toContain(PRODUCT_NAMED_AFTER_AI ? 'data-trina-star' : 'lucide-sparkles')
  expect(row).not.toContain('<img')
  expect(html).not.toContain('favicon.svg')
})
