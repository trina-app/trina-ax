// "Looks like a personal document": the hint behind "Save to team folder" (rooms/save-to-team.ts; docs/decisions/
// 20261117-room-file-save-btn.md). A file that matches gets no pre-selected folder and a gentle note; the person may still
// pick a folder and save it. A hint only: a false alarm costs one suggestion, a miss could put a named person's
// contract in front of the whole company with one click (TC-4804), so it leans towards flagging.
//
// Three sources, from the strongest:
//   DOC_WORDS   personal documents by name (an ID card, a passport, a bank book, a payslip, an employment contract, a CV,
//               a medical certificate …) in the file's name OR the words it was sent with (room name, message, thread
//               root), in the six languages of the app.
//   NAME_WORDS  broad words that mean a personal document in a FILE NAME but not in a chat line ("급여" in
//               "급여대장.xlsx" is payroll; "광고 성적" in a message is an ad's performance).
//   HR + name   "<HR word>_<Korean personal name>" or "<name>_<HR word>": an HR, contract or medical word in the name and
//               a 2–4 syllable Hangul token at its start or end (after "_", a space or "-") that starts with a common
//               surname and is not an ordinary word or a team/company name ("인사평가_김민수.xlsx", "홍길동_사직서.hwp",
//               not "휴가신청서_양식.txt" or "계약서_삼성전자.pdf").
// Plus a Korean resident registration number in those words or in a small text file's content.
// Non-ASCII words are written as escapes (patterns, not screen text: tests/unit/i18n-languages.test.ts).

/** whole Latin-script words: an underscore, a dash or a digit next to one still splits it ("KTP_budi", "CV_Budi") */
const latin = (ws: readonly string[]) => ws.map((w) => `(?<![\\p{L}])${w}(?![\\p{L}])`)

