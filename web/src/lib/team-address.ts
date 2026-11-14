// The team's address for its own members (GET /api/me team.address: the relay address, or the public address the server
// knows, or for a server without a relay the address it is reached at, with its port; server/src/system/connection.ts
// teamAddressOf). Settings › 앱 shows it with a copy button, and the install pictures draw it in the address bar. Never
// the address this page was opened at: in the desktop app over the office network of a team on a relay that is the
// office's own address (192.168.x.x), which a new device elsewhere cannot use.

/** The host of the team address as the URL API gives it (punycode, never Unicode, so a look-alike name shows as
 * xn--…; the port when there is one), or null when there is none or it is not an http(s) address. */
export function teamAddressHost(address: string | null | undefined): string | null {
  if (!address) return null
  try {
    const u = new URL(address)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.host : null
  } catch {
    return null
  }
}

/** The team address as people should read and type it: the host (with its port) for https, the whole origin with
 * http:// for plain http (an office server without a certificate: typed without it, the apps would try https). null as
 * teamAddressHost. */
export function teamAddressShown(address: string | null | undefined): string | null {
  const host = teamAddressHost(address)
  if (!host) return null
  const u = new URL(address!)
  return u.protocol === 'http:' ? u.origin : host
}

/** After the owner saves a connection change: the new team address to tell the team, or null when there is nothing to
 * tell. Apps that were signed in follow a relay rename by themselves (the old name answers with a redirect; only the
 * first label of the host differs), but any other change leaves them with "can't connect" (QA TC-1232). Nothing to tell
 * when there was no address before, none now, or it is the same. */
export function addressToTell(before: string | null | undefined, after: string | null | undefined): string | null {
  const was = teamAddressShown(before), now = teamAddressShown(after)
  if (!was || !now || was === now) return null
  const rest = (s: string) => s.replace(/^https?:\/\//, '').split('.').slice(1).join('.')
  if (rest(was) && rest(was) === rest(now)) return null
  return now
}
