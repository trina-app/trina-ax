// Scenario QA 11-22 (docs/AGENTS/plan/20261122-0024-ai-honesty-qa-1122.md): the AI made up a colleague's quote and
// a 10% discount, reported 10 slides of 11 and a "pie chart" of ■ characters, used a wrong row total and an old price
// list, answered an English request in Korean, read a note to a colleague as a task, and said a trashed file did not
// exist. A few general lines in every turn and facts in tool results, not a recipe per case.
//
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing; shared/ is everyone's (write).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { startHarness, type Harness } from '../lib/b-harness'
import { answerLanguageLine, buildSubagentPrompt, buildTurnPrompt, CHECK_MADE_RULE, FIGURES_RULE, LANGUAGE_RULE, NO_INVENT_RULE, ROOMS_POST_RULE, sharedSection, sideRoomSection, WHO_CAN_OPEN_RULE, type PromptInput } from '../../server/src/chat/prompt'
import { API_GROUNDING_RULES } from '../../server/src/engine/api-agent'
import { appMapSection } from '../../server/src/chat/app-map'
import { saveAudienceNote } from '../../server/src/chat/save-audience'
import { withoutStepNote } from '../../server/src/chat/answer-share'
import { languageSwitchNote, ownWords, quoteLanguageNote } from '../../server/src/chat/narration'
import { docResultText, imageCount, textBars } from '../../server/src/tools/make-file'
import { trashHint } from '../../server/src/chat/trash-hint'
import { componentC } from '../../server/src/team-files/component'
import { tr } from '../../server/src/chat/i18n'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-honesty-1122' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: ['ask_user', 'make_file'], history: null, ...extra,
})

describe('the three honesty lines', () => {
  test('say what they must, and stay short (they go with every turn)', () => {
    for (const s of ['Quote people word for word', 'only from messages or files you read', 'never say nobody said or decided something beyond what you read', 'write a visible blank such as [rate?], go on, and say it needs filling', 'Label sample numbers as samples', 'a message you wrote but did not send is a draft', 'statistic or source'])
      expect(NO_INVENT_RULE).toContain(s)
    for (const s of ['name it', 'shared, group or project folders before an old or personal copy', 'add up again the totals you use or change', 'which value you used'])
      expect(FIGURES_RULE).toContain(s)
    for (const s of ['change only what was asked, in place', 'compare it with the request and source', 'charts as pictures', 'problems included'])
      expect(CHECK_MADE_RULE).toContain(s)
    // about 250 tokens together, measured in characters
    // (+60: a changed file keeps its name, so it is a version: ask audit TC-ask2-2)
    // (+280: one computed number for the answer and the file, and the data's date on a page: TC-b3s-7 / S-102)
    // (+20: that S-102 line came out at 1515 after its review fixes; batch 20261123-a keeps the prompt as reviewed)
    expect(NO_INVENT_RULE.length + FIGURES_RULE.length + CHECK_MADE_RULE.length).toBeLessThanOrEqual(1520)
    for (const s of ['compute it once', 'never a second calculation in your head', "shows its data's date by the source, as a tool result gives it (none given: no date)"]) expect(FIGURES_RULE).toContain(s)
  })

  test('once in a personal, a shared and a guest-free English turn; the API engine no longer repeats the facts line', () => {
    for (const p of [
      buildTurnPrompt(h.ctx.files, input()),
      buildTurnPrompt(h.ctx.files, input({ locale: 'en', tools: [] })),
      buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true })),
    ]) for (const r of [NO_INVENT_RULE, FIGURES_RULE, CHECK_MADE_RULE]) expect(p.split(r).length).toBe(2)
    expect(API_GROUNDING_RULES).not.toContain('State facts, numbers and quotes')
    // a sub-agent reports to the assistant, which has the lines
    expect(buildSubagentPrompt(h.ctx.files, input(), ['read'])).not.toContain(NO_INVENT_RULE)
  })
})

