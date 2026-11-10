// User-facing texts of the chat runtime (ko, en, id; English when a language is missing): answer errors, step labels
// (shared with the web app: shared/src/step-labels.ts), confirmation cards.
import { CHAT_ERROR_MESSAGES, PRODUCT_NAMED_AFTER_AI, type ApiErrorBody, type ChatErrorReason, type Locale } from '@mycel/shared/api'
import { STEP_TEXT } from '@mycel/shared'
import { fillPlurals } from '@mycel/shared/plural'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

export const TEXT = {
  scheduleLimit: t('개인 예약은 꺼진 예약을 포함해 최대 {n}개까지 보관할 수 있어요. 새 예약을 만들려면 기존 예약 하나를 삭제해 주세요.', 'You can keep up to {n} personal schedules, including paused schedules. Delete an existing schedule to create a new one.', 'Anda dapat menyimpan hingga {n} jadwal pribadi, termasuk jadwal yang dijeda. Hapus jadwal yang ada untuk membuat jadwal baru.', "一時停止中を含め、個人の予定は最大{n}件です。新しく作成するには既存の予定を削除してください。", "Puede tener hasta {n} programaciones personales, incluidas las pausadas. Elimine una existente para crear otra."),
  scheduleCompleted: t('이미 실행된 일회성 예약은 다시 켤 수 없어요. 새 예약을 만들어 주세요.', 'This one-time task has already run and cannot be resumed. Create a new schedule.', 'Tugas sekali jalan ini sudah dijalankan dan tidak dapat dilanjutkan. Buat jadwal baru.', "この1回限りのタスクは実行済みのため再開できません。新しい予定を作成してください。", "Esta tarea de una sola ejecución ya se ejecutó y no se puede reanudar. Cree una nueva programación."),
  scheduleExpired: t('실행 시각이 지난 일회성 예약은 켤 수 없어요. 새 예약을 만들어 주세요.', 'This one-time task has expired and cannot be resumed. Create a new schedule.', 'Waktu tugas sekali jalan ini sudah lewat dan tidak dapat dilanjutkan. Buat jadwal baru.', "この1回限りのタスクは期限切れのため再開できません。新しい予定を作成してください。", "Esta tarea de una sola ejecución venció y no se puede reanudar. Cree una nueva programación."),
  scheduleReview: t('이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요. "다시 확인"을 눌러 지시문과 주소를 확인하면 다시 켤 수 있어요.', 'This scheduled task was made without its confirmation card, so it is paused. Choose "Check again" to review its instruction and addresses and resume it.', 'Tugas terjadwal ini dibuat tanpa kartu konfirmasi, jadi dijeda. Pilih "Periksa lagi" untuk meninjau instruksi dan alamatnya lalu melanjutkannya.', "この定期タスクは確認カードなしで作成されたため一時停止しています。「再確認」を選び、指示とアドレスを確認すると再開できます。", "Esta tarea programada se creó sin su tarjeta de confirmación, así que está en pausa. Elija «Revisar de nuevo» para comprobar la instrucción y sus direcciones y reanudarla."),
  scheduleCardChanged: t('예약 작업이나 연결 서비스가 그 사이에 바뀌었어요. 카드를 다시 확인해 주세요.', 'The scheduled task or its connected services changed in the meantime. Check the card again.', 'Tugas terjadwal atau layanan terhubungnya berubah sementara itu. Periksa kartunya lagi.', "その間に定期タスクまたは接続サービスが変更されました。カードをもう一度確認してください。", "La tarea programada o sus servicios conectados cambiaron mientras tanto. Revise la tarjeta de nuevo."),
  scheduleInvalid: t('예약 작업을 확인해 주세요. 제목은 1–80자, 지시문은 3–4,000자로 쓰고 일정(시각, 요일, 날짜)을 골라 주세요.', 'Check the scheduled task: a title of 1–80 characters, an instruction of 3–4,000 characters, and a complete schedule (time, weekday, date).', 'Periksa tugas terjadwal: judul 1–80 karakter, instruksi 3–4.000 karakter, dan jadwal yang lengkap (waktu, hari, tanggal).', "定期タスクを確認してください。タイトルは1〜80文字、指示は3〜4,000文字で、予定（時刻・曜日・日付）を選んでください。", "Revise la tarea programada: un título de 1 a 80 caracteres, una instrucción de 3 a 4.000 caracteres y un horario completo (hora, día, fecha)."),
  scheduleField: t('이 칸을 확인해 주세요.', 'Check this field.', 'Periksa kolom ini.', "この項目を確認してください。", "Revise este campo."),
  /** the edit's save folder cannot be one (chat/schedule-scope.ts): gone, no write access, a top, own, hidden or skills folder */
  scheduleSaveFolder: t('이 폴더에는 예약 작업이 저장할 수 없어요. 쓸 수 있는 팀 폴더 안의 폴더를 고르거나 저장 폴더를 빼 주세요.', 'A scheduled task cannot save in this folder. Pick a folder inside a team folder you can write, or remove the save folder.', 'Tugas terjadwal tidak bisa menyimpan di folder ini. Pilih folder di dalam folder tim yang bisa Anda tulisi, atau hapus folder simpan.', "このフォルダーには定期タスクが保存できません。書き込めるチームフォルダー内のフォルダーを選ぶか、保存先フォルダーを外してください。", "Una tarea programada no puede guardar en esta carpeta. Elija una carpeta dentro de una carpeta del equipo en la que pueda escribir, o quite la carpeta de guardado."),
  /** "다시 확인" of a lapsed save folder that is not there (or not writable) any more */
  scheduleSaveGone: t('저장 폴더를 찾을 수 없거나 쓸 수 없어요. 예약 작업을 수정해서 다른 폴더를 고르거나 저장 폴더를 빼 주세요.', 'The save folder cannot be found or written. Edit the task to pick another folder, or remove the save folder.', 'Folder simpan tidak ditemukan atau tidak bisa ditulisi. Ubah tugasnya untuk memilih folder lain, atau hapus folder simpan.', "保存先フォルダーが見つからないか、書き込めません。タスクを編集して別のフォルダーを選ぶか、保存先フォルダーを外してください。", "No se encuentra la carpeta de guardado o no se puede escribir en ella. Edite la tarea para elegir otra carpeta, o quite la carpeta de guardado."),
  /** the edit keeps a place the task did not have (only taking places away is possible there) */
  scheduleSaveSources: t('예약 작업에 없던 내용은 여기서 더할 수 없어요. 채팅에서 예약 작업을 다시 만들어 주세요.', 'Content the task did not have cannot be added here. Make the task again in a chat.', 'Isi yang tidak dimiliki tugas ini tidak bisa ditambahkan di sini. Buat tugasnya lagi di obrolan.', "タスクになかった内容はここでは追加できません。チャットでタスクを作り直してください。", "Aquí no se puede añadir contenido que la tarea no tenía. Vuelva a crear la tarea en un chat."),
  schedulePast: t('그 시각은 이미 지났어요. 앞으로의 날짜와 시각을 골라 주세요.', 'That time has already passed. Pick a date and time in the future.', 'Waktu itu sudah lewat. Pilih tanggal dan waktu di masa depan.', "その時刻はすでに過ぎています。これからの日付と時刻を選んでください。", "Esa hora ya pasó. Elija una fecha y una hora futuras."),
  scheduleProject: t('그 프로젝트를 찾을 수 없거나 열 수 없어요. 다른 프로젝트를 고르거나 "프로젝트 없음"으로 두세요.', 'That project cannot be found or opened. Pick another project or "No project".', 'Proyek itu tidak ditemukan atau tidak bisa dibuka. Pilih proyek lain atau "Tanpa proyek".', "そのプロジェクトは見つからないか、開けません。別のプロジェクトか「プロジェクトなし」を選んでください。", "No se encuentra o no se puede abrir ese proyecto. Elija otro o «Sin proyecto»."),
  scheduleProjectGone: t('이 예약 작업의 프로젝트를 더 볼 수 없어서 실행하지 않아요. 프로젝트를 다시 볼 수 있게 되거나 작업을 바꾼 뒤에 실행해 주세요.', 'This scheduled task\'s project is no longer yours to see, so it does not run. Run it once you see the project again, or change the task.', 'Proyek tugas terjadwal ini tidak lagi bisa Anda lihat, jadi tidak dijalankan. Jalankan setelah Anda bisa melihat proyeknya lagi, atau ubah tugasnya.', "この定期タスクのプロジェクトを閲覧できなくなったため、実行しません。プロジェクトを再び閲覧できるようになってから、またはタスクを変更してから実行してください。", "Ya no puede ver el proyecto de esta tarea programada, así que no se ejecuta. Ejecútela cuando vuelva a ver el proyecto o cambie la tarea."),
  scheduleNeedsKey: t('이 예약 작업에는 {name}에 내 키가 필요해요. 설정 › MCP에서 연결해 주세요.', 'This scheduled task needs your own key for {name}: connect it in Settings › MCP.', 'Tugas terjadwal ini memerlukan kunci Anda sendiri untuk {name}: hubungkan di Pengaturan › MCP.', "この定期タスクには{name}のあなた自身のキーが必要です。設定 › MCPで接続してください。", "Esta tarea programada necesita su propia clave de {name}: conéctela en Configuración › MCP."),
  scheduleRunning: t('이 예약 작업이 지금 실행 중이에요. 끝난 뒤 다시 실행해 주세요.', 'This scheduled task is running now. Run it again once it has finished.', 'Tugas terjadwal ini sedang berjalan. Jalankan lagi setelah selesai.', "この定期タスクは実行中です。終わってからもう一度実行してください。", "Esta tarea programada se está ejecutando. Vuelva a ejecutarla cuando termine."),
  scheduleKind: t('이 예약 작업은 이 방법으로 바꿀 수 없어요. 화면을 새로 고친 뒤 다시 해 주세요.', 'This scheduled task cannot be changed this way. Reload the page and try again.', 'Tugas terjadwal ini tidak bisa diubah dengan cara ini. Muat ulang halaman lalu coba lagi.', "この定期タスクはこの方法では変更できません。ページを再読み込みしてもう一度お試しください。", "Esta tarea programada no se puede cambiar así. Vuelva a cargar la página e inténtelo de nuevo."),
  turnInProgress: t('이 채팅에서 답변이 아직 진행 중이에요. 끝나거나 중지한 뒤 보내 주세요.', 'An answer is still in progress in this chat. Wait for it or stop it first.', 'Jawaban di chat ini masih berjalan. Tunggu atau hentikan dulu.', "このチャットではまだ回答中です。完了を待つか、先に停止してください。", "Aún hay una respuesta en curso en este chat. Espere a que termine o deténgala primero."),
  attachmentsTeamUnavailable: t('추가한 팀 파일 중 더 이상 열 수 없는 파일이 있어요. 그 파일을 빼고 보내려면 다시 보내기를 눌러 주세요.', 'A team file you added is no longer available to you. Send again to send the message without it.', 'Ada berkas tim yang Anda tambahkan yang tidak lagi tersedia untuk Anda. Kirim ulang untuk mengirim pesan tanpa berkas itu.', "追加したチームのファイルが利用できなくなりました。再送信すると、そのファイルなしで送信します。", "Un archivo del equipo que añadió ya no está disponible. Vuelva a enviar para mandar el mensaje sin él."),
  attachmentsUnavailable: t('첨부 파일을 찾을 수 없어요. 다시 올려 주세요.', 'The attachments could not be found. Please upload them again.', 'Lampiran tidak ditemukan. Unggah ulang.', "添付ファイルが見つかりませんでした。再度アップロードしてください。", "No se encontraron los archivos adjuntos. Vuelva a subirlos."),
  requestClosed: t('이미 답했거나 시간이 지난 질문이에요.', 'This question was already answered or has expired.', 'Pertanyaan ini sudah dijawab atau kedaluwarsa.', "この質問は回答済みか、期限切れです。", "Esta pregunta ya se respondió o venció."),
  answerNotOption: t('이 확인은 카드의 버튼으로만 답할 수 있어요.', 'This check takes only the buttons on its card.', 'Pemeriksaan ini hanya bisa dijawab dengan tombol di kartunya.', "この確認にはカードのボタンでのみ答えられます。", "Esta comprobación solo se responde con los botones de su tarjeta."),
  notUserMessage: t('사용자 메시지만 수정할 수 있어요.', 'Only your own messages can be edited.', 'Hanya pesan Anda yang bisa diubah.', "編集できるのは自分のメッセージのみです。", "Solo puede editar sus propios mensajes."),
  notAssistantMessage: t('AI 답변만 다시 생성할 수 있어요.', 'Only AI answers can be regenerated.', 'Hanya jawaban AI yang bisa dibuat ulang.', "再生成できるのはAIの回答のみです。", "Solo se pueden volver a generar respuestas de IA."),
  badParent: t('이어 쓸 메시지를 찾을 수 없어요.', 'The message to continue from was not found.', 'Pesan yang mau dilanjutkan tidak ditemukan.', "続行元のメッセージが見つかりませんでした。", "No se encontró el mensaje desde el que continuar."),
  projectFolderFile: t('프로젝트 폴더 자리에 파일이 있어요.', 'A file is in the way of the project folder.', 'Ada berkas di lokasi folder proyek.', "プロジェクトフォルダーの場所にファイルが存在します。", "Un archivo ocupa la ubicación de la carpeta del proyecto."),
  projectCreatorOnly: t('프로젝트 이름·지침 수정과 삭제는 만든 사람과 관리자만 할 수 있어요.', 'Only the person who created the project and admins can rename it, change its instructions or delete it.', 'Hanya pembuat proyek dan admin yang bisa mengganti nama, instruksi, atau menghapusnya.', "名前変更、指示の変更、削除ができるのはプロジェクトの作成者と管理者のみです。", "Solo quien creó el proyecto y los administradores pueden cambiar su nombre, sus instrucciones o eliminarlo."),
  projectsAdminsOnly: t('이 팀에서는 관리자만 팀 프로젝트를 만들 수 있어요. 내 프로젝트로 만들어 주세요.', 'In this team only admins can make team projects. Make it a personal project instead.', 'Di tim ini hanya admin yang bisa membuat proyek tim. Buat sebagai proyek pribadi.', "このチームではチームプロジェクトを作成できるのは管理者のみです。個人プロジェクトとして作成してください。", "En este equipo solo los administradores pueden crear proyectos del equipo. Créelo como proyecto personal."),
  projectLocation: t('팀 프로젝트는 프로젝트 폴더 안에, 내 프로젝트는 내 폴더의 projects 안에만 만들 수 있어요.', 'A team project lives only in the Projects folder, a personal project only in projects inside My folder.', 'Proyek tim hanya ada di folder Proyek, proyek pribadi hanya di projects dalam Folder saya.', "チームプロジェクトはプロジェクトフォルダー内、個人プロジェクトは自分のフォルダーのprojects内にのみ作成できます。", "Un proyecto del equipo solo puede estar en la carpeta Proyectos, y uno personal solo en projects dentro de Mi carpeta."),
  projectParticipantGroup: t('내가 속한 부서만 고를 수 있어요.', 'You can only choose groups you are in.', 'Anda hanya bisa memilih grup tempat Anda bergabung.', "選べるのは自分が所属するグループだけです。", "Solo puede elegir los grupos a los que pertenece."),
  projectParticipantPerson: t('지금 활동 중인 팀원만 고를 수 있어요.', 'You can only choose active members of the team.', 'Anda hanya bisa memilih anggota tim yang aktif.', "選べるのは現在有効なチームメンバーだけです。", "Solo puede elegir miembros activos del equipo."),
  projectParticipantFixed: t('이 사람이나 부서는 관리자 › 폴더 권한에서 따로 정해져 있어 여기서 바꿀 수 없어요.', 'This person or group is set separately in Admin › Folder permissions and cannot be changed here.', 'Orang atau grup ini diatur terpisah di Admin › Izin folder dan tidak bisa diubah di sini.', "この人またはグループは管理 › フォルダー権限で個別に設定されているため、ここでは変更できません。", "Esta persona o grupo se configura aparte en Administración › Permisos de carpetas y no se puede cambiar aquí."),
  projectAccessNotEditable: t('이 프로젝트를 볼 수 있는 사람은 관리자 › 폴더 권한에서 바꿔요.', 'Who sees this project is changed in Admin › Folder permissions.', 'Siapa yang melihat proyek ini diubah di Admin › Izin folder.', "このプロジェクトを見られる人は、管理 › フォルダー権限で変更します。", "Quién ve este proyecto se cambia en Administración › Permisos de carpetas."),
  projectAccessChanged: t('그사이 누군가 이 프로젝트를 볼 수 있는 사람을 바꿨어요. 바뀐 내용을 확인한 뒤 다시 저장해 주세요.', 'Someone changed who sees this project in the meantime. Check the change, then save again.', 'Seseorang mengubah siapa yang melihat proyek ini sementara itu. Periksa perubahannya, lalu simpan lagi.', "その間に誰かがこのプロジェクトを見られる人を変更しました。変更内容を確認してから、もう一度保存してください。", "Alguien cambió mientras tanto quién ve este proyecto. Revise el cambio y vuelva a guardar."),
  projectAccessWidened: t('{by}님이 "{name}" 프로젝트를 볼 수 있는 사람을 {n}명 늘렸어요.', '{by} let {n} more people see the project "{name}".', '{by} menambah {n} orang yang dapat melihat proyek "{name}".', "{by}さんがプロジェクト「{name}」を見られる人を{n}人増やしました。", "{by} permitió que {n} personas más vean el proyecto «{name}»."),
  projectRepointPlace: t('폴더가 휴지통에 있거나 없어진 프로젝트만, 프로젝트 폴더 안에 있는 폴더로 다시 이을 수 있어요.', 'Only a project whose folder is in the trash or missing can be pointed again, at an existing folder in Projects.', 'Hanya proyek yang foldernya ada di Sampah atau hilang yang bisa diarahkan lagi, ke folder yang ada di Proyek.', "フォルダーがゴミ箱にあるか見つからないプロジェクトだけを、プロジェクトフォルダー内にある既存のフォルダーに付け直せます。", "Solo un proyecto cuya carpeta está en la papelera o falta puede volver a apuntar a una carpeta existente en Proyectos."),
  projectTrashFolderNot: t('이 프로젝트의 폴더는 함께 휴지통으로 옮길 수 없어요. 파일에서 관리자가 옮길 수 있어요.', 'This project\'s folder cannot go to the trash with it. An admin can move it in Files.', 'Folder proyek ini tidak bisa ikut dipindah ke Sampah. Admin dapat memindahkannya di Berkas.', "このプロジェクトのフォルダーは一緒にゴミ箱へ移せません。管理者がファイルで移動できます。", "La carpeta de este proyecto no puede ir a la papelera con él. Un administrador puede moverla en Archivos."),
  projectFolderAdminOnly: t('프로젝트 폴더를 바꾸는 것은 관리자만 할 수 있어요.', 'Only admins can change the folder of a project.', 'Hanya admin yang bisa mengganti folder proyek.', "プロジェクトのフォルダーを変更できるのは管理者のみです。", "Solo los administradores pueden cambiar la carpeta de un proyecto."),
  projectInstructionsChanged: t("'{name}' 프로젝트 지침을 {by} 님이 바꿨어요.", "{by} changed the instructions of the project '{name}'.", "{by} mengubah instruksi proyek '{name}'.", "{by}がプロジェクト'{name}'の指示を変更しました。", "{by} cambió las instrucciones del proyecto '{name}'."),
  projectFolderTaken: t('그 이름의 폴더 권한 기록이 남아 있어 쓸 수 없어요. 다른 이름을 골라 주세요.', 'Access rules are still kept for a folder of that name. Pick another name.', 'Aturan akses masih tersimpan untuk folder bernama itu. Pilih nama lain.', "同名フォルダーのアクセスルールが残っています。別の名前を選んでください。", "Aún se conservan reglas de acceso para una carpeta con ese nombre. Elija otro."),
  projectShareNotPersonal: t('팀 폴더로 복사해 공유하는 것은 내 프로젝트만 할 수 있어요.', 'Only a personal project can be shared by copying it to a team folder.', 'Hanya proyek pribadi yang bisa dibagikan dengan menyalinnya ke folder tim.', "チームフォルダーへのコピーで共有できるのは個人プロジェクトのみです。", "Solo un proyecto personal se puede compartir copiándolo a una carpeta del equipo."),
  projectFolderNoWrite: t('이 폴더에 쓰기 권한이 없어요.', 'You cannot write to this folder.', 'Anda tidak bisa menulis ke folder ini.', "このフォルダーには書き込めません。", "No puede escribir en esta carpeta."),
  // one project per folder (docs/DECISIONS.md "Projects: a folder with instructions")
  projectFolderHasProject: t("이 폴더는 이미 '{name}' 프로젝트예요. 그 프로젝트를 열어 쓰거나 다른 폴더를 골라 주세요.", "This folder is already the project '{name}'. Open that project, or pick another folder.", "Folder ini sudah menjadi proyek '{name}'. Buka proyek itu, atau pilih folder lain.", "このフォルダーはすでにプロジェクト'{name}'です。そのプロジェクトを開くか、別のフォルダーを選んでください。", "Esta carpeta ya es el proyecto '{name}'. Abra ese proyecto o elija otra carpeta."),
  projectFolderHasOtherProject: t('이 폴더는 이미 다른 프로젝트가 쓰고 있어요. 다른 폴더를 골라 주세요.', 'Another project already uses this folder. Pick another folder.', 'Proyek lain sudah memakai folder ini. Pilih folder lain.', "このフォルダーはすでに別のプロジェクトが使っています。別のフォルダーを選んでください。", "Otro proyecto ya usa esta carpeta. Elija otra carpeta."),
  // a project whose folder is in the trash: no chat is made or moved into it, and it is pointed only at a folder that is there
  projectInTrash: t('이 프로젝트의 폴더가 휴지통에 있어요. 폴더를 되돌리거나 프로젝트에 다른 폴더를 고른 뒤에 채팅을 넣어 주세요.', "This project's folder is in the trash. Restore the folder, or choose another folder for the project, before you put a chat in it.", 'Folder proyek ini ada di Sampah. Pulihkan foldernya, atau pilih folder lain untuk proyek ini, sebelum memasukkan chat ke dalamnya.', "このプロジェクトのフォルダーはゴミ箱にあります。チャットを入れる前に、フォルダーを元に戻すか、プロジェクトに別のフォルダーを選んでください。", "La carpeta de este proyecto está en la papelera. Restaure la carpeta o elija otra para el proyecto antes de poner un chat en él."),
  projectFolderMissing: t('그 폴더가 없어요. 휴지통에 있는 프로젝트는 지금 있는 폴더만 고를 수 있어요. 폴더를 먼저 되돌리거나 만들어 주세요.', 'That folder is not there. A project whose folder is in the trash can only be pointed at a folder that exists. Restore or make the folder first.', 'Folder itu tidak ada. Proyek yang foldernya ada di Sampah hanya bisa diarahkan ke folder yang ada. Pulihkan atau buat foldernya dulu.', "そのフォルダーはありません。フォルダーがゴミ箱にあるプロジェクトは、存在するフォルダーにしか向けられません。先にフォルダーを元に戻すか作成してください。", "Esa carpeta no existe. Un proyecto cuya carpeta está en la papelera solo puede apuntar a una carpeta que exista. Restaure o cree la carpeta primero."),
  // a project makes its folder admin-only to move: only someone who could move it may add that lock
  engineChoiceNotAllowed: t('AI 엔진과 모델은 관리자가 정해요. 엔진을 고르지 말고 보내면 팀 기본 엔진으로 답해요.', 'Your admin chooses the AI engine and model. Send without picking one and the team default answers.', 'Mesin dan model AI ditentukan admin. Kirim tanpa memilih dan mesin bawaan tim yang menjawab.', "AIエンジンとモデルは管理者が選びます。選択せずに送信すると、チームの既定で回答します。", "Su administrador elige el motor y modelo de IA. Envíe sin elegir ninguno para recibir una respuesta con el predeterminado del equipo."),
  engineOff: t('관리자가 이 AI 엔진을 꺼 두었어요. 다른 엔진을 골라 주세요.', 'Your admin switched this AI engine off. Pick another one.', 'Admin mematikan mesin AI ini. Pilih yang lain.', "管理者がこのAIエンジンを無効にしました。別のものを選んでください。", "Su administrador desactivó este motor de IA. Elija otro."),
  browserUnavailable: t('데스크톱 앱 창이 연결되어 있지 않아요.', 'The desktop app window is not connected.', 'Jendela aplikasi desktop tidak terhubung.', "デスクトップアプリのウィンドウが接続されていません。", "La ventana de la aplicación de escritorio no está conectada."),
  // a connect_service card (chat/connect-service.ts, POST /api/turns/:id/connect)
  connectClosed: t('이미 끝났거나 시간이 지난 연결 카드예요.', 'This connection card was already finished or has expired.', 'Kartu koneksi ini sudah selesai atau kedaluwarsa.', "この接続カードは完了済みか、期限切れです。", "Esta tarjeta de conexión ya se completó o venció."),
  connectBusy: t('이 카드로 지금 연결하는 중이에요. 잠시 기다려 주세요.', 'This card is connecting right now. Wait a moment.', 'Kartu ini sedang menghubungkan. Tunggu sebentar.', "このカードで接続中です。しばらくお待ちください。", "Esta tarjeta se está conectando. Espere un momento."),
  connectNeedsKey: t('먼저 카드에 키를 붙여 넣어 주세요.', 'Paste the key into the card first.', 'Tempel kuncinya di kartu terlebih dahulu.', "先にカードにキーを貼り付けてください。", "Pegue primero la clave en la tarjeta."),
  connectTeamAdmin: t('팀 연결은 관리자만 추가할 수 있어요.', 'Only an admin can add a team connection.', 'Hanya admin yang bisa menambahkan koneksi tim.', "チームの接続を追加できるのは管理者のみです。", "Solo un administrador puede añadir una conexión del equipo."),
  connectNotYet: t('아직 연결되지 않았어요. 로그인을 먼저 마쳐 주세요.', 'Not connected yet. Finish signing in first.', 'Belum terhubung. Selesaikan masuk terlebih dahulu.', "まだ接続されていません。先にサインインを完了してください。", "Aún no está conectado. Termine primero de iniciar sesión."),
  connectKeyTooLong: t('키가 너무 길어요(최대 {n}자). 서비스에서 받은 키만 붙여 넣어 주세요.', 'The key is too long (at most {n} characters). Paste only the key the service gave you.', 'Kuncinya terlalu panjang (paling banyak {n} karakter). Tempel hanya kunci dari layanan.', "キーが長すぎます（最大{n}文字）。サービスから受け取ったキーだけを貼り付けてください。", "La clave es demasiado larga (como máximo {n} caracteres). Pegue solo la clave que le dio el servicio."),
  connectNotStarted: t('이 카드로 아직 연결하지 않았어요. 카드의 버튼으로 먼저 연결해 주세요.', 'Nothing was connected from this card yet. Use its button to connect first.', 'Belum ada yang dihubungkan dari kartu ini. Gunakan tombolnya untuk menghubungkan dulu.', "このカードからはまだ何も接続していません。先にカードのボタンで接続してください。", "Todavía no se conectó nada desde esta tarjeta. Use primero su botón para conectar."),
  connectChanged: t('카드가 나온 뒤 설정에서 이 연결이 바뀌었거나 삭제됐어요. 아무것도 보내지 않았어요. AI에게 다시 연결해 달라고 해 주세요.', 'This connection was changed or removed in Settings after the card was shown. Nothing was sent. Ask the AI to connect it again.', 'Koneksi ini diubah atau dihapus di Pengaturan setelah kartu ditampilkan. Tidak ada yang dikirim. Minta AI menghubungkannya lagi.', "カードの表示後に、設定でこの接続が変更または削除されました。何も送信していません。AIにもう一度接続を頼んでください。", "Esta conexión se cambió o se eliminó en Configuración después de mostrarse la tarjeta. No se envió nada. Pida a la IA que la conecte de nuevo."),
  connectHidden: t('카드의 이름이나 메모에 보이지 않는 문자가 있어요. AI에게 다시 연결해 달라고 해 주세요.', 'The card\'s name or notes hold characters that cannot be seen. Ask the AI to connect it again.', 'Nama atau catatan kartu berisi karakter yang tidak terlihat. Minta AI menghubungkannya lagi.', "カードの名前またはメモに見えない文字が含まれています。AIにもう一度接続を頼んでください。", "El nombre o las notas de la tarjeta contienen caracteres que no se ven. Pida a la IA que lo conecte de nuevo."),

  // answer errors (message.error)
  errAuth: CHAT_ERROR_MESSAGES.auth,
  errRateLimit: CHAT_ERROR_MESSAGES.rate_limit,
  errContext: CHAT_ERROR_MESSAGES.context,
  errTimeout: CHAT_ERROR_MESSAGES.timeout,
  errWallTimeout: CHAT_ERROR_MESSAGES.wall_timeout,
  errRefused: CHAT_ERROR_MESSAGES.refused,
  errCrash: CHAT_ERROR_MESSAGES.crash,
  errInterrupted: CHAT_ERROR_MESSAGES.interrupted,
  errEngineMissing: CHAT_ERROR_MESSAGES.engine_missing,
  errProxyDown: CHAT_ERROR_MESSAGES.proxy_down,
  errBudget: t('AI 사용 한도를 다 썼어요. 더 필요하면 관리자에게 말해 주세요.', 'The AI usage limit is used up. Ask an admin if you need more.', 'Batas penggunaan AI sudah habis. Minta admin jika perlu lebih.', "AIの使用量上限を使い切りました。追加が必要な場合は管理者にご相談ください。", "Se agotó el límite de uso de IA. Consulte a un administrador si necesita más."),
  errUserDisabled: CHAT_ERROR_MESSAGES.user_disabled,
  errNoCredential: CHAT_ERROR_MESSAGES.no_credential,
  // the Linux launcher stopped the turn at its limits (linux-runtime 3.3.7: the turn's memory, the chat folder's size)
  errTurnMemory: t('이 답변이 한 답변에 쓸 수 있는 메모리를 넘어 멈췄어요. 질문을 나누거나, 큰 파일은 한 번에 하나씩 다뤄 달라고 해 보세요.', 'This answer stopped because it needed more memory than one answer may use. Try splitting the question, or ask for big files one at a time.', 'Jawaban ini berhenti karena butuh memori lebih dari yang boleh dipakai satu jawaban. Coba pecah pertanyaannya, atau minta berkas besar diproses satu per satu.', "1つの回答で使えるメモリを超えたため停止しました。質問を分けるか、大きなファイルは1つずつ依頼してください。", "La respuesta se detuvo porque necesitaba más memoria de la permitida por respuesta. Divida la pregunta o solicite los archivos grandes de uno en uno."),
  errTurnMemoryPlan: t('이 답변이 팀 요금제에서 한 답변에 쓸 수 있는 메모리(약 {mb} MB)를 넘어 멈췄어요. 질문을 나누거나, 큰 파일은 한 번에 하나씩 다뤄 달라고 해 보세요.', 'This answer stopped because it needed more memory than one answer may use on this team\'s plan (about {mb} MB). Try splitting the question, or ask for big files one at a time.', 'Jawaban ini berhenti karena butuh memori lebih dari yang boleh dipakai satu jawaban di paket tim ini (sekitar {mb} MB). Coba pecah pertanyaannya, atau minta berkas besar diproses satu per satu.', "このチームのプランで1つの回答に使えるメモリ（約{mb} MB）を超えたため停止しました。質問を分けるか、大きなファイルは1つずつ依頼してください。", "La respuesta se detuvo porque necesitaba más memoria de la permitida por respuesta en el plan del equipo (unos {mb} MB). Divida la pregunta o solicite los archivos grandes de uno en uno."),
  errTurnDisk: t('이 답변이 만든 작업 파일이 한 답변에 저장할 수 있는 크기를 넘어 멈췄어요. 작업 공간은 비웠어요. 결과를 작게 나눠 만들어 달라고 해 보세요.', 'This answer stopped because the working files it made grew past what one answer may store. Its workspace was emptied. Try asking for the result in smaller parts.', 'Jawaban ini berhenti karena berkas kerja yang dibuatnya melebihi batas penyimpanan satu jawaban. Ruang kerjanya sudah dikosongkan. Coba minta hasilnya dalam bagian yang lebih kecil.', "作成した作業ファイルが1つの回答で保存できる量を超えたため停止しました。作業領域は空にしました。結果を小さく分けて依頼してください。", "La respuesta se detuvo porque sus archivos de trabajo superaron lo permitido por respuesta. Se vació el espacio de trabajo. Solicite el resultado en partes más pequeñas."),
  errTurnDiskPlan: t('이 답변이 만든 작업 파일이 한 답변에 저장할 수 있는 크기({mb} MB)를 넘어 멈췄어요. 작업 공간은 비웠어요. 결과를 작게 나눠 만들어 달라고 해 보세요.', 'This answer stopped because the working files it made grew past what one answer may store ({mb} MB). Its workspace was emptied. Try asking for the result in smaller parts.', 'Jawaban ini berhenti karena berkas kerja yang dibuatnya melebihi batas penyimpanan satu jawaban ({mb} MB). Ruang kerjanya sudah dikosongkan. Coba minta hasilnya dalam bagian yang lebih kecil.', "作成した作業ファイルが1つの回答で保存できる量（{mb} MB）を超えたため停止しました。作業領域は空にしました。結果を小さく分けて依頼してください。", "La respuesta se detuvo porque sus archivos de trabajo superaron lo permitido por respuesta ({mb} MB). Se vació el espacio de trabajo. Solicite el resultado en partes más pequeñas."),
  errCredentialUnusable: CHAT_ERROR_MESSAGES.credential_unusable,
  errCredentialLimit: t('이 AI 연결의 이번 달 한도를 다 썼어요. 더 필요하면 관리자에게 말해 주세요.', 'This month\'s limit of the AI connection is used up. Ask an admin if you need more.', 'Batas bulan ini untuk koneksi AI sudah habis. Minta admin jika perlu lebih.', "AI接続の今月の上限を使い切りました。追加が必要な場合は管理者にご相談ください。", "Se agotó el límite mensual de la conexión de IA. Consulte a un administrador si necesita más."),

  // steps
  refusedRetry: STEP_TEXT.refusedRetry,
  demoReplay: STEP_TEXT.demoReplay,
  engineOffDefault: STEP_TEXT.engineOffDefault,
  engineNoConnection: STEP_TEXT.engineNoConnection,
  limitFallback: STEP_TEXT.limitFallback,
  credentialSwitchLimit: STEP_TEXT.credentialSwitchLimit,
  credentialSwitchInvalid: STEP_TEXT.credentialSwitchInvalid,
  attachChanged: STEP_TEXT.attachChanged,
  attachMoved: STEP_TEXT.attachMoved,
  attachUnavailable: STEP_TEXT.attachUnavailable,
  subtask: STEP_TEXT.subtask,
  // make_file .hwpx or edit_hwp while the HWP plugin is off (tools/hwp-writing.ts): the AI passes it on
  hwpWritingOff: t('한글 문서(HWP·HWPX)를 만들거나 채우려면 한글 문서 플러그인이 있어야 해요. 관리자가 관리 > 플러그인에서 "한글 문서 미리보기"를 설치하고 켜면 쓸 수 있어요. 아무것도 저장하지 않았어요.',
    'Making or filling Hangul documents (HWP, HWPX) needs the HWP plugin. An admin can install and turn on "HWP Preview" in Admin > Plugins. Nothing was saved.',
    'Membuat atau mengisi dokumen Hangul (HWP, HWPX) memerlukan plugin HWP. Admin dapat memasang dan mengaktifkan "Pratinjau HWP" di Admin > Plugin. Tidak ada yang disimpan.',
    'ハングル文書（HWP・HWPX）の作成や記入には HWP プラグインが必要です。管理者が 管理 > プラグイン で「HWPプレビュー」をインストールしてオンにすると使えます。何も保存していません。',
    'Crear o rellenar documentos Hangul (HWP, HWPX) requiere el complemento de HWP. Un administrador puede instalar y activar «Vista previa de HWP» en Administración > Complementos. No se guardó nada.'),
  memoryEmpty: t('기억할 내용을 적어 주세요.', 'Write what the AI should remember.', 'Tulis apa yang harus diingat AI.', "AIに覚えてほしい内容を入力してください。", "Escriba lo que la IA debe recordar."),
  memoryTooLong: t('메모리는 한 줄에 {max}자까지 쓸 수 있어요(지금 {n}자). 줄여 주세요.', 'A memory can be one line of up to {max} characters (this is {n}). Make it shorter.', 'Memori bisa berupa satu baris hingga {max} karakter (ini {n}). Persingkat.', "メモリーは1行{max}文字までです（現在{n}文字）。短くしてください。", "Una memoria puede ser una línea de hasta {max} caracteres (esta tiene {n}). Acórtela."),
  rememberConfirm: t('AI가 다음 내용을 기억하려고 해요. 기억할까요?\n\n{text}', 'The AI wants to remember this about you. OK?\n\n{text}', 'AI ingin mengingat hal ini tentang Anda. Boleh?\n\n{text}', "AIが自分について次の内容を記憶しようとしています。よろしいですか？\n\n{text}", "La IA quiere recordar esto sobre usted. ¿Está de acuerdo?\n\n{text}"),
  yes: t('기억하기', 'Remember', 'Ingat', "記憶", "Recordar"),
  no: t('기억하지 않기', 'Don’t remember', 'Jangan ingat', "記憶しない", "No recordar"),
  remembered: STEP_TEXT.remembered,
  notRemembered: STEP_TEXT.notRemembered,
  forgot: STEP_TEXT.forgot,
  asked: STEP_TEXT.asked,
  notAnswered: STEP_TEXT.notAnswered,
  connectConnected: STEP_TEXT.connectConnected,
  connectNotConnected: STEP_TEXT.connectNotConnected,
  browserSite: t('사내망 주소 {host}를 열어도 될까요?', 'May the AI open the office-network address {host}?', 'Bolehkan AI membuka alamat jaringan kantor {host}?', "AIが社内ネットワークのアドレス{host}を開いてもよろしいですか？", "¿Puede la IA abrir la dirección de red interna {host}?"),
  widenConfirm: t('AI가 볼 수 있는 사람이 더 적은 내용({sources})을 읽은 뒤 {target}에 저장하려고 해요. 이곳은 {n}명이 볼 수 있어요. 저장할까요?',
    'The AI read content fewer people can see ({sources}) and now wants to save to {target}, which {n, plural, one {# person} other {# people}} can see. Save it?',
    'AI membaca konten yang hanya bisa dilihat lebih sedikit orang ({sources}) dan sekarang ingin menyimpan ke {target}, yang bisa dilihat {n} orang. Simpan?', "AIは閲覧できる人が少ない内容（{sources}）を読み取り、{n}人が閲覧できる{target}に保存しようとしています。保存しますか？", "La IA leyó contenido que menos personas pueden ver ({sources}) y quiere guardarlo en {target}, visible para {n, plural, one {# persona} other {# personas}}. ¿Guardarlo?"),
  widenSave: t('저장하기', 'Save', 'Simpan', "保存", "Guardar"),
  widenDont: t('저장하지 않기', 'Don’t save', 'Jangan simpan', "保存しない", "No guardar"),
  scopeMine: t('내 개인 폴더나 앱 안 브라우저', 'your personal folder or the in-app browser', 'folder pribadi Anda atau browser di aplikasi', "自分の個人フォルダーまたはアプリ内ブラウザー", "su carpeta personal o el navegador integrado"),
  scopeRoot: t('팀 폴더 맨 위', 'the top of the team folder', 'bagian atas folder tim', "チームフォルダーの最上位", "la raíz de la carpeta del equipo"),
  scopeRoom: t("대화방 '{name}'의 메시지", "messages of the room '{name}'", "pesan di ruang '{name}'", "トークルーム「{name}」のメッセージ", "mensajes de la sala «{name}»"),
  roomAiBusy: t('트리나가 아직 내 질문에 답하고 있어요. 끝나거나 멈춘 뒤 다시 물어봐 주세요.', 'The AI is still answering your question. Ask again when it is done or stopped.', 'AI masih menjawab pertanyaan Anda. Tanyakan lagi setelah selesai atau dihentikan.', "AIはまだあなたの質問に回答中です。終わるか止めてから、もう一度聞いてください。", "La IA aún está respondiendo su pregunta. Vuelva a preguntar cuando termine o la detenga."),
  roomAiSafeOps: t('이 서버는 안전 작업 모드라서 대화방에서는 트리나를 부를 수 없어요. AI 채팅에서 물어봐 주세요.', 'This server runs in safe operations mode, so the AI cannot be asked in a room. Ask it in an AI chat instead.', 'Server ini berjalan dalam mode operasi aman, jadi AI tidak bisa ditanya di ruang obrolan. Tanyakan di chat AI.', "このサーバーは安全作業モードのため、トークルームではAIを呼べません。AIチャットで聞いてください。", "Este servidor funciona en modo de operaciones seguras, así que no se puede preguntar a la IA en una sala. Pregunte en un chat de IA."),
  roomMentionAll: t('전체 대화방에서는 소유자와 관리자만 @전체를 쓸 수 있어요.', 'In the everyone room, only owners and admins can use @everyone.', 'Di ruang Semua, hanya pemilik dan admin yang bisa memakai @semua.', "全員のトークルームで@全員を使えるのはオーナーと管理者だけです。", "En la sala Todos, solo los propietarios y administradores pueden usar @todos."),
  roomAiLeft: t('이제 이 대화방에 없어서 답을 올리지 않았어요.', 'You are no longer in this room, so the answer was not posted.', 'Anda tidak lagi berada di ruang ini, jadi jawabannya tidak dikirim.', "このトークルームにいないため、回答は投稿されませんでした。", "Ya no está en esta sala, así que la respuesta no se publicó."),
  roomGroupLimit: t('새 그룹 대화는 한 시간에 {n}개까지 만들 수 있어요. {minutes}분 뒤에 다시 만들어 주세요.', 'You can make up to {n} new group chats an hour. Try again in {minutes} min.', 'Anda bisa membuat hingga {n} obrolan grup baru per jam. Coba lagi dalam {minutes} menit.', "新しいグループトークは1時間に{n}件まで作成できます。{minutes}分後にもう一度お試しください。", "Puede crear hasta {n} chats de grupo nuevos por hora. Inténtelo de nuevo en {minutes} min."),
  roomAiConfirm: t('{ai}가 이 작업을 하려고 해요: {what}. 바뀐 파일은 기록에서 되돌릴 수 있어요.', '{ai} wants to do this: {what}. Changed files can be restored from their history.', '{ai} ingin melakukan ini: {what}. Berkas yang diubah bisa dipulihkan dari riwayatnya.', "{ai}がこの操作をしようとしています：{what}。変更したファイルは履歴から元に戻せます。", "{ai} quiere hacer esto: {what}. Los archivos cambiados se pueden restaurar desde su historial."),
  /** a room's change card for a new file ({folder}: where, {file}: its name) and for a file this answer made */
  roomAiConfirmNew: t('{ai}가 {folder}에 새 파일을 저장하려고 해요: {file}. 바뀐 파일은 기록에서 되돌릴 수 있어요.', '{ai} wants to save a new file in {folder}: {file}. Changed files can be restored from their history.', '{ai} ingin menyimpan berkas baru di {folder}: {file}. Berkas yang diubah bisa dipulihkan dari riwayatnya.', "{ai}が{folder}に新しいファイルを保存しようとしています：{file}。変更したファイルは履歴から元に戻せます。", "{ai} quiere guardar un archivo nuevo en {folder}: {file}. Los archivos cambiados se pueden restaurar desde su historial."),
  roomAiConfirmMade: t('{ai}가 이번 답에서 만든 파일을 고치려고 해요: {folder}/{file}. 바뀐 파일은 기록에서 되돌릴 수 있어요.', '{ai} wants to change a file it made in this answer: {folder}/{file}. Changed files can be restored from their history.', '{ai} ingin mengubah berkas yang dibuatnya di jawaban ini: {folder}/{file}. Berkas yang diubah bisa dipulihkan dari riwayatnya.', "{ai}がこの回答で作ったファイルを変更しようとしています：{folder}/{file}。変更したファイルは履歴から元に戻せます。", "{ai} quiere cambiar un archivo que creó en esta respuesta: {folder}/{file}. Los archivos cambiados se pueden restaurar desde su historial."),
  roomPhotoUnreadable: t('이 사진은 읽을 수 없어서 보내지 못했어요. 다른 사진이나 다른 형식으로 보내 주세요.', 'This photo could not be read, so it was not sent. Send another photo or another format.', 'Foto ini tidak bisa dibaca, jadi tidak terkirim. Kirim foto lain atau format lain.', "この写真を読み込めなかったため、送信しませんでした。別の写真か別の形式で送ってください。", "No se pudo leer esta foto, así que no se envió. Envíe otra foto u otro formato."),
  roomAiAskAgain: t('이 답은 무엇을 참고했는지 다시 확인할 수 없어서 올리지 않았어요. 같은 질문을 다시 해 주세요.', 'This answer was not posted: what it used can no longer be checked. Please ask the question again.', 'Jawaban ini tidak dikirim: apa yang dipakainya tidak bisa diperiksa lagi. Silakan ajukan pertanyaan itu lagi.', "この回答は投稿しませんでした。何を参照したかをもう確認できません。同じ質問をもう一度してください。", "Esta respuesta no se publicó: ya no se puede comprobar qué usó. Vuelva a hacer la pregunta."),
  roomAiHiddenPost: t('가려진 예전 답을 참고해서 방에 올릴 수 없어요.', "It used an earlier answer that's hidden from some people here, so it can't be posted.", 'Memakai jawaban sebelumnya yang disembunyikan dari sebagian orang di sini, jadi tidak bisa dikirim.', "一部の人に非表示の以前の回答を参照したため、ルームに投稿できません。", "Usó una respuesta anterior oculta para algunas personas de aquí, así que no se puede publicar."),
  roomsSeenConfirm: t('여기에 대화방 메시지(다른 사람이 쓴 글)가 들어와서, 무언가를 바꾸기 전에 먼저 물어봐요. {ai}가 이 작업을 하려고 해요: {what}. 하게 할까요?', 'Messages from your conversations (other people\'s words) came in here, so changes are asked first. {ai} wants to do this: {what}. Allow it?', 'Chat ini berisi pesan dari ruang obrolan Anda (tulisan orang lain), jadi perubahan ditanyakan dulu. {ai} ingin melakukan ini: {what}. Izinkan?', "このチャットにはトークルームのメッセージ（ほかの人が書いたもの）が含まれているため、変更の前に確認します。{ai}がこの操作をしようとしています：{what}。許可しますか？", "Este chat contiene mensajes de sus salas de chat (palabras de otras personas), así que los cambios se consultan antes. {ai} quiere hacer esto: {what}. ¿Lo permite?"),
  /** the person's own chat after a room read, in front of the wider-audience card that also asks for the change */
  roomsSeenWhy: t('여기에 대화방 메시지(다른 사람이 쓴 글)가 들어와서, 무언가를 바꾸기 전에 먼저 물어봐요.', 'Messages from your conversations (other people\'s words) came in here, so changes are asked first.', 'Chat ini berisi pesan dari ruang obrolan Anda (tulisan orang lain), jadi perubahan ditanyakan dulu.', "このチャットにはトークルームのメッセージ（ほかの人が書いたもの）が含まれているため、変更の前に確認します。", "Este chat contiene mensajes de sus salas de chat (palabras de otras personas), así que los cambios se consultan antes."),
  /** the AI on a card where the product is named after it (PRODUCT_NAMED_AFTER_AI), and elsewhere */
  aiOwnName: t('트리나', 'Trina', 'Trina', "トリナ", "Trina"),
  aiPlainName: t('AI', 'The AI', 'AI', "AI", "La IA"),
  roomAiConfirmInstruction: t('AI가 따르는 지시 파일이에요. 내용을 끝까지 확인해 주세요.', 'This is an instruction file the AI follows. Read all of its content.', 'Ini file instruksi yang diikuti AI. Baca seluruh isinya.', "AIが従う指示ファイルです。内容を最後まで確認してください。", "Es un archivo de instrucciones que sigue la IA. Revise todo su contenido."),
  roomAiConfirmYes: t('이번만 허용', 'Allow once', 'Izinkan sekali', "今回だけ許可", "Permitir esta vez"),
  roomAiConfirmNo: t('허용 안 함', "Don't allow", 'Jangan izinkan', "許可しない", "No permitir"),
  roomAiConfirmAlways: t('이 방에서는 항상 허용', 'Always allow in this room', 'Selalu izinkan di ruang ini', "このルームでは常に許可", "Permitir siempre en esta sala"),
  /** under the three buttons: what "always" covers */
  roomAiConfirmNote: t('내가 부를 때, 이 폴더에 새 파일을 만들 때만 적용돼요.', 'Applies only when you call it, to new files in this folder.', 'Berlaku hanya saat Anda memanggilnya, untuk berkas baru di folder ini.', "自分が呼んだとき、このフォルダーに新しいファイルを作る場合だけです。", "Solo se aplica cuando usted la llama, a archivos nuevos en esta carpeta."),
  /** the step of a call a room grant let through, after its own words */
  roomGrantStep: t('항상 허용으로 진행', 'allowed: always in this room', 'diizinkan: selalu di ruang ini', "常に許可で実行", "permitido: siempre en esta sala"),
  /** the step of a call this answer's [이번만 허용] for its folder let through */
  roomOnceStep: t('이번만 허용으로 진행', 'allowed once in this answer', 'diizinkan sekali di jawaban ini', "今回だけ許可で実行", "permitido esta vez en esta respuesta"),
  /** the step of a scheduled run's save or send that its task's card allowed (chat/schedule-cover.ts) */
  scheduleCoverStep: t('예약 작업에서 허용', 'allowed on the scheduled task', 'diizinkan di tugas terjadwal', "定期タスクで許可", "permitido en la tarea programada"),
  /** under a room answer: the files a grant or [이번만 허용] let the AI save without a card (links) */
  roomGrantFiles: t('미리 허용한 폴더에 저장한 파일: {files}', 'Saved in a folder allowed in advance: {files}', 'Disimpan di folder yang sudah diizinkan: {files}', "事前に許可したフォルダーに保存したファイル：{files}", "Guardado en una carpeta permitida de antemano: {files}"),
  roomAiConfirmFiles: t('바꿀 파일', 'Files', 'Berkas', "変更するファイル", "Archivos"),
  roomAiConfirmInput: t('바꿀 내용', 'What it would change', 'Yang akan diubah', "変更する内容", "Lo que cambiaría"),
  roomAiChangeAction: t('하는 일', 'Action', 'Tindakan', "操作", "Acción"),
  roomAiChangeFile: t('파일', 'File', 'Berkas', "ファイル", "Archivo"),
  roomAiChangeFolder: t('넣을 폴더', 'Into folder', 'Ke folder', "移動先のフォルダー", "A la carpeta"),
  roomAiChangeNewName: t('새 이름', 'New name', 'Nama baru', "新しい名前", "Nuevo nombre"),
  roomAiChangeSource: t('원본', 'From', 'Dari', "元のファイル", "Desde"),
  roomAiChangeTemplate: t('서식', 'Template', 'Templat', "テンプレート", "Plantilla"),
  roomAiChangeSaveAs: t('저장할 곳', 'Save as', 'Simpan sebagai', "保存先", "Guardar como"),
  roomAiChangeAddress: t('주소', 'Address', 'Alamat', "アドレス", "Dirección"),
  roomAiChangeCell: t('표 칸 고치기', 'A table cell', 'Sel tabel', "表のセル", "Una celda de tabla"),
  roomAiChangeNotShown: t('저장될 내용은 이 카드에 다 보이지 않아요. {from}에서 가져와요.', 'Not all of what it saves is on this card: it comes from {from}.', 'Tidak semua yang disimpan ada di kartu ini: isinya diambil dari {from}.', "保存される内容の一部はこのカードに表示されません。{from} から取り込みます。", "No todo lo que guarda aparece en esta tarjeta: viene de {from}."),
  roomAiChangeContent: t('내용', 'Content', 'Isi', "内容", "Contenido"),
  roomAiChangeNewText: t('바뀐 뒤', 'Becomes', 'Menjadi', "変更後", "Queda"),
  roomAiChangeEmpty: t('(빈 내용)', '(empty)', '(kosong)', "（空）", "(vacío)"),
  roomAiChangeCut: t('(모두 {n}자 중 앞부분)', '(the start of {n} characters)', '(awal dari {n} karakter)', "（全{n}文字のうち最初の部分）", "(el inicio de {n} caracteres)"),
  roomAiReasonsChanged: t('그 사이에 대화방 멤버나 권한이 바뀌었어요. 바뀐 이유를 확인하고 다시 올려 주세요.', 'The room\'s members or access changed in the meantime. Check the new reasons and post it again.', 'Anggota atau akses ruang berubah sementara itu. Periksa alasan barunya lalu kirim lagi.', "その間にルームのメンバーや権限が変わりました。新しい理由を確認して、もう一度投稿してください。", "Los miembros o el acceso de la sala cambiaron mientras tanto. Revise los nuevos motivos y publíquela de nuevo."),
  roomAiCut: t('(답이 길어서 여기까지만 올렸어요.)', '(The answer was long, so it was cut here.)', '(Jawabannya panjang, jadi dipotong di sini.)', "（回答が長いため、ここまでにしました。）", "(La respuesta era larga, así que se cortó aquí.)"),
  // "대화방에 보내기" (chat/answer-share.ts): an answer of my own AI chat sent to a room as my message
  /** the end of a shared answer that was too long for one room message; {history}: aiHistory, the sidebar's heading */
  answerShareCut: t('…(이하 생략) 전체는 내 {history}에서', '…(cut here) The whole answer is in my {history}.', '…(dipotong di sini) Jawaban lengkapnya ada di {history} saya.', "…（以下省略）全文は私の{history}にあります。", "…(cortado aquí) La respuesta completa está en mi {history}."),
  /** the person's AI chats, as the web app's sidebar names them (sidebar.aiChats); {name}: the AI's name there */
  aiHistory: t('{name} 기록', '{name} history', 'Riwayat {name}', "{name}の履歴", "Historial de {name}"),
  answerShareNotReady: t('끝난 답변만 대화방에 보낼 수 있어요. 답변이 끝난 뒤 다시 보내 주세요.', 'Only a finished answer can be sent to a room. Send it again once the answer is done.', 'Hanya jawaban yang sudah selesai yang bisa dikirim ke ruang obrolan. Kirim lagi setelah jawabannya selesai.', "トークルームに送れるのは完了した回答のみです。回答が終わってからもう一度送ってください。", "Solo se puede enviar a una sala una respuesta terminada. Vuelva a enviarla cuando la respuesta haya terminado."),
  answerShareHidden: t('방 사람 중 일부에게 가려진 예전 답이 이 답에 쓰여서 보낼 수 없어요.', 'This answer cannot be sent: it used an earlier answer that some people in this room cannot see.', 'Jawaban ini tidak bisa dikirim: jawaban ini memakai jawaban sebelumnya yang tidak bisa dilihat sebagian orang di ruang ini.', "この回答は送れません。このルームの一部の人には表示されない以前の回答を使っています。", "Esta respuesta no se puede enviar: usó una respuesta anterior que algunas personas de esta sala no pueden ver."),
  answerShareThreadRoot: t('이 메시지의 스레드에 보낼 수 없어요. 메시지가 지워졌을 수 있어요.', "This can't go to that message's thread. The message may have been deleted.", 'Ini tidak bisa dikirim ke utas pesan itu. Pesannya mungkin sudah dihapus.', 'そのメッセージのスレッドには送れません。メッセージが削除された可能性があります。', 'No se puede enviar al hilo de ese mensaje. Puede que el mensaje se haya eliminado.'),
  answerShareConfidential: t('보안 작업을 한 대화라 답변을 대화방에 보낼 수 없어요.', 'This is a confidential conversation, so its answers cannot be sent to a room.', 'Ini percakapan rahasia, jadi jawabannya tidak bisa dikirim ke ruang obrolan.', "機密扱いの会話なので、回答をトークルームに送れません。", "Esta es una conversación confidencial, así que sus respuestas no se pueden enviar a una sala."),
  // post_to_room's card (chat/post-to-room.ts): the room and its number of people, the lines that apply, the buttons
  postRoomAsk: t('{room}({n}명)에 보낼까요?', 'Send this to {room} ({n, plural, one {# person} other {# people}})?', 'Kirim ini ke {room} ({n} orang)?', '{room}（{n, plural, one {#人} other {#人}}）に送りますか？', '¿Enviar esto a {room} ({n, plural, one {# persona} other {# personas}})?'),
  postRoomAskThread: t("{room}({n}명)에서 '{quote}' 메시지의 스레드에 보낼까요?", "Send this to the thread of '{quote}' in {room} ({n, plural, one {# person} other {# people}})?", "Kirim ini ke utas pesan '{quote}' di {room} ({n} orang)?", '{room}（{n, plural, one {#人} other {#人}}）の「{quote}」のスレッドに送りますか？', '¿Enviar esto al hilo de «{quote}» en {room} ({n, plural, one {# persona} other {# personas}})?'),
  postRoomAskThreadNoQuote: t('{room}({n}명)의 메시지 스레드에 보낼까요?', 'Send this to a message\'s thread in {room} ({n, plural, one {# person} other {# people}})?', 'Kirim ini ke utas sebuah pesan di {room} ({n} orang)?', '{room}（{n, plural, one {#人} other {#人}}）のメッセージのスレッドに送りますか？', '¿Enviar esto al hilo de un mensaje en {room} ({n, plural, one {# persona} other {# personas}})?'),
  postRoomNote: t('내 이름으로 보일 한마디', 'Your note, shown under your name', 'Catatan Anda, tampil atas nama Anda', 'あなたの名前で表示されるひとこと', 'Tu nota, que aparece con tu nombre'),
  postRoomFilesToSend: t('[파일도 함께 보내기]로 첨부할 파일', 'Attached with “Send with the files”', 'Dilampirkan dengan “Kirim dengan berkasnya”', '「ファイルも一緒に送る」で添付', 'Se adjuntan con «Enviar con los archivos»'),
  postRoomText: t('보낼 내용', 'What will be sent', 'Yang akan dikirim', '送る内容', 'Lo que se enviará'),
  postRoomProvenance: t('{n}명은 이 내용의 일부 출처({places})를 볼 수 없어요.', "{n, plural, one {# person} other {# people}} there can't see some of the sources of this ({places}).", '{n} orang di sana tidak bisa melihat sebagian sumber isi ini ({places}).', '{n, plural, one {#人} other {#人}}はこの内容の一部の出典（{places}）を見られません。', '{n, plural, one {# persona no puede} other {# personas no pueden}} ver parte de las fuentes de esto ({places}).'),
  postRoomProvenanceNoPlace: t('{n}명은 이 내용의 일부 출처를 볼 수 없어요.', "{n, plural, one {# person} other {# people}} there can't see some of the sources of this.", '{n} orang di sana tidak bisa melihat sebagian sumber isi ini.', '{n, plural, one {#人} other {#人}}はこの内容の一部の出典を見られません。', '{n, plural, one {# persona no puede} other {# personas no pueden}} ver parte de las fuentes de esto.'),
  postRoomUnknown: t('이 내용이 참고한 자료를 다 알 수 없어요.', 'Not everything this used is known.', 'Tidak semua yang dipakai isi ini diketahui.', 'この内容が参照した資料をすべては把握できません。', 'No se sabe todo lo que usó este contenido.'),
  postRoomFiles: t('링크된 파일 {files}개를 {n}명이 열 수 없어요.', "{n, plural, one {# person} other {# people}} can't open {files, plural, one {# linked file} other {# linked files}}.", '{n} orang tidak bisa membuka {files} berkas yang ditautkan.', 'リンクされたファイル{files, plural, one {#件} other {#件}}を{n, plural, one {#人} other {#人}}が開けません。', '{n, plural, one {# persona no puede} other {# personas no pueden}} abrir {files, plural, one {# archivo enlazado} other {# archivos enlazados}}.'),
  postRoomWithFiles: t('파일도 함께 보내면: {line}', 'With the files: {line}', 'Dengan berkasnya: {line}', 'ファイルも送る場合: {line}', 'Con los archivos: {line}'),
  postRoomWithFilesAll: t('파일도 함께 보내면 모두 볼 수 있어요.', 'With the files, everyone there can see it.', 'Dengan berkasnya, semua orang di sana bisa melihatnya.', 'ファイルも送れば全員が見られます。', 'Con los archivos, todos pueden verlo.'),
  postRoomSend: t('보내기', 'Send', 'Kirim', '送る', 'Enviar'),
  postRoomSendFiles: t('파일도 함께 보내기', 'Send with the files', 'Kirim dengan berkasnya', 'ファイルも一緒に送る', 'Enviar con los archivos'),
  postRoomDont: t('보내지 않기', "Don't send", 'Jangan kirim', '送らない', 'No enviar'),
  postRoomNotSent: t('보내지 않았어요', 'Not sent', 'Tidak dikirim', '送っていません', 'No se envió'),
  postRoomEveryone: t('전체', 'Everyone', 'Semua', '全員', 'Todos'),
  postRoomTeam: t('팀 대화방', 'team room', 'ruang tim', 'チームルーム', 'sala del equipo'),
  postRoomGroup: t('그룹 대화', 'group chat', 'obrolan grup', 'グループチャット', 'chat de grupo'),
  postRoomDm: t('{name}님과의 1:1 대화', '1:1 chat with {name}', 'obrolan 1:1 dengan {name}', '{name}さんとの1:1', 'chat 1:1 con {name}'),
  postRoomTeamFolder: t('팀 폴더', 'Team folder', 'Folder tim', 'チームフォルダー', 'Carpeta del equipo'),
  postRoomMine: t('내 폴더', 'My folder', 'Folder saya', '自分のフォルダー', 'Mi carpeta'),
  postRoomPlaceRoom: t('{name} 대화방', '{name} chat room', 'Ruang obrolan {name}', '{name} トークルーム', 'Sala de chat {name}'),
  postRoomConversation: t('1:1·그룹 대화', '1:1 and group conversations', 'Percakapan 1:1 dan grup', '1:1・グループの会話', 'Conversaciones 1:1 y de grupo'),
  roomSharedAnswerEdit: t('대화방에 보낸 AI 답변은 고칠 수 없어요. 지우고 다시 보내 주세요.', 'An AI answer sent to a room cannot be edited. Delete it and send it again.', 'Jawaban AI yang dikirim ke ruang obrolan tidak bisa diubah. Hapus lalu kirim lagi.', "トークルームに送ったAIの回答は編集できません。削除してから送り直してください。", "Una respuesta de la IA enviada a una sala no se puede editar. Elimínela y vuelva a enviarla."),
  webSearch: STEP_TEXT.webSearch,
  webSearchRunning: STEP_TEXT.webSearchRunning,
  webSearchOpen: STEP_TEXT.webSearchOpen,
  webSearchPlain: STEP_TEXT.webSearchPlain,
  webSearchRefused: STEP_TEXT.webSearchRefused,
  thinking: STEP_TEXT.thinking,
  // shared project chats (chat/shared.ts, docs/DECISIONS.md "Shared project chats")
  sharedChatBusy: t('{name}님의 질문에 답하는 중이에요. 끝나면 보낼 수 있어요.', "{name}'s question is being answered. You can send yours when it is done.", 'Pertanyaan {name} sedang dijawab. Anda bisa mengirim setelah selesai.', "{name}さんの質問に回答中です。終わったら送信できます。", "Se está respondiendo la pregunta de {name}. Podrá enviar la suya cuando termine."),
  sharedChatSafeOps: t('안전 작업 모드라서 공유 채팅을 이어갈 수 없어요. 내 채팅에서 물어봐 주세요.', 'Safe operations mode is on, so shared chats cannot be continued. Ask in a chat of your own.', 'Mode operasi aman aktif, jadi obrolan bersama tidak bisa dilanjutkan. Tanyakan di obrolan Anda sendiri.', "安全作業モードのため、共有チャットは続けられません。自分のチャットで質問してください。", "El modo de operaciones seguras está activado, así que los chats compartidos no se pueden continuar. Pregunte en un chat propio."),
  sharedChatUpload: t('공유 채팅에는 팀 파일만 붙일 수 있어요. 컴퓨터의 파일은 프로젝트 폴더에 올린 뒤 붙여 주세요.', 'Only team files can be attached to a shared chat. Upload a file from your computer to the project folder first, then attach it.', 'Obrolan bersama hanya menerima berkas tim. Unggah berkas dari komputer Anda ke folder proyek dulu, lalu lampirkan.', "共有チャットに添付できるのはチームのファイルだけです。パソコンのファイルはプロジェクトのフォルダーにアップロードしてから添付してください。", "Un chat compartido solo admite archivos del equipo. Suba primero el archivo de su computadora a la carpeta del proyecto y luego adjúntelo."),
  sharedChatMove: t('공유 채팅은 다른 프로젝트로 옮길 수 없어요.', 'A shared chat cannot be moved to another project.', 'Obrolan bersama tidak bisa dipindahkan ke proyek lain.', "共有チャットは別のプロジェクトに移動できません。", "Un chat compartido no se puede mover a otro proyecto."),
  sharedChatCreatorOnly: t('공유 채팅의 이름과 엔진은 만든 사람만 바꿀 수 있어요.', 'Only the person who made a shared chat can rename it or change its engine.', 'Hanya pembuat obrolan bersama yang bisa mengganti nama atau mesinnya.', "共有チャットの名前とエンジンを変更できるのは作成した人だけです。", "Solo quien creó un chat compartido puede cambiarle el nombre o el motor."),
  sharedChatRunnerOnly: t('질문한 사람만 이 답변을 멈출 수 있어요.', 'Only the person who asked can stop this answer.', 'Hanya orang yang bertanya yang bisa menghentikan jawaban ini.', "この回答を停止できるのは質問した人だけです。", "Solo quien preguntó puede detener esta respuesta."),
  sharedChatOwnMessages: t('공유 채팅에서는 내 메시지만 고치거나 다시 답하게 할 수 있어요.', 'In a shared chat you can edit, or get a new answer to, only your own messages.', 'Di obrolan bersama, Anda hanya bisa mengubah atau meminta jawaban baru untuk pesan Anda sendiri.', "共有チャットで編集や回答の再生成ができるのは、自分のメッセージだけです。", "En un chat compartido solo puede editar sus propios mensajes o pedir una nueva respuesta a ellos."),
  sharedChatDeleteNo: t('공유 채팅은 만든 사람이나 프로젝트를 고칠 수 있는 사람만 지울 수 있어요.', 'Only the person who made a shared chat, or someone who can edit its project, can delete it.', 'Hanya pembuat obrolan bersama, atau orang yang bisa mengubah proyeknya, yang bisa menghapusnya.', "共有チャットを削除できるのは、作成した人かプロジェクトを編集できる人だけです。", "Solo quien creó un chat compartido, o quien puede editar su proyecto, puede eliminarlo."),
  chatPinsFull: t('상단에 고정은 {n}개까지 할 수 있어요. 고정한 기록 하나를 해제한 뒤 다시 해 주세요.', 'You can pin up to {n} chats. Unpin one first.', 'Anda bisa menyematkan hingga {n} obrolan. Lepas sematan salah satunya dulu.', "固定できるのは{n}件までです。先にどれかの固定を解除してください。", "Puede fijar hasta {n} chats. Deje de fijar uno primero."),
  // pinned conversations (rooms/service.ts pin)
  roomPinsFull: t('상단에 고정은 {n}개까지 할 수 있어요. 고정한 대화 하나를 해제한 뒤 다시 해 주세요.', 'You can pin up to {n} conversations. Unpin one first.', 'Anda bisa menyematkan hingga {n} percakapan. Lepas sematan salah satunya dulu.', "固定できる会話は{n}件までです。先にどれかの固定を解除してください。", "Puede fijar hasta {n} conversaciones. Deje de fijar una primero."),
  roomPinHidden: t('숨긴 대화는 고정할 수 없어요. 다시 보이게 한 뒤 고정해 주세요.', 'A hidden conversation cannot be pinned. Show it again first.', 'Percakapan yang disembunyikan tidak bisa disematkan. Tampilkan lagi dulu.', "非表示の会話は固定できません。先に再表示してください。", "No se puede fijar una conversación oculta. Vuelva a mostrarla primero."),
  sharedProjectPersonal: t('개인 프로젝트의 채팅은 공유할 수 없어요.', 'Chats of a personal project cannot be shared.', 'Obrolan proyek pribadi tidak bisa dibagikan.', "個人プロジェクトのチャットは共有できません。", "Los chats de un proyecto personal no se pueden compartir."),
  sharedProjectSafeOps: t('안전 작업 모드에서는 채팅을 공유할 수 없어요.', 'Chats cannot be shared while safe operations mode is on.', 'Obrolan tidak bisa dibagikan saat mode operasi aman aktif.', "安全作業モードではチャットを共有できません。", "No se pueden compartir chats mientras el modo de operaciones seguras está activado."),
  // an existing chat shared with its project's people (chat/share-chat.ts)
  chatShareNoProject: t('이 채팅은 채팅을 공유하는 팀 프로젝트에 있지 않아요. 그런 프로젝트로 옮긴 뒤에 공유해 주세요.', 'This chat is not in a team project that shares its chats. Move it into one first.', 'Obrolan ini tidak ada di proyek tim yang membagikan obrolannya. Pindahkan dulu ke proyek seperti itu.', "このチャットは、チャットを共有するチームプロジェクトにありません。先にそのようなプロジェクトへ移動してください。", "Este chat no está en un proyecto del equipo que comparta sus chats. Muévalo primero a uno."),
  chatShareSafeOps: t('안전 작업 모드이거나 기밀 대화라 공유할 수 없어요.', 'This chat cannot be shared: safe operations mode is on or the chat is confidential.', 'Obrolan ini tidak bisa dibagikan: mode operasi aman aktif atau obrolannya rahasia.', "安全作業モード中か機密チャットのため、共有できません。", "Este chat no se puede compartir: el modo de operaciones seguras está activado o el chat es confidencial."),
  chatShareAlready: t('이미 프로젝트 사람들과 공유한 채팅이에요.', "This chat is already shared with the project's people.", 'Obrolan ini sudah dibagikan dengan orang-orang proyek.', "このチャットはすでにプロジェクトのメンバーと共有されています。", "Este chat ya está compartido con las personas del proyecto."),
  chatShareScheduled: t('예약 작업이 만든 채팅은 공유할 수 없어요.', 'A chat made by a scheduled task cannot be shared.', 'Obrolan yang dibuat oleh tugas terjadwal tidak bisa dibagikan.', "定期タスクが作成したチャットは共有できません。", "Un chat creado por una tarea programada no se puede compartir."),
  chatShareBusy: t('답변이 아직 진행 중이에요. 끝난 뒤에 공유해 주세요.', 'An answer is still in progress. Share the chat once it is done.', 'Jawaban masih berjalan. Bagikan obrolan setelah selesai.', "まだ回答中です。終わってから共有してください。", "Aún hay una respuesta en curso. Comparta el chat cuando termine."),
  chatShareHidden: t('이 채팅이 읽은 대화방의 예전 답 중에 프로젝트 사람 일부에게 가려진 것이 있어 공유할 수 없어요.', "This chat cannot be shared: it used an earlier answer in a room that some of the project's people cannot see.", 'Obrolan ini tidak bisa dibagikan: obrolan ini memakai jawaban sebelumnya di ruang obrolan yang tidak bisa dilihat sebagian orang proyek.', "このチャットは共有できません。プロジェクトの一部のメンバーには表示されない、トークルームの以前の回答を使っています。", "Este chat no se puede compartir: usó una respuesta anterior de una sala que algunas personas del proyecto no pueden ver."),
  sharedReadConfirm: t('AI가 {sources}을(를) 읽으려고 해요. 이 채팅을 보는 프로젝트 사람 {n}명 중 {m}명은 이곳을 볼 수 없어요. 읽으면 모두가 이 채팅에서 내용을 보게 돼요.',
    'The AI wants to read {sources}. Of the {n, plural, one {# person} other {# people}} in the project who see this chat, {m} cannot see this place. If it does, everyone sees the content in this chat.',
    'AI ingin membaca {sources}. Dari {n} orang proyek yang melihat obrolan ini, {m} tidak bisa melihat tempat ini. Jika dibaca, semua orang melihat isinya di obrolan ini.',
    "AIが{sources}を読もうとしています。このチャットを見るプロジェクトの{n}人のうち{m}人はこの場所を見られません。読むと、全員がこのチャットで内容を見ることになります。",
    "La IA quiere leer {sources}. De las {n, plural, one {# persona} other {# personas}} del proyecto que ven este chat, {m} no pueden ver este lugar. Si lo lee, todos verán el contenido en este chat."),
  // a group's skill someone who sees the chat may not use (not in the group: the owner and admins read its folder)
  sharedSkillConfirm: t('AI가 {sources}의 스킬을 쓰려고 해요. 이 채팅을 보는 프로젝트 사람 {n}명 중 {m}명은 이 스킬을 쓸 수 없어요. 쓰면 모두가 이 채팅에서 내용을 보게 돼요.',
    'The AI wants to use a skill in {sources}. Of the {n, plural, one {# person} other {# people}} in the project who see this chat, {m} cannot use this skill. If it does, everyone sees its content in this chat.',
    'AI ingin memakai skill di {sources}. Dari {n} orang proyek yang melihat obrolan ini, {m} tidak bisa memakai skill ini. Jika dipakai, semua orang melihat isinya di obrolan ini.',
    "AIが{sources}のスキルを使おうとしています。このチャットを見るプロジェクトの{n}人のうち{m}人はこのスキルを使えません。使うと、全員がこのチャットで内容を見ることになります。",
    "La IA quiere usar una habilidad de {sources}. De las {n, plural, one {# persona} other {# personas}} del proyecto que ven este chat, {m} no pueden usar esta habilidad. Si la usa, todos verán su contenido en este chat."),
  sharedReadYes: t('읽고 공유하기', 'Read and share', 'Baca dan bagikan', "読んで共有する", "Leer y compartir"),
  sharedReadNo: t('읽지 않기', "Don't read", 'Jangan baca', "読まない", "No leer"),
  sharedReadSkipped: t('프로젝트 사람 모두가 볼 수는 없는 곳이라 읽지 않았어요', 'Not read: not everyone in the project can see that place', 'Tidak dibaca: tidak semua orang di proyek bisa melihat tempat itu', "プロジェクトの全員が見られる場所ではないため、読みませんでした", "No se leyó: no todas las personas del proyecto pueden ver ese lugar"),
  sharedScopeMine: t('내 개인 폴더', 'your personal folder', 'folder pribadi Anda', "自分の個人フォルダー", "su carpeta personal"),
  sharedScopeOther: t('이 채팅에서 다른 사람이 연 곳', 'a place someone else opened in this chat', 'tempat yang dibuka orang lain di obrolan ini', "このチャットでほかの人が開いた場所", "un lugar que otra persona abrió en este chat"),
  sharedAnswerFailed: t('답을 마치지 못했어요.', 'The answer did not finish.', 'Jawaban tidak selesai.', "回答を完了できませんでした。", "La respuesta no terminó."),
} satisfies Record<string, T>

