// Why the sign-in page was opened, and the line it shows for it (pages/Auth.tsx). 'removed' (TC-1974): the server
// answers a sign-in that ended because its account was removed with reason 'account_removed'
// (server/src/auth/account-removal.ts), only to that sign-in's own holder.
import { ApiError } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

/** 'left': a guest who left their one place themselves (their account ends with it: guest walkthrough S5) */
export type SignedOutReason = 'expired' | 'ended' | 'removed' | 'left'

/** The answer said this sign-in ended because its account was removed from the team. */
export const accountRemoved = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 401 && e.body.params?.reason === 'account_removed'

/** A guest's sign-in that ended with their account (the 401's params.guest, server/src/http/route.ts): whether they
 * left their place themselves or were taken out, and the team's name; null for anyone else. */
export function guestRemoval(e: unknown): { how: 'left' | 'removed'; team: string | null } | null {
  if (!accountRemoved(e)) return null
  const p = (e as ApiError).body.params
  if (p?.guest !== 'left' && p?.guest !== 'removed') return null
  return { how: p.guest, team: typeof p.team === 'string' && p.team ? p.team : null }
}

/** The sign-in page's line under its title; none for a plain visit or the person's own sign-out. */
export function signedOutLine(reason: SignedOutReason | undefined): MessageKey | undefined {
  if (reason === 'removed') return 'auth.accountRemoved'
  if (reason === 'ended') return 'auth.sessionEnded'
  if (reason === 'expired') return 'auth.sessionExpired'
  return undefined
}