const DOC_WORDS = new RegExp([
  // Korean: ID card, resident registration, resident number, bank book, passport, driver's licence, payslip, employment
  // certificate, resident register copy (both kinds), seal certificate, alien registration, family relations; employment
  // contract (근로/고용), salary contract, personnel record, CV, cover letter, health check-up, medical certificate,
  // academic transcript (not "personal information": a privacy policy or a privacy team's room would lose every
  // suggestion)
  '\uC2E0\uBD84\uC99D', '\uC8FC\uBBFC\uB4F1\uB85D', '\uC8FC\uBBFC\uBC88\uD638', '(?<!\uACF5)\uD1B5\uC7A5', '\uC5EC\uAD8C',
  '\uC6B4\uC804\uBA74\uD5C8', '\uAE09\uC5EC\uBA85\uC138', '\uC7AC\uC9C1\uC99D\uBA85', '\uB4F1\uBCF8', '\uCD08\uBCF8',
  '\uC778\uAC10\uC99D\uBA85', '\uC678\uAD6D\uC778\uB4F1\uB85D', '\uAC00\uC871\uAD00\uACC4',
  '\uADFC\uB85C\uACC4\uC57D', '\uACE0\uC6A9\uACC4\uC57D', '\uC5F0\uBD09\uACC4\uC57D', '\uC778\uC0AC\uAE30\uB85D', '\uC778\uC0AC\uCE74\uB4DC',
  '\uC774\uB825\uC11C', '\uC790\uAE30\uC18C\uAC1C\uC11C', '\uAC74\uAC15\uAC80\uC9C4', '\uC9C4\uB2E8\uC11C', '\uC131\uC801\uC99D\uBA85',
  '\uC6D0\uCC9C\uC9D5\uC218', '\uACBD\uB825\uC99D\uBA85', '\uC878\uC5C5\uC99D\uBA85', '\uAC74\uAC15\uBCF4\uD5D8\uC790\uACA9', '4\uB300\uBCF4\uD5D8\uAC00\uC785', '\uCC98\uBC29\uC804', '\uC18C\uACAC\uC11C', '\uC9C4\uB8CC\uBE44', '\uC0AC\uC6D0\uC99D', '\uC2DC\uB9D0\uC11C', '\uC7A5\uC560\uC778\uC99D\uBA85', '\uBCD1\uC801\uC99D\uBA85',
  // Japanese and Chinese: ID card (both), bank book (both), passport (both), driver's licence, My Number, residence card,
  // bank card; payslip (ja, zh), employment certificate (ja, zh), seal certificate (ja), family register (ja/zh),
  // resident record (ja); employment contract (ja: 雇用/労働契約, 年俸契約; zh: 劳动/雇佣合同), personnel record (ja, zh),
  // CV (ja: 履歴書, 職務経歴書; zh: 简历, 履历), health check-up (ja, zh), medical certificate (ja, zh: 诊断书/诊断证明),
  // transcript (ja 成績証明, zh 成绩单)
  '\u8EAB\u5206\u8A3C', '\u8EAB\u4EFD\u8BC1', '\u901A\u5E33', '\u5B58\u6298', '\u62A4\u7167', '\u30D1\u30B9\u30DD\u30FC\u30C8',
  '\u514D\u8A31\u8A3C', '\u9A7E\u9A76\u8BC1', '\u30DE\u30A4\u30CA\u30F3\u30D0\u30FC', '\u5728\u7559\u30AB\u30FC\u30C9',
  '\u94F6\u884C\u5361', '\u7D66\u4E0E\u660E\u7D30', '\u5DE5\u8D44\u5355', '\u5728\u7C4D\u8A3C\u660E', '\u5728\u804C\u8BC1\u660E',
  '\u5370\u9451\u8A3C\u660E', '\u6236\u7C4D', '\u6238\u7C4D', '\u6237\u7C4D', '\u6E90\u6CC9\u5FB4\u53CE', '\u6237\u53E3\u672C', '\u4F4F\u6C11\u7968',
  '\u96C7\u7528\u5951\u7D04', '\u52B4\u50CD\u5951\u7D04', '\u5E74\u4FF8\u5951\u7D04', '\u52B3\u52A8\u5408\u540C', '\u96C7\u4F63\u5408\u540C',
  '\u4EBA\u4E8B\u8A18\u9332', '\u4EBA\u4E8B\u6863\u6848', '\u5C65\u6B74\u66F8', '\u8077\u52D9\u7D4C\u6B74\u66F8', '\u7B80\u5386', '\u5C65\u5386',
  '\u5065\u5EB7\u8A3A\u65AD', '\u4F53\u68C0', '\u8A3A\u65AD\u66F8', '\u8BCA\u65AD\u4E66', '\u8BCA\u65AD\u8BC1\u660E', '\u6210\u7E3E\u8A3C\u660E', '\u6210\u7EE9\u5355',
  // English, Indonesian, Spanish
  ...latin(['id[\\s_-]?card', 'identity[\\s_-]?card', 'passport', 'bank[\\s_-]?book', 'bankbook', 'bank[\\s_-]?statement',
    "driver'?s?[\\s_-]?licen[cs]e", 'resident[\\s_-]?registration', 'social[\\s_-]?security', 'ssn', 'ktp', 'npwp',
    'kartu[\\s_-]?keluarga', 'buku[\\s_-]?tabungan', 'pasaporte', 'dni',
    'pay[\\s_-]?slip', 'pay[\\s_-]?stub', 'salary[\\s_-]?statement', 'employment[\\s_-]?certificate',
    'certificate[\\s_-]?of[\\s_-]?employment', 'family[\\s_-]?(?:relation|register)', 'seal[\\s_-]?certificate',
    'slip[\\s_-]?gaji', 'surat[\\s_-]?keterangan[\\s_-]?kerja', 'n[o\u00F3]mina', 'certificado[\\s_-]?de[\\s_-]?empresa',
    // employment contract, personnel record, CV, medical (en / id / es)
    '(?:employment|labou?r|work|salary)[\\s_-]?(?:contract|agreement)', 'personnel[\\s_-]?(?:record|file)s?', 'curriculum[\\s_-]?vitae',
    'medical[\\s_-]?(?:certificate|report|records?)', '(?:health|medical)[\\s_-]?check[\\s_-]?ups?', 'sick[\\s_-]?note', "doctor'?s[\\s_-]?note",
    'academic[\\s_-]?transcript', 'report[\\s_-]?card',
    'kontrak[\\s_-]?kerja', 'perjanjian[\\s_-]?kerja', '(?:daftar[\\s_-]?)?riwayat[\\s_-]?hidup', 'surat[\\s_-]?keterangan[\\s_-]?(?:sehat|sakit|dokter)',
    'surat[\\s_-]?dokter', 'pemeriksaan[\\s_-]?kesehatan', 'transkrip[\\s_-]?nilai', 'rapor',
    'contrato[\\s_-]?(?:de[\\s_-]?trabajo|laboral)', 'expediente[\\s_-]?(?:personal|acad[e\u00E9]mico)', 'curr\u00EDculum',
    'birth[\\s_-]?certificate', 'offer[\\s_-]?letter', 'lebenslauf',
    '(?:certificado|informe|reconocimiento)[\\s_-]?m[e\u00E9]dico', 'bolet[i\u00ED]n[\\s_-]?de[\\s_-]?notas']),
].join('|'), 'iu')