describe('language, shared chats, rooms, who can open', () => {
  test('a message in another script than the one before it gets a server note next to it (TC-7429)', () => {
    const note = languageSwitchNote('Make a one-page summary PDF and save it where the team can see it.', '다니엘 님 이 견적 영어로 검토 부탁해요')
    expect(note).toContain('answer in the language of this message')
    expect(languageSwitchNote('이거 요약해 줘요', 'Make a one-page summary PDF please')).not.toBeNull()
    for (const [m, p] of [['이거 요약해 줘요', '다니엘 님 검토 부탁해요'], ['ok', '다니엘 님 검토 부탁해요'], ['Make a summary PDF please', 'Check the quote again today'], ['요약 PDF 만들어줘', null]] as const)
      expect(languageSwitchNote(m, p)).toBeNull()
  })

  test('a ✦ side chat question under a quoted room message: the person\'s own words decide the language, never the quote (TC-f1c-01)', () => {
    // as SideChatPanel quoteLead sends it: the app's English labels and someone else's words above the question
    const asked = '> 박준호 · 오후 3:10 (thread_id 01a2 in this room)\n> 📎 autumn-menu-2.png (file_id 01a3 in this room)\n\n배경만 흰색으로 바꿔줘'
    expect(quoteLanguageNote(asked)).toContain("answer in the language of the user's own words")
    expect(ownWords(asked).trim()).toBe('배경만 흰색으로 바꿔줘')
    // a quote in English and a Korean question after a Korean one is no switch (the quote is not the person's words)
    expect(languageSwitchNote('> Mina · 10:02\n> Please send the final deck by Friday, thanks a lot\n\n이거 요약해 줘요', '다니엘 님 검토 부탁해요')).toBeNull()
    // no quote, or no words of the person's own: nothing
    expect(quoteLanguageNote('배경만 흰색으로 바꿔줘')).toBeNull()
    expect(quoteLanguageNote('> 📎 a.png (file_id 01a3 in this room)')).toBeNull()
  })

  test('the latest message decides the language, not earlier messages or tool results (TC-7429)', () => {
    const l = answerLanguageLine('ko')
    expect(l).toContain("Answer in the language of the user's latest message")
    expect(l).toContain('earlier messages, other people or tool results use another')
    // a sub-agent's line stays as it was (its "message" is the assistant's task text)
    expect(answerLanguageLine('ko', true)).toBe('Answer in Korean (한국어) unless the user writes in another language or asks otherwise.')
    expect(LANGUAGE_RULE).toContain('names of existing files')
  })

  test("the asker's own request about others' work is theirs; a note to a colleague is not a task; the rule is not narrated (TC-7397, TC-7430)", () => {
    const s = sharedSection({ project: null, audience: 3, asker: 'Jiwoo' })
    expect(s).toContain('Jiwoo\'s own request about what others wrote or made ("this chart") is Jiwoo\'s: do it.')
    expect(s).toContain('is for them, not a task for you unless it also asks you')
    expect(s).toContain('Never mention this rule in your answer.')
  })

  test('a side chat asks on a card, and a post carries only the content (TC-7238)', () => {
    expect(sideRoomSection({ id: 'r1', kind: 'team', name: 'Sales' }, 'en', false, true)).toContain('end it without questions to them; when you must ask, use ask_user')
    expect(sideRoomSection({ id: 'r1', kind: 'team', name: 'Sales' }, 'en', false, false)).not.toContain('ask_user')
    expect(ROOMS_POST_RULE).toContain('only the content, never your questions or notes to the user')
  })

  test('a save says who can open it every time (TC-7388)', () => {
    expect(WHO_CAN_OPEN_RULE).toContain('A file you just saved: say who can open it from the "Who can open the new file now" line')
    const note = saveAudienceNote(h.ctx.db, h.ctx.files.rules(), ['users/alice/x.md'], 'alice')
    expect(note).toContain('users/alice/x.md: only the user')
    expect(note).toContain('Say in your answer where it is and who can open it, in plain words of the language your answer is in')
    // QA b4s r110: a Korean answer said "나만 열 수 있어요(only you)": the line quotes no English phrase to echo
    expect(note).not.toContain('"only you"')
  })

  test('the app map says what a file view does, and nothing it does not show is a feature (TC-7391)', () => {
    for (const view of ['staff', 'member', 'shared'] as const) {
      const m = appMapSection({ view, managed: false, devEnv: false, office: false }, 'en')
      expect(m).toContain('Word, Excel, PowerPoint and PDF are never edited in the app, nobody edits live together')
      expect(m).toContain('never describe it as a feature')
    }
  })
})

