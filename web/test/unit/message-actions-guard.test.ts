// Guard: a message's actions come from one place (components/messages/MessageActions.tsx; docs/decisions/
// 20261126-shared-message-actions.md). The surfaces that draw messages pass their actions to the shared sheet, bar and
// row; they do not build a long press, a hidden menu, a copy button or an action icon of their own, so one surface can
// not drift from the others again (the UX audit found three ways to open a message's actions on a phone, two thread
// icons and three copy words). A new surface that draws messages is added to SURFACES.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ACTION_ICON } from '../../src/components/messages/MessageActions'

const SRC = join(import.meta.dir, '../../src')
/** every file that draws a message (a question, an answer, a room message, a thread's answer or reply) */
const SURFACES = [
  'components/chat/Messages.tsx',
  'components/chat/ChatThreadPanel.tsx',
  'components/rooms/RoomMessages.tsx',
  'components/rooms/ThreadPanel.tsx',
  'components/rooms/SideChatPanel.tsx',
  'components/rooms/SendHere.tsx',
]
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')
/** the names a file imports from lucide-react */
const lucide = (src: string) => [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean))
/** the lucide icon names ACTION_ICON uses (a component's displayName, or the name it was exported under) */
const ACTION_ICON_NAMES = new Set(Object.values(ACTION_ICON).map((I) => (I as { displayName?: string }).displayName ?? ''))
/** icons that mean more than the action too: ✕ also closes a panel or a dialog */
const GENERIC = new Set(['X'])

test('the surfaces are where they are said to be', () => {
  for (const f of SURFACES) expect(statSync(join(SRC, f)).isFile(), f).toBe(true)
  expect(ACTION_ICON_NAMES.size).toBe(Object.keys(ACTION_ICON).length)
})

test('no surface builds its own long press, hidden menu, copy button or copy words', () => {
  for (const f of SURFACES) {
    const s = read(f)
    expect(s, `${f}: use useMessagePress`).not.toMatch(/\buseLongPress\b/)
    expect(s, `${f}: use MessageActionSheet`).not.toMatch(/\bopenSignal=/)
    expect(s, `${f}: copy is a MessageAction (copy: …)`).not.toMatch(/\bCopyButton\b/)
    expect(s, `${f}: the copy words are the shared ones (messages.copied)`).not.toMatch(/'(common|rooms)\.copied'/)
  }
})

test('no surface draws an action icon of its own: they come from ACTION_ICON', () => {
  for (const f of SURFACES) {
    const own = lucide(read(f)).filter((name) => !GENERIC.has(name)).filter((name) => ACTION_ICON_NAMES.has(name) || ACTION_ICON_NAMES.has(`${name}Icon`) || ACTION_ICON_NAMES.has(name.replace(/Icon$/, '')))
    expect(own, `${f}: use <ActionIcon id=… /> or a MessageAction`).toEqual([])
  }
})

test('one thread icon and one hover bar in the whole app', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) files.push(p)
    }
  }
  walk(SRC)
  for (const p of files) {
    const s = readFileSync(p, 'utf8')
    expect(lucide(s), p).not.toContain('MessageSquareReply')
    expect(s, p).not.toMatch(/from '[^']*MessageHoverBar'/)
  }
})
