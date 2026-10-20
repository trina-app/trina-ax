// User-facing texts of the chat runtime (ko default, en, id): answer errors, step labels, confirmation cards.
import type { ApiErrorBody, ErrorCode, Locale } from '@mycel/shared/api'
import type { EngineErrorCode } from '@mycel/shared'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string): T => ({ ko, en, id })

export const TEXT = {
  turnInProgress: t('이 채팅에서 답변이 아직 진행 중입니다. 끝나거나 중지한 뒤 보내 주세요.', 'An answer is still in progress in this chat. Wait for it or stop it first.', 'Jawaban di chat ini masih berjalan. Tunggu atau hentikan dulu.'),
  attachmentsUnavailable: t('첨부 파일을 찾을 수 없습니다. 다시 올려 주세요.', 'The attachments could not be found. Please upload them again.', 'Lampiran tidak ditemukan. Unggah ulang.'),
  requestClosed: t('이미 답했거나 시간이 지난 질문입니다.', 'This question was already answered or has expired.', 'Pertanyaan ini sudah dijawab atau kedaluwarsa.'),
  notUserMessage: t('사용자 메시지만 수정할 수 있습니다.', 'Only your own messages can be edited.', 'Hanya pesan Anda yang bisa diubah.'),
  notAssistantMessage: t('AI 답변만 다시 생성할 수 있습니다.', 'Only AI answers can be regenerated.', 'Hanya jawaban AI yang bisa dibuat ulang.'),
  badParent: t('이어 쓸 메시지를 찾을 수 없습니다.', 'The message to continue from was not found.', 'Pesan yang mau dilanjutkan tidak ditemukan.'),
  projectFolderFile: t('프로젝트 폴더 자리에 파일이 있습니다.', 'A file is in the way of the project folder.', 'Ada berkas di lokasi folder proyek.'),
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
  refusedRetry: t('AI가 답하지 않아 다른 모델({model})로 다시 답합니다', 'The AI declined; answering again with another model ({model})', 'AI menolak; menjawab ulang dengan model lain ({model})'),
  rememberConfirm: t('AI가 다음 내용을 기억하려고 합니다. 기억할까요?\n\n{text}', 'The AI wants to remember this about you. OK?\n\n{text}', 'AI ingin mengingat hal ini tentang Anda. Boleh?\n\n{text}'),
  yes: t('기억하기', 'Remember', 'Ingat'),
  no: t('기억하지 않기', 'Don’t remember', 'Jangan ingat'),
  remembered: t('기억함: {text}', 'Remembered: {text}', 'Diingat: {text}'),
  notRemembered: t('기억하지 않음: {text}', 'Not remembered: {text}', 'Tidak diingat: {text}'),
  forgot: t('기억 지움', 'Forgot a memory', 'Ingatan dihapus'),
  asked: t('질문: {q}', 'Question: {q}', 'Pertanyaan: {q}'),
  notAnswered: t('답하지 않음', 'Not answered', 'Tidak dijawab'),
  browserSite: t('사내망 주소 {host}를 열어도 될까요?', 'May the AI open the office-network address {host}?', 'Bolehkan AI membuka alamat jaringan kantor {host}?'),
  widenConfirm: t('AI가 볼 수 있는 사람이 더 적은 내용({sources})을 읽은 뒤 {target}에 저장하려고 합니다. 이곳은 {n}명이 볼 수 있어요. 저장할까요?',
    'The AI read content fewer people can see ({sources}) and now wants to save to {target}, which {n} people can see. Save it?',
    'AI membaca konten yang hanya bisa dilihat lebih sedikit orang ({sources}) dan sekarang ingin menyimpan ke {target}, yang bisa dilihat {n} orang. Simpan?'),
  widenSave: t('저장하기', 'Save', 'Simpan'),
  widenDont: t('저장하지 않기', 'Don’t save', 'Jangan simpan'),
  scopeMine: t('내 개인 폴더나 앱 안 브라우저', 'your personal folder or the in-app browser', 'folder pribadi Anda atau browser di aplikasi'),
  scopeRoot: t('팀 폴더 맨 위', 'the top of the team folder', 'bagian atas folder tim'),
  webSearch: t('웹 검색: {q}', 'Web search: {q}', 'Cari di web: {q}'),
  thinking: t('생각하는 중', 'Thinking', 'Berpikir'),
} satisfies Record<string, T>

