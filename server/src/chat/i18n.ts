// User-facing texts of the chat runtime (ko, en, id; English when a language is missing): answer errors, step labels
// (shared with the web app: shared/src/step-labels.ts), confirmation cards.
import { CHAT_ERROR_MESSAGES, type ApiErrorBody, type ChatErrorReason, type Locale } from '@mycel/shared/api'
import { STEP_TEXT } from '@mycel/shared'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string): T => ({ ko, en, id })

export const TEXT = {
  scheduleLimit: t('개인 예약은 꺼진 예약을 포함해 최대 {n}개까지 보관할 수 있어요. 새 예약을 만들려면 기존 예약 하나를 삭제해 주세요.', 'You can keep up to {n} personal schedules, including paused schedules. Delete an existing schedule to create a new one.', 'Anda dapat menyimpan hingga {n} jadwal pribadi, termasuk jadwal yang dijeda. Hapus jadwal yang ada untuk membuat jadwal baru.'),
  scheduleCompleted: t('이미 실행된 일회성 예약은 다시 켤 수 없어요. 새 예약을 만들어 주세요.', 'This one-time task has already run and cannot be resumed. Create a new schedule.', 'Tugas sekali jalan ini sudah dijalankan dan tidak dapat dilanjutkan. Buat jadwal baru.'),
  scheduleExpired: t('실행 시각이 지난 일회성 예약은 켤 수 없어요. 새 예약을 만들어 주세요.', 'This one-time task has expired and cannot be resumed. Create a new schedule.', 'Waktu tugas sekali jalan ini sudah lewat dan tidak dapat dilanjutkan. Buat jadwal baru.'),
  turnInProgress: t('이 채팅에서 답변이 아직 진행 중입니다. 끝나거나 중지한 뒤 보내 주세요.', 'An answer is still in progress in this chat. Wait for it or stop it first.', 'Jawaban di chat ini masih berjalan. Tunggu atau hentikan dulu.'),
  attachmentsTeamUnavailable: t('추가한 팀 파일 중 더 이상 열 수 없는 파일이 있습니다. 그 파일을 빼고 보내려면 다시 보내기를 누르세요.', 'A team file you added is no longer available to you. Send again to send the message without it.', 'Ada berkas tim yang Anda tambahkan yang tidak lagi tersedia untuk Anda. Kirim ulang untuk mengirim pesan tanpa berkas itu.'),
  attachmentsUnavailable: t('첨부 파일을 찾을 수 없습니다. 다시 올려 주세요.', 'The attachments could not be found. Please upload them again.', 'Lampiran tidak ditemukan. Unggah ulang.'),
  requestClosed: t('이미 답했거나 시간이 지난 질문입니다.', 'This question was already answered or has expired.', 'Pertanyaan ini sudah dijawab atau kedaluwarsa.'),
  notUserMessage: t('사용자 메시지만 수정할 수 있습니다.', 'Only your own messages can be edited.', 'Hanya pesan Anda yang bisa diubah.'),
  notAssistantMessage: t('AI 답변만 다시 생성할 수 있습니다.', 'Only AI answers can be regenerated.', 'Hanya jawaban AI yang bisa dibuat ulang.'),
  badParent: t('이어 쓸 메시지를 찾을 수 없습니다.', 'The message to continue from was not found.', 'Pesan yang mau dilanjutkan tidak ditemukan.'),
  projectFolderFile: t('프로젝트 폴더 자리에 파일이 있습니다.', 'A file is in the way of the project folder.', 'Ada berkas di lokasi folder proyek.'),
  projectCreatorOnly: t('프로젝트 이름·지침 수정과 삭제는 만든 사람과 관리자만 할 수 있습니다.', 'Only the person who created the project and admins can rename it, change its instructions or delete it.', 'Hanya pembuat proyek dan admin yang bisa mengganti nama, instruksi, atau menghapusnya.'),
  projectFolderAdminOnly: t('프로젝트 폴더를 바꾸는 것은 관리자만 할 수 있습니다.', 'Only admins can change the folder of a project.', 'Hanya admin yang bisa mengganti folder proyek.'),
  projectFolderPersonal: t('팀 프로젝트를 개인 폴더(users/)로 옮길 수 없습니다.', 'A team project cannot move into a personal folder (users/).', 'Proyek tim tidak dapat dipindah ke folder pribadi (users/).'),
  projectInstructionsChanged: t("'{name}' 프로젝트 지침을 {by} 님이 바꿨습니다.", "{by} changed the instructions of the project '{name}'.", "{by} mengubah instruksi proyek '{name}'."),
  projectNewTeamAdminOnly: t('새 팀 프로젝트 폴더(projects/)는 관리자만 만들 수 있습니다. 쓰기 권한이 있는 기존 폴더를 고르거나 내 프로젝트로 만드세요.', 'Only admins can create a new team project folder (projects/). Pick an existing folder you can write to, or make it a personal project.', 'Hanya admin yang bisa membuat folder proyek tim baru (projects/). Pilih folder yang bisa Anda tulis, atau buat proyek pribadi.'),
  projectParticipantsNewOnly: t('참여 대상은 새 팀 프로젝트 폴더를 만들 때만 고를 수 있습니다(기존 폴더의 권한은 관리자 화면에서 바꿉니다).', 'Participants can only be chosen for a new team project folder (change an existing folder\'s access in the admin screen).', 'Peserta hanya bisa dipilih untuk folder proyek tim baru.'),
  projectPersonalFolder: t('내 프로젝트는 내 개인 폴더 안에만 만들 수 있습니다.', 'A personal project lives inside your personal folder.', 'Proyek pribadi hanya bisa di dalam folder pribadi Anda.'),
  projectFolderTaken: t('그 이름의 폴더 권한 기록이 남아 있어 쓸 수 없습니다. 다른 이름을 고르세요.', 'Access rules are still kept for a folder of that name. Pick another name.', 'Aturan akses masih tersimpan untuk folder bernama itu. Pilih nama lain.'),
  projectShareNotPersonal: t('팀 폴더로 복사해 공유하는 것은 내 프로젝트만 할 수 있습니다.', 'Only a personal project can be shared by copying it to a team folder.', 'Hanya proyek pribadi yang bisa dibagikan dengan menyalinnya ke folder tim.'),
  projectFolderNoWrite: t('이 폴더에 쓰기 권한이 없습니다.', 'You cannot write to this folder.', 'Anda tidak bisa menulis ke folder ini.'),
  engineChoiceNotAllowed: t('AI 엔진과 모델은 관리자가 정합니다. 엔진을 고르지 말고 보내면 팀 기본 엔진으로 답합니다.', 'Your admin chooses the AI engine and model. Send without picking one and the team default answers.', 'Mesin dan model AI ditentukan admin. Kirim tanpa memilih dan mesin bawaan tim yang menjawab.'),
  engineOff: t('관리자가 이 AI 엔진을 꺼 두었습니다. 다른 엔진을 고르세요.', 'Your admin switched this AI engine off. Pick another one.', 'Admin mematikan mesin AI ini. Pilih yang lain.'),
  browserUnavailable: t('데스크톱 앱 창이 연결되어 있지 않습니다.', 'The desktop app window is not connected.', 'Jendela aplikasi desktop tidak terhubung.'),

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
  errBudget: t('AI 사용 한도를 다 썼습니다. 더 필요하면 관리자에게 말해 주세요.', 'The AI usage limit is used up. Ask an admin if you need more.', 'Batas penggunaan AI sudah habis. Minta admin jika perlu lebih.'),
  errUserDisabled: CHAT_ERROR_MESSAGES.user_disabled,
  errNoCredential: CHAT_ERROR_MESSAGES.no_credential,
  // the Linux launcher stopped the turn at its limits (linux-runtime 3.3.7: the turn's memory, the chat folder's size)
  errTurnMemory: t('이 답변이 한 답변에 쓸 수 있는 메모리를 넘어 멈췄습니다. 질문을 나누거나, 큰 파일은 한 번에 하나씩 다뤄 달라고 해 보세요.', 'This answer stopped because it needed more memory than one answer may use. Try splitting the question, or ask for big files one at a time.', 'Jawaban ini berhenti karena butuh memori lebih dari yang boleh dipakai satu jawaban. Coba pecah pertanyaannya, atau minta berkas besar diproses satu per satu.'),
  errTurnMemoryPlan: t('이 답변이 팀 요금제에서 한 답변에 쓸 수 있는 메모리(약 {mb} MB)를 넘어 멈췄습니다. 질문을 나누거나, 큰 파일은 한 번에 하나씩 다뤄 달라고 해 보세요.', 'This answer stopped because it needed more memory than one answer may use on this team\'s plan (about {mb} MB). Try splitting the question, or ask for big files one at a time.', 'Jawaban ini berhenti karena butuh memori lebih dari yang boleh dipakai satu jawaban di paket tim ini (sekitar {mb} MB). Coba pecah pertanyaannya, atau minta berkas besar diproses satu per satu.'),
  errTurnDisk: t('이 답변이 만든 작업 파일이 한 답변에 저장할 수 있는 크기를 넘어 멈췄습니다. 작업 공간은 비웠습니다. 결과를 작게 나눠 만들어 달라고 해 보세요.', 'This answer stopped because the working files it made grew past what one answer may store. Its workspace was emptied. Try asking for the result in smaller parts.', 'Jawaban ini berhenti karena berkas kerja yang dibuatnya melebihi batas penyimpanan satu jawaban. Ruang kerjanya sudah dikosongkan. Coba minta hasilnya dalam bagian yang lebih kecil.'),
  errTurnDiskPlan: t('이 답변이 만든 작업 파일이 한 답변에 저장할 수 있는 크기({mb} MB)를 넘어 멈췄습니다. 작업 공간은 비웠습니다. 결과를 작게 나눠 만들어 달라고 해 보세요.', 'This answer stopped because the working files it made grew past what one answer may store ({mb} MB). Its workspace was emptied. Try asking for the result in smaller parts.', 'Jawaban ini berhenti karena berkas kerja yang dibuatnya melebihi batas penyimpanan satu jawaban ({mb} MB). Ruang kerjanya sudah dikosongkan. Coba minta hasilnya dalam bagian yang lebih kecil.'),
  errCredentialUnusable: CHAT_ERROR_MESSAGES.credential_unusable,
  errCredentialLimit: t('이 AI 연결의 이번 달 한도를 다 썼습니다. 더 필요하면 관리자에게 말해 주세요.', 'This month\'s limit of the AI connection is used up. Ask an admin if you need more.', 'Batas bulan ini untuk koneksi AI sudah habis. Minta admin jika perlu lebih.'),

  // steps
  refusedRetry: STEP_TEXT.refusedRetry,
  engineOffDefault: STEP_TEXT.engineOffDefault,
  limitFallback: STEP_TEXT.limitFallback,
  credentialSwitchLimit: STEP_TEXT.credentialSwitchLimit,
  credentialSwitchInvalid: STEP_TEXT.credentialSwitchInvalid,
  attachChanged: STEP_TEXT.attachChanged,
  attachMoved: STEP_TEXT.attachMoved,
  attachUnavailable: STEP_TEXT.attachUnavailable,
  rememberConfirm: t('AI가 다음 내용을 기억하려고 합니다. 기억할까요?\n\n{text}', 'The AI wants to remember this about you. OK?\n\n{text}', 'AI ingin mengingat hal ini tentang Anda. Boleh?\n\n{text}'),
  yes: t('기억하기', 'Remember', 'Ingat'),
  no: t('기억하지 않기', 'Don’t remember', 'Jangan ingat'),
  remembered: STEP_TEXT.remembered,
  notRemembered: STEP_TEXT.notRemembered,
  forgot: STEP_TEXT.forgot,
  asked: STEP_TEXT.asked,
  notAnswered: STEP_TEXT.notAnswered,
  browserSite: t('사내망 주소 {host}를 열어도 될까요?', 'May the AI open the office-network address {host}?', 'Bolehkan AI membuka alamat jaringan kantor {host}?'),
  widenConfirm: t('AI가 볼 수 있는 사람이 더 적은 내용({sources})을 읽은 뒤 {target}에 저장하려고 합니다. 이곳은 {n}명이 볼 수 있어요. 저장할까요?',
    'The AI read content fewer people can see ({sources}) and now wants to save to {target}, which {n} people can see. Save it?',
    'AI membaca konten yang hanya bisa dilihat lebih sedikit orang ({sources}) dan sekarang ingin menyimpan ke {target}, yang bisa dilihat {n} orang. Simpan?'),
  widenSave: t('저장하기', 'Save', 'Simpan'),
  widenDont: t('저장하지 않기', 'Don’t save', 'Jangan simpan'),
  scopeMine: t('내 개인 폴더나 앱 안 브라우저', 'your personal folder or the in-app browser', 'folder pribadi Anda atau browser di aplikasi'),
  scopeRoot: t('팀 폴더 맨 위', 'the top of the team folder', 'bagian atas folder tim'),
  webSearch: STEP_TEXT.webSearch,
  thinking: STEP_TEXT.thinking,
} satisfies Record<string, T>

export function tr(key: keyof typeof TEXT, locale: Locale, vars: Record<string, string> = {}): string {
  let s = TEXT[key][locale] ?? TEXT[key].en
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
