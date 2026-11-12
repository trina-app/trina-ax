// The setup's folder plan for the files the 팀 파일 step uploaded into 전사 공유 (docs/DECISIONS.md "Setup 팀 파일: the AI
// proposes folders"; server/src/onboarding/files-organize.ts, the mock server). The AI reads the text of at most
// ORGANIZE_LIMITS.read files and proposes folders one level under shared/ (at most ORGANIZE_LIMITS.folders, existing
// ones first); every other file, and every file when no AI answers, goes by the name rules here (the file-rank reason
// words). The plan is built by one pure function, so the server and the mock server propose the same thing.
import { z } from 'zod'
import { TEMPLATES_FOLDER } from '../folder-labels'
import { RelPath, type Locale } from './common'
import { BRAND_FOLDER, NOTES_FOLDER } from './onboarding-packs'
import { endpoint } from './endpoint'
import { TeamFileReason } from './onboarding-files'

export const ORGANIZE_LIMITS = {
  /** at most this many uploaded files in one plan */
  files: 200,
  /** the AI reads the text of at most this many of them */
  read: 20,
  /** each file's text, at most this many characters */
  textChars: 3000,
  /** reading the files stops after this long (the rest go by name) */
  readMs: 8_000,
  /** the AI's answer is waited for this long, then the turn is stopped and the name rules answer */
  aiMs: 25_000,
  /** at most this many folders in a plan, one level under shared/ */
  folders: 8,
  /** a folder's name, at most */
  folderChars: 40,
  /** a project's name, at most */
  projectChars: 60,
  /** a project group has at least this many files */
  projectMin: 2,
} as const

/** A folder's name in a plan: one level, no separators or characters a disk refuses, not hidden, not "." or "..". */
export const FolderName = z.string().trim().min(1).max(ORGANIZE_LIMITS.folderChars).refine((s) => cleanFolderName(s) === s.normalize('NFC'), 'not a folder name')

/** One uploaded file in the plan. `folder`: where it goes under shared/ (null: it stays where it is); `reason`: the kind
 * of document (the list's word); `form`: a reusable form or template (PR B offers it as a skill). */
export const OrganizeRow = z.object({ path: RelPath, folder: z.string().nullable(), reason: TeamFileReason.nullable(), form: z.boolean() })
export type OrganizeRow = z.infer<typeof OrganizeRow>

export const OrganizePlan = z.object({
  /** done: the AI answered · none: no AI answers the caller · failed · timeout. Anything but done: name rules only. */
  ai: z.enum(['done', 'none', 'failed', 'timeout']),
  /** the folders in shared/ now, for the row's folder picker */
  existing: z.array(z.string()),
  /** the plan's folders, in the order they are first used (existing ones reused, new ones made at apply) */
  folders: z.array(z.string()).max(ORGANIZE_LIMITS.folders),
  rows: z.array(OrganizeRow),
  /** files about one engagement: "이 n개는 '{name}' 프로젝트로 묶을까요?" after the moves (at most one) */
  project: z.object({ name: z.string(), paths: z.array(RelPath) }).nullable(),
})
export type OrganizePlan = z.infer<typeof OrganizePlan>

/** Start: the paths the upload run landed in shared/. */
export const OrganizeStart = z.object({ paths: z.array(RelPath).min(1).max(ORGANIZE_LIMITS.files) }).strict()
export type OrganizeStart = z.infer<typeof OrganizeStart>
/** `total`: the files whose text is read (the progress line's N). */
export const OrganizeStarted = z.object({ id: z.string(), total: z.number().int().nonnegative() })
export type OrganizeStarted = z.infer<typeof OrganizeStarted>
/** reading: n of N read · thinking: the AI's turn · done: `plan` is there. */
export const OrganizeStatus = z.object({ state: z.enum(['reading', 'thinking', 'done']), read: z.number().int().nonnegative(), total: z.number().int().nonnegative(), plan: OrganizePlan.nullable() })
export type OrganizeStatus = z.infer<typeof OrganizeStatus>

/** [이대로 정리]: each file of the plan `id` into shared/<folder>/ (made when missing); a file not in that plan is not
 * moved (failed). Applying the same plan again answers the first result. */
