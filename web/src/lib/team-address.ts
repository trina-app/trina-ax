// The team's address for its own members (GET /api/me team.address: the relay address, or the public address the server
// knows; server/src/system/connection.ts teamAddressOf). Settings › 앱 shows it with a copy button, and the install
// pictures draw it in the address bar. Never the address the page was opened at: in the desktop app over the office
// network that is the office's own address (192.168.x.x), which a new device elsewhere cannot use.

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
