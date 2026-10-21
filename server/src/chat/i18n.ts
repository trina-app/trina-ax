// User-facing texts of the chat runtime (ko, en, id; English when a language is missing): answer errors, step labels
// (shared with the web app: shared/src/step-labels.ts), confirmation cards.
import type { ApiErrorBody, ErrorCode, Locale } from '@mycel/shared/api'
import { STEP_TEXT, type EngineErrorCode } from '@mycel/shared'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string): T => ({ ko, en, id })

export const TEXT = {
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
  browserUnavailable: t('데스크톱 앱 창이 연결되어 있지 않습니다.', 'The desktop app window is not connected.', 'Jendela aplikasi desktop tidak terhubung.'),

  // answer errors (message.error)
  errAuth: t('AI 연결에 문제가 있습니다. 관리자에게 AI 연결을 확인해 달라고 해 주세요.', 'The AI connection has a problem. Ask your admin to check the AI connection.', 'Koneksi AI bermasalah. Minta admin memeriksa koneksi AI.'),
  errRateLimit: t('AI 사용 한도에 잠시 도달했습니다. 조금 뒤 다시 시도해 주세요.', 'The AI usage limit was reached for now. Try again a bit later.', 'Batas penggunaan AI tercapai untuk sementara. Coba lagi nanti.'),
  errContext: t('대화가 너무 길어졌습니다. 새 채팅에서 이어 가 주세요.', 'This conversation got too long. Please continue in a new chat.', 'Percakapan ini terlalu panjang. Lanjutkan di chat baru.'),
  errTimeout: t('시간 제한을 넘겨 답변을 멈췄습니다.', 'The answer was stopped because it took too long.', 'Jawaban dihentikan karena terlalu lama.'),
  errRefused: t('AI가 이 요청에 답하지 않았습니다. 표현을 바꿔 다시 시도해 주세요.', 'The AI declined this request. Try rephrasing it.', 'AI menolak permintaan ini. Coba ubah kalimatnya.'),
  errCrash: t('AI 엔진이 예기치 않게 멈췄습니다. 다시 시도해 주세요.', 'The AI engine stopped unexpectedly. Please try again.', 'Mesin AI berhenti tiba-tiba. Coba lagi.'),
  errInterrupted: t('서버가 다시 시작되어 답변이 중단되었습니다.', 'The answer was interrupted because the server restarted.', 'Jawaban terputus karena server dimulai ulang.'),
  errEngineMissing: t('지금은 AI 엔진을 쓸 수 없습니다. 팀장에게 알려 주세요(관리자 > 시스템 > 진단에서 원인을 볼 수 있어요).', 'The AI engine is not available right now. Let the team owner know (Admin > System > Diagnostics shows why).', 'Mesin AI sedang tidak tersedia. Beri tahu pemilik tim (Admin > Sistem > Diagnostik menunjukkan penyebabnya).'),
  errProxyMode: t('회사 API 키 모드는 이 버전에서 아직 켤 수 없습니다. 구독 로그인 모드를 써 주세요.', 'Company API key mode cannot be turned on in this version yet. Use the subscription login mode.', 'Mode kunci API perusahaan belum bisa diaktifkan di versi ini. Gunakan mode login langganan.'),
  errUserDisabled: t('계정을 사용할 수 없습니다.', 'This account is not active.', 'Akun ini tidak aktif.'),

  // steps
  refusedRetry: STEP_TEXT.refusedRetry,
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

/** Engine error -> message.error (stable code + localized text). */
export function engineError(code: EngineErrorCode | 'interrupted' | 'engine_missing' | 'proxy_mode' | 'user_disabled', locale: Locale, retryAfter?: number): ApiErrorBody {
  const map: Record<string, [ErrorCode, keyof typeof TEXT]> = {
    auth: ['engine_unavailable', 'errAuth'],
    rate_limit: ['rate_limited', 'errRateLimit'],
    context: ['payload_too_large', 'errContext'],
    timeout: ['busy', 'errTimeout'],
    refused: ['forbidden', 'errRefused'],
    crash: ['internal', 'errCrash'],
    interrupted: ['unavailable', 'errInterrupted'],
    engine_missing: ['engine_unavailable', 'errEngineMissing'],
    proxy_mode: ['engine_unavailable', 'errProxyMode'],
    user_disabled: ['forbidden', 'errUserDisabled'],
  }
  const [c, k] = map[code] ?? ['internal', 'errCrash']
  return { code: c, message: tr(k, locale), ...(retryAfter !== undefined ? { retryAfter } : {}) }
}

/** Short human label of a tool step ("Search "invoice" · finance/"). Never the raw input. The words live in
 * shared/src/step-labels.ts, where the web app reads them to redraw old steps in the language on screen. */
export { stepLabel } from '@mycel/shared'