export const OrganizeApply = z.object({ id: z.string().min(1).max(64), moves: z.array(z.object({ from: RelPath, folder: FolderName }).strict()).min(1).max(ORGANIZE_LIMITS.files) }).strict()
export type OrganizeApply = z.infer<typeof OrganizeApply>
export const OrganizeApplied = z.object({ moved: z.array(z.object({ from: RelPath, to: RelPath })), failed: z.array(RelPath) })
export type OrganizeApplied = z.infer<typeof OrganizeApplied>

// ---------------------------------------------------------------- name rules

/** The words that tell a document's kind from its name (any of the five languages), checked in this order. */
const NAME_WORDS: [TeamFileReason, RegExp][] = [
  ['form', /양식|서식|템플릿|신청서|template|\bforms?\b|plantilla|formulario|templat|formulir|テンプレート|様式|書式|ひな形|雛形/i],
  ['minutes', /회의록|minutes|meeting notes|議事録|\bacta|notulen|notula/i],
  ['proposal', /제안서|proposal|提案|propuesta/i],
  ['report', /보고서|\breports?\b|報告|informe|laporan/i],
  ['intro', /소개서|회사\s*소개|company profile|introduction|会社案内|会社紹介|presentaci[oó]n|profil perusahaan/i],
  ['policy', /규정|정책|규칙|\bpolic(y|ies)\b|\brules\b|規程|規定|ポリシー|pol[ií]tica|reglamento|kebijakan|peraturan/i],
  ['training', /매뉴얼|교육|가이드|안내서|\bmanual\b|\bguide\b|handbook|training|マニュアル|研修|ガイド|gu[ií]a|capacitaci[oó]n|panduan|pelatihan/i],
  ['brand', /로고|브랜드|\blogo|\bbrand|ブランド|ロゴ|\bmarca\b|\bmerek\b/i],
]

/** The kind of document a file name says (without its extension), or null. */
export function nameReason(name: string): TeamFileReason | null {
  const stem = name.normalize('NFC').replace(/\.[^./]+$/, '').replace(/[_\-.]+/g, ' ')
  for (const [reason, re] of NAME_WORDS) if (re.test(stem)) return reason
  return null
}

/** The folder each kind goes to when nothing else says (the team's language). 양식, 회의록 and 브랜드 are the folders a new
 * team already has (docs/DECISIONS.md "Team folder basics"). */
export const REASON_FOLDER: Record<TeamFileReason, Record<Locale, string>> = {
  form: TEMPLATES_FOLDER,
  minutes: NOTES_FOLDER,
  brand: BRAND_FOLDER,
  intro: { ko: '회사 소개', en: 'Company intro', id: 'Profil perusahaan', ja: '会社紹介', es: 'Presentación de la empresa' },
  report: { ko: '보고서', en: 'Reports', id: 'Laporan', ja: '報告書', es: 'Informes' },
  policy: { ko: '규정', en: 'Policies', id: 'Kebijakan', ja: '規程', es: 'Políticas' },
  training: { ko: '교육 자료', en: 'Training', id: 'Pelatihan', ja: '研修資料', es: 'Formación' },
  proposal: { ko: '제안서', en: 'Proposals', id: 'Proposal', ja: '提案書', es: 'Propuestas' },
}

/** A folder name as a plan uses it, or null: NFC, spaces collapsed, no separators or characters Windows refuses, no
 * control characters, not hidden, at most ORGANIZE_LIMITS.folderChars. */
