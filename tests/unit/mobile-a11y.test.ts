// The phone app's own screens (mobile/App.tsx: setup, "Could not connect", the team starting, the sign-in footer) before
// the team's web page loads: every Pressable is announced as a button (React Native gives it no role), and a button
// whose text turns into a spinner while busy keeps its name and says it is busy (VoiceOver, TalkBack).
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const app = fs.readFileSync(path.resolve(import.meta.dir, '../../mobile/App.tsx'), 'utf8')

/** the props of each `<Pressable ...>` opening tag (braces counted, so `=>` and `{{ }}` inside props do not end it) */
function pressables(src: string): string[] {
  const out: string[] = []
  for (let i = src.indexOf('<Pressable'); i >= 0; i = src.indexOf('<Pressable', i + 1)) {
    let depth = 0, j = i + '<Pressable'.length
    for (; j < src.length; j++) {
      const ch = src[j]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    out.push(src.slice(i, j))
  }
  return out
}

test('every Pressable on the native screens has the button role', () => {
  const all = pressables(app)
  expect(all.length).toBeGreaterThan(10)
  expect(all.filter((p) => !p.includes('accessibilityRole="button"'))).toEqual([])
})

test('a button that shows a spinner while busy keeps its name and says it is busy', () => {
  for (const id of ['team-connect', 'setup-ask-yes', 'link-connect']) {
    const p = pressables(app).find((x) => x.includes(`testID="${id}"`))
    expect(p, id).toBeDefined()
    expect(p).toContain('accessibilityLabel=')
    expect(p).toMatch(/accessibilityState=\{\{[^}]*\bbusy\b/)
  }
})

test('the address field has a label of its own, not only a placeholder that goes away', () => {
  const input = app.slice(app.indexOf('<TextInput'), app.indexOf('/>', app.indexOf('<TextInput')))
  expect(input).toContain('accessibilityLabel=')
})