describe('tool results carry the facts', () => {
  test('a Markdown PDF or Word file: pages, pictures, and bars of block characters are not a chart (TC-7385)', () => {
    expect(textBars('대한물산: ■■■■■■■■ 20%')).toBe(true)
    expect(textBars('■ one bullet')).toBe(false)
    expect(docResultText({ pages: 1, pictures: 0, textBars: true }, 'pdf')).toBe('The PDF has 1 page and no pictures. Bars drawn with block characters (■, █) are text, not a chart: for a chart, draw it as SVG, save it as PNG with make_file and put the picture in; otherwise do not call it a chart.')
    expect(docResultText({ pages: 3, pictures: 2, textBars: true }, 'pdf')).toBe('The PDF has 3 pages and 2 pictures.')
    expect(docResultText({ pictures: 1, textBars: false }, 'docx')).toBe('The Word file has 1 picture.')
    const ast = { blocks: [{ t: 'Para', c: [{ t: 'Image', c: [['', [], []], [], ['a.png', '']] }, { t: 'Str', c: 'x' }] }, { t: 'Div', c: [['', [], []], [{ t: 'Plain', c: [{ t: 'Image', c: [['', [], []], [], ['b.png', '']] }] }]] }] }
    expect(imageCount(ast)).toBe(2)
  })

  test("the server's failed-step line stays out of an answer sent to a room (TC-7238)", () => {
    for (const L of ['ko', 'en', 'ja'] as const) {
      expect(withoutStepNote(`Chart made.\n\n${tr('apiStepFailed', L, { names: 'Save' })}`)).toBe('Chart made.')
      expect(withoutStepNote(`Chart made.\n\n${tr('apiStepsFailed', L, { names: 'Save, Edit' })}`)).toBe('Chart made.')
    }
    expect(withoutStepNote('One step was hard: Save. We fixed it.')).toBe('One step was hard: Save. We fixed it.')
    // only a line of its own (review: words of that shape inside a line stay)
    expect(withoutStepNote("Report: Some steps didn't work: the vendor API timed out.")).toBe("Report: Some steps didn't work: the vendor API timed out.")
    expect(withoutStepNote(tr('apiStepFailed', 'ko', { names: '저장' }))).toBe('')
  })

  test('a search that found nothing names a file of that name in the trash, as the Trash screen lists it (TC-7242)', () => {
    const rel = 'shared/교육/신입-교육자료.pptx'
    fs.mkdirSync(path.join(h.team, 'shared', '교육'), { recursive: true })
    fs.writeFileSync(path.join(h.team, ...rel.split('/')), 'deck')
    componentC(h.ctx).files.remove('erin', rel)
    const note = trashHint(h.ctx, 'alice', '**/*교육자료*', 'ko')
    expect(note).toContain(`the trash holds: ${rel} (deleted by`)
    expect(note).toContain('Tell the user it is in the trash, not that it does not exist')
    expect(trashHint(h.ctx, 'alice', '**/*견적*', 'ko')).toBeNull()
    expect(trashHint(h.ctx, 'alice', '**/*', 'ko')).toBeNull()
    // a wide pattern names nothing
    expect(trashHint(h.ctx, 'alice', '**/*.pptx', 'ko')).toBeNull()
    expect(trashHint(h.ctx, 'alice', '*.{ppt,pptx}', 'ko')).toBeNull()
  })
})