export function cleanFolderName(s: string): string | null {
  const v = s.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  if (!v || v.startsWith('.') || v.length > ORGANIZE_LIMITS.folderChars) return null
  return v
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
/** The folder under shared/ a path is in now (shared/양식/a.pdf → "양식"; shared/a.pdf → null). */
export const sharedFolderOf = (p: string): string | null => {
  const segs = p.split('/')
  return segs[0] === 'shared' && segs.length === 3 ? segs[1]! : null
}

/** What the AI said, read and cleaned by the server: per path its folder, kind and form mark; at most one project. */
export interface AiOrganize {
  files: Map<string, { folder: string | null; reason: TeamFileReason | null; form: boolean }>
  project: { name: string; paths: string[] } | null
}

/**
 * The plan for `paths` (files in shared/): the AI's folder for a file it read, else the name rules' folder for its kind
 * (the folder the AI used most for that kind, else an existing folder named for that kind in any language, else the
 * kind's folder in the team's language). An existing folder is reused whatever the letter case. At most
 * ORGANIZE_LIMITS.folders folders: a file whose folder would be one more goes to its kind's folder when that one is in
 * the plan, else stays. A file already in its folder stays (no row moves it).
 */
export function organizePlan(o: { paths: readonly string[]; existing: readonly string[]; locale: Locale; ai: AiOrganize | null }): Pick<OrganizePlan, 'folders' | 'rows' | 'project'> {
  const existing = new Map(o.existing.map((n) => [fold(n), n]))
  const canon = (n: string) => existing.get(fold(n)) ?? n
  // the AI's folder per kind (its most used), for the files it did not read
  const byKind = new Map<TeamFileReason, Map<string, number>>()
  for (const f of o.ai?.files.values() ?? []) {
    if (!f.folder || !f.reason) continue
    const m = byKind.get(f.reason) ?? new Map<string, number>()
    m.set(canon(f.folder), (m.get(canon(f.folder)) ?? 0) + 1)
    byKind.set(f.reason, m)
  }
  const kindFolder = (r: TeamFileReason): string => {
    const m = byKind.get(r)
    if (m?.size) return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    for (const name of Object.values(REASON_FOLDER[r])) { const e = existing.get(fold(name)); if (e) return e }
    return REASON_FOLDER[r][o.locale]
  }
  const used: string[] = []
  const take = (f: string): boolean => {
    if (used.some((u) => fold(u) === fold(f))) return true
    if (used.length >= ORGANIZE_LIMITS.folders) return false
    used.push(f)
    return true
  }
  const rows: OrganizeRow[] = []
  for (const p of o.paths) {
    const said = o.ai?.files.get(p)
    const reason = said?.reason ?? nameReason(baseOf(p))
    let folder = said?.folder ? canon(said.folder) : said ? null : reason ? kindFolder(reason) : null
    if (folder && !take(folder)) {
      const k = reason ? kindFolder(reason) : null
      folder = k && used.some((u) => fold(u) === fold(k)) ? used.find((u) => fold(u) === fold(k))! : null
    }
    if (folder) folder = used.find((u) => fold(u) === fold(folder!)) ?? folder
    const now = sharedFolderOf(p)
    if (folder && now !== null && fold(now) === fold(folder)) folder = null
    rows.push({ path: p, folder, reason, form: said ? said.form : reason === 'form' })
  }
  const inPlan = new Set(rows.map((r) => r.folder).filter((f): f is string => !!f).map(fold))
  const folders = used.filter((u) => inPlan.has(fold(u)))
  const known = new Set(o.paths)
  const pp = o.ai?.project ? [...new Set(o.ai.project.paths)].filter((p) => known.has(p)) : []
  const project = o.ai?.project && pp.length >= ORGANIZE_LIMITS.projectMin ? { name: o.ai.project.name, paths: pp } : null
  return { folders, rows, project }
}

export const FILES_ORGANIZE = {
  startOrganize: endpoint({ method: 'POST', path: '/api/onboarding/files/organize', auth: 'admin', owner: 'B', body: OrganizeStart, response: OrganizeStarted,
    summary: 'The setup\'s folder plan for files the caller just uploaded into shared/ (owners and admins; other paths are left out): the server reads the text of at most 20 of them as the caller and asks the caller\'s AI once (a turn with no tool); the rest, and everything without AI, by name. Answers at once with a job id; the plan comes from the status call.' }),
  organizeStatus: endpoint({ method: 'GET', path: '/api/onboarding/files/organize/:id', auth: 'admin', owner: 'B', response: OrganizeStatus,
    summary: 'A folder plan\'s progress (files read of the total, then the AI) and, once done, the plan. Only the caller who started it.' }),
  applyOrganize: endpoint({ method: 'POST', path: '/api/onboarding/files/organize/apply', auth: 'admin', owner: 'B', body: OrganizeApply, response: OrganizeApplied,
    summary: 'Apply an approved folder plan of the caller (owners and admins): each of its files moves into shared/<folder>/ (made when missing; a taken name gets " (2)"), folders the moves left empty go, and the team records that a plan was applied. The same plan again: the first result.' }),
} as const
