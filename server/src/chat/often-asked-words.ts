// The fixed word lists of "what my group often asks" (chat/often-asked.ts; docs/DECISIONS.md "Home: what my group
// often asks"). A sentence the AI writes is read word by word: a function word (STOP) or a plain word for what to do
// (GENERIC: verbs and manner words, never a noun that names a topic) needs no one; every other word (a topic) must be
// in the item's lines of each of 3 or more people, else the sentence is dropped (fail closed: a word that is not here
// and not typed by those people never passes, whatever the AI meant).
// - ENDINGS: what Korean (and a few Japanese) words end with; a word is also read without one of them.
// - APP_PROMPTS: what the app itself puts in the box (web/src/i18n, checked against it by
//   tests/unit/b-often-asked-words.test.ts), as templates: such a line is never counted as someone's question.
import type { Locale } from '@mycel/shared/api'

const list = (s: string) => s.trim().split(/\s+/)

export const STOP = new Set(list(`
  a an the to for of in on at by with from into about and or but so as is are be it its this that these those there
  i me my mine we us our you your he she they them their what how which who whom when where why whether can could
  would should will shall may might must do does did done please just also some any all each every more most less few
  one other same such than then up down out over under again very really new
  좀 그 이 저 것 거 게 수 등 및 또는 그리고 하고 해 해줘 줘 주세요 해주세요 줄래 줄래요 할 한 하는 하기 하면 해서 해요
  했어 했던 되는 된 될 있는 있어 있나요 있을까 없는 어떻게 무엇 뭐 뭘 어떤 왜 언제 어디 누가
  에 에서 에게 한테 으로 로 을 를 이 가 은 는 의 도 만 와 과 랑 이랑 까지 부터 처럼 보다 대해 대한 관련 위한 위해 같이 같은 맞게 대로
  요 다 고 서 면 며 지 나 죠 네
  の を に は が で と も へ や から まで より て た だ です ます ください して する した し い な こと もの これ それ この その
  ため よう ように について など か ね よ
  de la el los las un una y o en con por para del al que es son se su sus mi mis lo como más
  dan atau yang di ke dari untuk dengan ini itu saya kami kita tolong bisa apa bagaimana ada
`))

/** Plain words for what to do and how (verbs and manner words, in five languages). Never a noun that names a topic:
 * "report", "meeting", "resume" or "회의록" must come from the people. */
export const GENERIC = new Set(list(`
  summarize summarise write draft translate check review explain list compare create make give show find plan prepare
  update rewrite improve edit fix format turn suggest outline analyze analyse organize organise sort answer reply
  respond help shorten simplify proofread polish short shorter simple simply quick quickly brief briefly clear clearly
  formal politely polite better
  요약 정리 작성 초안 번역 확인 검토 설명 비교 분석 추천 제안 준비 수정 고쳐 다듬어 다듬기 개선 만들어 만들기 만들 써 써줘 쓰기
  알려 알려줘 찾아 찾아줘 정리해 요약해 작성해 번역해 확인해 검토해 설명해 비교해 분석해 추천해 만들어줘 바꿔 바꿔줘 뽑아 뽑아줘
  줄여 줄여줘 채워 채워줘 다시 짧게 간단히 간단하게 쉽게 자세히 정중하게 깔끔하게
  要約 まとめ まとめて 作成 翻訳 確認 説明 比較 分析 提案 修正 書いて 作って 教えて 短く 簡単に
  resumen resumir escribir redactar traducir revisar explicar comparar crear preparar
  ringkas rangkum tulis buatkan terjemahkan periksa jelaskan bandingkan siapkan
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