/** How the person's AI is named on a card: 트리나 where the product is named after its AI (PRODUCT_NAMED_AFTER_AI),
 * else the plain word. */
export function aiCalled(locale: Locale): string {
  return tr(PRODUCT_NAMED_AFTER_AI ? 'aiOwnName' : 'aiPlainName', locale)
}

export function tr(key: keyof typeof TEXT, locale: Locale, vars: Record<string, string> = {}): string {
  // a count first ("{n, plural, one {# person} other {# people}}", shared/src/plural.ts), no second honorific after a
  // name that has one ("{by} 님" with 대표님, shared/src/honorific.ts), then the plain values
  let s = dropDoubleHonorifics(fillPlurals(TEXT[key][locale] ?? TEXT[key].en, vars, locale), vars)
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v)
  return s
}

/** Engine error -> message.error. Persist the reason as well as the localized fallback for older clients. */
export function engineError(reason: ChatErrorReason, locale: Locale, retryAfter?: number, status?: number): ApiErrorBody {
  const text = CHAT_ERROR_MESSAGES[reason]
  // the provider's HTTP status (API engine) goes with the error: the screen adds "(HTTP 502)" after the text
  const withStatus = status !== undefined && Number.isInteger(status)
  return { code: text.code, message: text[locale] + (withStatus ? ` (HTTP ${status})` : ''), params: { reason, ...(withStatus ? { status } : {}) }, ...(retryAfter !== undefined ? { retryAfter } : {}) }
}

