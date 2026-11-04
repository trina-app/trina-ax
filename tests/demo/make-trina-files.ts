// Regenerates the spreadsheets of the Trina demo company (scripts/demo/trina/files/<team path>), which
// `bun run demo:trina` uploads. The outputs are committed, so this only runs when the samples change:
//
//   bun tests/demo/make-trina-files.ts
//
// Only the .xlsx files come from here (SheetJS); the Markdown next to them is written by hand. The company, its
// people, customers and numbers are all made up. The budgets are built from one table, so the company sheet is
// always the sum of the team sheets; the script refuses to write if a total drifts.
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

const OUT = path.resolve(import.meta.dir, '..', '..', 'scripts', 'demo', 'trina', 'files')

type Cell = string | number | null

function write(rel: string, wb: XLSX.WorkBook) {
  const data = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }))
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  console.log(`wrote ${rel} (${data.byteLength} bytes)`)
}

/** A sheet from rows; numbers in the `money` columns get a thousands format. */
function sheet(rows: Cell[][], widths: number[], money: number[] = []): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (let r = 1; r < rows.length; r++) {
    for (const c of money) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell?.t === 'n') cell.z = '#,##0'
    }
  }
  ws['!cols'] = widths.map(wch => ({ wch }))
  return ws
}

/** A formula with its value: viewers and the AI's xlsx reader do not recalculate. */
function formula(ws: XLSX.WorkSheet, addr: string, f: string, v: number, z = '#,##0') {
  ws[addr] = { t: 'n', f, v, z }
}

function book(...sheets: [string, XLSX.WorkSheet][]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name)
  return wb
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// ---- 2026 4분기 운영 예산 (인건비 제외) ----

type Line = { item: string, months: [number, number, number], spent: number, memo: string }
type Team = { team: string, folder: string, total: number, lines: Line[] }

const TEAMS: Team[] = [
  { team: '마케팅팀', folder: '마케팅팀', total: 45_000_000, lines: [
    { item: '광고비 (상시)', months: [7_000_000, 5_500_000, 5_500_000], spent: 6_420_000, memo: '광고비 3,000만 원 중 1,800만 원. 검색·인스타그램 상시 광고' },
    { item: '광고비 (11월 캠페인)', months: [0, 7_500_000, 4_500_000], spent: 0, memo: '광고비 3,000만 원 중 1,200만 원. 연말 사무실 간식 박스 (11/16–12/13)' },
    { item: '콘텐츠 제작', months: [2_500_000, 3_000_000, 2_500_000], spent: 2_180_000, memo: '촬영, 영상 편집, 외부 일러스트' },
    { item: '행사·박람회', months: [1_000_000, 3_000_000, 0], spent: 1_000_000, memo: '11월 오피스 박람회 부스 (10월은 계약금)' },
    { item: '도구·구독', months: [1_000_000, 1_000_000, 1_000_000], spent: 960_000, memo: '디자인 도구, 광고 분석 도구' },
  ] },
  { team: '영업팀', folder: '영업팀', total: 18_000_000, lines: [
    { item: '체험 박스 발송', months: [2_000_000, 3_500_000, 2_500_000], spent: 1_740_000, memo: '11월 캠페인 체험 신청 증가 반영' },
    { item: '출장·교통', months: [1_000_000, 1_000_000, 1_000_000], spent: 820_000, memo: '고객사 방문, 데모 미팅' },
    { item: '고객 미팅', months: [1_000_000, 1_000_000, 1_000_000], spent: 690_000, memo: '미팅 다과, 식사' },
    { item: '영업 도구', months: [800_000, 800_000, 800_000], spent: 800_000, memo: 'CRM, 전자계약' },
    { item: '연말 고객 선물', months: [0, 0, 1_600_000], spent: 0, memo: '주요 고객사 시즌 박스 선물' },
  ] },
  { team: '인사팀', folder: '인사팀', total: 9_000_000, lines: [
    { item: '채용 광고', months: [1_200_000, 600_000, 600_000], spent: 1_150_000, memo: '10월 신입 마케터 채용 포함' },
    { item: '교육', months: [600_000, 700_000, 700_000], spent: 420_000, memo: '직무 교육, 교육비 지원' },
    { item: '연말 행사', months: [0, 0, 2_000_000], spent: 0, memo: '12월 송년회' },
    { item: '복지 (경조금·생일 등)', months: [800_000, 900_000, 900_000], spent: 730_000, memo: '' },
  ] },
  { team: '경영지원', folder: '경영지원', total: 16_000_000, lines: [
    { item: '장비', months: [2_500_000, 1_500_000, 1_000_000], spent: 1_980_000, memo: '신입 노트북 1대 포함' },
    { item: '사무 소모품·비품', months: [800_000, 800_000, 800_000], spent: 710_000, memo: '' },
    { item: '법무·세무 자문', months: [1_400_000, 1_400_000, 1_400_000], spent: 1_100_000, memo: '월 자문료, 계약서 검토' },
    { item: '보험', months: [600_000, 600_000, 600_000], spent: 600_000, memo: '영업배상, 화재' },
    { item: '사내 IT·보안', months: [900_000, 850_000, 850_000], spent: 870_000, memo: '클라우드, 백업, 보안 점검' },
  ] },
]
const COMMON = { team: '전사 공통', total: 12_000_000, spent: 3_600_000 }
const COMPANY_TOTAL = 100_000_000

