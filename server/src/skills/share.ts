// 내 스킬 가져오기 (docs/DECISIONS.md "SK — 내 스킬 가져오기"): share proposals of an owner or admin. Contract:
// shared/src/api/skill-shares.ts; routes: routes/skill-shares.ts; Claude Code: connectors/remote-mcp/share.ts.
// The target (docs/DECISIONS.md "Group skills", migration 258): the team (skills/) or one of the proposer's groups whose
// skills folder they may write (groups/<folder>/skills/), chosen at create (share_skills `group`) or moved before
// anything went in (setSkillShareTarget). The checks and the judgement compare with the target's skills (the group's and
// the team's); a share to a group is also seen, applied and dropped by the group's members who may write its skills
// folder (their review list: scope review; a live notice), carries no team rule or tools, and never feeds the invite.
//   create   the candidates are checked (share-check.ts), the kept files staged outside the team files (share-stage.ts)
//            and the AI's judgement started as a restricted turn of the person (share-judge.ts) when an AI answers them
//            and their budget allows; otherwise nothing is pre-ticked (ai "none"). A proposal Claude Code or Codex sent
//            through the connector tells its person at once (a realtime notice with a link to it).
//   read     GET and the list evaluate the judgement when they read a share still "checking": its answer read once,
//            the final groups written, the judge chat deleted. A share belongs to its person: anyone else gets 404.
//   apply    what the person ticked, written as them (FileService.humanSave, like approving a suggestion: folder
//            rules, versions, the skills/ change log and the owner/admin notices), per skill: add (skills/<name>/), a
//            separate name, or merge (share-merge.ts: a restricted merge chat of theirs, the candidate as data in its
//            instructions, only the team skill readable and writable there, the skill-write card before any save;
//            while the owner's welcome steps are under way the merge waits for their end: "later"); the CLAUDE.md
//            (Codex: AGENTS.md) lines as a team rule (skills/<일하는-방식>.md, no header); remote MCP servers as
//            connection templates (no key). Idempotent per skill; the welcome steps learn what went in, and 내 스킬
//            is done (onboarding/welcome.ts recordShared).
//   dismiss  나중에 하기: its staged files go. A share expires after SKILL_SHARE_LIMITS.days (read, create sweep). A
//            dismissed or expired share keeps nothing of what it proposed (close).
import { SKILL_SHARE_LIMITS, errorMessage, skillLabel, skillTitle, IntegrationTemplateInput, type ApplySkillShare, type CreateSkillShare, type Locale, type Role, type ShareApp, type ShareCandidate, type ShareRule, type ShareTool, type SkillShare, type SkillShareSource, type SkillShareStatus } from '@mycel/shared/api'
import { Locale as LocaleSchema } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ChatRuntime } from '../chat/runtime'
import type { Principal } from '../policy/access'
import { newId } from '../db'
import { HttpError, fail } from '../http/errors'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { budgetBlock } from '../admin/budgets'
import { newChatEngine, turnEngine } from '../admin/engine-choice'
import { aiAccessFor } from '../credentials/access'
import { memberOwnAllowed } from '../credentials/policy'
import { listGroupSkills, listSkills, listTeamSkills, readSkill, sameSkillName, SKILL_NAME_MAX, writableGroupSkillRoots, type GroupSkillRoot } from '../chat/skills'
import { forgetPurgedChats } from '../chat/forget'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { FileError } from '../team-files/errors'
import { templatesOf } from '../integrations/connections/templates'
import { packSkillNames } from '../onboarding/skill-packs'
import { recordShared } from '../onboarding/welcome'
import { checkShare, freeName, renamedSkillMd, type TeamSkillRef } from './share-check'
import { judgedCandidates, parseShareJudge, shareRuleOf } from './share-judge'
import { readStagedFiles, removeStage, stagedIds, writeStage } from './share-stage'
import { dropUnstartedMerges, mergeWaits, queueMerge, startMergeChat, startStaleMerges } from './share-merge'

/** The body limit of POST /api/skill-shares (the server's own request cap): a picked folder of up to 200 skills. */
export const SKILL_SHARE_BODY_MAX = 50 * 1024 * 1024
/** A judgement still running after this is given up (failed: nothing pre-ticked). */
const JUDGE_MAX_MS = 10 * 60_000
const LIST_MAX = 50
const DAY = 86_400_000

interface Row {
  id: string; created_by: string; source: SkillShareSource; status: SkillShareStatus; ai: SkillShare['ai']; where_label: string | null
  projects: number | null; result: string; created_at: string; expires_at: string; updated_at: string
  /** 'codex' for a share Codex sent through the connector (the source column's CHECK has no 'codex': migration 253) */
  source_detail: string | null
  /** the group it goes to, or null for the team (migration 258; docs/DECISIONS.md "Group skills") */
  target_group_id: string | null
}
const COLS = 'id, created_by, source, status, ai, where_label, projects, result, created_at, expires_at, updated_at, source_detail, target_group_id'
/** The columns a new share is written with (source_detail last). */
const INSERT_COLS = COLS
/** What `result` holds (no file content: the files are staged). */
interface Result {
  candidates: ShareCandidate[]
  rule: ShareRule | null
  /** CLAUDE.md as received: its lines after the ones with a secret were left out, and how many those were */
  ruleIn: { lines: number; dropped: number } | null
  tools: ShareTool[]
  landing: string | null
  /** whose folder (absent on shares from before: Claude's) */
  app?: ShareApp
}
const OPEN = "('checking','ready')"

/** The caller of a share: their id and role (owner or admin; members never get here). */
export interface ShareCaller { id: string; role: Role }

// ---------------------------------------------------------------- text

