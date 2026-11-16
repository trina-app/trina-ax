// "Suggest as a skill" (components/SuggestSkillDialog.tsx): the folder choice says each place as the Team skills page
// does ("Team skills", "<group> skills" by the group's name now), never "skills/" or "groups/…/skills/", in all six
// languages; what is sent stays the path.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import SuggestSkillDialog, { suggestFolderWords } from '../../src/components/SuggestSkillDialog'
import { folderWords } from '../../src/lib/folderLabels'
import { installDom, mount, removeDom } from './dom-host'

const LANGS = ['en', 'ko', 'zh', 'ja', 'es', 'id'] as const
const GROUPS = { 'groups/design/skills': { id: 'g1', name: 'Design' }, 'groups/design/skills/briefs': { id: 'g1', name: 'Design' } }
const tr = (lang: (typeof LANGS)[number]) => ((k: MessageKey, v?: Record<string, string | number>) => translate(lang, k, v)) as never

describe('the suggestion dialog\'s folder words', () => {
  test('every language: a place, never a path', () => {
    for (const lang of LANGS) {
      const say = (f: string) => suggestFolderWords(f, GROUPS, tr(lang), folderWords(lang, 'dana').path)
      expect(say('skills')).toBe(TOP_FOLDER_LABELS.skills[lang]!)
      for (const f of ['skills', 'skills/sales', 'groups/design/skills', 'groups/design/skills/briefs', 'groups/old-folder/skills']) {
        const w = say(f)
        expect(w).not.toContain('/')
        expect(w).not.toMatch(/^skills|groups/)
      }
      expect(say('groups/design/skills')).toBe(translate(lang, 'skills.groupPlace', { group: 'Design' }))
      expect(say('groups/design/skills/briefs')).toBe(`${translate(lang, 'skills.groupPlace', { group: 'Design' })} › briefs`)
      // a group the overview did not name (an older server): its folder's name stands in
      expect(say('groups/old-folder/skills')).toBe(translate(lang, 'skills.groupPlace', { group: 'old-folder' }))
    }
    const en = (f: string) => suggestFolderWords(f, GROUPS, tr('en'), folderWords('en', 'dana').path)
    expect(en('skills')).toBe('Team skills')
    expect(en('skills/sales')).toBe('Team skills › sales')
    expect(en('groups/design/skills')).toBe('Design skills')
    const zh = (f: string) => suggestFolderWords(f, GROUPS, tr('zh'), folderWords('zh', 'dana').path)
    expect(zh('skills')).toBe('团队技能')
    expect(zh('groups/design/skills')).toBe('Design的技能')
  })
})

describe('the dialog', () => {
  const realFetch = globalThis.fetch
  const before = useLocaleStore.getState().locale
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'zh' })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input).split('?')[0]!
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (path === '/api/skills/overview') return json({ managedFolders: [], suggestFolders: ['skills', 'groups/design/skills'], suggestGroups: { 'groups/design/skills': { id: 'g1', name: '设计' } }, pendingReview: 0, myPending: 0 })
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: before })
  })

  test('zh: the options say 团队技能 and 设计的技能; the value is the path', async () => {
    const m = await mount(<SuggestSkillDialog source={{ kind: 'message', path: null } as never} initialName="周报" initialContent="内容" onClose={() => {}} />)
    try {
      await m.until(() => m.find('suggest-folder')?.getAttribute('disabled') == null && (m.find('suggest-folder')?.textContent ?? '').includes('设计'), 'the folders')
      const select = m.get('suggest-folder')
      const options = select.children.filter((c) => (c as { tagName?: string }).tagName?.toLowerCase() === 'option') as unknown as { getAttribute(n: string): string | null; textContent: string }[]
      expect(options.map((o) => o.textContent)).toEqual(['团队技能', '设计的技能'])
      expect(options.map((o) => o.getAttribute('value'))).toEqual(['skills', 'groups/design/skills'])
      expect(select.textContent).not.toContain('skills')
    } finally { await m.unmount() }
  })
})