const lineTotal = (l: Line) => sum(l.months)
const teamSpent = (t: Team) => sum(t.lines.map(l => l.spent))
for (const t of TEAMS) {
  const got = sum(t.lines.map(lineTotal))
  if (got !== t.total) throw new Error(`${t.team}: lines sum to ${got}, expected ${t.total}`)
}
if (sum(TEAMS.map(t => t.total)) + COMMON.total !== COMPANY_TOTAL) throw new Error('company budget is not 100,000,000')

function teamBudget(t: Team): XLSX.WorkBook {
  const n = t.lines.length
  const rows: Cell[][] = [['항목', '10월', '11월', '12월', '4분기 합계', '10월 집행', '메모']]
  for (const l of t.lines) rows.push([l.item, ...l.months, null, l.spent, l.memo])
  rows.push(['합계', null, null, null, null, null, ''])
  const ws = sheet(rows, [22, 12, 12, 12, 14, 12, 44], [1, 2, 3, 4, 5])
  t.lines.forEach((l, i) => formula(ws, `E${i + 2}`, `SUM(B${i + 2}:D${i + 2})`, lineTotal(l)))
  const last = n + 2
  const col = (c: string, v: number) => formula(ws, `${c}${last}`, `SUM(${c}2:${c}${last - 1})`, v)
  col('B', sum(t.lines.map(l => l.months[0])))
  col('C', sum(t.lines.map(l => l.months[1])))
  col('D', sum(t.lines.map(l => l.months[2])))
  col('E', t.total)
  col('F', teamSpent(t))
  return book(['4분기 예산', ws])
}