const TEXT = {
  judgeTitle: { ko: '내 스킬 살펴보기', en: 'Looking at my skills', id: 'Melihat skill saya', ja: '自分のスキルを確認', es: 'Revisando mis habilidades' },
  judgeAsk: {
    ko: '이 스킬들이 팀에 맞는지 봐 주세요.', en: 'See which of these skills fit the team.', id: 'Lihat skill mana yang cocok untuk tim.',
    ja: 'どのスキルがチームに合うか見てください。', es: 'Mire cuáles de estas habilidades sirven al equipo.',
  },
  checking: {
    ko: '아직 팀에 맞는지 보는 중이에요. 잠시 뒤에 다시 해 주세요.', en: 'Still checking which skills fit the team. Try again in a moment.',
    id: 'Masih memeriksa skill mana yang cocok untuk tim. Coba lagi sebentar lagi.', ja: 'まだチームに合うか確認しています。少ししてからもう一度どうぞ。',
    es: 'Aún se está revisando qué habilidades sirven al equipo. Inténtelo de nuevo en un momento.',
  },
  gone: {
    ko: '이 공유 제안은 끝났어요. 스킬을 다시 찾아 주세요.', en: 'This share proposal has ended. Look for the skills again.',
    id: 'Usulan berbagi ini sudah berakhir. Cari skill-nya lagi.', ja: 'この共有の提案は終了しました。もう一度スキルを探してください。',
    es: 'Esta propuesta ya terminó. Vuelva a buscar las habilidades.',
  },
  applied: {
    ko: '이 공유 제안은 이미 팀에 넣었어요.', en: 'This share proposal was already shared with the team.',
    id: 'Usulan ini sudah dibagikan ke tim.', ja: 'この提案はすでにチームに共有しました。', es: 'Esta propuesta ya se compartió con el equipo.',
  },
  busy: {
    ko: '이 공유 제안을 넣는 중이에요. 잠시 뒤에 다시 해 주세요.', en: 'This share proposal is being shared right now. Try again in a moment.',
    id: 'Usulan ini sedang dibagikan. Coba lagi sebentar lagi.', ja: 'この提案を共有しているところです。少ししてからもう一度どうぞ。',
    es: 'Esta propuesta se está compartiendo ahora. Inténtelo de nuevo en un momento.',
  },
  folderExists: {
    ko: "팀 스킬에 '{name}' 폴더가 이미 있어요. 따로 두기로 다른 이름을 골라 주세요.", en: "The team skills already have a '{name}' folder. Choose \"keep separate\" for another name.",
    id: "Skill tim sudah punya folder '{name}'. Pilih \"simpan terpisah\" untuk nama lain.", ja: "チームのスキルに「{name}」フォルダーがすでにあります。「別にする」で別の名前を選んでください。",
    es: "Las habilidades del equipo ya tienen una carpeta '{name}'. Elija \"dejar aparte\" para otro nombre.",
  },
  sameName: {
    ko: "같은 이름의 팀 스킬 '{title}'이 있어요. 합치기나 따로 두기를 골라 주세요.", en: "A team skill '{title}' has the same name. Choose merge or keep separate.",
    id: "Ada skill tim '{title}' dengan nama yang sama. Pilih gabungkan atau simpan terpisah.", ja: "同じ名前のチームスキル「{title}」があります。「まとめる」か「別にする」を選んでください。",
    es: "Una habilidad del equipo '{title}' tiene el mismo nombre. Elija combinar o dejar aparte.",
  },
  nameTaken: {
    ko: "'{name}'은 이미 쓰는 이름이에요. 다른 이름을 골라 주세요.", en: "'{name}' is already in use. Choose another name.",
    id: "'{name}' sudah dipakai. Pilih nama lain.", ja: "「{name}」はすでに使われています。別の名前を選んでください。", es: "'{name}' ya está en uso. Elija otro nombre.",
  },
  denied: {
    ko: '팀 스킬 폴더에 넣을 권한이 없어요.', en: 'You may not save into the team skills folder.',
    id: 'Kamu tidak boleh menyimpan ke folder skill tim.', ja: 'チームのスキルフォルダーに保存する権限がありません。', es: 'No puede guardar en la carpeta de habilidades del equipo.',
  },
  notSaved: {
    ko: '팀 스킬에 넣지 못했어요: {path}에 이미 파일이 있거나 바뀌었어요.', en: 'It could not be saved to the team skills: a file at {path} is already there or changed.',
    id: 'Tidak bisa disimpan ke skill tim: sudah ada atau berubah berkas di {path}.', ja: 'チームのスキルに保存できませんでした: {path} にすでにファイルがあるか、変更されています。',
    es: 'No se pudo guardar en las habilidades del equipo: ya hay un archivo en {path} o cambió.',
  },
  stagedGone: {
    ko: '이 스킬의 파일을 더 이상 찾을 수 없어요. 스킬을 다시 찾아 주세요.', en: 'The files of this skill are no longer there. Look for the skills again.',
    id: 'Berkas skill ini sudah tidak ada. Cari skill-nya lagi.', ja: 'このスキルのファイルが見つかりません。もう一度スキルを探してください。',
    es: 'Los archivos de esta habilidad ya no están. Vuelva a buscar las habilidades.',
  },
  mergeGone: {
    ko: "합칠 팀 스킬 '{title}'을 찾을 수 없어요. 따로 두기를 골라 주세요.", en: "The team skill '{title}' to merge into is not there. Choose keep separate.",
    id: "Skill tim '{title}' yang mau digabung tidak ada. Pilih simpan terpisah.", ja: "まとめる先のチームスキル「{title}」が見つかりません。「別にする」を選んでください。",
    es: "La habilidad del equipo '{title}' para combinar no está. Elija dejar aparte.",
  },
  toolInvalid: {
    ko: '이 도구 주소로는 연결 템플릿을 만들 수 없어요.', en: 'A connection template cannot be made from this tool address.',
    id: 'Template koneksi tidak bisa dibuat dari alamat alat ini.', ja: 'このツールのアドレスでは接続テンプレートを作れません。', es: 'No se puede crear una plantilla de conexión con esta dirección.',
  },
  proposedCodex: {
    ko: 'Codex에서 스킬 {n}개를 공유하자고 했어요 · 확인', en: 'Codex proposed sharing {n} skills · Review',
    id: 'Codex mengusulkan berbagi {n} skill · Periksa', ja: 'Codex からスキル {n} 件の共有の提案があります · 確認', es: 'Codex propuso compartir {n} habilidades · Revisar',
  },
  proposed: {
    ko: 'Claude Code에서 스킬 {n}개를 공유하자고 했어요 · 확인', en: 'Claude Code proposed sharing {n} skills · Review',
    id: 'Claude Code mengusulkan berbagi {n} skill · Periksa', ja: 'Claude Code からスキル {n} 件の共有の提案があります · 確認', es: 'Claude Code propuso compartir {n} habilidades · Revisar',
  },
  // a share to a group (docs/DECISIONS.md "Group skills")
  proposedGroup: {
    ko: "{who}님이 '{group}' 그룹에 스킬 {n}개를 공유하자고 했어요 · 확인", en: "{who} proposed sharing {n} skills with the group '{group}' · Review",
    id: "{who} mengusulkan berbagi {n} skill dengan grup '{group}' · Periksa", ja: "{who}さんがグループ「{group}」にスキル {n} 件の共有を提案しました · 確認",
    es: "{who} propuso compartir {n} habilidades con el grupo '{group}' · Revisar",
  },
  notGroupWriter: {
    ko: '이 그룹의 스킬 폴더에 넣을 수 있는 그룹 멤버만 할 수 있어요.', en: 'Only a member of this group who may write its skills folder can do this.',
    id: 'Hanya anggota grup ini yang boleh menulis folder skill-nya yang bisa melakukan ini.', ja: 'このグループのスキルフォルダーに書き込めるメンバーだけができます。',
    es: 'Solo un miembro de este grupo que pueda escribir en su carpeta de habilidades puede hacerlo.',
  },
  targetGone: {
    ko: '이 공유 제안의 그룹이 없어졌어요. 스킬을 다시 찾아 주세요.', en: 'The group of this share proposal is gone. Look for the skills again.',
    id: 'Grup usulan berbagi ini sudah tidak ada. Cari skill-nya lagi.', ja: 'この共有の提案のグループがなくなりました。もう一度スキルを探してください。',
    es: 'El grupo de esta propuesta ya no existe. Vuelva a buscar las habilidades.',
  },
  targetFixed: {
    ko: '이미 일부를 넣은 공유 제안은 보낼 곳을 바꿀 수 없어요.', en: 'Part of this share proposal already went in: where it goes cannot change now.',
    id: 'Sebagian usulan ini sudah masuk: tujuannya tidak bisa diubah lagi.', ja: 'この提案の一部はすでに入っています。行き先は変えられません。',
    es: 'Parte de esta propuesta ya se agregó: ya no se puede cambiar el destino.',
  },
} satisfies Record<string, Record<Locale, string>>
/** The team rule's file name in the team's language (skills/<name>.md, a file without a header: a team rule). */
export const RULE_NAME: Record<Locale, string> = { ko: '일하는-방식', en: 'how-we-work', id: 'cara-kerja', ja: '仕事の進め方', es: 'como-trabajamos' }
const fill = (s: string, p: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(p[k] ?? ''))

