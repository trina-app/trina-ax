// Answers told office workers where a file is with a raw team path in code formatting (`groups/영업/견적서/`,
// `users/sora/작업/`, `skills/…/SKILL.md`): the instructions asked for "the team path (e.g. users/<id>/report.docx)"
// (AI scenario check 2026-11-16, root cause #1; docs/AGENTS/plan/20261116-0500-ai-file-link-labels.md). Now a file or
// folder is named by a link with the name the Files screen shows; Slack, where the app's cards do not show, keeps the
// path. A folder link opens the Files screen there (web/test/unit/markdown.test.ts classifyLink).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { personFolderLabel } from '@mycel/shared'
import { buildSubagentPrompt, buildTurnContext, buildTurnPrompt, ENVIRONMENT, environmentSection, FIND_FILE_RULE, GUEST_ENVIRONMENT, sharedOwnFolderLine, SOURCE_LINK_RULE, type PromptInput } from '../../server/src/chat/prompt'
import { situationSection, type Situation } from '../../server/src/chat/situation'
import { startHarness, type Harness } from '../lib/b-harness'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'prompt-file-links' }) })
afterAll(async () => { await h.close() })

const input = (extra: Partial<PromptInput> = {}): PromptInput => ({
  user: h.ctx.files.principal('alice'), groupNames: [], locale: 'ko', timeZone: 'Asia/Seoul', memories: [], project: null,
  browser: false, tools: [], history: null, ...extra,
})

describe('files and folders are named by a link with their name', () => {
  test('the rule: a link labelled with the shown name for files and folders, no path as text unless asked', () => {
    const r = SOURCE_LINK_RULE
    expect(r).toContain('Name a team file or folder by a link labelled with its shown name, not by its path: [report.docx](/files/view?path=<team path, URL-encoded>)')
    // top folders and the person's own folder by the names folderPurposeLines puts in quotes (전사 공유, 내 폴더…)
    expect(r).toContain('a top folder or the user\'s own folder labelled with the name shown in quotes under "Team folders" (without the quotes)')
    // only the answer: paths stay in tool calls, sub-agent tasks, file contents and post_to_room text; Slack keeps them
    expect(r).toContain('In your answer, never write a team path as text or in code unless the user asks for it (or the App line says otherwise).')
    // the source links with their place stay
    expect(r).toContain('When your answer relies on a team file, link it where you mention it, adding &page=N for a PDF page')
    // in every turn: about 150 tokens on Claude's tokenizer
    expect(r.length).toBeLessThanOrEqual(720)
  })

  test('in a person\'s own chat, next to the "Team folders" names it points to; not for a guest (no file page)', () => {
    const p = buildTurnPrompt(h.ctx.files, input())
    expect(p).toContain(SOURCE_LINK_RULE)
    expect(p).toContain('Team folders (the app shows them by the names in quotes')
    expect(p).toContain('("내 폴더")')
    expect(buildTurnPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true }))).toContain(SOURCE_LINK_RULE)
    // a guest has no file page (web App.tsx): no link rule
    const guest = { places: [{ kind: 'project' as const, id: 'p1', name: 'Quote prep', folder: 'projects/quote-prep' }], inviter: 'Alice Kim' }
    const g = buildTurnPrompt(h.ctx.files, input({ guest }))
    expect(g).toContain('## Where you run')
    expect(g).not.toContain(SOURCE_LINK_RULE)
    expect(g).not.toContain('Name a team file or folder by a link')
  })

  test('a shared chat: the asker\'s own folder is theirs by name, not "내 폴더" (that is each reader\'s own)', () => {
    const shared = { project: 'Atlas', audience: 3, asker: 'Alice Kim' }
    const line = sharedOwnFolderLine('Alice Kim', 'ko')
    // in the reader's words, never an English possessive in a Korean answer ("김민지's folder", QA TC-r2a-05)
    expect(line).toBe('Others see this chat: in your answer, call Alice Kim\'s own folder "Alice Kim 님 폴더" (said in the answer\'s language when it is another one; never an English "\'s" in a sentence of another language), not "내 폴더".')
    expect(sharedOwnFolderLine('김민지', 'ko')).toContain('"김민지 님 폴더"')
    expect(sharedOwnFolderLine('김민지', 'ko')).not.toContain('김민지\'s folder')
    expect(sharedOwnFolderLine('Mina', 'en')).toContain('"Mina\'s folder"')
    expect(sharedOwnFolderLine('ミナ', 'ja')).toContain('"ミナさんのフォルダー"')
    expect(sharedOwnFolderLine('Mina', 'es')).toContain('"la carpeta de Mina"')
    expect(sharedOwnFolderLine('Mina', 'id')).toContain('"folder Mina"')
    expect(sharedOwnFolderLine('米娜', 'zh')).toContain('"米娜的文件夹"')
    // a name with "$&" stays the name
    expect(personFolderLabel('A$&B', 'ko')).toBe('A$&B 님 폴더')
    expect(buildTurnPrompt(h.ctx.files, input({ shared, roomReadable: () => true }))).toContain(line)
    // the turn context too, so a chat shared after it started gets it
    expect(buildTurnContext(h.ctx.files, input({ shared, roomReadable: () => true }))).toContain(line)
    expect(buildTurnPrompt(h.ctx.files, input())).not.toContain('Others see this chat: in your answer')
  })

  test('a sub-agent reports team paths: its "Where you run" never says "not its path"', () => {
    const p = buildSubagentPrompt(h.ctx.files, input({ shared: { project: 'Atlas', audience: 3, asker: 'Alice Kim' }, roomReadable: () => true }), ['read', 'write'])
    expect(p).toContain('Give the team path of what you save in your report.')
    expect(p).not.toContain('not its path')
    expect(p).not.toContain(SOURCE_LINK_RULE)
    expect(p).not.toContain('Others see this chat: in your answer')
  })

  test('"Where you run" says where by the link and folder name, never with a team path example', () => {
    for (const env of [ENVIRONMENT, environmentSection('hosted')]) {
      expect(env).toContain('Say where by its link and folder name, not its path (e.g. [report.docx](/files/view?path=…) in their own folder)')
      expect(env).not.toContain('users/<id>/report.docx')
      expect(env).not.toContain('Say where with the team path')
    }
    expect(GUEST_ENVIRONMENT).toContain('Say where by the file and folder names, not the path;')
    expect(GUEST_ENVIRONMENT).not.toContain('users/<id>/report.docx')
  })

  test('nothing found: the closest files are listed as links, not paths', () => {
    expect(FIND_FILE_RULE).toContain('list the closest as links')
    expect(FIND_FILE_RULE).not.toContain('with paths')
  })

  test('Slack keeps the team path (no cards there), next to a link', () => {
    const s: Situation = { role: 'member', guest: false, app: 'slack', ai: 'team', ownAi: true, ownConnectors: true, plan: null, web: true }
    expect(situationSection(s, 'ko')).toContain('so give the team path of any file you save, next to its link.')
  })
})
