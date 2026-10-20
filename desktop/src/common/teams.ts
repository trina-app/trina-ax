// The teams this desktop app remembers (teams.json in the app's user data). Each team gets its own session
// partitions, so cookies / storage of one team never reach another, and the in-app browser of a team is separate
// from its app page. Pure: file I/O is in main/teams-store.ts. Unit-tested in tests/unit/e-desktop-common.test.ts.
import { z } from 'zod'

export const TeamId = z.string().regex(/^[a-f0-9]{12,32}$/)

export const DirectInfo = z.object({
  /** server's teamId from /api/connect-info */
  teamId: z.string(),
  /** pinned SHA-256 of the LAN certificate, upper-case hex with colons (AA:BB:...) */
  fingerprint: z.string(),
  port: z.number().int(),
  hosts: z.array(z.string()),
  checkedAt: z.string(),
})
export type DirectInfo = z.infer<typeof DirectInfo>

export const TeamEntry = z.object({
  id: TeamId,
  /** the team address as entered and checked, e.g. https://acme.treesoop.com */
  origin: z.string(),
  label: z.string().max(200),
  addedAt: z.string(),
  lastOpenedAt: z.string().nullable(),
  /** office-network direct connection learned over the team address; null = relay only */
  direct: DirectInfo.nullable().default(null),
})
export type TeamEntry = z.infer<typeof TeamEntry>

export const TeamsFile = z.object({
  version: z.literal(1),
  teams: z.array(TeamEntry).max(100),
  lastTeamId: z.string().nullable(),
})
export type TeamsFile = z.infer<typeof TeamsFile>

export const emptyTeams = (): TeamsFile => ({ version: 1, teams: [], lastTeamId: null })

/** Parse a stored file; anything unreadable starts empty (the user just adds the team again). */
export function readTeams(json: string | null): TeamsFile {
  if (!json) return emptyTeams()
  try {
    const r = TeamsFile.safeParse(JSON.parse(json))
    return r.success ? r.data : emptyTeams()
  } catch {
    return emptyTeams()
  }
}

export function findTeam(f: TeamsFile, id: string | null | undefined): TeamEntry | undefined {
  return id ? f.teams.find((t) => t.id === id) : undefined
}

/** Add a team, or return the existing one with the same origin. */
export function addTeam(f: TeamsFile, origin: string, label: string, id: string, now: string): { file: TeamsFile; team: TeamEntry; existed: boolean } {
  const existing = f.teams.find((t) => t.origin === origin)
  if (existing) return { file: f, team: existing, existed: true }
  const team: TeamEntry = { id, origin, label: label.slice(0, 200), addedAt: now, lastOpenedAt: null, direct: null }
  return { file: { ...f, teams: [...f.teams, team] }, team, existed: false }
}

export function removeTeam(f: TeamsFile, id: string): TeamsFile {
  return { ...f, teams: f.teams.filter((t) => t.id !== id), lastTeamId: f.lastTeamId === id ? null : f.lastTeamId }
}

export function updateTeam(f: TeamsFile, id: string, patch: Partial<Omit<TeamEntry, 'id'>>): TeamsFile {
  return { ...f, teams: f.teams.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

export function touchTeam(f: TeamsFile, id: string, now: string): TeamsFile {
  return { ...updateTeam(f, id, { lastOpenedAt: now }), lastTeamId: id }
}

/** Most recently opened first, then by name. */
export function sortedTeams(f: TeamsFile): TeamEntry[] {
  return [...f.teams].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.label.localeCompare(b.label))
}

/** Electron session partitions: the team's app page, and its in-app browser (never shared between teams). */
export function partitionFor(teamId: string, kind: 'app' | 'browser'): string {
  return kind === 'app' ? `persist:team-${teamId}` : `persist:team-${teamId}-browser`
}

/** "aa:bb..." / "AABB..." -> "AA:BB:..." (Electron's certificate fingerprint format is "sha256/<base64>"; see main/direct.ts). */
export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return hex.match(/.{2}/g)?.join(':') ?? ''
}

/** "1.2.10" vs "1.10.0" -> -1 / 0 / 1 (numeric parts; pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}