function localeOf(ctx: AppContext, id: string): Locale {
  const v = LocaleSchema.safeParse((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(id) as { locale: string } | null)?.locale)
  return v.success ? v.data : teamDefaultLocale(ctx.db)
}

// ---------------------------------------------------------------- rows

const readResult = (r: Row): Result => JSON.parse(r.result) as Result
const rowOf = (ctx: AppContext, id: string) => ctx.db.query(`SELECT ${COLS} FROM skill_shares WHERE id = ?`).get(id) as Row | null
/** How it arrived: the source column, or 'codex' kept beside it (migration 253). */
const sourceOf = (r: Row): SkillShareSource => (r.source_detail === 'codex' ? 'codex' : r.source)
/** What a dismissed or expired share keeps of what it proposed: nothing (the audit rows keep the counts). */
const EMPTY: Result = { candidates: [], rule: null, ruleIn: null, tools: [], landing: null }

/** The share as `viewer` reads it: where it goes, who proposed it, whether the viewer may apply it, and (the proposer's
 * open share only) the groups it may go to instead. */
function toShare(ctx: AppContext, r: Row, viewer: string): SkillShare {
  const res = readResult(r)
  const source = sourceOf(r)
  const target = targetOf(ctx, r)
  const mine = r.created_by === viewer
  const open = r.status === 'checking' || r.status === 'ready'
  return {
    id: r.id, source, app: source === 'codex' ? 'codex' : res.app ?? 'claude', status: r.status, where: r.where_label, projects: r.projects,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(Number.isFinite(Date.parse(r.updated_at)) ? r.updated_at : r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), ai: r.ai,
    candidates: res.candidates ?? [], rule: res.rule ?? null, tools: res.tools ?? [], landing: res.landing ?? null,
    targetGroup: target, proposer: { id: r.created_by, name: nameOf(ctx, r.created_by) }, mine, canApply: mayApply(ctx, r, viewer),
    targets: mine && open && !partlyIn(res) ? targetChoices(ctx, viewer) : [],
  }
}

// ---------------------------------------------------------------- targets (docs/DECISIONS.md "Group skills")

const nameOf = (ctx: AppContext, id: string) => (ctx.db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null)?.name ?? id
const principalOf = (ctx: AppContext, id: string): Principal | null => { try { return ctx.files.principal(id) } catch { return null } }

/** The group a share goes to (its current name; null name: the group is gone), or null for the team. */
function targetOf(ctx: AppContext, r: Pick<Row, 'target_group_id'>): { id: string; name: string | null } | null {
  if (!r.target_group_id) return null
  const g = ctx.db.query('SELECT name FROM groups WHERE id = ?').get(r.target_group_id) as { name: string } | null
  return { id: r.target_group_id, name: g?.name ?? null }
}

/** The skills folder of a group `p` belongs to and may write, or null (not a member, no write, no folder). */
function groupRootFor(ctx: AppContext, p: Principal, groupId: string): GroupSkillRoot | null {
  return writableGroupSkillRoots(ctx.files, p).find((g) => g.id === groupId) ?? null
}

/** The groups a proposer may send a share to instead of the team: their groups whose skills folder they may write. */
function targetChoices(ctx: AppContext, userId: string): { id: string; name: string }[] {
  const p = principalOf(ctx, userId)
  return p ? writableGroupSkillRoots(ctx.files, p).map((g) => ({ id: g.id, name: g.name })) : []
}

/** May `viewer` apply (and drop) this share: for the team its proposer (an owner or admin), for a group a member of it
 * who may write its skills folder (the proposer too, while they are one). */
function mayApply(ctx: AppContext, r: Row, viewer: string): boolean {
  const p = principalOf(ctx, viewer)
  if (!p) return false
  if (!r.target_group_id) return r.created_by === viewer && (p.role === 'owner' || p.role === 'admin')
  return !!groupRootFor(ctx, p, r.target_group_id)
}

/** Something of the share already went in (a skill added or merging, the rule, a tool): its target is fixed. */
const partlyIn = (res: Result) => res.candidates.some((c) => c.applied && c.applied.status !== 'failed') || !!res.rule?.path || res.tools.some((t) => !!t.templateId)

/** The existing skills a share's candidates are compared with, as the person `me` sees them: a group's own skills
 * (first: a group skill of a name hides the team's) and the team's, for a group target; the team's for the team. */
function targetRefs(ctx: AppContext, me: Principal, groupId: string | null): TeamSkillRef[] {
  const team = teamRefs(ctx, me)
  if (!groupId) return team
  const group = listGroupSkills(ctx.files, me, groupId).map((s) => ({ name: s.name, path: s.path, title: skillTitle(s), description: s.description }))
  return [...group, ...team.filter((t) => !group.some((g) => sameSkillName(g.name, t.name)))]
}

/** Active members of a group who may write its skills folder, with their language: who reviews a share to it. */
function groupWriters(ctx: AppContext, groupId: string): { id: string; locale: Locale }[] {
  const ids = (ctx.db.query("SELECT m.user_id AS id FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.status = 'active' AND u.deleted_at IS NULL").all(groupId) as { id: string }[]).map((x) => x.id)
  return ids.filter((id) => { const p = principalOf(ctx, id); return !!p && !!groupRootFor(ctx, p, groupId) }).map((id) => ({ id, locale: localeOf(ctx, id) }))
}

