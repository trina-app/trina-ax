// The pictures a saved engine session carries into the next answer (server/src/chat/session-slim.ts sessionPictures,
// QA TC-4931): each counted once, from the message, not from Claude Code's copy beside it; and when a session is kept.
import { describe, expect, test } from 'bun:test'
import { PICTURE_REMOVED, sessionPictures } from '../../server/src/chat/session-slim'
import { sessionPicturesKept, VISION_FITTED_BYTES, VISION_FITTED_IMAGES, VISION_TURN_BYTES, VISION_TURN_IMAGES } from '../../server/src/files/vision'

const pic = (n: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(n) } })
const lines = (...o: unknown[]) => Buffer.from(o.map((x) => JSON.stringify(x)).join('\n') + '\n')

describe('pictures a saved session carries', () => {
  test('each picture once: a tool result and a pasted picture count, the toolUseResult copy does not', () => {
    const session = lines(
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, pic(1000)] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Image a.jpg (shown below).' }, pic(3000)] }] },
        toolUseResult: [{ type: 'text', text: 'Image a.jpg' }, pic(3000)] },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: PICTURE_REMOVED }] } },
    )
    expect(sessionPictures(session)).toEqual({ count: 2, bytes: 4000 })
    expect(sessionPictures(lines({ type: 'user', message: { role: 'user', content: 'hi' } }))).toEqual({ count: 0, bytes: 0 })
    expect(sessionPictures(Buffer.from('not json "image"\n'))).toEqual({ count: 0, bytes: 0 })
  })

  test('a session is kept while it carries at most half of what an answer may hold', () => {
    const fitted = { images: VISION_FITTED_IMAGES, bytes: VISION_FITTED_BYTES }
    const direct = { images: VISION_TURN_IMAGES, bytes: VISION_TURN_BYTES }
    expect(sessionPicturesKept({ count: 40, bytes: VISION_FITTED_BYTES / 2 }, fitted)).toBe(true)
    expect(sessionPicturesKept({ count: 40, bytes: VISION_FITTED_BYTES / 2 + 1 }, fitted)).toBe(false)
    expect(sessionPicturesKept({ count: VISION_FITTED_IMAGES / 2 + 1, bytes: 1 }, fitted)).toBe(false)
    expect(sessionPicturesKept({ count: 10, bytes: VISION_TURN_BYTES / 2 + 1 }, direct)).toBe(false)
  })
})
