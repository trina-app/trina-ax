// Team paths on the server's cards in words (server/src/chat/place-words.ts, docs/DECISIONS.md "Plain words in errors,
// cards and steps"): the Files screen's words for the top folders, "내 폴더" for the person's own, another person's
// folder by their name, the team folder's top in words; every folder below keeps its name, so two places never read
// the same. A path that steps up is shown as it was given.
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { placeWords } from '../../server/src/chat/place-words'

const db = new Database(':memory:')
db.run('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
db.run("INSERT INTO users VALUES ('u-bob', 'Bob'), ('u-olga', '대표님')")
const at = (p: string, l: 'ko' | 'en' = 'ko') => placeWords(db, p, l, 'u-bob')

test('the top folders as the Files screen says them; the rest by name', () => {
  expect(at('shared/영업/보고서.pptx')).toBe('전사 공유 › 영업 › 보고서.pptx')
  expect(at('groups/영업/브랜드/로고.png')).toBe('부서 › 영업 › 브랜드 › 로고.png')
  expect(at('shared/브랜드/로고.png')).toBe('전사 공유 › 브랜드 › 로고.png')
  expect(at('projects/견적/메모.md', 'en')).toBe('Projects › 견적 › 메모.md')
  expect(at('skills/meeting-notes/SKILL.md')).toBe('팀 스킬 › meeting-notes › SKILL.md')
  expect(at('/shared/')).toBe('전사 공유')
  expect(at('')).toBe('팀 폴더 맨 위')
  expect(at('/', 'en')).toBe('Top of the team folder')
})

test('my folder and my attachments in words; another person\'s folder by their name, never their id', () => {
  expect(at('users/u-bob/메모.txt')).toBe('내 폴더 › 메모.txt')
  expect(at('users/u-bob/.attachments/0193abcd/사진.jpg')).toBe('첨부한 파일 › 사진.jpg')
  expect(at('users/u-bob/downloads', 'en')).toBe('My folder › downloads')
  expect(at('users/u-olga/메모.txt')).toBe('대표님의 폴더 › 메모.txt')
  expect(at('users/u-olga', 'en')).toBe("대표님's folder")
  expect(at('users/u-olga/x')).not.toContain('u-olga')
})

test('a path that steps up or stays put is shown as it was given', () => {
  expect(at('shared/../users/u-olga/x')).toBe('shared/../users/u-olga/x')
  expect(at('shared/./x')).toBe('shared/./x')
})
