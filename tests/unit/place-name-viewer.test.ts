// placeName with who reads it (QA TC-8922): users/<me>/ is "My files", another person's folder is theirs by name (never
// "My files", never their id), users/ alone is "Personal"; without a viewer it says what the step lines always said.
import { afterEach, describe, expect, test } from 'bun:test'
import { ownFolderWord, placeName, setOwnFolderWord, stepPlace } from '@mycel/shared'

const before = ownFolderWord()
afterEach(() => setOwnFolderWord(before))
const names: Record<string, string> = { mina: '김민지' }
const viewer = { me: 'qa-admin', nameOf: (id: string) => names[id] ?? null }

describe('placeName for a viewer', () => {
  test('my own folder by the name it has on this server', () => {
    setOwnFolderWord('files')
    expect(placeName('users/qa-admin/공문', 'ko', viewer)).toBe('내 파일 › 공문')
    expect(placeName('users/qa-admin/공문', 'en', viewer)).toBe('My files › 공문')
    expect(placeName('users/qa-admin', 'en', viewer)).toBe('My files')
  })
  test("another person's folder by their name, in the screen's language", () => {
    expect(placeName('users/mina/보고서', 'ko', viewer)).toBe('김민지 님 폴더 › 보고서')
    expect(placeName('users/mina/보고서', 'en', viewer)).toBe("김민지's folder › 보고서")
    expect(placeName('users/mina/.attachments/c1/a.pdf', 'en', viewer)).toBe("김민지's folder › Attachments › a.pdf")
  })
  test('someone the directory does not name: "Personal", never their id', () => {
    const said = placeName('users/u-7f3a/메모', 'en', viewer)
    expect(said).toBe('Personal › 메모')
    expect(said).not.toContain('u-7f3a')
  })
  test('a viewer not known yet (me null): nobody is "My files"', () => {
    setOwnFolderWord('files')
    expect(placeName('users/qa-admin/a', 'en', { me: null })).toBe('Personal › a')
  })
  test('users/ alone', () => {
    expect(placeName('users', 'ko', viewer)).toBe('개인')
  })
  test('the team folders as before', () => {
    expect(placeName('shared/양식', 'en', viewer)).toBe('Company-wide › 양식')
    expect(placeName('groups/영업/견적', 'en', viewer)).toBe('영업 folder › 견적')
    expect(placeName('projects/falcon/notes', 'en', viewer)).toBe('Projects › falcon › notes')
  })
  test('without a viewer: users/<id>/ is the reader\'s own (the AI\'s steps in its asker\'s chat)', () => {
    setOwnFolderWord('files')
    expect(placeName('users/mina/보고서', 'ko')).toBe('내 파일 › 보고서')
  })
  test('step lines take the viewer: a shared chat\'s reader sees the asker\'s folder by name', () => {
    setOwnFolderWord('files')
    expect(stepPlace({ tool: 'read' }, '파일 읽기 · users/mina/보고서/a.md', 'ko', viewer).label).toBe('파일 읽기 · 김민지 님 폴더 › 보고서 › a.md')
    expect(stepPlace({ tool: 'read' }, '파일 읽기 · users/qa-admin/보고서/a.md', 'ko', viewer).label).toBe('파일 읽기 · 내 파일 › 보고서 › a.md')
  })
})
