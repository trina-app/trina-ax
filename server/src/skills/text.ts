// Server texts of team skills (ko / en / id): the confirmation card, notices, refusals.
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

export const SKILL_TEXT = {
  confirm: t('팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따릅니다.\n\n{path} ({what})',
    'Save this as a team skill / rule? Every teammate\'s AI will follow it.\n\n{path} ({what})',
    'Simpan sebagai skill / aturan tim? AI semua anggota tim akan mengikutinya.\n\n{path} ({what})', "チームスキル／ルールとして保存しますか？全メンバーのAIが従います。\n\n{path}（{what}）", "¿Guardar como habilidad o regla del equipo? La IA de todos los miembros la seguirá.\n\n{path} ({what})"),
  whatNewSkill: t('새 팀 스킬 "{name}"', 'new team skill "{name}"', 'skill tim baru "{name}"', "新しいチームスキル\"{name}\"", "nueva habilidad del equipo \"{name}\""),
  whatSkill: t('팀 스킬 "{name}" 수정', 'changes the team skill "{name}"', 'mengubah skill tim "{name}"', "チームスキル\"{name}\"を変更", "modifica la habilidad del equipo \"{name}\""),
  whatNewRule: t('새 팀 규칙: 모든 대화에 들어갑니다', 'new team rule: goes into every conversation', 'aturan tim baru: masuk ke setiap percakapan', "新しいチームルール：すべての会話に適用", "nueva regla del equipo: se incluye en todas las conversaciones"),
  whatRule: t('팀 규칙 수정: 모든 대화에 들어갑니다', 'changes a team rule: goes into every conversation', 'mengubah aturan tim: masuk ke setiap percakapan', "チームルールを変更：すべての会話に適用", "modifica una regla del equipo: se incluye en todas las conversaciones"),
  whatFile: t('skills/ 안의 파일', 'a file in skills/', 'berkas di skills/', "skills/内のファイル", "un archivo en skills/"),
  save: t('저장', 'Save', 'Simpan', "保存", "Guardar"),
  dont: t('저장하지 않기', 'Don’t save', 'Jangan simpan', "保存しない", "No guardar"),
  producedFile: t('{format} 파일 (변환해서 만듦)', '{format} file (made by conversion)', 'berkas {format} (dibuat dengan konversi)', "{format}ファイル（変換で作成）", "archivo {format} (creado por conversión)"),
  // notices (banner in the app)
  changed: t('팀 스킬이 바뀌었어요: {path} ({who}{ai})', 'A team skill changed: {path} ({who}{ai})', 'Skill tim berubah: {path} ({who}{ai})', "チームスキルが変更されました：{path}（{who}{ai}）", "Cambió una habilidad del equipo: {path} ({who}{ai})"),
  viaAi: t(', AI가 저장', ', saved by the AI', ', disimpan oleh AI', "、AIが保存", ", guardado por la IA"),
  suggested: t('{who} 님이 스킬을 제안했어요: {name} → {folder}', '{who} suggested a skill: {name} → {folder}', '{who} mengusulkan skill: {name} → {folder}', "{who}がスキルを提案しました：{name} → {folder}", "{who} sugirió una habilidad: {name} → {folder}"),
  approved: t('제안한 스킬이 등록됐어요: {name} ({path})', 'Your suggested skill was registered: {name} ({path})', 'Skill yang Anda usulkan sudah didaftarkan: {name} ({path})', "提案したスキルが登録されました：{name}（{path}）", "Se registró su habilidad sugerida: {name} ({path})"),
  rejected: t('제안한 스킬이 거절됐어요: {name}{note}', 'Your suggested skill was turned down: {name}{note}', 'Skill yang Anda usulkan ditolak: {name}{note}', "提案したスキルは却下されました：{name}{note}", "Se rechazó su habilidad sugerida: {name}{note}"),
  // errors (HTTP)
  sourceNotYours: t('내 채팅의 답변이나 내 폴더(users/{me}/)의 파일만 스킬로 제안할 수 있습니다.', 'Only an answer in your own chat or a file in your own folder (users/{me}/) can be suggested as a skill.', 'Hanya jawaban di chat Anda atau berkas di folder Anda (users/{me}/) yang bisa diusulkan sebagai skill.', "スキルとして提案できるのは、自分のチャットの回答または自分のフォルダー（users/{me}/）内のファイルのみです。", "Solo puede sugerir como habilidad una respuesta de su propio chat o un archivo de su carpeta (users/{me}/)."),
  folderNotSkills: t('skills/ 안의 볼 수 있는 폴더를 골라 주세요.', 'Pick a folder inside skills/ that you can see.', 'Pilih folder di dalam skills/ yang bisa Anda lihat.', "skills/内の閲覧できるフォルダーを選んでください。", "Elija una carpeta dentro de skills/ que pueda ver."),
  notManager: t('이 폴더의 팀 스킬을 관리할 권한이 없습니다.', 'You do not manage the team skills of this folder.', 'Anda tidak mengelola skill tim di folder ini.', "このフォルダーのチームスキルを管理する権限がありません。", "No administra las habilidades del equipo de esta carpeta."),
  alreadyReviewed: t('이미 처리된 제안입니다.', 'This suggestion was already handled.', 'Usulan ini sudah ditangani.', "この提案は処理済みです。", "Esta sugerencia ya se procesó."),
  fileExists: t('같은 이름의 파일이 이미 있습니다: {path}. 파일 이름을 바꿔 주세요.', 'A file with that name already exists: {path}. Change the file name.', 'Sudah ada berkas dengan nama itu: {path}. Ganti nama berkasnya.', "同名のファイルが存在します：{path}。ファイル名を変更してください。", "Ya existe un archivo con ese nombre: {path}. Cambie el nombre del archivo."),
  notLoadable: t('이 이름과 설명으로 저장하면 스킬 파일을 읽을 수 없습니다 ({problem}). 이름, 설명 또는 파일 이름을 바꿔 주세요.', 'The skill file would not load with this name and description ({problem}). Change the name, the description or the file name.', 'Berkas skill tidak dapat dimuat dengan nama dan deskripsi ini ({problem}). Ubah nama, deskripsi, atau nama berkasnya.', "この名前と説明ではスキルファイルを読み込めません（{problem}）。名前、説明、またはファイル名を変更してください。", "El archivo de habilidad no se cargaría con este nombre y descripción ({problem}). Cambie el nombre, la descripción o el nombre del archivo."),
  managerNotSubject: t('팀장·관리자는 항상 팀 스킬을 관리합니다.', 'The owner and admins always manage team skills.', 'Pemilik dan admin selalu mengelola skill tim.', "オーナーと管理者は常にチームスキルを管理できます。", "El propietario y los administradores siempre administran las habilidades del equipo."),
} as const

export function st(key: keyof typeof SKILL_TEXT, locale: Locale, vars: Record<string, string> = {}): string {
  let s = SKILL_TEXT[key][locale] ?? SKILL_TEXT[key].en
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v)
  return s
}
