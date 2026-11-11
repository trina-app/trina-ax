// The fixed word lists of "what my group often asks" (chat/often-asked.ts; docs/DECISIONS.md "Home: what my group
// often asks"). A sentence the AI writes may use only words on these lists and words that 3 or more people of the
// audience typed; anything else drops it (the check fails closed: a word that is not here and not typed by enough
// people never passes, whatever the AI meant).
// - STOP: function words, particles and endings. They never back a person (a shared "how" or "에서" says nothing).
// - TASK: plain words for the kind of work people ask for. They may stand in a sentence without anyone typing them, and
//   a person who typed one counts for an item that uses it.
// - ENDINGS: what Korean (and a few Japanese) words end with; a word is also read without one of them.
// - APP_PROMPTS: what the app itself puts in the box (web/src/i18n, checked against it by
//   tests/unit/b-often-asked-words.test.ts), as templates: such a line is never counted as someone's question.
import type { Locale } from '@mycel/shared/api'

const list = (s: string) => s.trim().split(/\s+/)

export const STOP = new Set(list(`
  a an the to for of in on at by with from into about and or but so as is are be it its this that these those there
  i me my mine we us our you your he she they them their what how which who whom when where why whether can could
  would should will shall may might must do does did done please just also some any all each every more most less few
  one other same such than then up down out over under again very really new old
  좀 그 이 저 것 거 게 수 등 및 또는 그리고 하고 해 해줘 해 줘 줘 주세요 해주세요 해 주세요 줄래 줄래요 줄 래 할 한 하는 하기 하면 해서 해요
  했어 했던 되는 된 될 있는 있어 있나요 있을까 없는 어떻게 무엇 뭐 뭘 어떤 왜 언제 어디 누가 이번 저번 다음 지난 오늘 내일 어제
  에 에서 에게 한테 으로 로 을 를 이 가 은 는 의 도 만 와 과 랑 이랑 까지 부터 처럼 보다 대해 대한 관련 위한 위해 같이 같은 맞게 대로
  요 다 고 서 면 며 게 지 나 죠 네
  の を に は が で と も へ や から まで より て た だ です ます ください して する した し い な こと もの これ それ この その
  ため よう ように について など か ね よ
  de la el los las un una y o en con por para del al que es son se su sus mi mis lo como más
  dan atau yang di ke dari untuk dengan ini itu saya kami kita tolong buat bisa apa bagaimana ada
`))

export const TASK = new Set(list(`
  summarize summarise summary summaries write draft translate translation check review explain list compare comparison
  create make give show find plan planning prepare update rewrite improve edit fix format turn ideas idea suggest
  suggestions tips steps step ways way example examples outline brief overview analyze analyse analysis organize
  organise sort answer reply respond question questions
  email emails mail message messages letter report reports weekly monthly daily annual meeting meetings notes note minutes
  agenda schedule calendar presentation slides slide deck document documents doc docs file files table spreadsheet
  excel sheet chart graph proposal proposals quote quotation estimate contract contracts invoice invoices receipt
  customer customers client clients team company project projects task tasks todo week month year today tomorrow
  short simple key points point main action items item english korean japanese spanish indonesian chinese text post
  posts blog social media copy title titles headline headlines caption captions announcement notice newsletter press
  release product products service services sales marketing price prices budget cost costs policy policies guide
  manual faq interview job description resume feedback survey checklist template templates form forms memo pdf ppt
  word data numbers figures trends research article articles news content campaign event events training onboarding
  welcome introduction intro profile brand logo design image images photo picture video script story
  요약 정리 작성 초안 번역 확인 검토 설명 비교 분석 추천 제안 계획 준비 수정 고쳐 다듬어 다듬기 개선 만들어 만들기 만들 써 써줘 쓰기
  알려 알려줘 찾아 찾아줘 정리해 요약해 작성해 번역해 확인해 검토해 설명해 비교해 분석해 추천해 만들어줘 바꿔 바꿔줘 뽑아 뽑아줘
  목록 리스트 표 엑셀 시트 차트 그래프 메일 이메일 답장 답변 메시지 문자 편지 보고서 보고 주간 월간 일간 연간 회의 회의록 미팅 안건 일정
  발표 발표자료 슬라이드 피피티 문서 자료 파일 제안서 기획서 견적서 견적 계약서 계약 청구서 영수증 고객 고객사 거래처 팀 회사 우리 프로젝트
  업무 할일 할 일 주 달 월 년 오늘 내일 짧게 간단히 간단하게 쉽게 핵심 요점 주요 액션 아이템 영어 한국어 일본어 중국어 영어로 한국어로
  글 게시물 블로그 문구 카피 제목 헤드라인 캡션 공지 공지사항 안내 안내문 뉴스레터 보도자료 상품 제품 서비스 영업 마케팅 가격 예산 비용
  정책 규정 가이드 매뉴얼 질문 인터뷰 채용 공고 이력서 피드백 설문 체크리스트 양식 템플릿 서식 메모 데이터 숫자 수치 트렌드 조사 리서치
  기사 뉴스 콘텐츠 캠페인 행사 이벤트 교육 온보딩 소개 소개서 회사소개서 프로필 브랜드 로고 디자인 이미지 사진 영상 대본 스크립트 아이디어
  방법 예시 단계 내용 순서 포인트 정리본 카드뉴스 홍보 광고 상세페이지 리뷰 후기 계획서 결과 결과보고서 일지 업무일지 주간보고 월간보고
  要約 まとめ 作成 翻訳 確認 説明 比較 分析 提案 計画 準備 修正 一覧 リスト 表 メール 返信 報告 報告書 会議 議事録 資料 文書 ファイル
  見積 見積書 契約 契約書 顧客 お客様 チーム 会社 プロジェクト 今日 明日 今週 来週 英語 日本語 韓国語 文章 投稿 ブログ タイトル 案内
  resumen resumir escribir redactar traducir revisar explicar lista comparar crear preparar correo correos informe reunión
  reuniones notas acta presentación documento archivo propuesta presupuesto contrato cliente clientes equipo empresa proyecto
  ringkas ringkasan rangkum tulis buatkan terjemahkan periksa jelaskan daftar bandingkan siapkan email laporan rapat notulen
  presentasi dokumen berkas proposal penawaran kontrak pelanggan klien tim perusahaan proyek
`))

