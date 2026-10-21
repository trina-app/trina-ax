// Regenerates the sample files of the demo team (scripts/demo/files/<team path>), which `bun run demo:seed`
// uploads. The outputs are committed, so this only runs when the samples change:
//
//   bun tests/demo/make-files.ts
//
// Markdown is written as is, the .docx through pandoc, the .xlsx with SheetJS and the PDF by printing an HTML page
// in Playwright's Chromium (Korean text needs a real font, which the tiny fixture PDF writer does not have).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import * as XLSX from 'xlsx'

const OUT = path.resolve(import.meta.dir, '..', '..', 'scripts', 'demo', 'files')

function write(rel: string, data: string | Uint8Array) {
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  console.log(`wrote ${rel} (${typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength} bytes)`)
}

const WEEKLY = `# 주간 전체회의 회의록

- 일시: 2026년 10월 20일(월) 10:00–10:50
- 장소: 본사 3층 회의실 / 온라인 병행
- 참석: Dion(대표), 관리자1, Alice(마케팅), Bob(재무)
- 작성: Alice

## 1. 지난주 실적

| 항목 | 목표 | 실적 | 비고 |
|---|---|---|---|
| 신규 문의 | 40건 | 46건 | 가을 캠페인 효과 |
| 계약 | 6건 | 5건 | 1건은 11월 첫째 주로 연기 |
| 매출 | 1억 2,000만 원 | 1억 1,350만 원 | 목표 대비 94.6% |

## 2. 논의 사항

1. **가을 캠페인 2차 집행** — 1차 집행 결과(클릭률 2.8%)가 좋아 예산 1,500만 원을 추가 배정하기로 함. 소재는 Alice가 수요일까지 3종 준비.
2. **4분기 예산 조정** — 재무팀에서 광고비 항목 상향 요청. Bob이 수정안을 목요일 회의 전까지 공유하기로 함(\`groups/재무/2026-4분기-예산.xlsx\`).
3. **신제품 출시 일정** — 11월 24일 출시 목표 유지. 랜딩 페이지 문구 검토는 다음 주 화요일까지.
4. **사내 AI 도구 도입** — 이번 주부터 Team AX 시범 사용. 각자 회의록 정리와 보고서 초안에 써 보고 금요일에 의견 공유.

## 3. 결정 사항

- 가을 캠페인 2차 예산 1,500만 원 승인
- 신제품 출시일 11월 24일 확정
- 주간 회의록은 \`shared/회의록/\` 폴더에 날짜-제목 형식으로 저장

## 4. 할 일

| 담당 | 할 일 | 기한 |
|---|---|---|
| Alice | 캠페인 2차 소재 3종 | 10/22(수) |
| Bob | 4분기 예산 수정안 공유 | 10/23(목) |
| 관리자1 | Team AX 계정 안내 및 폴더 권한 정리 | 10/21(화) |
| Dion | 신제품 가격 최종 결정 | 10/24(금) |

다음 회의: 2026년 10월 27일(월) 10:00
`

const MARKETING = `# 마케팅팀 회의록 — 가을 캠페인 점검

- 일시: 2026년 10월 14일(화) 14:00–15:00
- 참석: Alice, 마케팅팀 2명
- 작성: Alice

## 캠페인 현황

- 기간: 10월 1일 ~ 10월 31일
- 채널: 검색 광고, 인스타그램, 뉴스레터
- 1차 집행 예산: 2,000만 원 (사용 1,640만 원)
- 클릭률 2.8%, 전환율 3.1%, 문의 46건

## 잘 된 점

- 인스타그램 짧은 영상 소재의 반응이 가장 좋음 (클릭률 4.2%)
- 뉴스레터 구독자 대상 할인 코드 사용률 12%

## 아쉬운 점

- 검색 광고 키워드 일부가 경쟁사 브랜드명과 겹쳐 비용이 높았음
- 랜딩 페이지 모바일 로딩이 느리다는 의견 (3초 이상)

## 다음 할 일

- 2차 소재 3종 제작 (영상 2, 이미지 1)
- 검색 광고 키워드 정리 — 경쟁사 브랜드 키워드 제외
- 랜딩 페이지 이미지 용량 줄이기 (개발 담당과 협의)
`

const GLOSSARY = `# 팀 용어집

| 용어 | 뜻 |
|---|---|
| 문의 | 홈페이지·전화·메일로 들어온 상담 요청 1건 |
| 계약 | 서명까지 끝난 건. 견적만 나간 건은 포함하지 않음 |
| 소재 | 광고에 쓰는 이미지·영상·문구 한 벌 |
| 전환율 | 광고 클릭 중 문의까지 이어진 비율 |
| 4분기 | 10월 1일 ~ 12월 31일 |
`

