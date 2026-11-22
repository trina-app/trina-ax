// The examples of the kept skills in the viewer's own language (onboarding/skill-examples.ts viewerExample; the routes
// GET /api/onboarding/packs and GET /api/skills/examples): a Korean account on an English team sees the Korean example
// (EXAMPLE.md text, the intro deck's picture) when the skill has one, the team's otherwise, with the example's own
// `locale` when it is not the skill text's. The installed skill text never changes.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { setSetting } from '../../server/src/admin/settings'
import { exampleBody, inViewerLanguage, PACK_EXAMPLES, packExample, viewerExample } from '../../server/src/onboarding/skill-examples'

setDefaultTimeout(60_000)

const text = (l: 'ko' | 'en' | 'ja', name: string) => {
  const e = PACK_EXAMPLES[l][name]
  return e?.kind === 'text' ? exampleBody(e.text) : null
}

describe('viewerExample (no server)', () => {
  test('the viewer\'s own example when the skill has one, marked with its language; else the team\'s as before', () => {
    // a Korean viewer, English text: the Korean EXAMPLE.md
    expect(viewerExample('ko', 'meeting-notes', 'en', 'en')).toEqual({ kind: 'text', markdown: text('ko', 'meeting-notes')!, locale: 'ko' })
    // the intro deck: the picture made in the viewer's language
    expect(viewerExample('ja', 'intro-deck', 'en', 'en')).toEqual({ kind: 'image', url: '/skill-examples/ja/intro-deck.webp', company: 'Soopteum', locale: 'ja' })
    expect(viewerExample('en', 'intro-deck', 'en', 'ja')).toEqual({ kind: 'image', url: '/skill-examples/en/intro-deck.webp', company: 'Soopteum' })
    // the card news is made in Korean and English only: a Japanese viewer gets the team's, as before
    expect(viewerExample('ja', 'card-news', 'ko', 'ko')).toEqual(packExample('ko', 'card-news', 'ko'))
    // the same language: the same as before
    for (const name of ['meeting-notes', 'humanizer', 'intro-deck', 'card-news']) expect(viewerExample('ko', name, 'ko', 'ko')).toEqual(packExample('ko', name, 'ko'))
    expect(viewerExample('ko', 'not-a-kept-skill', 'ko', 'ko')).toBeNull()
  })

  test('inViewerLanguage leaves a row without an example or a language as it is', () => {
    const rows = [{ name: 'meeting-notes', example: packExample('en', 'meeting-notes'), locale: 'en' as const }, { name: 'meeting-notes' }, { name: 'meeting-notes', example: null, locale: 'en' as const }]
    const out = inViewerLanguage(rows, 'ko', 'en')
    expect(out[0]!.example).toEqual({ kind: 'text', markdown: text('ko', 'meeting-notes')!, locale: 'ko' })
    expect(out[0]!.locale).toBe('en')
    expect(out.slice(1)).toEqual(rows.slice(1))
  })
})

describe('over the API', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ name: 'b-skill-examples-viewer' })
    // an English team; dana (the owner) reads Korean, alice (a member) English
    setSetting(h.ctx.db, 'defaultLocale', 'en')
  })
  afterAll(async () => { await h?.close() })

  test('the catalog and Home\'s block: a Korean owner on an English team sees the Korean examples, the text the team gets stays English', async () => {
    const c = await h.api('dana').call(API.listSkillPacks)
    const notes = c.skills.find((s) => s.name === 'meeting-notes')!
    expect(notes.locale).toBe('en')
    expect(notes.example).toEqual({ kind: 'text', markdown: text('ko', 'meeting-notes')!, locale: 'ko' })
    expect(c.skills.find((s) => s.name === 'intro-deck')!.example).toEqual({ kind: 'image', url: '/skill-examples/ko/intro-deck.webp', company: '숲틈', locale: 'ko' })

    const w = await h.api('dana').call(API.installSkillPack, { params: { id: 'work' }, body: { skills: ['meeting-notes'] } })
    expect(w.locale).toBe('en')
    expect(fs.readFileSync(path.join(h.team, 'skills/work/meeting-notes/SKILL.md'), 'utf8')).toContain('title: Meeting notes')
    const dana = (await h.api('dana').call(API.skillExamples)).skills.find((s) => s.name === 'meeting-notes')!
    expect(dana.example).toEqual({ kind: 'text', markdown: text('ko', 'meeting-notes')!, locale: 'ko' })
    // an English reader: the English example, as before
    const alice = (await h.api('alice').call(API.skillExamples)).skills.find((s) => s.name === 'meeting-notes')
    expect(alice!.example).toEqual(packExample('en', 'meeting-notes', 'en')!)
  })
})
