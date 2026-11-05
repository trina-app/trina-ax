// How the socket's sign-out signals reach the session store: session.ended says why (the sign-in screen then reads
// "signed out elsewhere or password changed"), and nothing that arrives after the person's own sign-out changes
// the screen they are on.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Me, ServerEvent } from '@mycel/shared/api'
import { dispatch } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { usePeople } from '../../src/store/people'
import { useUi } from '../../src/store/ui'

const ended = (reason: 'logout' | 'password_changed' | 'disabled' = 'password_changed'): ServerEvent => ({ type: 'session.ended', seq: 7, at: Date.now(), data: { reason } })

beforeEach(() => {
  useSession.setState({ status: { kind: 'signed-in', me: {} as Me } })
})

describe('session.ended', () => {
  test('a signed-in window goes to the sign-in screen with the "ended" reason', () => {
    dispatch(ended())
    expect(useSession.getState().status).toEqual({ kind: 'signed-out', reason: 'ended' })
  })

  test('after the person signed out in this window, a late session.ended does not change the screen', () => {
    useSession.getState().signedOut()
    dispatch(ended('logout'))
    expect(useSession.getState().status).toEqual({ kind: 'signed-out', reason: undefined })
  })
})

describe('profile_changed', () => {
  test('no toast; the people list is read again', () => {
    let loads = 0
    const load = usePeople.getState().load
    usePeople.setState({ loaded: true, load: async () => { loads++ } })
    const before = JSON.stringify(useUi.getState())
    try {
      dispatch({ type: 'notice', seq: 8, at: Date.now(), data: { level: 'info', code: 'profile_changed', message: '' } })
      expect(loads).toBe(1)
      expect(JSON.stringify(useUi.getState())).toBe(before)
    } finally { usePeople.setState({ load }); useSession.getState().signedOut() } // later files expect no half-made session
  })
})
