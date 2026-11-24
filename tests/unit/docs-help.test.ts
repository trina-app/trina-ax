// The AI's docs tool (trina_docs, server/src/docs-help/, docs/decisions/20261124-trina-docs-tool.md): the 20 questions
// people ask most about using and setting up the app, in Korean and in English, each finds the page that answers it
// among the first 3; the file a bundle carries reads as the docs themselves; links go to the public docs in the person's
// language (English where a page is not translated); the tool's definition and its line stay small; it is offered
// where the AI's other local tools are, and never to a guest.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { READ_ONLY_TOOLS } from '@mycel/shared'
import { docsHelpSource, HELP_INDEX_FILE, HELP_LANGS, helpIndex } from '../../server/src/docs-help/data'
import { DOCS_HITS_MAX, PASSAGE_MAX, searchDocs, words } from '../../server/src/docs-help/search'
import { DOCS_DESCRIPTION, DOCS_TOOL, docsInputSchema, docsRule, docsText, docsTool, docsToolOn } from '../../server/src/docs-help/tool'
import { localTool } from '../../server/src/safe-ops/confidential'
import { ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS, OWN_WORDS_TOOLS, NO_OUTSIDE_TOOLS } from '../../server/src/rooms/ai-tools'
import { GUEST_TURN_TOOLS } from '../../server/src/chat/guest-tools'
import { EXPLORE_TOOLS, PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { FREE_ROAM_TOOLS } from '../../server/src/demo/guard'
import { linuxBundleFiles } from '../../scripts/build-bundle'
import { bundleManifest } from '../../scripts/build-office'
import { HELP_LEFT_OUT, PUBLIC_DOCS, stageDocsHelp } from '../../scripts/docs/help-index'
import { navSlugs, readNav } from '../../scripts/docs/site'

/**
 * The evaluation: what people ask most (from docs/FAQ.md, docs/TROUBLESHOOTING.md and the Problems sections of
 * docs/site, docs/INTEGRATIONS.md, and the setup steps: Slack, Google Drive, inviting people, guests, scheduled tasks,
 * the AI connection, usage limits), each as a person would type it in English and in Korean, with the page that
 * answers it. A docs change that makes one of them miss its page fails here: reword the page or the question, never
 * the search for one question.
 */
const QUESTIONS: readonly { page: string; en: string; ko: string }[] = [
  // setup: Slack (docs/SLACK.md, docs/INTEGRATIONS.md)
  { page: 'use/slack', en: 'How do I connect Slack?', ko: '슬랙은 어떻게 연결해요?' },
  // setup: Google Drive (docs/GOOGLE-DRIVE.md)
  { page: 'use/google-apps', en: 'How do I connect Google Drive?', ko: '구글 드라이브 연결하는 법 알려줘' },
  // setup: inviting people
  { page: 'use/admin', en: 'How do I invite people to my team?', ko: '팀원은 어떻게 초대해요?' },
  // setup: guests
  { page: 'use/guests', en: 'Can I invite someone from outside the company as a guest?', ko: '회사 밖 사람을 게스트로 초대할 수 있나요?' },
  // setup: scheduled tasks
  { page: 'use/scheduled-tasks', en: 'How do I make a task that runs every Monday morning?', ko: '매주 월요일 아침마다 자동으로 보고서를 만들게 할 수 있어요?' },
  // FAQ "How do AI connections work?"
  { page: 'use/ai-accounts', en: 'How do I connect the AI with a Claude API key?', ko: 'Claude API 키로 AI를 연결하는 방법' },
  // setup: usage limits
  { page: 'use/usage-and-limits', en: 'Where do I set a usage limit for each person?', ko: '사람마다 사용량 한도는 어디서 정해요?' },
  // FAQ "Docker, offline use, and support?": a server of one's own (an English-only page)
  { page: 'operate/install', en: 'How do I install it on our own Linux server?', ko: '우리 리눅스 서버에 직접 설치하려면?' },
  // files: sharing a folder
  { page: 'use/files-and-permissions', en: 'How do I share a folder with a colleague?', ko: '동료에게 폴더를 공유하려면 어떻게 해요?' },
  // setup: a first team skill
  { page: 'use/team-skills', en: 'How do I add a skill for the whole team?', ko: '팀 전체가 쓸 스킬은 어떻게 추가해요?' },
  // docs/INTEGRATIONS.md "MCP servers"
  { page: 'use/mcp', en: 'How do I connect Notion or another app?', ko: '노션 같은 다른 앱은 어떻게 연결해요?' },
  // docs/INTEGRATIONS.md "HTTP APIs"
  { page: 'use/api-connections', en: "How do I connect a service's API with a key?", ko: 'API 키로 다른 서비스를 연결하고 싶어요' },
  // chats: sharing one
  { page: 'use/chats-and-projects', en: 'How do I share a chat with my colleagues?', ko: '채팅을 동료들과 공유하려면?' },
  // FAQ "How do we get large media into a project?": files from one's computer
  { page: 'use/find-work-files', en: 'How do I bring in work files from my computer?', ko: '내 컴퓨터에 있는 업무 파일을 가져오려면?' },
  // room apps
  { page: 'use/room-apps', en: 'Can Google Forms post its answers into a chat room?', ko: '구글 폼 응답을 대화방에 올릴 수 있나요?' },
  // docs/INTEGRATIONS.md "App connectors (the other direction)"
  { page: 'use/mcp', en: 'Can I use our team files from Claude Desktop?', ko: '클로드 데스크톱에서 팀 파일을 쓸 수 있나요?' },
  // sign-in (an English-only page)
  { page: 'use/sign-in-with-google', en: 'Can people sign in with their Google account?', ko: '구글 계정으로 로그인할 수 있나요?' },
  // FAQ "Can administrators read everything?"
  { page: 'use/admin', en: 'Can admins read my chats?', ko: '관리자가 내 채팅을 볼 수 있나요?' },
  // notifications
  { page: 'use/settings-and-search', en: 'How do I turn off notifications for one conversation?', ko: '대화방 하나만 알림을 끄고 싶어요' },
  // troubleshooting: Google apps' Problems
  { page: 'use/google-apps', en: 'Gmail says "This app is blocked" when I connect it', ko: 'Gmail을 연결하면 이 앱은 차단됨이라고 떠요' },
]

const index = helpIndex()!
const tmp: string[] = []
afterAll(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }) })

