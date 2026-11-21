/** The Google address a sign-in came back with is not the person's own sign-in email (both known, case and spaces
 * aside): the confirm step says so (components/integrations/GoogleAccount.tsx). Unknown on either side: nothing said. */
export function notOwnEmail(google: string | null | undefined, own: string | null | undefined): boolean {
  const g = google?.trim().toLowerCase(), o = own?.trim().toLowerCase()
  return !!g && !!o && g !== o
}