/** A share to a group: its members who may apply it hear of it (a live notice with the link), the proposer not. */
function tellGroup(ctx: AppContext, r: Row): void {
  const target = targetOf(ctx, r)
  if (!target?.name) return
  const n = readResult(r).candidates.filter((c) => c.group !== 'excluded').length
  const who = nameOf(ctx, r.created_by)
  for (const m of groupWriters(ctx, target.id)) {
    if (m.id === r.created_by) continue
    try {
      ctx.services.realtime.publish(m.id, { type: 'notice', data: { level: 'info', code: 'skill_share', message: fill(TEXT.proposedGroup[m.locale], { who, group: target.name, n }), link: `/skills/share/${r.id}` } })
    } catch (err) { ctx.log.warn('skill share notice failed', { err: err instanceof Error ? err.message : String(err) }) }
  }
}

function save(ctx: AppContext, id: string, res: Result, status?: SkillShareStatus): void {
  const now = new Date().toISOString()
  if (status) ctx.db.query('UPDATE skill_shares SET result = ?, status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(res), status, now, id)
  else ctx.db.query('UPDATE skill_shares SET result = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(res), now, id)
}

/** The caller's own share, or one to a group the caller may apply (a member who may write its skills folder), else
 * 404 (someone else's share is the same as none). */
function ownRow(ctx: AppContext, userId: string, id: string): Row {
  const r = rowOf(ctx, id)
  if (!r || (r.created_by !== userId && !(r.target_group_id && mayApply(ctx, r, userId)))) return fail('not_found')
  return r
}

function teamRefs(ctx: AppContext, me: Principal): TeamSkillRef[] {
  return listTeamSkills(ctx.files, me).map((s) => ({ name: s.name, path: s.path, title: skillTitle(s), description: s.description }))
}

// ---------------------------------------------------------------- the judge chat

const judgeChatOf = (ctx: AppContext, shareId: string) =>
  (ctx.db.query('SELECT chat_id FROM skill_share_judges WHERE share_id = ? ORDER BY created_at DESC LIMIT 1').get(shareId) as { chat_id: string } | null)?.chat_id ?? null

/** Delete a judge chat for good once its turn is over (a machine-only chat: no trash, the person never saw it). Its
 * rows go like a chat purged from the trash (ChatRuntime.purgeChat) and so does what it left outside the database
 * (chat/forget.ts: the engine session). A turn still closing keeps it for the next sweep. */
function purgeJudge(ctx: AppContext, rt: ChatRuntime, chatId: string): boolean {
  if (rt.activeTurn(chatId) || ctx.db.query("SELECT 1 FROM turns WHERE chat_id = ? AND status IN ('queued','running')").get(chatId)) return false
  rt.purgeChat(chatId)
  void forgetPurgedChats(ctx, [chatId])
  return true
}

/** Can AI answer this person now (their AI connection, their budget)? */
function aiAnswers(ctx: AppContext, rt: ChatRuntime, who: ShareCaller, locale: Locale): boolean {
  if (budgetBlock(ctx.db, who.id, locale)) return false
  try { return aiAccessFor(ctx, who, memberOwnAllowed(ctx.db), { problems: rt.engines.get().problems }).usable } catch { return false }
}

/** The judgement: a chat of the person marked as the share's judge, and its turn queued like a message they send. */
function startJudge(ctx: AppContext, rt: ChatRuntime, who: ShareCaller, shareId: string): string {
  const locale = rt.userLocale(who.id)
  const { engine, model } = newChatEngine(ctx, who, {}, locale)
  const id = newId(), now = new Date().toISOString()
  ctx.db.transaction(() => {
    ctx.db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?,?,NULL,?,'user',?,?,?,?)")
      .run(id, who.id, TEXT.judgeTitle[locale], engine, model ?? null, now, now)
    ctx.db.query('INSERT INTO skill_share_judges (chat_id, share_id, created_at) VALUES (?,?,?)').run(id, shareId, now)
  })()
  const chat = rt.store.chatRow(id)!
  try {
    const te = turnEngine(ctx, who, chat, {}, locale, (e) => rt.defaultModelFor(e))
    rt.createTurn({ chat, userId: who.id, locale, windowId: null, clientKind: null, engine: te.engine, model: te.model,
      ...(te.substitutedFrom ? { substitutedFrom: te.substitutedFrom } : {}),
      user: { parentId: null, content: TEXT.judgeAsk[locale], attachments: [], clientMessageId: `ssj-${shareId}` } })
  } catch (e) {
    // queue full, server draining: no chat stays behind
    ctx.db.query('DELETE FROM chats WHERE id = ?').run(id)
    throw e
  }
  return id
}

/** Write the outcome of the judgement once (the share leaves "checking"), then delete the judge chat. */
function finish(ctx: AppContext, rt: ChatRuntime | null, r: Row, ai: 'done' | 'none' | 'failed', answer: ReturnType<typeof parseShareJudge>): void {
  const res = readResult(r)
  const next: Result = { ...res, candidates: judgedCandidates(res.candidates, ai === 'done' ? answer : null), rule: ai === 'done' ? shareRuleOf(answer?.rule ?? null) : null }
  const done = ctx.db.query("UPDATE skill_shares SET status = 'ready', ai = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'checking'")
    .run(ai, JSON.stringify(next), new Date().toISOString(), r.id)
  if (!done.changes || !rt) return
  const chat = judgeChatOf(ctx, r.id)
  if (chat) purgeJudge(ctx, rt, chat)
}

/** A share still "checking": its judge's answer read when it is over (evaluate on read). */
function settle(ctx: AppContext, rt: ChatRuntime, r: Row): Row {
  if (r.status !== 'checking') return r
  const chatId = judgeChatOf(ctx, r.id)
  const chat = chatId ? rt.store.chatRow(chatId) : null
  // the judge chat is gone (it could not start, or it was removed): no judgement
  if (!chat) { finish(ctx, rt, r, 'failed', null); return rowOf(ctx, r.id) ?? r }
  const leaf = chat?.active_leaf_id ? rt.store.messageRow(chat.active_leaf_id) : null
  const answer = leaf?.role === 'assistant' ? leaf : null
  const late = Date.now() - Date.parse(r.created_at) > JUDGE_MAX_MS
  if (!answer || answer.status === 'streaming') {
    if (!late) return r
    if (chatId) rt.stopChat(chatId)
    finish(ctx, rt, r, 'failed', null)
  } else if (answer.status !== 'done') {
    finish(ctx, rt, r, 'failed', null)
  } else {
    const res = readResult(r)
    // read by a group's member, the proposer may be gone since: no judgement then (nothing pre-ticked)
    const me = principalOf(ctx, r.created_by)
    const parsed = me ? parseShareJudge(answer.content, { names: res.candidates.filter((c) => c.group !== 'excluded').map((c) => c.name), team: targetRefs(ctx, me, r.target_group_id), rule: res.ruleIn }) : null
    finish(ctx, rt, r, parsed ? 'done' : 'failed', parsed)
  }
  return rowOf(ctx, r.id) ?? r
}

/** Close a share for good (dismissed or expired): its staged files and judge chat go, nothing of what it proposed
 * stays (no skill name, title, description, file name, rule or tool: the review of PR #100), and its merges that did
 * not start go with their text (share-merge.ts dropUnstartedMerges: a merge waiting for the steps' end, or for its chat
 * to be opened, would otherwise still run later). */
function close(ctx: AppContext, rt: ChatRuntime | null, r: Row, status: 'dismissed' | 'expired'): boolean {
  const res = readResult(r)
  const next: Result = { ...EMPTY, ...(res.app ? { app: res.app } : {}) }
  const done = ctx.db.query(`UPDATE skill_shares SET status = ?, ai = CASE ai WHEN 'pending' THEN 'failed' ELSE ai END, result = ?, updated_at = ? WHERE id = ? AND status IN ${OPEN}`)
    .run(status, JSON.stringify(next), new Date().toISOString(), r.id)
  if (done.changes) dropUnstartedMerges(ctx, rt, r.id)
  removeStage(ctx, r.id)
  const chat = judgeChatOf(ctx, r.id)
  if (chat && rt) { rt.stopChat(chat); purgeJudge(ctx, rt, chat) }
  return done.changes > 0
}

/** Shares past their days expire (staged files deleted); staging folders without an open share and judge chats of a
 * share no longer checking go. Runs on create and on every read of the list. */
function sweep(ctx: AppContext, rt: ChatRuntime | null): void {
  const now = new Date().toISOString()
  for (const r of ctx.db.query(`SELECT ${COLS} FROM skill_shares WHERE status IN ${OPEN} AND expires_at <= ?`).all(now) as Row[]) close(ctx, rt, r, 'expired')
  const open = new Set((ctx.db.query(`SELECT id FROM skill_shares WHERE status IN ${OPEN}`).all() as { id: string }[]).map((x) => x.id))
  for (const id of stagedIds(ctx)) if (!open.has(id)) removeStage(ctx, id)
  if (rt) {
    const left = ctx.db.query("SELECT j.chat_id FROM skill_share_judges j JOIN skill_shares s ON s.id = j.share_id WHERE s.status != 'checking'").all() as { chat_id: string }[]
    for (const j of left) purgeJudge(ctx, rt, j.chat_id)
    // merges that waited for welcome steps which no longer hold them (finished another way, hidden, the owner changed)
    startStaleMerges(ctx, rt)
  }
}

// ---------------------------------------------------------------- create, read, dismiss

/**
 * A new share proposal of `who` (owner or admin). The deterministic checks run now, so the answer lists every candidate
 * by name; the AI's judgement follows (status "checking"), or there is none (ai "none": no AI answers the person or
 * their budget is used up; "failed": it could not be started). A Claude Code proposal tells its person at once.
 */
export function createSkillShare(ctx: AppContext, rt: ChatRuntime | null, who: ShareCaller, locale: Locale, body: CreateSkillShare, o: { via: 'app' | 'connector' }): SkillShare {
  if (who.role !== 'owner' && who.role !== 'admin') fail('forbidden')
  sweep(ctx, rt)
  const me = ctx.files.principal(who.id)
  // the target: the team, or one of the proposer's groups whose skills folder they may write (docs/DECISIONS.md "Group skills")
  const group = body.group ?? null
  if (group && !groupRootFor(ctx, me, group)) fail('validation', TEXT.notGroupWriter[locale], { fields: { 'body.group': 'not a group of yours whose skills you may write' } })
  const checked = checkShare(body, targetRefs(ctx, me, group))
  const id = newId(), now = new Date()
  const app: ShareApp = body.source === 'codex' ? 'codex' : body.app ?? 'claude'
  const res: Result = { candidates: checked.candidates, rule: null, ruleIn: checked.rule ? { lines: checked.rule.lines, dropped: checked.rule.dropped } : null, tools: checked.tools, landing: null, app }
  // a Codex share keeps 'claude_code' in the source column (its CHECK) and 'codex' beside it (migration 253)
  ctx.db.query(`INSERT INTO skill_shares (${INSERT_COLS}) VALUES (?,?,?,'checking','pending',?,?,?,?,?,?,?,?)`)
    .run(id, who.id, body.source === 'codex' ? 'claude_code' : body.source, checked.where, checked.projects, JSON.stringify(res), now.toISOString(), new Date(now.getTime() + SKILL_SHARE_LIMITS.days * DAY).toISOString(), now.toISOString(), body.source === 'codex' ? 'codex' : null, group)
  try {
    writeStage(ctx, id, checked.files, checked.rule)
  } catch (e) {
    removeStage(ctx, id)
    ctx.db.query('DELETE FROM skill_shares WHERE id = ?').run(id)
    throw e
  }
  const kept = checked.candidates.filter((c) => c.group !== 'excluded').length
  audit(ctx.db, { actor: who.id, action: 'skills.share_create', target: id, detail: {
    source: body.source, app, via: o.via, candidates: checked.candidates.length, kept, excluded: checked.candidates.length - kept,
    rule: !!checked.rule, tools: checked.tools.length, projects: checked.projects, ...(group ? { group } : {}),
  } })
  // the AI's judgement: only when there is something to judge and an AI answers the person
  const row = rowOf(ctx, id)!
  if (!kept && !checked.rule) finish(ctx, rt, row, 'done', { skills: new Map(), rule: null })
  else if (!rt || !aiAnswers(ctx, rt, who, locale)) finish(ctx, rt, row, 'none', null)
  else {
    try { startJudge(ctx, rt, who, id) } catch (e) {
      ctx.log.warn('skill share judgement not started', { err: e instanceof Error ? e.message : String(e) })
      finish(ctx, rt, row, 'failed', null)
    }
  }
  const share = toShare(ctx, rowOf(ctx, id)!, who.id)
  if (body.source === 'claude_code' || body.source === 'codex') {
    const L = localeOf(ctx, who.id)
    try {
      ctx.services.realtime.publish(who.id, { type: 'notice', data: { level: 'info', code: 'skill_share', message: fill(TEXT[body.source === 'codex' ? 'proposedCodex' : 'proposed'][L], { n: kept }), link: `/skills/share/${id}` } })
    } catch (err) { ctx.log.warn('skill share notice failed', { err: err instanceof Error ? err.message : String(err) }) }
  }
  // a share to a group: the group's members who may apply it hear of it
  if (group && kept) tellGroup(ctx, rowOf(ctx, id)!)
  return share
}

/**
 * Move one's own open share to the team (`group` null) or to one of one's groups whose skills folder one may write,
 * before anything of it went in (409 after). The same-name checks run again against the new target's skills (the
 * group's and the team's); a similar skill the AI named stays only when the new target has it. The group's members
 * who may apply it are told. Audited as skills.share_target.
 */
export function setSkillShareTarget(ctx: AppContext, rt: ChatRuntime, who: ShareCaller, locale: Locale, id: string, body: { group: string | null }): SkillShare {
  const r = rowOf(ctx, id)
  if (!r || r.created_by !== who.id) return fail('not_found')
  if (r.status !== 'checking' && r.status !== 'ready') fail('conflict', TEXT[r.status === 'applied' ? 'applied' : 'gone'][locale], { params: { reason: r.status } })
  const res = readResult(r)
  if (partlyIn(res)) fail('conflict', TEXT.targetFixed[locale], { params: { reason: 'partly_applied' } })
  const me = ctx.files.principal(who.id)
  const group = body.group
  if (group && !groupRootFor(ctx, me, group)) fail('validation', TEXT.notGroupWriter[locale], { fields: { 'body.group': 'not a group of yours whose skills you may write' } })
  if ((r.target_group_id ?? null) === group) return toShare(ctx, r, who.id)
  const refs = targetRefs(ctx, me, group)
  const ref = (path: string) => refs.find((x) => x.path === path)
  for (const c of res.candidates) {
    if (c.group === 'excluded') continue
    const same = refs.find((x) => sameSkillName(x.name, c.name))
    c.sameName = same ? { path: same.path, title: same.title } : null
    if (c.similar && !ref(c.similar.path)) c.similar = null
    // a reason that named the other target's skill no longer holds
    if ((c.reason === 'same_name' && !c.sameName) || (c.reason === 'similar' && !c.similar)) c.reason = c.group === 'recommended' ? 'team_any' : 'unjudged'
    c.action = c.sameName || c.similar ? 'merge' : 'add'
  }
  ctx.db.query('UPDATE skill_shares SET target_group_id = ?, result = ?, updated_at = ? WHERE id = ?').run(group, JSON.stringify(res), new Date().toISOString(), id)
  audit(ctx.db, { actor: who.id, action: 'skills.share_target', target: id, detail: { from: r.target_group_id ?? null, to: group } })
  const next = rowOf(ctx, id)!
  if (group) tellGroup(ctx, next)
  return toShare(ctx, settle(ctx, rt, next), who.id)
}

/** The caller's own shares, newest first (a judgement that is over is read first). `scope` review: the open shares
 * others made to a group the caller may apply (docs/DECISIONS.md "Group skills"), newest first. */
export function listSkillShares(ctx: AppContext, rt: ChatRuntime, userId: string, q: { status?: SkillShareStatus; source?: SkillShareSource; scope?: 'mine' | 'review' }): SkillShare[] {
  sweep(ctx, rt)
  if (q.scope === 'review') {
    const p = principalOf(ctx, userId)
    const groups = p ? writableGroupSkillRoots(ctx.files, p).map((g) => g.id) : []
    if (!groups.length) return []
    const rows = ctx.db.query(`SELECT ${COLS} FROM skill_shares WHERE target_group_id IN (${groups.map(() => '?').join(',')}) AND created_by <> ? AND status IN ${OPEN}
      ORDER BY created_at DESC, id DESC LIMIT ${LIST_MAX}`).all(...groups, userId) as Row[]
    return rows.map((r) => settle(ctx, rt, r)).filter((r) => (!q.status || r.status === q.status) && (!q.source || sourceOf(r) === q.source)).map((r) => toShare(ctx, r, userId))
  }
  for (const r of ctx.db.query(`SELECT ${COLS} FROM skill_shares WHERE created_by = ? AND status = 'checking'`).all(userId) as Row[]) settle(ctx, rt, r)
  const where = ['created_by = ?']
  const args: string[] = [userId]
  if (q.status) { where.push('status = ?'); args.push(q.status) }
  if (q.source) { where.push("(CASE WHEN source_detail = 'codex' THEN 'codex' ELSE source END) = ?"); args.push(q.source) }
  const rows = ctx.db.query(`SELECT ${COLS} FROM skill_shares WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${LIST_MAX}`).all(...args) as Row[]
  return rows.map((r) => toShare(ctx, r, userId))
}

/** One share of the caller's own, or one to a group the caller may apply (404 for anyone else). */
export function getSkillShare(ctx: AppContext, rt: ChatRuntime, userId: string, id: string): SkillShare {
  let r = ownRow(ctx, userId, id)
  if ((r.status === 'checking' || r.status === 'ready') && Date.parse(r.expires_at) <= Date.now()) { close(ctx, rt, r, 'expired'); r = rowOf(ctx, id)! }
  return toShare(ctx, settle(ctx, rt, r), userId)
}

/** 나중에 하기: the share is dropped with its staged files (and a judgement still running). A share already over stays.
 * The proposer, or for a share to a group one of its members who may apply it (they turn it down for the group). */
export function dismissSkillShare(ctx: AppContext, rt: ChatRuntime, userId: string, id: string): void {
  const r = ownRow(ctx, userId, id)
  if (close(ctx, rt, r, 'dismissed')) audit(ctx.db, { actor: userId, action: 'skills.share_dismiss', target: id, detail: { source: r.source, ...(r.target_group_id ? { group: r.target_group_id } : {}) } })
}

// ---------------------------------------------------------------- apply

const applying = new Set<string>()
const VALID_NAME = (n: string) => n.length <= SKILL_NAME_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)
type Failure = { code: 'forbidden' | 'conflict' | 'budget_exceeded' | 'validation' | 'internal'; message: string; reason: string }
class Refused extends Error { constructor(readonly f: Failure) { super(f.reason) } }
const refused = (code: Failure['code'], message: string, reason: string) => new Refused({ code, message, reason })

