// Server texts of team skills (ko / en / id): the confirmation card, notices, refusals.
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string): T => ({ ko, en, id })

export const SKILL_TEXT = {
  confirm: t('팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따릅니다.\n\n{path} ({what})',
    'Save this as a team skill / rule? Every teammate\'s AI will follow it.\n\n{path} ({what})',
    'Simpan sebagai skill / aturan tim? AI semua anggota tim akan mengikutinya.\n\n{path} ({what})'),
  whatNewSkill: t('새 팀 스킬 "{name}"', 'new team skill "{name}"', 'skill tim baru "{name}"'),
  whatSkill: t('팀 스킬 "{name}" 수정', 'changes the team skill "{name}"', 'mengubah skill tim "{name}"'),
  whatNewRule: t('새 팀 규칙: 모든 대화에 들어갑니다', 'new team rule: goes into every conversation', 'aturan tim baru: masuk ke setiap percakapan'),
  whatRule: t('팀 규칙 수정: 모든 대화에 들어갑니다', 'changes a team rule: goes into every conversation', 'mengubah aturan tim: masuk ke setiap percakapan'),
  whatFile: t('skills/ 안의 파일', 'a file in skills/', 'berkas di skills/'),
  save: t('저장', 'Save', 'Simpan'),
  dont: t('저장하지 않기', 'Don’t save', 'Jangan simpan'),
  producedFile: t('{format} 파일 (변환해서 만듦)', '{format} file (made by conversion)', 'berkas {format} (dibuat dengan konversi)'),
  // notices (banner in the app)
  changed: t('팀 스킬이 바뀌었어요: {path} ({who}{ai})', 'A team skill changed: {path} ({who}{ai})', 'Skill tim berubah: {path} ({who}{ai})'),
  viaAi: t(', AI가 저장', ', saved by the AI', ', disimpan oleh AI'),
  suggested: t('{who} 님이 스킬을 제안했어요: {name} → {folder}', '{who} suggested a skill: {name} → {folder}', '{who} mengusulkan skill: {name} → {folder}'),
  approved: t('제안한 스킬이 등록됐어요: {name} ({path})', 'Your suggested skill was registered: {name} ({path})', 'Skill yang Anda usulkan sudah didaftarkan: {name} ({path})'),
  rejected: t('제안한 스킬이 거절됐어요: {name}{note}', 'Your suggested skill was turned down: {name}{note}', 'Skill yang Anda usulkan ditolak: {name}{note}'),
  // errors (HTTP)
  sourceNotYours: t('내 채팅의 답변이나 내 폴더(users/{me}/)의 파일만 스킬로 제안할 수 있습니다.', 'Only an answer in your own chat or a file in your own folder (users/{me}/) can be suggested as a skill.', 'Hanya jawaban di chat Anda atau berkas di folder Anda (users/{me}/) yang bisa diusulkan sebagai skill.'),
  folderNotSkills: t('skills/ 안의 볼 수 있는 폴더를 골라 주세요.', 'Pick a folder inside skills/ that you can see.', 'Pilih folder di dalam skills/ yang bisa Anda lihat.'),
  notManager: t('이 폴더의 팀 스킬을 관리할 권한이 없습니다.', 'You do not manage the team skills of this folder.', 'Anda tidak mengelola skill tim di folder ini.'),
  alreadyReviewed: t('이미 처리된 제안입니다.', 'This suggestion was already handled.', 'Usulan ini sudah ditangani.'),
  fileExists: t('같은 이름의 파일이 이미 있습니다: {path}. 파일 이름을 바꿔 주세요.', 'A file with that name already exists: {path}. Change the file name.', 'Sudah ada berkas dengan nama itu: {path}. Ganti nama berkasnya.'),
  managerNotSubject: t('팀장·관리자는 항상 팀 스킬을 관리합니다.', 'The owner and admins always manage team skills.', 'Pemilik dan admin selalu mengelola skill tim.'),
} as const

export function st(key: keyof typeof SKILL_TEXT, locale: Locale, vars: Record<string, string> = {}): string {
  let s = SKILL_TEXT[key][locale] ?? SKILL_TEXT[key].en
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v)
  return s
}
