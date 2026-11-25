// Korean particles after a filled-in value ("{name}을(를)" with Canva reads "Canva를", with Notion "Notion을"). A
// particle's form follows the last sound of the word before it as it is read aloud: a Hangul syllable by its final
// consonant, a number as it is read (1 일, 3 삼), a Latin name as Korean speakers say it (Canva 캔바, Gmail 지메일). A
// name whose reading cannot be told keeps the written-out form "을(를)". The web app fills every text through this
// (web/src/i18n format). Particles are written as escapes: Hangul literals belong in the language tables
// (tests/unit/i18n-languages.test.ts).

/** How a word ends when read aloud in Korean: a vowel, ㄹ (which takes 로, not 으로), or another final consonant. */
export type KoEnding = 'vowel' | 'rieul' | 'consonant'

const V = 'vowel', L = 'rieul', C = 'consonant'

/** Known service and product names (lowercase), by the last sound of their usual Korean reading. Looked up with the
 * whole name first ("wordpress.com"), then its last word ("Google Drive" -> drive). Add a name only when its Korean
 * reading is the common one. */
const NAMES: Record<string, KoEnding> = {
  // 캔바 피그마 리니어 스트라이프 수파베이스 클라우드플레어 힉스필드 에이레프스 브렉스 캘린들리 클라우디너리 차트 민트리파이
  canva: V, figma: V, linear: V, stripe: V, supabase: V, cloudflare: V, higgsfield: V, ahrefs: V, brex: V, calendly: V,
  cloudinary: V, chart: V, mintlify: V,
  // 먼데이 넷리파이 오픈라우터 포스트호그 레일웨이 레이저페이 리센드 새니티 센트리 스퀘어 투두이스트 웹플로 윅스 워드프레스 인디드
  monday: V, netlify: V, openrouter: V, posthog: V, railway: V, razorpay: V, resend: V, sanity: V, sentry: V,
  square: V, todoist: V, webflow: V, wix: V, wordpress: V, indeed: V,
  // 드라이브 독스 시트 슬라이드 캘린더 폼즈 미트 지라 컨플루언스 트렐로 아사나 드롭박스 디스코드 팀즈 워드 파워포인트
  drive: V, docs: V, sheets: V, slides: V, calendar: V, forms: V, meet: V, jira: V, confluence: V, trello: V, asana: V,
  dropbox: V, discord: V, teams: V, word: V, powerpoint: V,
  // 원드라이브 셰어포인트 세일즈포스 미로 재피어 젠데스크 유튜브 카카오 네이버 웍스 클로드 코드 코덱스 챗지피티 오픈에이아이
  onedrive: V, sharepoint: V, salesforce: V, miro: V, zapier: V, zendesk: V, youtube: V, kakao: V, naver: V, works: V,
  claude: V, code: V, codex: V, chatgpt: V, openai: V,
  // 제미나이 퍼플렉시티 브레이브 엑사 태빌리 감마 박스 엑스 스레드 쇼피파이 메일침프 코다 에버노트 도커 파이어베이스 헤로쿠
  gemini: V, perplexity: V, brave: V, exa: V, tavily: V, gamma: V, box: V, granola: V, x: V, threads: V, shopify: V, mailchimp: V,
  coda: V, evernote: V, docker: V, firebase: V, heroku: V,
  // 사파리 두레이 플렉스 잔디 하이웍스 오피스 마이크로소프트 아이클라우드 키노트 페이지스 넘버스
  safari: V, dooray: V, flex: V, jandi: V, hiworks: V, office: V, microsoft: V, icloud: V, keynote: V, pages: V, numbers: V,
  // 지메일 구글 엑셀 에어테이블 페이팔 플래닛스케일 버셀 메일 애플
  gmail: L, google: L, excel: L, airtable: L, paypal: L, planetscale: L, vercel: L, mail: L, apple: L,
  // 노션 슬랙 깃허브 깃랩 아틀라시안 클릭업 인터컴 네온 포스트맨 허브스팟 줌 아웃룩 카카오톡 라인 텔레그램 왓츠앱
  notion: C, slack: C, github: C, gitlab: C, atlassian: C, clickup: C, intercom: C, neon: C, postman: C, hubspot: C,
  zoom: C, outlook: C, kakaotalk: C, line: C, telegram: C, whatsapp: C,
  // 인스타그램 페이스북 링크드인 크롬 룸 피그잼 옵시디언 한컴 스윗 노트북LM 워드프레스닷컴
  instagram: C, facebook: C, linkedin: C, chrome: C, loom: C, figjam: C, obsidian: C, hancom: C, swit: C, notebooklm: C,
  'wordpress.com': C,
}

/** File extensions with a vowel letter, or not read letter by letter, by their usual Korean reading (docx 독스, json
 * 제이슨, jpeg 제이펙, zip 집, gif 지아이에프, webp 웹피, mov 엠오브이, hwpx 에이치더블유피엑스 is spelled) */