/** A file layer error as a row's failure: folder rules (Denied) → forbidden; a file there or changed (ToolError,
 * FileError) → conflict. */
function failureOf(e: unknown, locale: Locale, rel: string): Failure {
  if (e instanceof Refused) return e.f
  if (e instanceof Denied) return { code: 'forbidden', message: TEXT.denied[locale], reason: 'denied' }
  if (e instanceof ToolError || e instanceof FileError) return { code: 'conflict', message: fill(TEXT.notSaved[locale], { path: rel }), reason: 'file' }
  if (e instanceof HttpError) return { code: e.code === 'forbidden' || e.code === 'budget_exceeded' || e.code === 'validation' ? e.code : 'conflict', message: e.userMessage ?? errorMessage(e.code, locale), reason: e.code }
  return { code: 'internal', message: errorMessage('internal', locale), reason: 'internal' }
}

function existsFor(ctx: AppContext, me: Principal, rel: string): boolean {
  try { return authorize(ctx.files.fx, ctx.files.rules(), me, rel, 'read', { mustExist: false }).exists } catch { return true }
}

/** Write one candidate as <root>/<name>/ (skills/ or a group's groups/<folder>/skills; its kept files first, SKILL.md
 * last), as the caller; anything already written is moved to the trash again when a later file fails, so a retry
 * finds no half folder. */