const LAUNCH = `# 신제품 출시 일정

| 날짜 | 할 일 | 담당 |
|---|---|---|
| 10/27 | 랜딩 페이지 문구 확정 | 마케팅 |
| 11/03 | 가격표 확정 | 대표 |
| 11/10 | 보도자료 초안 | 마케팅 |
| 11/17 | 출시 전 점검 회의 | 전체 |
| 11/24 | 출시 | 전체 |

## 메모

- 출시 할인: 첫 달 20%
- 재무팀은 이 폴더를 읽기만 할 수 있음 (예산 확인용)
`

const RULES = `# 답변 규칙 (팀 공통)

- 금액은 원 단위로 쓰고 세 자리마다 쉼표를 넣는다. 예: 1,500만 원, 12,000,000원
- 날짜는 YYYY-MM-DD 또는 "10월 20일(월)"처럼 요일을 함께 쓴다.
- 회의록을 정리할 때는 "결정 사항"과 "할 일(담당·기한)"을 꼭 따로 적는다.
- 팀 밖으로 나가는 문서에는 내부 숫자(매출, 급여)를 넣지 않는다.
`

const BRIEF_MD = `# 가을 캠페인 2차 기획안

## 목표

- 기간: 2026년 10월 23일 ~ 11월 15일
- 목표 문의 수: 60건 (1차 대비 +30%)
- 예산: 1,500만 원

## 핵심 메시지

"바쁜 팀을 위한, 설치 한 번으로 끝나는 업무 도구"

## 소재

1. 짧은 영상 A — 회의록이 자동으로 정리되는 장면 (15초)
2. 짧은 영상 B — 고객 후기 인터뷰 (20초)
3. 이미지 — 가격 비교표

## 채널별 예산

| 채널 | 예산 | 비고 |
|---|---|---|
| 인스타그램 | 800만 원 | 영상 A, B |
| 검색 광고 | 500만 원 | 경쟁사 키워드 제외 |
| 뉴스레터 | 200만 원 | 구독자 할인 코드 |

## 일정

- 10/22 소재 확정
- 10/23 집행 시작
- 11/01 중간 점검
`