/** The launcher ended the turn at a Linux limit (LaunchEvent exit.signal "oom" | "disk_limit", shared/src/engine.ts):
 * the answer's error, with the plan's number when there is a plan (system/limits.ts; without one the launcher
 * derives the limit from the machine, which the server does not know). payload_too_large: the work was too big for
 * one answer, like a too long conversation; params.reason tells the two apart. null for any other end. */
export function turnLimitError(signal: unknown, locale: Locale, limits: { turnMemoryMiB: number | null; turnDiskMiB: number | null }): ApiErrorBody | null {
  if (signal === 'oom') {
    const mb = limits.turnMemoryMiB
    return { code: 'payload_too_large', message: mb ? tr('errTurnMemoryPlan', locale, { mb: String(mb) }) : tr('errTurnMemory', locale), params: { reason: 'turn_memory_limit', ...(mb ? { limitMiB: mb } : {}) } }
  }
  if (signal === 'disk_limit') {
    const mb = limits.turnDiskMiB
    return { code: 'payload_too_large', message: mb ? tr('errTurnDiskPlan', locale, { mb: String(mb) }) : tr('errTurnDisk', locale), params: { reason: 'turn_disk_limit', ...(mb ? { limitMiB: mb } : {}) } }
  }
  return null
}

/** Short human label of a tool step ("Search "invoice" · finance/"). Never the raw input. The words live in
 * shared/src/step-labels.ts, where the web app reads them to redraw old steps in the language on screen. */
export { stepLabel } from '@mycel/shared'
