// Matrix plumbing: cases, expectations, the canary visibility table and the route enumeration from the code.
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import type { Client, Resp } from './instance'
import { C, type Who, type World } from './world'

export type Exp = 'allow' | 'deny' | 'pass-auth'

export interface Case {
  /** API key (API.<key>) or 'RAW <METHOD> <path>' */
  route: string
  who: Who
  label: string
  exp: Exp
  run: (c: Client, w: World) => Promise<Resp>
  /** extra assertion on the response (throws on failure) */
  check?: (r: Resp, w: World) => void | Promise<void>
  /** set when this case currently fails: the finding it documents */
  todo?: string
  /** excluded from the positive-allow pass (reauth / re-login requests, covered by the deny matrix instead) */
  skipPositive?: boolean
}

/** Which canaries each person may legitimately see somewhere (design tab 2 folder rules, tab 1 own-only data). */
const ALICE_OWN = [C.aliceFile, C.aliceFileOld, C.aliceFileName, C.aliceTrashName, C.aliceChatTitle, C.aliceMsg, C.aliceAnswer, C.aliceArtifact,
  C.aliceMemory, C.aliceQuestion, C.aliceAttName, C.aliceProjInstr, C.aliceUploadName, C.aliceTranscript]
const FIN = [C.finFile, C.finFileOld, C.finTrashName, C.finName]
const ALL = [...ALICE_OWN, ...FIN, C.bobFile, C.salary, C.mktBrief, C.mktInstr, C.falconPlan, C.falconInstr]
export const VISIBLE: Record<Who, string[]> = {
  owner: [...FIN, C.salary, C.mktBrief, C.mktInstr, C.falconPlan, C.falconInstr],
  admin: [...FIN, C.salary, C.mktBrief, C.mktInstr, C.falconPlan, C.falconInstr],
  memberIn: [...ALICE_OWN, C.mktBrief, C.mktInstr, C.falconPlan, C.falconInstr],
  other: [C.mktBrief, C.mktInstr],
  memberOut: [...FIN, C.bobFile, C.falconPlan, C.falconInstr],
  pwchange: [],
  anon: [],
}
export const hiddenFrom = (who: Who) => ALL.filter((x) => !VISIBLE[who].includes(x))

export function leaks(who: Who, text: string): string[] {
  return hiddenFrom(who).filter((x) => text.includes(x))
}

/** Evaluate one case's response; returns problems (empty = pass). */
export function judge(k: Case, r: Resp): string[] {
  const out: string[] = []
  const l = leaks(k.who, r.text)
  if (l.length) out.push(`response shows canaries hidden from ${k.who}: ${l.join(', ')}`)
  if (k.exp === 'allow' && (r.status < 200 || r.status >= 300)) out.push(`expected allow (2xx), got ${r.status} ${r.text.slice(0, 200)}`)
  if (k.exp === 'pass-auth' && (r.status === 401 || r.status === 403)) out.push(`expected to pass the permission check, got ${r.status} ${r.text.slice(0, 200)}`)
  if (k.exp === 'deny') {
    if (r.status < 400 || r.status >= 500) out.push(`expected deny (4xx), got ${r.status} ${r.text.slice(0, 200)}`)
    if (k.who === 'anon' && r.status !== 401 && !k.route.startsWith('RAW') && !isPublic(k.route)) out.push(`anon must get 401, got ${r.status}`)
  }
  return out
}

export const isPublic = (route: string) => (API as Record<string, { auth: string }>)[route]?.auth === 'public'
export const authOf = (route: string) => (API as Record<string, { auth: string; allowWhilePasswordChange?: boolean }>)[route]

/** Default expectation from the endpoint's auth level (who may call it at all). */
export function levelExp(route: string, who: Who): Exp {
  const ep = authOf(route)
  if (!ep) throw new Error('unknown route ' + route)
  if (ep.auth === 'public') return 'allow'
  if (who === 'anon') return 'deny'
  if (who === 'pwchange' && !ep.allowWhilePasswordChange) return 'deny'
  if (ep.auth === 'user') return 'allow'
  if (ep.auth === 'admin') return who === 'owner' || who === 'admin' ? 'allow' : 'deny'
  return who === 'owner' ? 'allow' : 'deny' // owner, owner-reauth
}

/** Every route the server registers, read from server/src/routes/*.ts (kit.handle(API.x) and kit.raw(M, P)). */
export function enumerateRoutes(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'server', 'src', 'routes')
  const out = new Set<string>()
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'module.ts' && n !== 'index.ts')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    for (const m of src.matchAll(/kit\.handle\(\s*API\.(\w+)/g)) out.add(m[1]!)
    for (const m of src.matchAll(/kit\.raw\(\s*'(\w+)'\s*,\s*([^,]+),/g)) out.add(`RAW ${m[1]} ${m[2]!.trim()}`)
  }
  return [...out].sort()
}

export const enc = encodeURIComponent