function writeSkill(ctx: AppContext, userId: string, locale: Locale, shareId: string, c: ShareCandidate, name: string, root: string): string {
  const staged = readStagedFiles(ctx, shareId, c.name, c.files)
  if (!staged?.length) throw refused('conflict', TEXT.stagedGone[locale], 'staged_gone')
  const manifest = renamedSkillMd(staged[0]!.data.toString('utf8'), { name, title: c.title })
  if (!manifest) throw refused('conflict', TEXT.stagedGone[locale], 'not_loadable')
  const folder = `${root}/${name}`
  const files = [...staged.slice(1), { path: 'SKILL.md', data: Buffer.from(manifest, 'utf8') }]
  const written: string[] = []
  let at = folder
  try {
    for (const f of files) {
      at = `${folder}/${f.path}`
      // no "last seen" hash: a file that appeared meanwhile is refused, never replaced
      ctx.files.humanSave(userId, at, f.data, null)
      written.push(at)
    }
  } catch (e) {
    for (const p of written.reverse()) { try { ctx.files.deleteFile(userId, p) } catch { /* best effort */ } }
    throw new Refused(failureOf(e, locale, at))
  }
  return `${folder}/SKILL.md`
}

/** The team rule as a file without a header (skills/<일하는-방식>.md; "-2" … when the name is taken). */
function writeRule(ctx: AppContext, me: Principal, userId: string, text: string): string {
  const base = RULE_NAME[teamDefaultLocale(ctx.db)]
  let rel = `skills/${base}.md`
  for (let n = 2; existsFor(ctx, me, rel); n++) {
    if (n > 99) throw new ToolError('no free rule name')
    rel = `skills/${base}-${n}.md`
  }
  ctx.files.humanSave(userId, rel, Buffer.from(`${text.replace(/\s+$/, '')}\n`, 'utf8'), null)
  return rel
}