function companyBudget(): XLSX.WorkBook {
  const parts = [...TEAMS.map(t => ({ team: t.team, total: t.total, spent: teamSpent(t) })), COMMON]
  const rows: Cell[][] = [['팀', '4분기 예산', '10월 집행', '집행률']]
  for (const p of parts) rows.push([p.team, p.total, p.spent, null])
  rows.push(['합계', null, null, null])
  const ws = sheet(rows, [12, 14, 14, 10], [1, 2])
  parts.forEach((p, i) => formula(ws, `D${i + 2}`, `C${i + 2}/B${i + 2}`, p.spent / p.total, '0.0%'))
  const last = parts.length + 2
  const spent = sum(parts.map(p => p.spent))
  formula(ws, `B${last}`, `SUM(B2:B${last - 1})`, COMPANY_TOTAL)
  formula(ws, `C${last}`, `SUM(C2:C${last - 1})`, spent)
  formula(ws, `D${last}`, `C${last}/B${last}`, spent / COMPANY_TOTAL, '0.0%')
  const memo = sheet([
    ['메모'],
    ['2026년 4분기 운영 예산이에요 (인건비 제외). 2026-10-01 대표 승인.'],
    ['팀별 세부 항목은 shared/경영/팀별/<팀>/ 아래 각 팀 시트에 있어요. 팀 행 금액은 그 시트의 합계와 같아요.'],
    ['전사 공통: 그룹웨어·메신저 등 전사 구독, 사무실 공용 비용, 예비비.'],
    ['10월 집행은 10월 31일 마감 기준 (경영지원 집계). 12월 첫 주 전사 주간회의에서 다시 봐요.'],
  ], [90])
  return book(['요약', ws], ['메모', memo])
}

// ---- 영업팀 고객사 현황 ----

const CUSTOMERS: [string, string, number, string, number, string, string, string, string][] = [
  ['가람소프트', 'IT 서비스', 45, '플러스', 520_000, '2025-03-02', '배성민', '이용 중', ''],
  ['나래물류', '물류', 28, '베이직', 260_000, '2025-06-02', '임채원', '이용 중', ''],
  ['다온치과의원', '의료', 12, '베이직', 190_000, '2026-02-02', '노다은', '이용 중', ''],
  ['라온건축사무소', '건축 설계', 18, '베이직', 220_000, '2025-11-03', '배성민', '해지 예정', '11월 말 해지 (사무실 이전)'],
  ['마루세무회계', '세무·회계', 22, '베이직', 240_000, '2026-04-01', '노다은', '이용 중', ''],
  ['바른디자인랩', '디자인', 15, '베이직', 190_000, '2026-10-26', '임채원', '체험 중', '체험 박스 10/26 발송, 11/9 계약 여부 확인'],
  ['새봄교육', '교육', 60, '플러스', 690_000, '2024-09-02', '권우진', '이용 중', '연말 시즌 박스 문의'],
  ['아름법률사무소', '법률', 25, '플러스', 420_000, '2026-07-01', '배성민', '이용 중', ''],
  ['자람바이오', '바이오', 85, '플러스', 980_000, '2025-01-06', '권우진', '이용 중', '12월 인원 증가 예정'],
  ['차오름마케팅', '광고 대행', 35, '플러스', 450_000, '2026-11-02', '노다은', '체험 중', '체험 박스 11/2 발송, 11/16 계약 여부 확인'],
  ['별빛게임즈', '게임', 50, '플러스', 580_000, '2025-08-04', '임채원', '이용 중', ''],
  ['한결엔지니어링', '엔지니어링', 40, '베이직', 340_000, '2026-05-04', '배성민', '해지 예정', '12월 말 해지 (비용 절감)'],
]

function customers(): XLSX.WorkBook {
  const rows: Cell[][] = [['고객사', '업종', '인원', '플랜', '월 금액(원)', '계약 시작', '담당', '상태', '메모']]
  for (const c of CUSTOMERS) rows.push([...c])
  const ws = sheet(rows, [16, 12, 6, 8, 12, 12, 8, 10, 40], [4])
  const n = CUSTOMERS.length + 1
  const states = ['이용 중', '체험 중', '해지 예정']
  const by = (s: string) => CUSTOMERS.filter(c => c[7] === s)
  const summary = sheet([
    ['상태', '고객사 수', '월 금액 합계(원)'],
    ...states.map(s => [s, null, null] as Cell[]),
    ['합계', null, null],
    [],
    ['MRR (이용 중 + 해지 예정)', null, null],
    [],
    ['이 파일은 영업팀이 11월에 집중 관리하는 고객사 12곳이에요. 전체 고객은 CRM에서 봐요.'],
    ['체험 중 금액은 계약하면 받을 예상 금액이라 MRR에 넣지 않아요. 해지 예정은 해지일까지 청구해요.'],
  ], [26, 10, 16])
  states.forEach((s, i) => {
    const r = i + 2
    formula(summary, `B${r}`, `COUNTIF('고객사'!H2:H${n},A${r})`, by(s).length, '0')
    formula(summary, `C${r}`, `SUMIF('고객사'!H2:H${n},A${r},'고객사'!E2:E${n})`, sum(by(s).map(c => c[4])))
  })
  formula(summary, 'B5', 'SUM(B2:B4)', CUSTOMERS.length, '0')
  formula(summary, 'C5', 'SUM(C2:C4)', sum(CUSTOMERS.map(c => c[4])))
  formula(summary, 'C7', 'C2+C4', sum(by('이용 중').map(c => c[4])) + sum(by('해지 예정').map(c => c[4])))
  return book(['고객사', ws], ['요약', summary])
}