const NAME_WORDS = new RegExp([
  // Korean: pay (급여), annual salary (연봉), report card (성적표); Japanese: pay (給与), report card (成績表); Chinese:
  // wages, salary, pay (工资, 薪资, 薪酬)
  '\uAE09\uC5EC', '\uC5F0\uBD09', '\uC131\uC801\uD45C', '\u7D66\u4E0E', '\u6210\u7E3E\u8868', '\u5DE5\u8D44', '\u85AA\u8D44', '\u85AA\u916C',
  ...latin(['r[e\u00E9]sum[e\u00E9]', 'cv', 'salary', 'salaries', 'payroll', 'gaji', 'salario', 'calificaciones', 'w-?2', 'tax[\\s_-]?returns?', 'performance[\\s_-]?review']),
].join('|'), 'iu')

/** HR, contract and medical words that make a trailing or leading Korean name personal (Korean). */
const HR_WORDS = new RegExp([
  // 근로, 고용, 연봉, 인사, 평가, 면접, 채용, 입사, 퇴사, 사직, 경위서, 시말서, 징계, 휴직, 복직, 재직, 경력, 급여, 상여, 퇴직,
  // 이력, 자기소개, 근태, 휴가, 연차, 증명서, 검진, 진단, 성적, 고과, 승진, 발령, 연말정산, 원천징수, 보험, 처방, 소견
  '\uADFC\uB85C', '\uACE0\uC6A9', '\uC5F0\uBD09', '\uC778\uC0AC', '\uD3C9\uAC00', '\uBA74\uC811', '\uCC44\uC6A9', '\uC785\uC0AC', '\uD1F4\uC0AC',
  '\uC0AC\uC9C1', '\uACBD\uC704\uC11C', '\uC2DC\uB9D0\uC11C', '\uC9D5\uACC4', '\uD734\uC9C1', '\uBCF5\uC9C1', '\uC7AC\uC9C1', '\uACBD\uB825',
  '\uAE09\uC5EC', '\uC0C1\uC5EC', '\uD1F4\uC9C1', '\uC774\uB825', '\uC790\uAE30\uC18C\uAC1C', '\uADFC\uD0DC', '\uD734\uAC00', '\uC5F0\uCC28',
  '\uC99D\uBA85\uC11C', '\uAC80\uC9C4', '\uC9C4\uB2E8', '\uC131\uC801', '\uACE0\uACFC', '\uC2B9\uC9C4', '\uBC1C\uB839', '\uC5F0\uB9D0\uC815\uC0B0', '\uC6D0\uCC9C\uC9D5\uC218', '\uBCF4\uD5D8', '\uCC98\uBC29', '\uC18C\uACAC',
].join('|'), 'u')

