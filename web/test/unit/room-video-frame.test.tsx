// A video sent in a room shows a frame of itself in the timeline, as a photo shows its thumbnail (QA TC-7239), and the
// viewer's column starts hidden on a short screen (a phone on its side) so the player has the width.
import { expect, test } from 'bun:test'
import { translate } from '../../src/i18n'
import { RoomMessages, roomVideoFrame } from '../../src/components/rooms/RoomMessages'
import { columnShown } from '../../src/components/rooms/ViewerColumn'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { BEN, ME, message } from './rooms-fixtures'
import { uuidv7 } from '@mycel/shared/api'

const R = uuidv7()
const video = (over: Record<string, unknown> = {}) => ({ id: uuidv7(), name: 'intro.mp4', size: 14_300_000, mime: 'video/mp4', kind: 'video', thumb: false, ...over })

test('which videos get a frame: one the browser plays here; another kind, an unknown format or a gone file does not', () => {
  expect(roomVideoFrame(video() as never, null)).toBe(true)
  expect(roomVideoFrame(video({ name: 'clip.webm' }) as never, null)).toBe(true)
  expect(roomVideoFrame(video({ name: 'clip.avi' }) as never, null)).toBe(false)
  expect(roomVideoFrame(video({ name: 'notes.pdf', kind: 'document' }) as never, null)).toBe(false)
  expect(roomVideoFrame(video({ state: 'deleted' }) as never, null)).toBe(false)
})

test("a video's frame: the room's address at 0.1 s, metadata only, a 16:9 box until its size is known, a play mark; a video it cannot decode is its chip", async () => {
  const { act } = await import('react')
  const f = video()
  const m0 = message({ roomId: R, seq: 1, author: BEN, body: 'our intro', files: [f] as never })
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[m0]} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} />)
  try {
    const btn = m.get('room-video')
    expect(btn.getAttribute('aria-label')).toBe(translate('en', 'rooms.playVideo', { name: 'intro.mp4' }))
    expect([btn.style.width, btn.style.height]).toEqual(['320px', '180px'])
    const v = m.get('room-video-frame')
    expect(v.getAttribute('src')).toContain(`/rooms/${R}/files/${f.id}`)
    expect(v.getAttribute('src')!.endsWith('#t=0.1')).toBe(true)
    expect(v.getAttribute('preload')).toBe('metadata')
    expect((v as unknown as { muted?: boolean }).muted).toBe(true)
    expect(m.html()).not.toContain('data-testid="room-file"')
    // a portrait phone video: its own shape in the photo's box (at most 320 x 240)
    Object.assign(v, { videoWidth: 1080, videoHeight: 1920 })
    await act(async () => { v.dispatchEvent(new FakeEvent('loadedmetadata')) })
    expect([m.get('room-video').style.width, m.get('room-video').style.height]).toEqual(['135px', '240px'])
    // a format this browser cannot decode: the file chip, with its name and download
    await act(async () => { m.get('room-video-frame').dispatchEvent(new FakeEvent('error')) })
    expect(m.html()).not.toContain('data-testid="room-video"')
    expect(m.html()).toContain('data-testid="room-file"')
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('the viewer column: hidden at first on a short screen, shown elsewhere; what was asked (toggle, ✦, thread) wins', () => {
  expect(columnShown(null, false)).toBe(true)
  expect(columnShown(null, true)).toBe(false)
  expect(columnShown(true, true)).toBe(true)
  expect(columnShown(false, false)).toBe(false)
})
