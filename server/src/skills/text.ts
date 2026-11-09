// Server texts of team skills (ko / en / id): the confirmation card, notices, refusals.
import type { Locale } from '@mycel/shared/api'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'
import { fillPlurals } from '@mycel/shared/plural'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

export const SKILL_TEXT = {
  confirm: t('팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요.\n\n{path} ({what})',
    'Save this as a team skill / rule? Every teammate\'s AI will follow it.\n\n{path} ({what})',
    'Simpan sebagai skill / aturan tim? AI semua anggota tim akan mengikutinya.\n\n{path} ({what})', "チームスキル／ルールとして保存しますか？全メンバーのAIが従います。\n\n{path}（{what}）", "¿Guardar como habilidad o regla del equipo? La IA de todos los miembros la seguirá.\n\n{path} ({what})"),
  whatNewSkill: t('새 팀 스킬 "{name}"', 'new team skill "{name}"', 'skill tim baru "{name}"', "新しいチームスキル\"{name}\"", "nueva habilidad del equipo \"{name}\""),
  whatSkill: t('팀 스킬 "{name}" 수정', 'changes the team skill "{name}"', 'mengubah skill tim "{name}"', "チームスキル\"{name}\"を変更", "modifica la habilidad del equipo \"{name}\""),
  whatNewRule: t('새 팀 규칙: 모든 대화에 들어가요', 'new team rule: goes into every conversation', 'aturan tim baru: masuk ke setiap percakapan', "新しいチームルール：すべての会話に適用", "nueva regla del equipo: se incluye en todas las conversaciones"),
  whatRule: t('팀 규칙 수정: 모든 대화에 들어가요', 'changes a team rule: goes into every conversation', 'mengubah aturan tim: masuk ke setiap percakapan', "チームルールを変更：すべての会話に適用", "modifica una regla del equipo: se incluye en todas las conversaciones"),
  whatFile: t('skills/ 안의 파일', 'a file in skills/', 'berkas di skills/', "skills/内のファイル", "un archivo en skills/"),
  // a group's skills folder (docs/DECISIONS.md "Group skills")
  confirmGroup: t('그룹 "{group}"의 스킬로 저장할까요? 이 그룹 멤버의 AI가 따라요.\n\n{path} ({what})',
    'Save this as a skill of the group "{group}"? The AI of every member of this group will follow it.\n\n{path} ({what})',
    'Simpan sebagai skill grup "{group}"? AI setiap anggota grup ini akan mengikutinya.\n\n{path} ({what})', "グループ「{group}」のスキルとして保存しますか？このグループの全メンバーのAIが従います。\n\n{path}（{what}）", "¿Guardar como habilidad del grupo \"{group}\"? La IA de cada miembro de este grupo la seguirá.\n\n{path} ({what})"),
  whatNewGroupSkill: t('새 그룹 스킬 "{name}"', 'new group skill "{name}"', 'skill grup baru "{name}"', "新しいグループスキル\"{name}\"", "nueva habilidad del grupo \"{name}\""),
  whatGroupSkill: t('그룹 스킬 "{name}" 수정', 'changes the group skill "{name}"', 'mengubah skill grup "{name}"', "グループスキル\"{name}\"を変更", "modifica la habilidad del grupo \"{name}\""),
  whatGroupFile: t('그룹 스킬 폴더 안의 파일', 'a file in the group\'s skills folder', 'berkas di folder skill grup', "グループのスキルフォルダー内のファイル", "un archivo en la carpeta de habilidades del grupo"),
  changedGroup: t('그룹 "{group}"의 스킬이 바뀌었어요: {path} ({who}{ai})', 'A skill of the group "{group}" changed: {path} ({who}{ai})', 'Skill grup "{group}" berubah: {path} ({who}{ai})', "グループ「{group}」のスキルが変更されました：{path}（{who}{ai}）", "Cambió una habilidad del grupo \"{group}\": {path} ({who}{ai})"),
  // a project's skills folder (docs/DECISIONS.md "Project skills")
  confirmProject: t('프로젝트 "{project}"의 스킬로 저장할까요? 이 프로젝트 채팅에서 AI가 따라요.\n\n{path} ({what})',
    'Save this as a skill of the project "{project}"? The AI follows it in this project\'s chats.\n\n{path} ({what})',
    'Simpan sebagai skill proyek "{project}"? AI mengikutinya di chat proyek ini.\n\n{path} ({what})', "プロジェクト「{project}」のスキルとして保存しますか？このプロジェクトのチャットでAIが従います。\n\n{path}（{what}）", "¿Guardar como habilidad del proyecto \"{project}\"? La IA la seguirá en los chats de este proyecto.\n\n{path} ({what})"),
  whatNewProjectSkill: t('새 프로젝트 스킬 "{name}"', 'new project skill "{name}"', 'skill proyek baru "{name}"', "新しいプロジェクトスキル\"{name}\"", "nueva habilidad del proyecto \"{name}\""),
  whatProjectSkill: t('프로젝트 스킬 "{name}" 수정', 'changes the project skill "{name}"', 'mengubah skill proyek "{name}"', "プロジェクトスキル\"{name}\"を変更", "modifica la habilidad del proyecto \"{name}\""),
  whatProjectFile: t('프로젝트 스킬 폴더 안의 파일', 'a file in the project\'s skills folder', 'berkas di folder skill proyek', "プロジェクトのスキルフォルダー内のファイル", "un archivo en la carpeta de habilidades del proyecto"),
  changedProject: t('프로젝트 "{project}"의 스킬이 바뀌었어요: {path} ({who}{ai})', 'A skill of the project "{project}" changed: {path} ({who}{ai})', 'Skill proyek "{project}" berubah: {path} ({who}{ai})', "プロジェクト「{project}」のスキルが変更されました：{path}（{who}{ai}）", "Cambió una habilidad del proyecto \"{project}\": {path} ({who}{ai})"),
  // the same name at another level (a project only adds names)
  whereTeam: t('팀 전체', 'the whole team', 'seluruh tim', "チーム全体", "todo el equipo"),
  whereGroup: t('{group} 그룹', 'the group {group}', 'grup {group}', "グループ「{group}」", "el grupo {group}"),
  wherePersonal: t('내 스킬', 'your own skills', 'skill Anda sendiri', "自分のスキル", "sus propias habilidades"),
  whereProject: t('{project} 프로젝트', 'the project {project}', 'proyek {project}', "プロジェクト「{project}」", "el proyecto {project}"),
  sameNameWider: t('"{name}" 스킬이 {where}에 있어 이 프로젝트에선 그게 쓰여요. 이 이름으로는 저장하지 않아요.', '"{name}" is in {where}, so this project uses that one. It is not saved under this name.', '"{name}" ada di {where}, jadi proyek ini memakai yang itu. Tidak disimpan dengan nama ini.', "「{name}」は{where}にあるため、このプロジェクトではそちらが使われます。この名前では保存しません。", "\"{name}\" está en {where}, así que este proyecto usa esa. No se guarda con este nombre."),
  sameNameNarrower: t('"{name}" 스킬이 {where}에도 있어요. 여기에 저장하면 그 프로젝트 스킬은 가려져요.', '"{name}" is also in {where}. Saved here, that project skill is hidden.', '"{name}" juga ada di {where}. Jika disimpan di sini, skill proyek itu tersembunyi.', "「{name}」は{where}にもあります。ここに保存すると、そのプロジェクトスキルは隠れます。", "\"{name}\" también está en {where}. Si se guarda aquí, esa habilidad del proyecto queda oculta."),
  renameSave: t('이름 바꿔 저장', 'Save under another name', 'Simpan dengan nama lain', "別の名前で保存", "Guardar con otro nombre"),
  fixTeam: t('팀 것 고치기', 'Change the team\'s', 'Ubah milik tim', "チームのものを直す", "Cambiar la del equipo"),
  fixGroup: t('그룹 것 고치기', 'Change the group\'s', 'Ubah milik grup', "グループのものを直す", "Cambiar la del grupo"),
  fixMine: t('내 것 고치기', 'Change mine', 'Ubah milik saya', "自分のものを直す", "Cambiar la mía"),
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
  sourceNotYours: t('내 채팅의 답변이나 내 폴더(users/{me}/)의 파일만 스킬로 제안할 수 있어요.', 'Only an answer in your own chat or a file in your own folder (users/{me}/) can be suggested as a skill.', 'Hanya jawaban di chat Anda atau berkas di folder Anda (users/{me}/) yang bisa diusulkan sebagai skill.', "スキルとして提案できるのは、自分のチャットの回答または自分のフォルダー（users/{me}/）内のファイルのみです。", "Solo puede sugerir como habilidad una respuesta de su propio chat o un archivo de su carpeta (users/{me}/)."),
  folderNotSkills: t('skills/ 안의 볼 수 있는 폴더를 골라 주세요.', 'Pick a folder inside skills/ that you can see.', 'Pilih folder di dalam skills/ yang bisa Anda lihat.', "skills/内の閲覧できるフォルダーを選んでください。", "Elija una carpeta dentro de skills/ que pueda ver."),
  notManager: t('이 폴더의 팀 스킬을 관리할 권한이 없어요.', 'You do not manage the team skills of this folder.', 'Anda tidak mengelola skill tim di folder ini.', "このフォルダーのチームスキルを管理する権限がありません。", "No administra las habilidades del equipo de esta carpeta."),
  alreadyReviewed: t('이미 처리된 제안이에요.', 'This suggestion was already handled.', 'Usulan ini sudah ditangani.', "この提案は処理済みです。", "Esta sugerencia ya se procesó."),
  fileExists: t('같은 이름의 파일이 이미 있어요: {path}. 파일 이름을 바꿔 주세요.', 'A file with that name already exists: {path}. Change the file name.', 'Sudah ada berkas dengan nama itu: {path}. Ganti nama berkasnya.', "同名のファイルが存在します：{path}。ファイル名を変更してください。", "Ya existe un archivo con ese nombre: {path}. Cambie el nombre del archivo."),
  notLoadable: t('이 이름과 설명으로 저장하면 스킬 파일을 읽을 수 없어요 ({problem}). 이름, 설명 또는 파일 이름을 바꿔 주세요.', 'The skill file would not load with this name and description ({problem}). Change the name, the description or the file name.', 'Berkas skill tidak dapat dimuat dengan nama dan deskripsi ini ({problem}). Ubah nama, deskripsi, atau nama berkasnya.', "この名前と説明ではスキルファイルを読み込めません（{problem}）。名前、説明、またはファイル名を変更してください。", "El archivo de habilidad no se cargaría con este nombre y descripción ({problem}). Cambie el nombre, la descripción o el nombre del archivo."),
  // members contribute (docs/DECISIONS.md "MC")
  contributed: t('{who}님이 스킬 {n}개를 팀에 올리자고 했어요', '{who} wants to bring {n} skill(s) to the team', '{who} ingin membawa {n} skill ke tim', "{who}さんがスキル{n}件をチームに出したいそうです", "{who} quiere aportar {n} habilidad(es) al equipo"),
  contributeMembers: t('팀장과 관리자는 내 스킬 가져오기로 스킬을 넣어요.', 'The owner and admins bring their skills with "Bring my skills".', 'Pemilik dan admin membawa skill mereka lewat "Bawa skill saya".', "オーナーと管理者は「自分のスキルを取り込む」でスキルを入れます。", "El propietario y los administradores aportan sus habilidades con \"Traer mis habilidades\"."),
  openLimit: t('기다리는 제안은 {n}개까지예요. 지금 {left}개 더 올릴 수 있어요. 팀장이 확인한 뒤에 더 올려 주세요.', 'Up to {n} suggestions can wait at a time. You can send {left} more now; send the rest once the owner has looked.', 'Paling banyak {n} usulan bisa menunggu sekaligus. Sekarang Anda bisa mengirim {left} lagi; kirim sisanya setelah pemilik melihatnya.', "待機できる提案は{n}件までです。今はあと{left}件送れます。残りはオーナーが確認してから送ってください。", "Pueden esperar hasta {n} sugerencias a la vez. Ahora puede enviar {left} más; envíe el resto cuando el propietario las haya visto."),
  folderName: t('폴더 이름은 영어 소문자, 숫자, 하이픈(-)만 써요 (64자까지).', 'A folder name uses lowercase letters, digits and hyphens (-) only, at most 64.', 'Nama folder hanya huruf kecil, angka, dan tanda hubung (-), paling banyak 64.', "フォルダー名は英小文字・数字・ハイフン(-)だけで、64文字までです。", "El nombre de la carpeta usa solo minúsculas, dígitos y guiones (-), hasta 64."),
  folderNotSaved: t('팀 스킬에 넣지 못했어요: {path}. 다시 해 보세요.', 'It could not be saved to the team skills: {path}. Try again.', 'Tidak bisa disimpan ke skill tim: {path}. Coba lagi.', "チームのスキルに保存できませんでした：{path}。もう一度お試しください。", "No se pudo guardar en las habilidades del equipo: {path}. Inténtelo de nuevo."),
  folderGone: t('이 제안의 스킬 파일을 찾을 수 없어요. 팀원에게 다시 올려 달라고 해 주세요.', 'The files of this suggestion are no longer there. Ask the teammate to send it again.', 'Berkas usulan ini sudah tidak ada. Minta anggota tim mengirimnya lagi.', "この提案のファイルが見つかりません。メンバーにもう一度送ってもらってください。", "Los archivos de esta sugerencia ya no están. Pida al compañero que la envíe de nuevo."),
  // moving a skill between levels (skills/move.ts)
  levelTeam: t('팀 전체', 'whole team', 'seluruh tim', "チーム全体", "todo el equipo"),
  levelGroup: t('{group} 그룹', '{group} group', 'grup {group}', "{group}グループ", "grupo {group}"),
  levelProject: t('{project} 프로젝트 채팅', '{project} project chats', 'chat proyek {project}', "{project}プロジェクトのチャット", "chats del proyecto {project}"),
  levelPersonal: t('나만', 'only me', 'hanya saya', "自分だけ", "solo yo"),
  moveConfirm: t('"{name}" 스킬을 옮길까요?\n\n{from} {fromN}명 → {to} {toN}명', 'Move the skill "{name}"?\n\n{from}, {fromN, plural, one {# person} other {# people}} → {to}, {toN, plural, one {# person} other {# people}}', 'Pindahkan skill "{name}"?\n\n{from}, {fromN} orang → {to}, {toN} orang', "スキル「{name}」を移動しますか？\n\n{from} {fromN, plural, one {#人} other {#人}} → {to} {toN, plural, one {#人} other {#人}}", "¿Mover la habilidad \"{name}\"?\n\n{from}, {fromN, plural, one {# persona} other {# personas}} → {to}, {toN, plural, one {# persona} other {# personas}}"),
  moveLost: t('{n}명은 이 스킬을 더 쓰지 않아요.', '{n, plural, one {# person} other {# people}} will no longer have this skill.', '{n} orang tidak akan memakai skill ini lagi.', "{n, plural, one {#人} other {#人}}はこのスキルを使えなくなります。", "{n, plural, one {# persona dejará} other {# personas dejarán}} de tener esta habilidad."),
  moveGained: t('{n}명이 새로 이 스킬을 따라요. 전체 내용을 확인해 주세요.', '{n, plural, one {# more person} other {# more people}} will follow this skill. Check all of it.', '{n} orang lagi akan mengikuti skill ini. Periksa seluruh isinya.', "{n, plural, one {#人} other {#人}}が新たにこのスキルに従います。内容をすべて確認してください。", "{n, plural, one {# persona más seguirá} other {# personas más seguirán}} esta habilidad. Revísela entera."),
  moveFiles: t('옮길 파일', 'Files to move', 'Berkas yang dipindah', "移動するファイル", "Archivos que se moverán"),
  moveNarrowHint: t('팀 스킬은 그대로 두고 skills/{name}/ 폴더 권한으로 쓸 사람을 줄일 수도 있어요.', 'You can also keep the team skill and narrow who uses it with the folder permissions of skills/{name}/.', 'Anda juga bisa membiarkan skill tim dan mempersempit penggunanya lewat izin folder skills/{name}/.', "チームスキルのまま、skills/{name}/のフォルダー権限で使う人を絞ることもできます。", "También puede dejar la habilidad del equipo y limitar quién la usa con los permisos de la carpeta skills/{name}/."),
  moveYes: t('옮기기', 'Move', 'Pindahkan', "移動", "Mover"),
  moveNo: t('옮기지 않기', 'Don’t move', 'Jangan pindahkan', "移動しない", "No mover"),
  moveNotProject: t('먼저 폴더를 프로젝트로 만들어 주세요: {folder}', 'Make the folder a project first: {folder}', 'Jadikan folder itu proyek terlebih dahulu: {folder}', "先にフォルダーをプロジェクトにしてください：{folder}", "Primero convierta la carpeta en un proyecto: {folder}"),
  moveNoLevel: t('이 프로젝트에는 프로젝트 스킬을 둘 수 없어요 (팀 루트·개인·그룹 폴더의 프로젝트).', 'This project cannot have skills of its own (a project on the team root, a personal folder or a group folder).', 'Proyek ini tidak dapat memiliki skill sendiri (proyek di root tim, folder pribadi, atau folder grup).', "このプロジェクトには専用のスキルを置けません（チームのルート・個人・グループのフォルダーのプロジェクト）。", "Este proyecto no puede tener habilidades propias (un proyecto en la raíz del equipo, una carpeta personal o de grupo)."),
  moveTaken: t('{to}에 이미 "{name}" 스킬이 있어요.', '{to} already has a skill "{name}".', '{to} sudah punya skill "{name}".', "{to}にはすでに「{name}」スキルがあります。", "{to} ya tiene una habilidad \"{name}\"."),
  moveHidden: t('"{name}" 스킬이 {where}에 있어 옮겨도 이 프로젝트에선 그게 쓰여요. 다른 이름으로 바꾼 뒤 옮겨 주세요.', '"{name}" is in {where}, so the project would use that one. Rename it before you move it.', '"{name}" ada di {where}, jadi proyek akan memakai yang itu. Ganti namanya sebelum dipindah.', "「{name}」は{where}にあるため、移動してもこのプロジェクトではそちらが使われます。名前を変えてから移動してください。", "\"{name}\" está en {where}, así que el proyecto usaría esa. Cámbiele el nombre antes de moverla."),
  moveNoWrite: t('{where}에 쓸 권한이 없어요.', 'You cannot write to {where}.', 'Anda tidak dapat menulis ke {where}.', "{where}に書き込む権限がありません。", "No puede escribir en {where}."),
  moveSame: t('이미 그 단계에 있는 스킬이에요.', 'The skill is already there.', 'Skill itu sudah di sana.', "スキルはすでにそこにあります。", "La habilidad ya está ahí."),
  moveNotFolder: t('프로젝트 스킬은 SKILL.md 폴더여야 해요. 이 스킬은 파일 하나라서 프로젝트로 옮길 수 없어요.', 'Project skills are SKILL.md folders. This skill is a single file, so it cannot move to a project.', 'Skill proyek harus berupa folder SKILL.md. Skill ini satu berkas, jadi tidak bisa dipindah ke proyek.', "プロジェクトスキルはSKILL.mdのフォルダーです。このスキルは単一ファイルなのでプロジェクトに移動できません。", "Las habilidades del proyecto son carpetas con SKILL.md. Esta es un solo archivo y no puede pasar a un proyecto."),
  moveChanged: t('카드를 보여 준 뒤 스킬 파일이 바뀌어서 옮기지 않았어요. 다시 확인해 주세요.', 'The skill\'s files changed after the card was shown, so nothing was moved. Look again.', 'Berkas skill berubah setelah kartu ditampilkan, jadi tidak ada yang dipindah. Periksa lagi.', "カードの表示後にスキルのファイルが変わったため、移動しませんでした。もう一度確認してください。", "Los archivos de la habilidad cambiaron después de mostrar la tarjeta, así que no se movió nada. Revise de nuevo."),
  moveTooMany: t('스킬 폴더의 파일이 너무 많아요 ({n}개). 파일 화면에서 옮겨 주세요.', 'The skill folder has too many files ({n}). Move it on the Files screen.', 'Folder skill punya terlalu banyak berkas ({n}). Pindahkan di layar Berkas.', "スキルフォルダーのファイルが多すぎます（{n}個）。ファイル画面で移動してください。", "La carpeta de la habilidad tiene demasiados archivos ({n}). Muévala en la pantalla Archivos."),
  moveNotFound: t('그 스킬을 찾을 수 없어요.', 'That skill was not found.', 'Skill itu tidak ditemukan.', "そのスキルが見つかりません。", "No se encontró esa habilidad."),
  moved: t('"{name}" 스킬을 옮겼어요: {from} → {to}', 'The skill "{name}" moved: {from} → {to}', 'Skill "{name}" dipindah: {from} → {to}', "スキル「{name}」を移動しました：{from} → {to}", "La habilidad \"{name}\" se movió: {from} → {to}"),
  managerNotSubject: t('팀장·관리자는 항상 팀 스킬을 관리해요.', 'The owner and admins always manage team skills.', 'Pemilik dan admin selalu mengelola skill tim.', "オーナーと管理者は常にチームスキルを管理できます。", "El propietario y los administradores siempre administran las habilidades del equipo."),
} as const

export function st(key: keyof typeof SKILL_TEXT, locale: Locale, vars: Record<string, string> = {}): string {
  // no second honorific after a name that has one ("{who} 님이" with 대표님, shared/src/honorific.ts)
  // counts first ("{n, plural, one {# person} other {# people}}", shared/src/plural.ts), then the plain values
  let s = fillPlurals(dropDoubleHonorifics(SKILL_TEXT[key][locale] ?? SKILL_TEXT[key].en, vars), vars, locale)
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v)
  return s
}