/** a contract or a service contract (계약, 용역): personal only with a three-syllable name */
const CONTRACT = /\uACC4\uC57D|\uC6A9\uC5ED/u

/** common Korean surnames (one syllable), and the two-syllable ones */
const SURNAMES = new Set([...'\uAE40\uC774\uBC15\uCD5C\uC815\uAC15\uC870\uC724\uC7A5\uC784\uD55C\uC624\uC11C\uC2E0\uAD8C\uD669\uC548\uC1A1\uB958\uC720\uC804\uD64D\uACE0\uBB38\uC591\uC190\uBC30\uBC31\uD5C8\uB0A8\uC2EC\uB178\uD558\uACFD\uC131\uCC28\uC8FC\uC6B0\uAD6C\uBBFC\uC9C4\uB098\uC9C0\uC5C4\uBCC0\uCC44\uC6D0\uCC9C\uBC29\uACF5\uD604\uD568\uC5FC\uC5EC\uCD94\uB3C4\uC18C\uC11D\uC120\uC124\uB9C8\uAE38\uC5F0\uC704\uD45C\uBA85\uAE30\uBC18\uB77C\uC655\uAE08\uC625\uC721\uC778\uB9F9\uC81C\uBAA8\uD0C1\uAD6D\uC5B4\uC740\uD3B8\uC6A9\uC608\uACBD\uBD09\uC0AC\uBD80\uAC00\uBCF5\uD0DC\uBAA9\uD615\uD53C\uB450\uAC10\uC74C\uBE48\uB3D9\uC628\uD638\uC88C'])
// 남궁, 황보, 제갈, 선우, 독고, 사공, 서문
const SURNAMES2 = new Set(['\uB0A8\uAD81', '\uD669\uBCF4', '\uC81C\uAC08', '\uC120\uC6B0', '\uB3C5\uACE0', '\uC0AC\uACF5', '\uC11C\uBB38'])