const FILE_EXT: Record<string, KoEnding> = { docx: V, doc: V, json: C, jpeg: C, zip: C, gif: V, webp: V, mov: V, key: V, pages: V, numbers: V, epub: C, heic: C }

/** A number ends as it is read: 0 영, 3 삼, 6 육 end in a consonant; 1 일, 7 칠, 8 팔 in ㄹ; 2 4 5 9 in a vowel. */
const DIGIT: Record<string, KoEnding> = { 0: C, 1: L, 2: V, 3: C, 4: V, 5: V, 6: C, 7: L, 8: L, 9: V }
/** A letter read on its own (an abbreviation like MCP or SQL): L 엘 and R 알 end in ㄹ, M 엠 and N 엔 in a consonant, the
 * others (에이, 비, 씨, 피, 엑스 …) in a vowel. */
/** Abbreviations with a vowel letter that are still read letter by letter. */
const SPELLED = new Set(['AI', 'API', 'URL', 'AWS', 'IBM', 'UI', 'UX', 'OS', 'IT', 'HR', 'PR', 'QA', 'CEO', 'CTO', 'CFO', 'ERP', 'OCR', 'SEO', 'EOD'])
const letterEnding = (ch: string): KoEnding => ('LR'.includes(ch) ? L : 'MN'.includes(ch) ? C : V)

/** How a value ends when read aloud in Korean, or null when that cannot be told (an unknown Latin name, a sign). A
 * closing quote or bracket, and a full stop after the value, are not read. */
export function koEnding(value: string): KoEnding | null {
  const v = value.normalize('NFC').trim().replace(/[\s'"’”」』»)\].,!?]+$/u, '')
  const last = [...v].pop() ?? ''
  const c = last.codePointAt(0) ?? 0
  if (c >= 0xac00 && c <= 0xd7a3) {
    const f = (c - 0xac00) % 28
    return f === 0 ? V : f === 8 ? L : C
  }
  if (/[0-9]/.test(last)) return DIGIT[last]!
  if (!/[A-Za-z]/.test(last)) return null
  const word = /[A-Za-z0-9.&+-]+$/.exec(v)?.[0].replace(/^[.&+-]+/, '') ?? ''
  const known = NAMES[v.toLowerCase()] ?? NAMES[word.toLowerCase()]
  if (known) return known
  // a file name ends as its extension is read (QA b3s TC-b3s-17: "주간 실적.xlsx을(를)"): a known one by its usual reading,
  // else letter by letter when it has no vowel letter (pdf 피디에프, xlsx 엑스엘에스엑스, html 에이치티엠엘)
  const ext = /[^\s.]\.([A-Za-z]{2,5})$/.exec(v)?.[1]
  if (ext) {
    const e = FILE_EXT[ext.toLowerCase()]
    if (e) return e
    if (!/[aeiou]/i.test(ext)) return letterEnding(ext.slice(-1).toUpperCase())
  }
  // an abbreviation in capitals is read letter by letter only when it has no vowel letter (MCP, HWP, SQL, CRM, PDF) or
  // is a known one (AI, API, URL, AWS, IBM); other capital words (WEB, HOME, FILE) are read as words: not told
  if (/^[A-Z][A-Z0-9]{1,4}$/.test(word) && (!/[AEIOU]/.test(word) || SPELLED.has(word))) return letterEnding(last)
  return null
}

/** The particle marks a Korean text may put after a placeholder, with their forms: [after a consonant, after a vowel].
 * In order: 을(를), (을)를, 이(가), 은(는), 와(과), 과(와), (으)로; "(으)로" also takes its vowel form after ㄹ. */
const MARKS: Record<string, [string, string]> = {
  '\uc744(\ub97c)': ['\uc744', '\ub97c'],
  '(\uc744)\ub97c': ['\uc744', '\ub97c'],
  '\uc774(\uac00)': ['\uc774', '\uac00'],
  '\uc740(\ub294)': ['\uc740', '\ub294'],
  '\uc640(\uacfc)': ['\uacfc', '\uc640'],
  '\uacfc(\uc640)': ['\uacfc', '\uc640'],
  '(\uc73c)\ub85c': ['\uc73c\ub85c', '\ub85c'],
}
const RO = '(\uc73c)\ub85c'

/** The marks as a regular expression alternative (for a text's "{name}을(를)"), in the order of MARKS: no mark is the
 * start of another, so the order does not matter. */
export const KO_PARTICLE_MARKS: readonly string[] = Object.keys(MARKS)
export const KO_PARTICLE_PATTERN = KO_PARTICLE_MARKS.map((m) => m.replace(/[()]/g, '\\$&')).join('|')

/** The form of a particle mark ("을(를)", "(으)로" …) that fits the value as it is read; the mark as written when that
 * cannot be told, and any other text unchanged. */
export function koParticle(value: string, mark: string): string {
  const forms = MARKS[mark]
  if (!forms) return mark
  const end = koEnding(value)
  if (end === null) return mark
  if (end === V || (end === L && mark === RO)) return forms[1]
  return forms[0]
}
