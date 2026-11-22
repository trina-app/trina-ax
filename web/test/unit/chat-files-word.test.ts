// A chat attachments folder is named in the team's language when it is made; the screen shows it in the viewer's
// ("Chat attachments" in a Korean room read as English, QA rerun E): rooms, file places and paths (lib/folderLabels.ts).
import { expect, test } from 'bun:test'
import { chatFilesWord } from '@mycel/shared'
import { folderWords } from '../../src/lib/folderLabels'
import { placeUnder } from '../../src/components/rooms/RoomMessages'

test('a chat attachments folder in the viewer\'s language; any other name as it is', () => {
  expect(chatFilesWord('Chat attachments', 'ko')).toBe('채팅 첨부')
  expect(chatFilesWord('채팅 첨부', 'en')).toBe('Chat attachments')
  expect(chatFilesWord('Quotes', 'ko')).toBe('Quotes')
  const w = folderWords('ko', 'olga')
  expect(w.path('projects/launch/Chat attachments', ' › ')).toBe('프로젝트 › launch › 채팅 첨부')
  expect(w.crumbs('projects/launch/Chat attachments').at(-1)).toEqual({ name: '채팅 첨부', path: 'projects/launch/Chat attachments' })
  expect(w.name('projects/launch/Chat attachments', 'Chat attachments')).toBe('채팅 첨부')
  expect(placeUnder('projects/launch/Chat attachments/a.png', { name: '신제품-출시', folderPath: 'projects/launch' }, 'ko')).toBe('신제품-출시 › 채팅 첨부')
})