/** two-syllable words that start with a surname syllable but name a document's state or kind, not a person */
const NOT_NAMES = new Set([
  // 양식 서식 정산 정리 정보 정책 조정 최종 수정 신청 신규 사본 원본 견본 공고 안내 목록 결과 일정 기준 규정 지침 예시 작성 제출 보고 요약
  // 현황 계획 내역 명세 문서 자료 변경 갱신 연장 해지 검토 승인 전체 부서 직원 임원 본부 분기 주간 연간 연말 연초 마감 임시 진행 완료
  // 대상 초안 서명 날인 원안 하반기 상반기 전사 공유 백업 사내 회사 한글 영문 국문 사용 이용 기본 표준 통합 개정 반기
  '\uC591\uC2DD', '\uC11C\uC2DD', '\uC815\uC0B0', '\uC815\uB9AC', '\uC815\uBCF4', '\uC815\uCC45', '\uC870\uC815', '\uCD5C\uC885', '\uC218\uC815',
  '\uC2E0\uCCAD', '\uC2E0\uADDC', '\uC0AC\uBCF8', '\uC6D0\uBCF8', '\uACAC\uBCF8', '\uACF5\uACE0', '\uC548\uB0B4', '\uBAA9\uB85D', '\uACB0\uACFC',
  '\uC77C\uC815', '\uAE30\uC900', '\uADDC\uC815', '\uC9C0\uCE68', '\uC608\uC2DC', '\uC791\uC131', '\uC81C\uCD9C', '\uBCF4\uACE0', '\uC694\uC57D',
  '\uD604\uD669', '\uACC4\uD68D', '\uB0B4\uC5ED', '\uBA85\uC138', '\uBB38\uC11C', '\uC790\uB8CC', '\uBCC0\uACBD', '\uAC31\uC2E0', '\uC5F0\uC7A5',
  '\uD574\uC9C0', '\uAC80\uD1A0', '\uC2B9\uC778', '\uC804\uCCB4', '\uBD80\uC11C', '\uC9C1\uC6D0', '\uC784\uC6D0', '\uBCF8\uBD80', '\uBD84\uAE30',
  '\uC8FC\uAC04', '\uC5F0\uAC04', '\uC5F0\uB9D0', '\uC5F0\uCD08', '\uB9C8\uAC10', '\uC784\uC2DC', '\uC9C4\uD589', '\uC644\uB8CC', '\uB300\uC0C1',
  '\uCD08\uC548', '\uC11C\uBA85', '\uB0A0\uC778', '\uC6D0\uC548', '\uD558\uBC18\uAE30', '\uC0C1\uBC18\uAE30', '\uC804\uC0AC', '\uACF5\uC720',
  '\uBC31\uC5C5', '\uC0AC\uB0B4', '\uD68C\uC0AC', '\uD55C\uAE00', '\uC601\uBB38', '\uAD6D\uBB38', '\uC0AC\uC6A9', '\uC774\uC6A9', '\uAE30\uBCF8',
  '\uD45C\uC900', '\uD1B5\uD569', '\uAC1C\uC815', '\uBC18\uAE30',
  '\uACF5\uC9C0', '\uBC30\uC1A1', '\uC11C\uBC84', '\uC804\uC9C1\uC6D0', '\uC870\uB2EC\uCCAD', '\uC2E0\uC785', '\uC815\uADDC', '\uACC4\uC57D\uC9C1', '\uBCF8\uBB38', '\uC6D0\uBB38', '\uC11C\uBA85\uBCF8', '\uCD5C\uC885\uBCF8', '\uC218\uC815\uBCF8', '\uC804\uB144', '\uAE08\uB144', '\uB0B4\uB144', '\uC62C\uD574', '\uC791\uB144', '\uC548\uAC74', '\uACF5\uBB38', '\uC591\uC2DD\uBCF8', '\uC774\uB3D9', '\uAC00\uC785', '\uAD50\uC721', '\uBC15\uB78C\uD68C', '\uC124\uBB38', '\uB9C8\uCF00\uD130',
])
/** endings of a team's or a company's name (팀 부 과 실 센터 그룹 본부 전자 건설 산업 상사 은행 증권 보험 물산 화학 제약 통신 기획
 * 컴퍼니 코리아 테크 주식회사 그룹사 협회 재단 학교 병원 공사 공단 전력 에너지 홀딩스 랩 스튜디오) */
const ORG_END = new RegExp(`(?:${['\uD300', '\uBD80', '\uACFC', '\uC2E4', '\uC13C\uD130', '\uADF8\uB8F9', '\uBCF8\uBD80', '\uC804\uC790', '\uAC74\uC124', '\uC0B0\uC5C5', '\uC0C1\uC0AC', '\uC740\uD589', '\uC99D\uAD8C', '\uBCF4\uD5D8', '\uBB3C\uC0B0', '\uD654\uD559', '\uC81C\uC57D', '\uD1B5\uC2E0', '\uAE30\uD68D', '\uCEF4\uD37C\uB2C8', '\uCF54\uB9AC\uC544', '\uD14C\uD06C', '\uC8FC\uC2DD\uD68C\uC0AC', '\uD611\uD68C', '\uC7AC\uB2E8', '\uD559\uAD50', '\uBCD1\uC6D0', '\uACF5\uC0AC', '\uACF5\uB2E8', '\uC804\uB825', '\uC5D0\uB108\uC9C0', '\uD640\uB529\uC2A4', '\uB7A9', '\uC2A4\uD29C\uB514\uC624'].join('|')})$`, 'u')

/** job titles and honorifics written after a name ("김민수 대리", "김민수님"): 님 대리 과장 차장 부장 사원 주임 팀장 실장 이사
 * 대표 선임 책임 수석 매니저 인턴 */