// ---- 인사팀: 급여, 상반기 평가 ----

const PEOPLE: { name: string, team: string, rank: string, base: number, grade?: string, note?: string }[] = [
  { name: '정해온', team: '대표', rank: '대표', base: 7_500_000 },
  { name: '서민재', team: '마케팅팀', rank: '팀장', base: 5_200_000, grade: 'A', note: '봄 캠페인 목표 달성, 팀 업무 분배가 안정적' },
  { name: '이하늘', team: '마케팅팀', rank: '선임', base: 3_900_000, grade: 'S', note: '검색광고 클릭 비용 18% 절감, 체험 신청 목표 120% 달성' },
  { name: '김도윤', team: '마케팅팀', rank: '선임', base: 3_700_000, grade: 'B', note: '소재 품질은 좋으나 일정 지연 2회, 중간 공유 필요' },
  { name: '최유나', team: '마케팅팀', rank: '매니저', base: 3_600_000, grade: 'A', note: '블로그 월 4편 꾸준히 발행, 검색 유입 1.5배' },
  { name: '한지우', team: '마케팅팀', rank: '사원', base: 3_000_000, note: '11/5 입사. 10월 지급 없음 (계약 기본급 표시)' },
  { name: '권우진', team: '영업팀', rank: '팀장', base: 5_300_000, grade: 'A', note: '신규 계약 목표 105%, 50인 이상 고객 2곳 유치' },
  { name: '배성민', team: '영업팀', rank: '선임', base: 4_000_000, grade: 'B', note: '기존 고객 관리 꼼꼼함, 신규 발굴은 목표의 85%' },
  { name: '임채원', team: '영업팀', rank: '매니저', base: 3_700_000, grade: 'A', note: '체험 후 계약 전환율 팀 내 가장 높음 (32%)' },
  { name: '노다은', team: '영업팀', rank: '사원', base: 3_300_000, grade: 'C', note: 'CRM 입력 누락이 잦음, 하반기 코칭 계획 세움' },
  { name: '문서윤', team: '인사팀', rank: '팀장', base: 5_000_000, grade: 'B', note: '채용 절차 정비, 평가 제도 개편은 하반기로 넘김' },
  { name: '조은비', team: '인사팀', rank: '매니저', base: 3_500_000, grade: 'B', note: '급여·근태 처리 오류 없음, 맡는 업무 범위 넓히기' },
  { name: '류재희', team: '경영지원', rank: '팀장', base: 5_100_000, grade: 'B', note: '월 결산 일정 지킴, 비용 처리 기준 문서화 진행 중' },
  { name: '탁윤서', team: '경영지원', rank: '매니저', base: 3_600_000, grade: 'B', note: '비용 처리 기간 평균 3일에서 2일로 줄임' },
  { name: '장하람', team: '경영지원', rank: '사원', base: 3_400_000, grade: 'B', note: '장비 관리 대장 정비, 보안 점검 1회 완료' },
]
const MEAL = 200_000

