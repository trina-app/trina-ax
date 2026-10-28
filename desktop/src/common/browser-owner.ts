// Whose in-app browser data this is (QA finding 4, 2026-10-27): the pane's cookies, storage and allowed sites are
// kept per team on this computer. On a shared desk, the next person who signed in to the same team got the previous
// person's logged-in sites and "always allowed" list. Now the app remembers the person (user id) the pane's data
// belongs to, and clears the data when someone else signs in or when the person signs out.
// Pure: the caller reads GET /api/me and keeps the stored id (main/teams-store.ts). Unit-tested in
// tests/unit/e-desktop-common.test.ts.

/** What GET /api/me said: signed in as this user, or signed out (401). Offline / other errors: do not call. */
export type MeResult = { signedIn: true; userId: string } | { signedIn: false }

/**
 * `stored`: the person the pane's data belongs to (null: nobody, the data was cleared at a sign-out; undefined: never
 * recorded, e.g. data from before this check existed). Returns whether to clear the pane's data, and the id to store.
 * After a clear (null) only the person signed in now can have used the pane, so their sign-in keeps what is there.
 */
export function browserOwnerChange(stored: string | null | undefined, me: MeResult): { clear: boolean; owner: string | null } {
  if (!me.signedIn) return { clear: stored !== null, owner: null }
  return { clear: stored !== null && stored !== me.userId, owner: me.userId }
}
