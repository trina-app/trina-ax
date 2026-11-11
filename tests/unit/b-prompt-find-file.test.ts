// Asked for a file that is there, the in-app AI wrote a new contract, template or storyboard instead, asked where the
// file was before it had looked, or searched the web for a team file (find-files test, 2026-11-11;
// docs/AGENTS/plan/20261111-0843-find-never-creates.md). One short rule in the instructions (server/src/chat/prompt.ts
// FIND_FILE_RULE) says what to do: search names and contents and open likely files first, never make a file in its
// place, say so and list the closest files when nothing matches, and only then ask. Claude and Codex get it in the same
// instructions (tests/unit/b-chat.test.ts "instructions"); here every kind of chat that keeps the tool rules.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildTurnPrompt, FIND_FILE_RULE, type PromptInput } from '../../server/src/chat/prompt'
import { startHarness, type Harness } from '../lib/b-harness'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-find-file' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: ['move_files', 'copy_files', 'ask_user'], history: null, ...extra,
})

describe('asked for an existing file', () => {
  test('the rule: search first, never a new file in its place, say so and list the closest, then ask; no web search', () => {
    const r = FIND_FILE_RULE
    // a message that only names a document asks for it, not for a new one (cr06 "외주 개발 용역 계약서")
    expect(r).toContain('Asked for a file, even by name only, find the existing one first:')
    // names and contents in other words, both languages and the usual version words, folders too (cr06's file has an
    // English name and text in a folder named 외주); then open what looks right
    expect(r).toContain('glob file and folder names, grep contents, with other words, both languages and variants (final, v2, old, copy)')
    expect(r).toContain('open likely ones, images and PDFs too')
    // never a new file instead of the one asked for, found or not (ms04 made a Japanese deck because there was none);
    // scoped to that ("instead"): the rule is in every turn, and a request whose result is a new file ("회의록 정리해줘",
    // a skill or a scheduled run that saves its output) still makes one
    expect(r).toContain('Found or not, never make or copy one instead unless asked to.')
    expect(r).not.toMatch(/never (write|make|create)[^.]*file unless asked/i)
    expect(r).toContain('If nothing matches, say so and list the closest with paths; only then ask where it is.')
    expect(r).toContain('Never search the web for team files.')
    // about 120 tokens on Claude's tokenizer (Korean words cost more): it goes into every new session's instructions
    expect(r.length).toBeLessThanOrEqual(420)
  })

  test('in every chat that keeps the tool rules: an own chat, a room, a shared project chat, a confidential chat', () => {
    expect(buildTurnPrompt(h.ctx.files, input())).toContain(FIND_FILE_RULE)
    expect(buildTurnPrompt(h.ctx.files, input({ locale: 'en', tools: [] }))).toContain(FIND_FILE_RULE)
    expect(buildTurnPrompt(h.ctx.files, input({ room: { name: 'Sales', kind: 'team', members: 4, asker: 'Alice Kim' }, roomReadable: () => true }))).toContain(FIND_FILE_RULE)
    expect(buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true }))).toContain(FIND_FILE_RULE)
    expect(buildTurnPrompt(h.ctx.files, input({ confidential: 'server', tools: [] }))).toContain(FIND_FILE_RULE)
  })

  test('once, after "To create a new file, call write directly", so a new file asked for is still made at once', () => {
    const p = buildTurnPrompt(h.ctx.files, input())
    expect(p.split(FIND_FILE_RULE).length).toBe(2)
    expect(p.indexOf('To create a new file, call write directly.')).toBeLessThan(p.indexOf(FIND_FILE_RULE))
  })
})
