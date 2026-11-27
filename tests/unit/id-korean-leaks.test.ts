// Words the server makes for one person follow that person's language (QA 11-27: Bahasa Indonesia in a Korean team).
import { describe, expect, test } from 'bun:test'
import { forkTitle } from '../../server/src/chat/fork'
import { FIRST_ADMIN_NAME, ownerName } from '../../server/src/auth/setup-console'

describe('a fork keeps one "(continued)", in the language of today', () => {
  test('a title gets the suffix of the person’s language', () => {
    expect(forkTitle('Rencana', 'id')).toBe('Rencana (lanjutan)')
    expect(forkTitle('Plan', 'en')).toBe('Plan (continued)')
  })
  test('a fork made in Korean, forked again in Indonesian, says it once in Indonesian', () => {
    expect(forkTitle('Rencana (이어서)', 'id')).toBe('Rencana (lanjutan)')
    expect(forkTitle('Rencana (lanjutan)', 'id')).toBe('Rencana (lanjutan)')
    expect(forkTitle('Plan (continued)', 'ko')).toBe('Plan (이어서)')
  })
  test('an empty title stays empty', () => {
    expect(forkTitle('', 'id')).toBe('')
  })
})

describe('the first owner without a usable name is "Admin" in the team language', () => {
  const owner = (locale: string) => ({ name: '', email: '\u0000@example.com', locale })
  test('the console name, else the e-mail before @', () => {
    expect(ownerName({ name: 'Dion', email: 'x@example.com', locale: 'id' })).toBe('Dion')
    expect(ownerName({ name: '', email: 'dion@example.com', locale: 'id' })).toBe('dion')
  })
  test('neither: Admin in the team language, English for an unknown one, never Korean in an Indonesian team', () => {
    expect(ownerName(owner('id'))).toBe('Admin')
    expect(ownerName(owner('id-ID'))).toBe('Admin')
    expect(ownerName(owner('ko'))).toBe(FIRST_ADMIN_NAME.ko)
    expect(ownerName(owner('fr'))).toBe('Admin')
  })
})
