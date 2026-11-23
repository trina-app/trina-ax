// A chat shared with people shows the people icon after its title in every history row, whoever made it: the faces of
// the others who wrote in it come at the row's end and never take the icon's place (docs/AGENTS/plan shared-icon-others-chats).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const src = (f: string) => fs.readFileSync(path.join(import.meta.dir, '..', '..', 'web', 'src', f), 'utf8')

describe('the people icon on shared chat rows', () => {
  test('the history row (Home, sidebar, sections, phone drawer) draws it whether or not faces show', () => {
    const s = src('components/nav/ChatItem.tsx')
    expect(s).toMatch(/\{rights\.shared && <SharedIcon /)
    expect(s).not.toMatch(/rights\.shared && !faces/)
    expect(s).toMatch(/faces=\{faces && <ChatFaces/)
  })
  test('the project page row draws it too', () => {
    const s = src('pages/Projects.tsx')
    expect(s).toMatch(/\{c\.shared && <SharedIcon /)
    expect(s).not.toMatch(/c\.shared && !faces/)
  })
})
