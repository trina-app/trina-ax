import { TEAM_NAME_MAX } from '@mycel/shared/cloud-protocol/team-name'

/** What the Team settings name box keeps on a hosted server: at most `max` code points (not UTF-16 units, so an emoji
 * counts one and a paste never splits a surrogate pair), cut back to a clean end: no lone surrogate and no zero-width
 * joiner left dangling after the cut (the server refuses both as a bad character). Shorter text is returned as it is. */
export function capTeamName(value: string, max = TEAM_NAME_MAX): string {
  const chars = [...value]
  if (chars.length <= max) return value
  let out = chars.slice(0, max)
  while (out.length && (out[out.length - 1] === '‍' || /^[\uD800-\uDFFF]$/.test(out[out.length - 1]!))) out = out.slice(0, -1)
  return out.join('')
}
