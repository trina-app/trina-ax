// Meeting notes on the team page (docs/AGENTS/plan/20261116-1903-live-meeting-notes.md): the desktop app captures and
// owns the meeting (DesktopBridge.meeting); the page shows the lines and writes the note to My files › Meetings as plain
// Markdown. Pure parts here; components/MeetingNotes.tsx draws them.
import { MEETING_BRIDGE_VERSION, MEETINGS_DIR, type DesktopBridge, type DesktopMeetingLine } from '@mycel/shared'

/** the bridge's meeting object when this page knows its version, else null (a browser, the store build, an older app) */
export function meetingBridge(b: DesktopBridge | null | undefined): NonNullable<DesktopBridge['meeting']> | null {
  const m = b?.meeting
  return m && m.version === MEETING_BRIDGE_VERSION ? m : null
}

const two = (n: number) => String(n).padStart(2, '0')

/** "2026-11-17 14.05 Meeting notes.md" in the person's folder: the start's local date and time and a fixed word (the
 * same name at every save of one meeting) */
export function notePath(me: string, startedAt: number, word: string): string {
  const d = new Date(startedAt)
  const name = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())} ${word}.md`
  return `users/${me}/${MEETINGS_DIR}/${name.replace(/[\\/:*?"<>|]/g, ' ')}`
}

/** hh:mm:ss of the line's start, on the clock (meeting start + its time) */
export function lineClock(startedAt: number, ms: number): string {
  const d = new Date(startedAt + ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** what was said, as text: Markdown's inline marks are escaped (a line starts with its time, so no block can begin) */
export const escapeInline = (s: string) => s.replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`)

/** The note: a title line, then one line per thing said with its time and who ("You" / "Others" in the person's words).
 * Lines are text only; nothing in them is read as Markdown structure (a leading "#" or "-" is escaped). */
export function noteMarkdown(o: { title: string; startedAt: number; lines: DesktopMeetingLine[]; you: string; others: string }): string {
  const body = [...o.lines]
    .sort((a, b) => a.startMs - b.startMs)
    .map((l) => `${lineClock(o.startedAt, l.startMs)} **${l.track === 'me' ? o.you : o.others}:** ${escapeInline(l.text.replace(/\s+/g, ' ').trim())}`)
  return `# ${o.title}\n\n${body.join('\n\n')}\n`
}

/** Merge lines that came again (a reload asks for all of them) by their place on meeting time and track. */
export function mergeLines(have: DesktopMeetingLine[], add: DesktopMeetingLine[]): DesktopMeetingLine[] {
  const key = (l: DesktopMeetingLine) => `${l.track}:${l.startMs}:${l.endMs}`
  const seen = new Set(have.map(key))
  const out = [...have]
  for (const l of add) if (!seen.has(key(l))) { seen.add(key(l)); out.push(l) }
  return out.sort((a, b) => a.startMs - b.startMs)
}
