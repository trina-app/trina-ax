// Why the sign-in page was opened, and the line it shows for it (pages/Auth.tsx). 'removed' (TC-1974): the server
// answers a sign-in that ended because its account was removed with reason 'account_removed'
// (server/src/auth/account-removal.ts), only to that sign-in's own holder.
import { ApiError } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export type SignedOutReason = 'expired' | 'ended' | 'removed'

/** The answer said this sign-in ended because its account was removed from the team. */
export const accountRemoved = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 401 && e.body.params?.reason === 'account_removed'

/** The sign-in page's line under its title; none for a plain visit or the person's own sign-out. */
export function signedOutLine(reason: SignedOutReason | undefined): MessageKey | undefined {
  if (reason === 'removed') return 'auth.accountRemoved'
  if (reason === 'ended') return 'auth.sessionEnded'
  if (reason === 'expired') return 'auth.sessionExpired'
  return undefined
}
