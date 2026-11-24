// Sign up with Google on the web (lib/googleSignUp.ts): what a setup, invite or team link page keeps in this tab before
// it goes to Google, for the way back without an account (?google=<result>), and what is forgotten once signed in.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { installDom, removeDom } from './dom-host'
import { googleResultOf, googleSignUpDone, keepGoogleSignUp, pendingGoogleSignUp } from '../../src/lib/googleSignUp'
import { JOIN_TOKEN_KEY } from '../../src/lib/team-link'

const INVITE = `/invite/${'A'.repeat(43)}`

describe('a sign-up with Google kept for the way back', () => {
  beforeAll(() => { installDom() })
  afterAll(() => removeDom())
  beforeEach(() => sessionStorage.clear())

  test('the page it started on gets what was typed back; another page gets nothing', () => {
    keepGoogleSignUp({ page: 'invite', path: INVITE, username: 'nico', name: 'Nico' })
    expect(pendingGoogleSignUp('invite')).toMatchObject({ page: 'invite', path: INVITE, username: 'nico', name: 'Nico' })
    expect(pendingGoogleSignUp('join')).toBeNull()
    expect(pendingGoogleSignUp('setup')).toBeNull()
  })

  test('only a fresh one, and only an invite page\'s own address', () => {
    keepGoogleSignUp({ page: 'invite', path: INVITE })
    expect(pendingGoogleSignUp('invite', Date.now() + 16 * 60_000)).toBeNull()
    keepGoogleSignUp({ page: 'invite', path: 'https://evil.example/invite/x' })
    expect(pendingGoogleSignUp('invite')?.path).toBeUndefined()
    sessionStorage.setItem('mycel.googleSignUp', '{not json')
    expect(pendingGoogleSignUp('invite')).toBeNull()
  })

  test('signed in afterwards: the kept tokens of this tab go; without a sign-up started here nothing does', () => {
    sessionStorage.setItem(JOIN_TOKEN_KEY, 'B'.repeat(43))
    googleSignUpDone()
    expect(sessionStorage.getItem(JOIN_TOKEN_KEY)).toBe('B'.repeat(43))
    keepGoogleSignUp({ page: 'join', username: 'rosa', name: 'Rosa' })
    googleSignUpDone()
    expect(sessionStorage.getItem(JOIN_TOKEN_KEY)).toBeNull()
    expect(pendingGoogleSignUp('join')).toBeNull()
  })

  test('the result of the address', () => {
    expect(googleResultOf('?google=username_taken')).toBe('username_taken')
    expect(googleResultOf('')).toBeNull()
  })
})
