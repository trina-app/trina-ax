// My sections in the Trina history (docs/decisions/20261122-trina-history-sections.md): which chats can go in one (the
// server's own rule), the refusals and words in section words for chats, and "더 보기" reading on while sectioned chats
// leave a page short.
import { describe, expect, test } from 'bun:test'
import { ApiError, type Chat } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { chatSectionBlock } from '../../src/components/nav/SidebarSections'
import { sectionErrorText } from '../../src/store/navFolders'
import { loadMoreShown } from '../../src/lib/chatListLoad'
import { useChats } from '../../src/store/chats'

const me = 'u-me'
const chat = (o: Partial<Chat> = {}) => ({ id: 'c1', title: 'x', ...o }) as Chat

describe('which chats can go in a section', () => {
  test("my own chat can; a room's side chat has no section items", () => {
    expect(chatSectionBlock(chat(), me)).toBeNull()
    expect(chatSectionBlock(chat({ sideRoomId: 'r1' }), me)).toBe('side')
  })
  test("a project's chat, or one shared through a project, says the project reason", () => {
    expect(chatSectionBlock(chat({ projectId: 'p1' }), me)).toBe('project')
    expect(chatSectionBlock(chat({ shared: { kind: 'project', by: { id: 'u-x', name: 'X' } } as never }), me)).toBe('project')
  })
  test('a chat someone shared with me by name says the shared reason; its creator may file it', () => {
    expect(chatSectionBlock(chat({ shared: { kind: 'people', by: { id: 'u-x', name: 'X' } } as never }), me)).toBe('shared')
    expect(chatSectionBlock(chat({ shared: { kind: 'people', by: { id: me, name: 'Me' } } as never }), me)).toBeNull()
  })
})

describe("the server's refusals for chats say section, never folder", () => {
  const refusal = (reason: string) => new ApiError(409, { code: 'conflict', message: 'A project chat stays in its project. It cannot go in a folder.', params: { reason } } as never)
  test('each reason', () => {
    for (const reason of ['folder_project_chat', 'folder_shared_chat', 'nav_folder_full', 'nav_folders_full', 'nav_folder_name_taken']) {
      const text = sectionErrorText(refusal(reason), 'chats')
      expect(text).not.toMatch(/folder|폴더/i)
      expect(text.length).toBeGreaterThan(5)
    }
    expect(sectionErrorText(refusal('nav_folder_full'), 'chats')).toContain('chats')
  })
})

describe('the words', () => {
  const keys = ['add', 'addTitle', 'addButton', 'addNone', 'search', 'emptyComputer', 'movedMany', 'addFailed', 'deleteBody', 'deleteBodyNone', 'sectionFull', 'projectChat', 'sharedChat', 'left'] as const
  test('every key in every language, filled in, and never a folder', () => {
    for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const)
      for (const k of keys) {
        const v = translate(l, `sidebarSections.chats.${k}`, { name: 'Bots', n: 3, reason: 'x' })
        expect(v).not.toBe(`sidebarSections.chats.${k}`)
        expect(v).not.toContain('{')
        expect(v.toLowerCase()).not.toMatch(/folder|폴더|carpeta|フォルダ|文件夹/)
      }
  })
  test('en first', () => {
    expect(translate('en', 'sidebarSections.chats.add')).toBe('Add chats')
    expect(translate('en', 'sidebarSections.chats.addButton', { n: 2 })).toBe('Add 2 chats')
    expect(translate('en', 'sidebarSections.chats.deleteBody', { n: 1 })).toBe('Its chat goes back to your history. Only your list changes.')
  })
})

describe('"더 보기" reads on while my sections take a page\'s rows', () => {
  test('until a page of rows shows, the history ends, or five reads', async () => {
    let reads = 0
    let shown = 0
    useChats.setState({ chatsCursor: 'c' })
    // every page brings 5 rows the list draws (the rest are in sections)
    await loadMoreShown(async () => {
      reads++
      shown += 5
    }, () => shown)
    expect(reads).toBe(4)
    reads = 0
    await loadMoreShown(async () => {
      reads++
    }, () => 0)
    expect(reads).toBe(5)
    reads = 0
    await loadMoreShown(async () => {
      reads++
      useChats.setState({ chatsCursor: null })
    }, () => 0)
    expect(reads).toBe(1)
  })
  test('a failed read stops', async () => {
    let reads = 0
    useChats.setState({ chatsCursor: 'c' })
    await loadMoreShown(async () => {
      reads++
      throw new Error('x')
    }, () => 0)
    expect(reads).toBe(1)
  })
})