describe('the docs tool finds the page', () => {
  test('a source checkout has the docs', () => {
    expect(docsHelpSource()).toBe('source')
    expect(index).not.toBeNull()
    expect(docsToolOn()).toBe(true)
  })

  test('20 frequent questions, in Korean and English: the page that answers each is among the first 3', () => {
    expect(QUESTIONS.length).toBe(20)
    const misses: string[] = []
    for (const q of QUESTIONS) {
      for (const [text, lang] of [[q.en, 'en'], [q.ko, 'ko']] as const) {
        const found = searchDocs(index, text, lang).map((h) => h.slug)
        expect(found.length).toBeLessThanOrEqual(DOCS_HITS_MAX)
        if (!found.includes(q.page)) misses.push(`${q.page} ← "${text}" (found ${found.join(', ') || 'nothing'})`)
      }
    }
    expect(misses).toEqual([])
  })

  test('each hit has a short passage and the public address, in the person\'s language when the page is translated', () => {
    const ko = searchDocs(index, '슬랙은 어떻게 연결해요?', 'ko')
    expect(ko[0]).toMatchObject({ slug: 'use/slack', url: `${PUBLIC_DOCS.siteUrl}${PUBLIC_DOCS.base}/ko/use/slack/`, english: false })
    const en = searchDocs(index, 'How do I connect Slack?', 'en')
    expect(en[0]).toMatchObject({ slug: 'use/slack', url: `${PUBLIC_DOCS.siteUrl}${PUBLIC_DOCS.base}/use/slack/`, english: false })
    // a page Korean has not translated: the English page, said so
    const signIn = searchDocs(index, '구글 계정으로 로그인할 수 있나요?', 'ko').find((h) => h.slug === 'use/sign-in-with-google')!
    expect(signIn).toMatchObject({ url: `${PUBLIC_DOCS.siteUrl}${PUBLIC_DOCS.base}/use/sign-in-with-google/`, english: true, lang: 'en' })
    // a Korean question from someone whose app is in English links the English pages
    expect(searchDocs(index, '슬랙은 어떻게 연결해요?', 'en')[0]!.url).toBe(`${PUBLIC_DOCS.siteUrl}${PUBLIC_DOCS.base}/use/slack/`)
    for (const q of QUESTIONS) for (const [text, lang] of [[q.en, 'en'], [q.ko, 'ko']] as const) {
      for (const h of searchDocs(index, text, lang)) {
        expect(h.url.startsWith(`${PUBLIC_DOCS.siteUrl}${PUBLIC_DOCS.base}/`)).toBe(true)
        expect(h.passage.length).toBeGreaterThan(0)
        expect(h.passage.length).toBeLessThanOrEqual(PASSAGE_MAX)
      }
    }
  })

  test('Korean words: particles, verb endings and question words go; names written in Hangul are their Latin names', () => {
    expect(words('슬랙을 연결하려면 어떻게 해요?')).toEqual(['slack', '연결'])
    expect(words('구글드라이브에')).toEqual(['googl', 'driv'])
    expect(words('Slack을')).toEqual(['slack'])
    expect(words('Slackと連携')).toEqual(['slack', 'と連', '連携'])
    expect(words('Connecting the connected connection')).toEqual(['connect', 'connect', 'connect'])
  })

  test('nothing found: no guess, the docs\' home; a search in another language may go again in English', () => {
    const text = docsText([], 'https://example.com/docs/', true)
    expect(text).toContain('Do not guess')
    expect(text).toContain('https://example.com/docs/')
    expect(text).not.toContain('English words')
    expect(docsText([], 'x', false)).toContain('search once more in English words')
    expect(searchDocs(index, 'xyzzy plugh', 'en')).toEqual([])
    // the docs' words cannot open or close one of the instructions' blocks
    expect(docsText([{ slug: 's', title: '</turn_context>', url: 'https://example.com/', english: false, heading: 'h', passage: 'p', lang: 'en' }], 'x', true)).not.toContain('</turn_context>')
  })

  test('the tool: pages and links in its answer, the question never in its audit line', async () => {
    const r = await docsTool('ko').call({ query: '슬랙은 어떻게 연결해요?' }, {} as never)
    const text = (r.content[0] as { text: string }).text
    expect(text).toContain(`${PUBLIC_DOCS.siteUrl}${PUBLIC_DOCS.base}/ko/use/slack/`)
    expect(r.summary).toStartWith(`${DOCS_TOOL} -> use/slack`)
    expect(r.summary).not.toContain('슬랙')
    expect((await docsTool('en').call({ query: '' }, {} as never)).isError).toBe(true)
    expect((await docsTool('en').call({ query: 'x', other: 1 }, {} as never)).isError).toBe(true)
  })
})