const TITLES = new Set(['\uB2D8', '\uB300\uB9AC', '\uACFC\uC7A5', '\uCC28\uC7A5', '\uBD80\uC7A5', '\uC0AC\uC6D0', '\uC8FC\uC784', '\uD300\uC7A5', '\uC2E4\uC7A5', '\uC774\uC0AC', '\uB300\uD45C', '\uC120\uC784', '\uCC45\uC784', '\uC218\uC11D', '\uB9E4\uB2C8\uC800', '\uC778\uD134'])

/** A 2–4 syllable Hangul token that reads as a person's name. */
function personName(t: string): boolean {
  if (!/^[\uAC00-\uD7A3]{2,4}$/u.test(t) || NOT_NAMES.has(t) || ORG_END.test(t) || HR_WORDS.test(t)) return false
  // a longer ordinary word ("최종본", "공고문", "기준표"), not a name like "조정민" or "이용수"
  if (t.length === 3 && /[\uBCF8\uBB38\uD45C\uB85D\uC9D1\uC548]$/u.test(t) && NOT_NAMES.has(t.slice(0, 2))) return false
  if (t.length === 4) return SURNAMES2.has(t.slice(0, 2))
  return SURNAMES.has(t[0]!) || (t.length === 3 && SURNAMES2.has(t.slice(0, 2)))
}

/** The name's parts: split on spaces, "_", ".", "-", "·" and brackets (NFKC first: a full-width "＿" is "_"), a 님 or
 * job title after a name taken off ("김민수님", "김민수 대리"), digits, dates and versions dropped. */
function parts(name: string): string[] {
  const i = name.lastIndexOf('.')
  const stem = i > 0 ? name.slice(0, i) : name
  const out: string[] = []
  for (let t of stem.split(/[\s_.\-\u00B7()[\]{},\uFF0C+&~#]+/u)) {
    if (!t || /^v?\d[\d,]*$/iu.test(t) || TITLES.has(t)) continue
    for (const x of TITLES) if (t.length > x.length + 1 && t.endsWith(x) && /^[\uAC00-\uD7A3]+$/u.test(t)) { t = t.slice(0, -x.length); break }
    out.push(t)
  }
  return out
}

/** "<HR word>_<name>" in any order and position ("인사평가_김민수.xlsx", "[홍길동] 계약서.pdf", "2026_인사평가_김민수 대리_최종"):
 * one part a Korean personal name, another an HR, contract or medical word. "계약" (most contracts are with companies)
 * needs a three-syllable name, the common length of a person's name and rarer for a company's. */
export function hrDocOfPerson(name: string): boolean {
  const ps = parts(name.normalize('NFKC'))
  for (const [i, t] of ps.entries()) {
    if (!personName(t)) continue
    const rest = ps.filter((_, j) => j !== i).join(' ')
    if (HR_WORDS.test(rest)) return true
    if (t.length === 3 && CONTRACT.test(rest)) return true
  }
  return false
}

/** a Korean resident registration number (as the file list's scrubber knows it: file-list/format.ts) */
const RESIDENT_NUMBER = /\b\d{6}\s*-\s*[1-8]\d{6}\b/
const TEXTISH = /^(txt|csv|tsv|md|json|xml|html?)$/i

/** The file looks like a personal document: by its name, the words it was sent with, or (a small text file) a resident
 * number in it. A hint only: it takes the suggestion away and shows a note; the person may still save it. */
export function looksSensitive(name: string, words: string, bytes?: () => Buffer | null): boolean {
  // NFKC: a name from a Mac upload (NFD) and full-width letters ("ＰＡＳＳＰＯＲＴ") read as their plain forms
  const n = name.normalize('NFKC')
  const said = `${n}\n${words.normalize('NFKC')}`
  if (DOC_WORDS.test(said) || RESIDENT_NUMBER.test(said) || NAME_WORDS.test(n) || hrDocOfPerson(n)) return true
  const e = name.slice(name.lastIndexOf('.') + 1)
  if (!bytes || !TEXTISH.test(e)) return false
  const b = bytes()
  return !!b && RESIDENT_NUMBER.test(b.toString('utf8'))
}