/** Korean particles and verb endings, longest first; a word is also read with one of them taken off. */
export const ENDINGS = [...new Set(list(`
  해주세요 해줄래요 해줄래 해줘요 해줘 해주라 해봐 해볼까 하는법 하는 하기 하면 해서 해요 해야 할까 할 한 했던 했어
  으로는 에서는 에게서 한테서 이라고 라고 처럼 까지 부터 에서 에게 한테 으로 이랑 하고 랑 에 로 을 를 이 가 은 는 의 도 만 와 과
  줘 요
`))].sort((a, b) => b.length - a.length)

/** The web app's keys whose text it puts in the box itself (checked against web/src/i18n by
 * tests/unit/b-often-asked-words.test.ts). */
export const APP_PROMPT_KEYS = ['home.prepared.filesAsk', 'home.prepared.profileAsk', 'home.prepared.startAsk', 'files.chatPrompt', 'files.summary.askOwnFolderPrompt', 'files.summary.askOwnFolderHiddenPrompt', 'artifact.fixPrompt'] as const

/** Their first lines in every language, in APP_PROMPT_KEYS' order: `{x}` stands for any text, and a line that starts
 * with one is the app's, not someone's question. */
export const APP_PROMPTS: Record<Locale, readonly string[]> = {
  en: [
    "Look only at the names and types of the files in the {folder} folder, leaving out the {brand} and skills folders, and pick the 3 I should look at first",
    "Sum up what our company does in 3 lines",
    "Tell me 3 ways you can help with our team's work",
    "Read the file `{path}` and",
    "You didn't have write access to {path}. Please save the same content in my folder.",
    "The previous save wasn't allowed. Please save the same content in my folder.",
    "The artifact \"{title}\" (id: {key}, v{version}) fails when it runs:",
  ],
  ko: [
    "{folder} 폴더에서 {brand} 폴더와 스킬 폴더는 빼고, 파일 이름과 종류만 보고 내가 먼저 보면 좋을 것 3개를 골라 줘",
    "우리 회사가 하는 일을 3줄로 정리해 줘",
    "우리 팀 일을 어떻게 도와줄 수 있는지 3가지만 알려 줘",
    "`{path}` 파일을 읽고",
    "{path}에는 쓸 권한이 없었어. 같은 내용을 내 폴더에 저장해 줘.",
    "앞서 저장하려던 위치에는 저장할 수 없었어. 같은 내용을 내 폴더에 저장해 줘.",
    "아티팩트 \"{title}\"(id: {key}, v{version})를 실행하면 오류가 나요:",
  ],
  id: [
    "Lihat nama dan jenis file di folder {folder} saja, tanpa folder {brand} dan folder skill, lalu pilih 3 yang sebaiknya saya lihat dulu",
    "Ringkas apa yang dikerjakan perusahaan kami dalam 3 baris",
    "Sebutkan 3 cara kamu bisa membantu pekerjaan tim kami",
    "Baca file `{path}` lalu",
    "Kamu tidak punya izin tulis ke {path}. Tolong simpan isi yang sama di folder saya.",
    "Penyimpanan sebelumnya tidak diizinkan. Tolong simpan isi yang sama di folder saya.",
    "Artefak \"{title}\" (id: {key}, v{version}) error saat dijalankan:",
  ],
  ja: [
    "{folder}フォルダーのファイル名と種類だけを見て（{brand}フォルダーとスキルのフォルダーは除いて）、最初に見るとよいものを3つ選んでください",
    "私たちの会社がしていることを3行でまとめてください",
    "私たちのチームの仕事をどう手伝えるか、3つ教えてください",
    "ファイル`{path}`を読んで、",
    "{path}への書き込み権限がありませんでした。同じ内容を自分のフォルダーに保存してください。",
    "前の保存は許可されませんでした。同じ内容を自分のフォルダーに保存してください。",
    "アーティファクト\"{title}\"（id: {key}, v{version}）の実行時にエラーが発生します：",
  ],
  es: [
    "Revise solo los nombres y tipos de los archivos de la carpeta {folder}, sin las carpetas {brand} y de habilidades, y elija los 3 que debería ver primero",
    "Resuma en 3 líneas a qué se dedica nuestra empresa",
    "Dígame 3 formas en que puede ayudar con el trabajo de nuestro equipo",
    "Lea el archivo `{path}` y",
    "No tenía permiso de escritura en {path}. Guarde el mismo contenido en mi carpeta.",
    "No se permitió el guardado anterior. Guarde el mismo contenido en mi carpeta.",
    "El artefacto \"{title}\" (id: {key}, v{version}) falla al ejecutarse:",
  ],
}