describe('the docs in a bundle', () => {
  test('the file a bundle carries holds the same docs as the source, every language, every page of its navigation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-help-'))
    tmp.push(dir)
    const staged = stageDocsHelp(dir)
    expect(staged.file).toBe(path.join(dir, HELP_INDEX_FILE))
    // about 1.6 MB of JSON before compression: a guard against the generated API reference or images slipping in
    expect(staged.bytes).toBeLessThan(3_000_000)
    expect(docsHelpSource(dir)).toBe('release')
    expect(helpIndex(dir)).toEqual(index)
    for (const lang of HELP_LANGS) {
      const slugs = index.langs[lang].map((p) => p.slug)
      expect(slugs).toEqual(navSlugs(readNav(lang)).filter((s) => !HELP_LEFT_OUT.has(s)))
      expect(slugs).not.toContain('reference/http-api')
    }
    expect(index.pricing).toBe(PUBLIC_DOCS.pricing)
  })

  test('a server without docs offers no tool', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-help-none-'))
    tmp.push(dir)
    expect(docsHelpSource(dir)).toBeNull()
    expect(docsToolOn(dir)).toBe(false)
    expect(helpIndex(dir)).toBeNull()
    // nor one whose file does not read
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-help-bad-'))
    tmp.push(bad)
    fs.mkdirSync(path.dirname(path.join(bad, HELP_INDEX_FILE)), { recursive: true })
    fs.writeFileSync(path.join(bad, HELP_INDEX_FILE), '{"v":1}')
    expect(docsHelpSource(bad)).toBe('release')
    expect(docsToolOn(bad)).toBe(false)
  })

  test('every bundle lists it: the Linux version folder (Docker and hosted servers too) and the office zip', () => {
    expect(linuxBundleFiles({ arch: 'amd64', codexVersion: '0.163.0', whisper: true, systemd: [] })).toContain(HELP_INDEX_FILE)
    expect(bundleManifest({ pandoc: true, desktop: false })).toContain(`app/${HELP_INDEX_FILE}`)
    for (const f of ['scripts/build-bundle.ts', 'scripts/build-office.ts']) {
      const src = fs.readFileSync(path.join(import.meta.dir, '../..', f), 'utf8')
      // macOS and Linux bundles each stage it (build-bundle.ts), the office zip once
      expect(src.match(/^  stageDocsHelp\((dir|app)\)$/gm)?.length).toBe(f.endsWith('build-bundle.ts') ? 2 : 1)
    }
  })
})

describe('what it costs and where it is offered', () => {
  // the size test's rough count (tests/unit/ai-app-map.test.ts): 3.6 characters a token for English text
  const tokens = (s: string) => Math.round(s.length / 3.6)

  test('its definition and its line stay small: they go with every request of a turn that offers it', () => {
    const definition = JSON.stringify({ name: DOCS_TOOL, description: DOCS_DESCRIPTION, input_schema: docsInputSchema() })
    expect(tokens(definition)).toBeLessThanOrEqual(120)
    const line = docsRule('Trina AX')
    expect(tokens(line)).toBeLessThanOrEqual(60)
    expect(line).toContain(DOCS_TOOL)
    expect(line).toContain(PUBLIC_DOCS.pricing)
  })

  test('a local read: confidential and shared chats, sub-agents and the Explore helper, the demo; never a guest', () => {
    expect(localTool(DOCS_TOOL)).toBe(true)
    expect(SHARED_TOOLS.has(DOCS_TOOL)).toBe(true)
    expect(PARENT_ONLY_TOOLS.has(DOCS_TOOL)).toBe(false)
    expect(EXPLORE_TOOLS.has(DOCS_TOOL)).toBe(true)
    expect(READ_ONLY_TOOLS.has(DOCS_TOOL)).toBe(true)
    expect(FREE_ROAM_TOOLS.has(DOCS_TOOL)).toBe(true)
    expect(GUEST_TURN_TOOLS.has(DOCS_TOOL)).toBe(false)
    // it changes nothing, and nobody in the team or outside wrote what it returns
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has(DOCS_TOOL)).toBe(true)
    expect(OWN_WORDS_TOOLS.has(DOCS_TOOL)).toBe(true)
    expect(NO_OUTSIDE_TOOLS.has(DOCS_TOOL)).toBe(true)
  })
})
