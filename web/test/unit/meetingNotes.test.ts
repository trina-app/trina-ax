// Meeting notes on the team page (web/src/lib/meetingNotes.ts): the bridge only at this page's version, the note's path
// and Markdown, lines merged after a reload.
import { describe, expect, test } from 'bun:test'
import { MEETING_BRIDGE_VERSION } from '@mycel/shared'
import { meetingBridge, mergeLines, noteMarkdown, notePath } from '../../src/lib/meetingNotes'

describe('meeting notes', () => {
  test('the bridge only at the version this page knows', () => {
    const meeting = { version: MEETING_BRIDGE_VERSION } as any
    expect(meetingBridge({ meeting } as any)).toBe(meeting)
    expect(meetingBridge({ meeting: { version: MEETING_BRIDGE_VERSION + 1 } } as any)).toBeNull()
    expect(meetingBridge({} as any)).toBeNull()
    expect(meetingBridge(null)).toBeNull()
  })
  test('the note goes to My files › Meetings, named by the start, with no characters a file name cannot hold', () => {
    const at = new Date(2026, 10, 17, 14, 5).getTime()
    expect(notePath('alice', at, 'Meeting notes, 17/11/2026, 14:05')).toBe('users/alice/Meetings/2026-11-17 14.05 Meeting notes, 17 11 2026, 14 05.md')
  })
  test('one line per thing said, in time order, with who; text cannot become a heading or a list', () => {
    const at = new Date(2026, 10, 17, 14, 0, 0).getTime()
    const md = noteMarkdown({ title: 'Meeting notes', startedAt: at, you: 'You', others: 'Others', lines: [
      { track: 'others', startMs: 6000, endMs: 7000, text: '# not a heading' },
      { track: 'me', startMs: 5000, endMs: 6000, text: ' Shall   we start? ' },
    ] })
    expect(md).toBe('# Meeting notes\n\n14:00:05 **You:** Shall we start?\n\n14:00:06 **Others:** \\# not a heading\n')
  })
  test('lines that come again after a reload are not doubled', () => {
    const a = { track: 'me' as const, startMs: 1000, endMs: 2000, text: 'a' }
    const b = { track: 'others' as const, startMs: 500, endMs: 900, text: 'b' }
    expect(mergeLines([a], [a, b])).toEqual([b, a])
  })
})