export function tr(key: keyof typeof TEXT, locale: Locale, vars: Record<string, string> = {}): string {
  let s = TEXT[key][locale] ?? TEXT[key].ko
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

/** Short human label of a tool step ("grep "invoice" · finance/"). Never the raw input. */
const FILE_VERB: Record<string, T> = {
  list: t('폴더 보기', 'List', 'Lihat folder'),
  glob: t('파일 찾기', 'Find files', 'Cari berkas'),
  grep: t('내용 검색', 'Search', 'Cari isi'),
  read: t('파일 읽기', 'Read', 'Baca berkas'),
  write: t('파일 저장', 'Save', 'Simpan berkas'),
  edit: t('파일 수정', 'Edit', 'Ubah berkas'),
  make_file: t('파일 만들기', 'Make file', 'Buat berkas'),
  share_file: t('파일 공유 링크', 'Share link', 'Tautan berkas'),
  artifact: t('아티팩트', 'Artifact', 'Artefak'),
  web_fetch: t('웹 페이지 가져오기', 'Fetch page', 'Ambil halaman'),
  ask_user: t('질문', 'Question', 'Pertanyaan'),
  remember: t('기억하기', 'Remember', 'Ingat'),
  forget: t('기억 지우기', 'Forget', 'Lupakan'),
}
const BROWSER_VERB: Record<string, T> = {
  preview_start: t('브라우저 열기', 'Open browser', 'Buka browser'),
  navigate: t('페이지 열기', 'Open page', 'Buka halaman'),
  read_page: t('페이지 읽기', 'Read page', 'Baca halaman'),
  get_page_text: t('페이지 읽기', 'Read page', 'Baca halaman'),
  find: t('페이지에서 찾기', 'Find on page', 'Cari di halaman'),
  computer: t('브라우저 조작', 'Use browser', 'Operasikan browser'),
  form_input: t('양식 채우기', 'Fill form', 'Isi formulir'),
  javascript_tool: t('페이지 스크립트 실행', 'Run page script', 'Jalankan skrip halaman'),
  browser_batch: t('브라우저 여러 단계', 'Browser steps', 'Beberapa langkah browser'),
  resize_window: t('화면 크기 바꾸기', 'Resize', 'Ubah ukuran'),
  read_console_messages: t('콘솔 보기', 'Read console', 'Baca konsol'),
  read_network_requests: t('네트워크 보기', 'Read network', 'Baca jaringan'),
  tabs_context: t('탭 보기', 'List tabs', 'Lihat tab'),
  tabs_create: t('새 탭', 'New tab', 'Tab baru'),
  tabs_select: t('탭 바꾸기', 'Switch tab', 'Ganti tab'),
  tabs_close: t('탭 닫기', 'Close tab', 'Tutup tab'),
}

const clip = (s: unknown, n = 80) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v }

export function stepLabel(tool: string, input: unknown, locale: Locale, browserTools: ReadonlySet<string>): string {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (browserTools.has(tool)) {
    const verb = (BROWSER_VERB[tool] ?? t('브라우저', 'Browser', 'Browser'))[locale]
    const url = typeof a.url === 'string' ? ` · ${clip(a.url, 60)}` : ''
    return verb + url
  }
  const verb = FILE_VERB[tool]?.[locale]
  switch (tool) {
    case 'list': return `${verb} · ${clip(a.path || '/', 80)}`
    case 'glob': return `${verb} "${clip(a.pattern, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'grep': return `${verb} "${clip(a.pattern, 60)}"${a.path ? ` · ${clip(a.path, 50)}` : ''}`
    case 'read': case 'write': case 'edit': return `${verb} · ${clip(a.file_path, 90)}`
    case 'make_file': return `${verb} · ${clip(a.output, 90)}`
    case 'share_file': return `${verb} · ${clip(a.path, 90)}`
    case 'artifact': return `${verb} · ${clip(a.title ?? a.key, 80)}`
    case 'web_fetch': return `${verb} · ${clip(a.url, 80)}`
    case 'ask_user': return tr('asked', locale, { q: clip(a.question, 120) })
    case 'remember': return tr('remembered', locale, { text: clip(a.text, 120) })
    case 'forget': return tr('forgot', locale)
    default: return verb ?? tool
  }
}