function payroll(): XLSX.WorkBook {
  const rows: Cell[][] = [['이름', '팀', '직급', '기본급', '식대', '지급 합계', '비고']]
  // the new hire is the only person without a grade and with a note: the note is about pay, not a review
  for (const p of PEOPLE) rows.push([p.name, p.team, p.rank, p.base, MEAL, null, p.grade ? '' : p.note ?? ''])
  rows.push(['합계', '', '', null, null, null, ''])
  rows.push([])
  rows.push(['2026년 10월분, 10월 25일 지급. 세전 금액이에요.'])
  const ws = sheet(rows, [8, 10, 8, 12, 10, 12, 40], [3, 4, 5])
  let paid = 0
  PEOPLE.forEach((p, i) => {
    const r = i + 2
    if (p.name === '한지우') { ws[`F${r}`] = { t: 'n', v: 0, z: '#,##0' }; return }
    paid += p.base + MEAL
    formula(ws, `F${r}`, `D${r}+E${r}`, p.base + MEAL)
  })
  const last = PEOPLE.length + 2
  const hired = PEOPLE.filter(p => p.name !== '한지우')
  // the totals count what was paid in October, so the new hire's contract salary is left out
  formula(ws, `D${last}`, `SUMIF(F2:F${last - 1},">0",D2:D${last - 1})`, sum(hired.map(p => p.base)))
  formula(ws, `E${last}`, `SUMIF(F2:F${last - 1},">0",E2:E${last - 1})`, MEAL * hired.length)
  formula(ws, `F${last}`, `SUM(F2:F${last - 1})`, paid)
  return book(['2026-10 급여', ws])
}

function review(): XLSX.WorkBook {
  const rated = PEOPLE.filter(p => p.grade)
  const ws = sheet([['이름', '팀', '등급', '한 줄 코멘트'], ...rated.map(p => [p.name, p.team, p.grade!, p.note!])], [8, 10, 6, 52])
  const n = rated.length + 1
  const grades = ['S', 'A', 'B', 'C']
  const teams = ['마케팅팀', '영업팀', '인사팀', '경영지원']
  const cols = ['B', 'C', 'D', 'E']
  const summary = sheet([
    ['팀', ...grades, '인원'],
    ...teams.map(t => [t] as Cell[]),
    ['합계'],
    [],
    ['평가 기간 2026-01-01 ~ 06-30. 팀원은 팀장이, 팀장은 대표가 평가했어요.'],
    ['대표는 평가 대상이 아니고, 한지우(11/5 입사)는 이번 평가에 들어가지 않아요.'],
  ], [10, 6, 6, 6, 6, 8])
  teams.forEach((t, i) => {
    const r = i + 2
    grades.forEach((g, j) => formula(summary, `${cols[j]}${r}`, `COUNTIFS('평가'!B2:B${n},A${r},'평가'!C2:C${n},"${g}")`, rated.filter(p => p.team === t && p.grade === g).length, '0'))
    formula(summary, `F${r}`, `SUM(B${r}:E${r})`, rated.filter(p => p.team === t).length, '0')
  })
  const last = teams.length + 2
  grades.forEach((g, j) => formula(summary, `${cols[j]}${last}`, `SUM(${cols[j]}2:${cols[j]}${last - 1})`, rated.filter(p => p.grade === g).length, '0'))
  formula(summary, `F${last}`, `SUM(F2:F${last - 1})`, rated.length, '0')
  return book(['평가', ws], ['요약', summary])
}

write('shared/경영/2026-4분기-예산-전사.xlsx', companyBudget())
for (const t of TEAMS) write(`shared/경영/팀별/${t.folder}/2026-4분기-${t.folder}-예산.xlsx`, teamBudget(t))
write('groups/영업팀/고객사-현황.xlsx', customers())
write('groups/인사팀/급여표.xlsx', payroll())
write('groups/인사팀/2026-상반기-평가.xlsx', review())
