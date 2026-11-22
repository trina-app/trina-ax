// The demo notes in the AI's instructions (server/src/chat/prompt.ts), from the owner's replay of their own asks on
// demo.trina.app (0.9.1, 11-22): a standalone phrase after a banner is the whole new headline, never a one-word swap;
// the user's words and punctuation stay exactly as typed; a recolor or edit of a photo, or a scene the demo has no
// photo of, gets one short line and no tool call; no apology for "not showing the draft" after a send card.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_BANNER_NOTE, DEMO_FAKES_NOTE, DEMO_SCENES, demoRule } from '../../server/src/chat/prompt'

const HANGUL = /[ㄱ-ㆎ가-힣]/

describe('demo banner note: which words change', () => {
  test('one rule with a priority: (a) named old -> new words, (b) a standalone phrase is the whole headline, (c) never mix', () => {
    const a = DEMO_BANNER_NOTE.indexOf('(a) The user names old and new words')
    const b = DEMO_BANNER_NOTE.indexOf('(b) Otherwise, when the user sends a standalone phrase or sentence with no edit verb right after a banner, or says "make the headline ...": the whole headline becomes exactly that phrase')
    const c = DEMO_BANNER_NOTE.indexOf('(c) Never mix the two: never merge a new phrase into the old headline or swap in only some of its words')
    expect(DEMO_BANNER_NOTE).toContain('Which words change, in this order: ')
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
    expect(DEMO_BANNER_NOTE).toContain('replace exactly those words with the edit tool')
    // the old lead sentence that outweighed the short-phrase rule is gone
    expect(DEMO_BANNER_NOTE).not.toContain('change only the words the user named')
    expect(DEMO_BANNER_NOTE).not.toContain('Never rewrite, add or drop words the user did not name.')
  })

  test('the user\'s exact words and punctuation; only the renderer breaks lines', () => {
    expect(DEMO_BANNER_NOTE).toContain("Use the user's exact words and punctuation: never add or remove a word, comma, period, mark, quote or emphasis (*italic*); line breaks are the renderer's choice, never add one yourself.")
  })

  test('the notes are English only (the Korean-text guard)', () => {
    for (const note of [DEMO_BANNER_NOTE, DEMO_FAKES_NOTE, demoRule('Steepling', true, true)]) expect(HANGUL.test(note)).toBe(false)
  })
})

describe('demo fakes note: prepared scenes and the send card', () => {
  test('lists every prepared scene of the banner kit, the green pouch in each', () => {
    const kit = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', 'scripts', 'demo', 'steepling', 'assets', 'banner', 'scenes.json'), 'utf8')) as { scenes: { id: string }[] }
    expect(Object.keys(DEMO_SCENES).sort()).toEqual(kit.scenes.map((s) => s.id).sort())
    expect(DEMO_FAKES_NOTE).toContain(`The prepared photos are exactly these scenes: ${Object.values(DEMO_SCENES).join('; ')}; the same green pouch is in every photo.`)
    for (const words of ['one glass by a frosted window', 'two glasses', 'the pouch up close', 'a cafe table']) expect(DEMO_FAKES_NOTE).toContain(words)
  })

  test('a recolor, an edit or an unlisted scene: one short line, no tool call', () => {
    expect(DEMO_FAKES_NOTE).toContain('Recoloring or editing a photo is impossible here')
    expect(DEMO_FAKES_NOTE).toContain('For a recolor or edit request, or a scene not on this list, answer in ONE short line without calling any tool, offering the listed scenes')
  })

  test('the send card showed the draft: no apology for not showing it', () => {
    expect(DEMO_FAKES_NOTE).toContain('The send card shows the user the full draft before anything is sent, so never apologize for not showing the draft.')
    expect(demoRule('Steepling', true)).toContain('never apologize for not showing the draft')
  })
})