const COMPANY_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; color: #1d2433; line-height: 1.6; }
  h1 { font-size: 30px; margin: 0 0 4px; color: #0f766e; }
  .sub { color: #5b6476; margin-bottom: 28px; }
  h2 { font-size: 18px; border-bottom: 2px solid #99e6d8; padding-bottom: 4px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d5dbe5; padding: 6px 10px; text-align: left; }
  th { background: #effaf7; }
  .page { page-break-before: always; }
</style></head><body>
  <h1>데모 주식회사 회사소개서</h1>
  <div class="sub">2026년 10월 · 내부 공유용 샘플 문서</div>
  <h2>회사 개요</h2>
  <table>
    <tr><th>회사명</th><td>데모 주식회사</td></tr>
    <tr><th>설립</th><td>2021년 3월</td></tr>
    <tr><th>직원 수</th><td>18명 (마케팅 5, 재무 3, 영업 6, 운영 4)</td></tr>
    <tr><th>주요 사업</th><td>중소기업용 업무 자동화 도구 판매 및 도입 컨설팅</td></tr>
    <tr><th>소재지</th><td>서울특별시 성동구 (샘플 주소)</td></tr>
  </table>
  <h2>핵심 가치</h2>
  <ol>
    <li><b>고객의 시간을 아낀다</b> — 반복 업무를 줄이는 것이 우리의 일입니다.</li>
    <li><b>숫자로 말한다</b> — 결정은 데이터와 기록을 근거로 합니다.</li>
    <li><b>작게 시작해 빨리 고친다</b> — 시범 운영 후 확대합니다.</li>
  </ol>
  <h2>연혁</h2>
  <table>
    <tr><th>연도</th><th>내용</th></tr>
    <tr><td>2021</td><td>회사 설립, 첫 제품 출시</td></tr>
    <tr><td>2023</td><td>고객사 100곳 돌파</td></tr>
    <tr><td>2025</td><td>연 매출 40억 원 달성</td></tr>
    <tr><td>2026</td><td>신제품 출시 예정 (11월 24일)</td></tr>
  </table>
  <div class="page"></div>
  <h2>2026년 3분기 실적 요약</h2>
  <table>
    <tr><th>항목</th><th>7월</th><th>8월</th><th>9월</th></tr>
    <tr><td>매출</td><td>3억 4,000만 원</td><td>3억 1,000만 원</td><td>3억 8,500만 원</td></tr>
    <tr><td>신규 고객</td><td>12곳</td><td>9곳</td><td>15곳</td></tr>
    <tr><td>해지</td><td>2곳</td><td>3곳</td><td>1곳</td></tr>
  </table>
  <p>9월 매출은 가을 캠페인 사전 예약 효과로 전월 대비 24% 늘었습니다. 4분기에는 신제품 출시와 함께 월 매출 4억 원을 목표로 합니다.</p>
  <h2>문의</h2>
  <p>이 문서는 Team AX 데모용으로 만든 가상의 회사 자료입니다. 실제 회사·인물과 관계없습니다.</p>
</body></html>`

function budgetXlsx(): Uint8Array {
  const rows: (string | number)[][] = [
    ['항목', '10월', '11월', '12월', '4분기 합계', '비고'],
    ['광고비', 20_000_000, 15_000_000, 12_000_000, null as unknown as number, '가을 캠페인 2차 포함'],
    ['인건비', 96_000_000, 96_000_000, 104_000_000, null as unknown as number, '12월 성과급 포함'],
    ['임대료', 8_500_000, 8_500_000, 8_500_000, null as unknown as number, ''],
    ['소프트웨어 구독', 2_300_000, 2_300_000, 2_600_000, null as unknown as number, 'AI 구독 포함'],
    ['출장·교육', 1_800_000, 3_200_000, 1_500_000, null as unknown as number, '11월 박람회'],
    ['합계', null as unknown as number, null as unknown as number, null as unknown as number, null as unknown as number, ''],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (let r = 2; r <= 6; r++) ws[`E${r}`] = { t: 'n', f: `SUM(B${r}:D${r})` }
  for (const c of ['B', 'C', 'D', 'E']) ws[`${c}7`] = { t: 'n', f: `SUM(${c}2:${c}6)` }
  ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 22 }]
  const sales = XLSX.utils.aoa_to_sheet([
    ['월', '매출 목표', '매출 실적', '달성률'],
    ['7월', 330_000_000, 340_000_000, null],
    ['8월', 330_000_000, 310_000_000, null],
    ['9월', 350_000_000, 385_000_000, null],
    ['10월', 400_000_000, null, null],
  ])
  for (let r = 2; r <= 4; r++) sales[`D${r}`] = { t: 'n', f: `C${r}/B${r}`, z: '0.0%' }
  sales['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 10 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '4분기 예산')
  XLSX.utils.book_append_sheet(wb, sales, '월별 매출')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

function payrollXlsx(): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    ['이름', '부서', '기본급', '수당', '공제', '실지급액'],
    ['김민준', '영업', 3_800_000, 400_000, 520_000, null],
    ['이서연', '마케팅', 3_600_000, 300_000, 480_000, null],
    ['박지훈', '재무', 4_100_000, 250_000, 560_000, null],
    ['최유나', '운영', 3_400_000, 200_000, 440_000, null],
  ])
  for (let r = 2; r <= 5; r++) ws[`F${r}`] = { t: 'n', f: `C${r}+D${r}-E${r}` }
  ws['!cols'] = [{ wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '2026-10')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

function docx(md: string): Uint8Array {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-docx-'))
  try {
    fs.writeFileSync(path.join(tmp, 'in.md'), md)
    const p = Bun.spawnSync(['pandoc', 'in.md', '-o', 'out.docx'], { cwd: tmp })
    if (p.exitCode !== 0) throw new Error('pandoc failed: ' + p.stderr.toString())
    return new Uint8Array(fs.readFileSync(path.join(tmp, 'out.docx')))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

async function pdf(html: string): Promise<Uint8Array> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    return new Uint8Array(await page.pdf({ format: 'A4', printBackground: true }))
  } finally { await browser.close() }
}

fs.rmSync(OUT, { recursive: true, force: true })
write('shared/회의록/2026-10-20-주간-전체회의.md', WEEKLY)
write('shared/팀-용어집.md', GLOSSARY)
write('shared/회사소개서.pdf', await pdf(COMPANY_HTML))
write('skills/답변-규칙.md', RULES)
write('groups/마케팅/2026-10-14-마케팅-회의록.md', MARKETING)
write('groups/마케팅/가을-캠페인-2차-기획안.docx', docx(BRIEF_MD))
write('groups/재무/2026-4분기-예산.xlsx', budgetXlsx())
write('groups/재무/급여/2026-10-급여대장.xlsx', payrollXlsx())
write('projects/신제품-출시/출시-일정.md', LAUNCH)
