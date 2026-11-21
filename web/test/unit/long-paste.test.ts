// A paste past what an AI chat message holds (lib/longPaste.ts): measured against the box's text and selection, never
// cut (docs/decisions/20261118-audit2-web-limits.md).
import { expect, test } from 'bun:test'
import { EditMessageBody, MESSAGE_TEXT_MAX, ROOM_MESSAGE_MAX, SendMessageBody, SendRoomMessageBody } from '@mycel/shared/api'
import { pastedTextFile, pasteOverLimit, textOverLimit } from '../../src/lib/longPaste'
import { QUEUE_CONTENT_MAX } from '../../src/lib/sendQueue'

test('one limit: what the server takes, the queue and both boxes', () => {
  expect(MESSAGE_TEXT_MAX).toBe(200_000)
  expect(QUEUE_CONTENT_MAX).toBe(MESSAGE_TEXT_MAX)
  expect(SendMessageBody.shape.content.safeParse('a'.repeat(MESSAGE_TEXT_MAX)).success).toBe(true)
  expect(SendMessageBody.shape.content.safeParse('a'.repeat(MESSAGE_TEXT_MAX + 1)).success).toBe(false)
  expect(EditMessageBody.shape.content.safeParse('a'.repeat(MESSAGE_TEXT_MAX + 1)).success).toBe(false)
})

test('a paste is over the limit when the text after it would be longer (the selection it replaces counted out)', () => {
  const box = (value: string, start: number | null = value.length, end = start) => ({ value, selectionStart: start, selectionEnd: end })
  // 20,000 characters (the side chat box cut there before) are nothing
  expect(pasteOverLimit(box(''), 'a'.repeat(20_001))).toBe(false)
  expect(pasteOverLimit(box(''), 'a'.repeat(MESSAGE_TEXT_MAX))).toBe(false)
  expect(pasteOverLimit(box(''), 'a'.repeat(MESSAGE_TEXT_MAX + 1))).toBe(true)
  expect(pasteOverLimit(box('hello'), 'a'.repeat(MESSAGE_TEXT_MAX - 4))).toBe(true)
  // the selected text goes: pasting over all of it fits
  expect(pasteOverLimit(box('hello', 0, 5), 'a'.repeat(MESSAGE_TEXT_MAX))).toBe(false)
  // no selection known: at the end
  expect(pasteOverLimit(box('hello', null, null), 'a'.repeat(MESSAGE_TEXT_MAX - 5))).toBe(false)
  expect(pasteOverLimit(box('', 0), 'abc', 2)).toBe(true)
})

test('the text check and the pasted file', async () => {
  expect(textOverLimit('a'.repeat(MESSAGE_TEXT_MAX))).toBe(false)
  expect(textOverLimit('a'.repeat(MESSAGE_TEXT_MAX + 1))).toBe(true)
  const text = '가'.repeat(MESSAGE_TEXT_MAX + 1)
  const f = pastedTextFile(text, 'Pasted text')
  expect(f.name).toBe('Pasted text.txt')
  expect(f.type).toContain('text/plain')
  // every character, none cut
  expect(await f.text()).toBe(text)
})

test('a room box: its limit is what the server takes (10,000); a paste over it is measured the same way and never cut (TC-5089)', async () => {
  expect(ROOM_MESSAGE_MAX).toBe(10_000)
  expect(SendRoomMessageBody.shape.body.safeParse('a'.repeat(ROOM_MESSAGE_MAX)).success).toBe(true)
  expect(SendRoomMessageBody.shape.body.safeParse('a'.repeat(ROOM_MESSAGE_MAX + 1)).success).toBe(false)
  const box = (value: string, start: number | null = value.length, end = start) => ({ value, selectionStart: start, selectionEnd: end })
  expect(pasteOverLimit(box(''), 'a'.repeat(ROOM_MESSAGE_MAX), ROOM_MESSAGE_MAX)).toBe(false)
  expect(pasteOverLimit(box(''), 'a'.repeat(60_000), ROOM_MESSAGE_MAX)).toBe(true)
  expect(pasteOverLimit(box('hello'), 'a'.repeat(ROOM_MESSAGE_MAX - 4), ROOM_MESSAGE_MAX)).toBe(true)
  expect(pasteOverLimit(box('hello', 0, 5), 'a'.repeat(ROOM_MESSAGE_MAX), ROOM_MESSAGE_MAX)).toBe(false)
  // the file holds every character
  const text = '가'.repeat(60_000)
  expect(await pastedTextFile(text, 'Pasted text').text()).toBe(text)
})

test('a Windows paste counts each line break once (\\r\\n is one character in the box)', () => {
  const box = { value: '', selectionStart: 0, selectionEnd: 0 }
  // 2,500 x "abc\r\n": 12,500 raw, 10,000 in the box
  const crlf = 'abc\r\n'.repeat(2500)
  expect(crlf.length).toBe(12_500)
  expect(pasteOverLimit(box, crlf, 10_000)).toBe(false)
  expect(pasteOverLimit(box, `${crlf}ab`, 10_000)).toBe(true)
  expect(pasteOverLimit(box, 'abc\n'.repeat(2500), 10_000)).toBe(false)
  // a lone \r is not a pair
  expect(pasteOverLimit(box, 'a\r'.repeat(5001), 10_000)).toBe(true)
})