/**
 * [팀에 공유]: what the person ticked, written as them. Each ticked skill once (a skill already added or merging is
 * skipped on a retry); a row that fails says why (applied.error) and the share stays "ready" for another try, else it
 * is "applied" and its staged files go. Answer: the share; when nothing in this request went through and something
 * failed, the first failure as an error (403 folder rules, 409 a file or folder there, …) with the share's rows kept.
 */
export function applySkillShare(ctx: AppContext, rt: ChatRuntime, auth: { user: ShareCaller }, locale: Locale, id: string, body: ApplySkillShare): SkillShare {
  let row = ownRow(ctx, auth.user.id, id)
  if (row.status === 'checking' || row.status === 'ready') {
    if (Date.parse(row.expires_at) <= Date.now()) { close(ctx, rt, row, 'expired'); row = rowOf(ctx, id)! }
    else row = settle(ctx, rt, row)
  }
  if (row.status === 'checking') fail('conflict', TEXT.checking[locale], { params: { reason: 'checking' } })
  if (row.status === 'dismissed' || row.status === 'expired') fail('conflict', TEXT.gone[locale], { params: { reason: row.status } })
  // who applies (docs/DECISIONS.md "Group skills"): the team's share its proposer; a group's a member of it who may write
  // its skills folder (the proposer too while they are one); a group gone since: nothing can go in
  const groupId = row.target_group_id
  if (groupId && !targetOf(ctx, row)?.name) fail('conflict', TEXT.targetGone[locale], { params: { reason: 'target_gone' } })
  if (!mayApply(ctx, row, auth.user.id)) fail('forbidden', groupId ? TEXT.notGroupWriter[locale] : TEXT.denied[locale])
  const meNow = ctx.files.principal(auth.user.id)
  const root = groupId ? groupRootFor(ctx, meNow, groupId)!.root : 'skills'
  const res = readResult(row)
  const byName = new Map(res.candidates.map((c) => [c.name, c]))
  // the request first: nothing is written when any part of it is wrong
  const fields: Record<string, string> = {}
  const asked = new Set<string>()
  body.skills.forEach((s, i) => {
    const c = byName.get(s.name)
    if (!c) fields[`body.skills.${i}.name`] = 'not a candidate of this share'
    else if (c.group === 'excluded') fields[`body.skills.${i}.name`] = 'excluded'
    else if (asked.has(s.name)) fields[`body.skills.${i}.name`] = 'twice'
    else if (s.action === 'merge' && !(c.sameName ?? c.similar)) fields[`body.skills.${i}.action`] = 'no team skill to merge into'
    else if (s.action === 'separate' && s.as !== undefined && !VALID_NAME(s.as)) fields[`body.skills.${i}.as`] = 'lowercase letters, digits and hyphens, at most 64'
    asked.add(s.name)
  })
  if (body.rule && !res.rule?.text) fields['body.rule'] = 'no team rule in this share'
  // a team rule and connection templates are the team's: a share to a group carries its skills only
  else if (body.rule && groupId) fields['body.rule'] = 'a team rule goes to the team only'
  ;(body.tools ?? []).forEach((t, i) => { if (!res.tools.some((x) => x.name === t)) fields[`body.tools.${i}`] = 'not a tool of this share'; else if (groupId) fields[`body.tools.${i}`] = 'connection templates go to the team only' })
  if (Object.keys(fields).length) fail('validation', undefined, { fields })
  const doneAlready = () => body.skills.every((s) => ['added', 'merge', 'later'].includes(byName.get(s.name)?.applied?.status ?? ''))
    && (!body.rule || !!res.rule?.path) && (body.tools ?? []).every((t) => !!res.tools.find((x) => x.name === t)?.templateId)
  if (row.status === 'applied') {
    if (doneAlready()) return toShare(ctx, row, auth.user.id)
    fail('conflict', TEXT.applied[locale], { params: { reason: 'applied' } })
  }
  if (applying.has(id)) fail('conflict', TEXT.busy[locale], { params: { reason: 'busy' } })
  applying.add(id)
  try {
    const me = meNow
    const team = targetRefs(ctx, me, groupId)
    const failures: Failure[] = []
    let went = 0
    const addedNow: ShareCandidate[] = []
    // merges: while the owner's welcome steps are under way they wait for their end (one merge chat then); otherwise
    // one restricted merge chat for the merges of this request (share-merge.ts)
    const waits = mergeWaits(ctx.db, auth.user.id)
    const merges: { c: ShareCandidate; target: { path: string; title: string }; text: string }[] = []
    // a name for "separate": no team skill, none of the caller's own, no pack skill (a later install would be blocked)
    // and no folder has it
    const names = [...listSkills(ctx.files, me).map((s) => s.name), ...team.map((t) => t.name), ...packSkillNames()]
    const taken = (n: string) => names.some((x) => sameSkillName(x, n)) || existsFor(ctx, me, `${root}/${n}`)
    for (const s of body.skills) {
      const c = byName.get(s.name)!
      if (c.applied?.status === 'added' || c.applied?.status === 'merge' || c.applied?.status === 'later') continue
      try {
        if (s.action === 'merge') {
          const target = c.sameName ?? c.similar!
          if (!readSkill(ctx.files, me, target.path)) throw refused('conflict', fill(TEXT.mergeGone[locale], { title: target.title }), 'merge_gone')
          const staged = readStagedFiles(ctx, id, c.name, c.files.slice(0, 1))
          if (!staged?.length) throw refused('conflict', TEXT.stagedGone[locale], 'staged_gone')
          const text = staged[0]!.data.toString('utf8')
          if (waits) {
            queueMerge(ctx.db, { userId: auth.user.id, shareId: id, name: c.name, title: skillLabel(c), target, text })
            c.applied = { status: 'later', path: target.path, chatId: null, error: null }
          } else {
            // started together after the loop; a failure there marks these rows
            merges.push({ c, target, text })
            continue
          }
        } else {
          let name = c.name
          if (s.action === 'separate') {
            if (s.as !== undefined) { if (taken(s.as)) throw refused('conflict', fill(TEXT.nameTaken[locale], { name: s.as }), 'name_taken'); name = s.as }
            else name = freeName(c.name, taken)
          } else {
            const same = team.find((t) => sameSkillName(t.name, c.name))
            if (same) throw refused('conflict', fill(TEXT.sameName[locale], { title: same.title }), 'same_name')
            if (existsFor(ctx, me, `${root}/${c.name}`)) throw refused('conflict', fill(TEXT.folderExists[locale], { name: c.name }), 'folder_exists')
          }
          const path = writeSkill(ctx, auth.user.id, locale, id, c, name, root)
          c.applied = { status: 'added', path, chatId: null, error: null }
          addedNow.push(c)
        }
        went++
      } catch (e) {
        const f = failureOf(e, locale, `${root}/${c.name}`)
        if (f.code === 'internal') ctx.log.warn('skill share apply failed', { share: id, err: e instanceof Error ? e.message : String(e) })
        failures.push(f)
        c.applied = { status: 'failed', path: null, chatId: null, error: f.message }
      }
      save(ctx, id, res)
    }
    if (merges.length) {
      try {
        const chatId = startMergeChat(ctx, rt, auth.user, merges.map((m) => ({ shareId: id, name: m.c.name, title: m.c.title ?? m.c.name, targetPath: m.target.path, targetTitle: m.target.title, text: m.text })))
        for (const m of merges) m.c.applied = { status: 'merge', path: m.target.path, chatId, error: null }
        went += merges.length
      } catch (e) {
        const f = failureOf(e, locale, merges[0]!.target.path)
        if (f.code === 'internal') ctx.log.warn('skill share merge not started', { share: id, err: e instanceof Error ? e.message : String(e) })
        for (const m of merges) { failures.push(f); m.c.applied = { status: 'failed', path: null, chatId: null, error: f.message } }
      }
      save(ctx, id, res)
    }
    if (body.rule && res.rule && !res.rule.path) {
      try { res.rule = { ...res.rule, path: writeRule(ctx, me, auth.user.id, res.rule.text) }; went++ } catch (e) { failures.push(failureOf(e, locale, `skills/${RULE_NAME[teamDefaultLocale(ctx.db)]}.md`)) }
      save(ctx, id, res)
    }
    for (const name of body.tools ?? []) {
      const t = res.tools.find((x) => x.name === name)!
      if (t.templateId) continue
      const input = IntegrationTemplateInput.safeParse({ kind: 'mcp', name: t.name, url: t.url, auth: t.auth, ...(t.auth === 'header' ? { authHeader: t.header } : {}) })
      if (!input.success) { t.error = TEXT.toolInvalid[locale]; failures.push({ code: 'validation', message: t.error, reason: 'tool' }); continue }
      try {
        // no key ever: each member connects it with their own (docs/INTEGRATIONS.md "Templates")
        t.templateId = templatesOf(ctx).create({ id: auth.user.id, role: auth.user.role }, input.data, locale).id
        t.error = null
        went++
      } catch (e) {
        const f = failureOf(e, locale, '')
        t.error = f.message
        failures.push(f)
      }
      save(ctx, id, res)
    }
    // the skill the invite opens: the first recommended one added, else the first added (a group's skill opens for its
    // members only: never the invite's)
    const added = res.candidates.filter((c) => c.applied?.status === 'added')
    res.landing = groupId ? null : (added.find((c) => c.group === 'recommended') ?? added[0])?.applied?.path ?? null
    const status: SkillShareStatus = failures.length ? 'ready' : 'applied'
    save(ctx, id, res, status)
    if (status === 'applied') removeStage(ctx, id)
    // 내 스킬 is done once anything of a share went in, wherever it was applied (the welcome step or /skills/share/:id)
    // a skill the AI gave no title (no AI, or its check failed) is named by its folder name as words ("quote maker"),
    // never the raw name, in the invite and the end screen (the walk of PR #100); a group's skills are not the invite's
    recordShared(ctx, auth.user.id, groupId ? [] : addedNow.map((c) => ({ path: c.applied!.path!, title: skillLabel(c), recommended: c.group === 'recommended' })), went > 0)
    audit(ctx.db, { actor: auth.user.id, action: 'skills.share_apply', target: id, detail: {
      ...(groupId ? { group: groupId } : {}),
      added: addedNow.map((c) => c.applied!.path), merge: body.skills.filter((s) => byName.get(s.name)?.applied?.status === 'merge').map((s) => byName.get(s.name)!.applied!.path),
      later: body.skills.filter((s) => byName.get(s.name)?.applied?.status === 'later').map((s) => byName.get(s.name)!.applied!.path),
      failed: body.skills.filter((s) => byName.get(s.name)?.applied?.status === 'failed').map((s) => s.name),
      rule: res.rule?.path ?? null, tools: (body.tools ?? []).filter((n) => res.tools.find((x) => x.name === n)?.templateId).length, failures: failures.length, status,
    } })
    if (failures.length && !went) {
      // folder rules refused everything: 403; else the first other reason (a file or folder there: 409)
      const f = failures.find((x) => x.code !== 'forbidden') ?? failures[0]!
      throw new HttpError(f.code, f.message, { params: { reason: f.reason } })
    }
    return toShare(ctx, rowOf(ctx, id)!, auth.user.id)
  } finally {
    applying.delete(id)
  }
}
