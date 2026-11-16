# Makes the AI scenario fixture's sample files (tests/ai-scenarios/fixture/files/). Every person, company, number and
# address in them is made up. The outputs are committed, so a run never needs Python; run this only to change them:
#
#   python3 tests/ai-scenarios/fixture/make-files.py          (macOS: reportlab, Pillow, openpyxl, python-docx;
#                                                                  pandoc for the deck)
#
# Fonts: Apple SD Gothic Neo (pictures) and Arial Unicode (PDF text), both macOS, for Korean.
# Not made here: the voice memo groups/영업/음성메모/*.m4a (macOS `say -v Yuna -o memo.aiff "…"`, then
# `afconvert -f m4af -d aac memo.aiff <name>.m4a`); the text files (Markdown, CSV, skills), written by hand. Two HWP files are copied from tests/fixtures/hwp (synthetic, see the
# README there).
import io
import os
import random
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
import openpyxl
from openpyxl.styles import Font
import docx

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'files')
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FONT = '/System/Library/Fonts/AppleSDGothicNeo.ttc'
random.seed(7)


def out(rel):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


# reportlab reads TrueType outlines only (not the .ttc above): Arial Unicode (macOS) has Hangul
PDF_FONT = '/Library/Fonts/Arial Unicode.ttf'
pdfmetrics.registerFont(TTFont('KR', PDF_FONT))
pdfmetrics.registerFont(TTFont('KRB', PDF_FONT))

ITEMS = [
    ('OF-1001', 'A4 복사용지 (80g, 500매)', '박스', 28000, 20),
    ('OF-1002', '볼펜 0.5mm 검정 (12개입)', '갑', 6000, 15),
    ('OF-1003', '스테이플러 + 심 세트', '세트', 12500, 5),
    ('OF-1004', '파일 바인더 A4 3공', '개', 3200, 40),
    ('OF-1005', '포스트잇 76x76 (10패드)', '팩', 9800, 10),
    ('OF-1006', '화이트보드 마커 4색', '세트', 7400, 8),
]


def quote_pdf(path, title_extra=''):
    """A two-page quote. Page 2 has the supplier's sign spot "(인)" at a fixed place."""
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    c.setTitle('견적서 - 라마바카페')
    c.setFont('KRB', 22)
    c.drawCentredString(w / 2, h - 70, '견 적 서')
    c.setFont('KR', 10)
    c.drawString(50, h - 110, '견적번호: Q-2026-1107    견적일: 2026년 11월 12일    유효기간: 견적일로부터 30일')
    c.drawString(50, h - 128, '수신: 라마바카페 구매담당 귀하 (가상의 회사)')
    c.drawString(50, h - 146, '공급자: 가나다오피스 주식회사 (가상의 회사)  담당: 이소라 (영업팀)')
    y = h - 190
    c.setFont('KRB', 10)
    for x, t in [(50, '품목코드'), (120, '품목'), (330, '단위'), (380, '수량'), (430, '단가'), (490, '금액')]:
        c.drawString(x, y, t)
    c.line(48, y - 4, w - 48, y - 4)
    c.setFont('KR', 10)
    total = 0
    for code, name, unit, price, qty in ITEMS:
        y -= 20
        amt = price * qty
        total += amt
        for x, t in [(50, code), (120, name), (330, unit), (380, str(qty))]:
            c.drawString(x, y, t)
        c.drawRightString(475, y, f'{price:,}')
        c.drawRightString(545, y, f'{amt:,}')
    y -= 12
    c.line(48, y, w - 48, y)
    vat = total // 10
    for label, v in [('공급가액', total), ('부가세 (10%)', vat), ('합계', total + vat)]:
        y -= 18
        c.drawString(380, y, label)
        c.drawRightString(545, y, f'{v:,}원')
    c.drawString(50, 90, '1 / 2')
    c.showPage()
    # page 2: terms and the sign spot
    c.setFont('KRB', 14)
    c.drawString(50, h - 70, '거래 조건')
    c.setFont('KR', 10)
    terms = [
        '1. 납품: 발주 후 영업일 기준 3일 이내, 라마바카페 본점으로 배송합니다.',
        '2. 결제: 납품 완료 후 익월 말일까지 계좌이체.',
        '3. 반품: 미개봉 상품에 한해 납품 후 7일 이내.',
        '4. 이 견적서의 금액은 부가세 별도 기준 공급가액을 함께 표시합니다.',
    ]
    y = h - 100
    for t in terms:
        c.drawString(50, y, t)
        y -= 18
    # the sign spot: a box at (380, 250)-(530, 330) with "(인)" in it
    c.setFont('KRB', 11)
    c.drawString(320, 360, '공급자  가나다오피스 주식회사')
    c.drawString(320, 342, '대표이사  김지우')
    c.rect(380, 250, 150, 80)
    c.setFont('KR', 12)
    c.drawCentredString(455, 285, '(인)')
    c.setFont('KR', 8)
    c.drawString(380, 238, '직인 날인란')
    c.setFont('KR', 10)
    c.drawString(50, 90, '2 / 2')
    c.showPage()
    c.save()


def seal_png(path):
    """A red round company seal on a transparent background."""
    size = 600
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    red = (200, 30, 40, 235)
    d.ellipse((20, 20, size - 20, size - 20), outline=red, width=26)
    d.ellipse((70, 70, size - 70, size - 70), outline=red, width=8)
    f = ImageFont.truetype(FONT, 120, index=6)
    for i, (t, xy) in enumerate([('가나다', (size / 2, 215)), ('오피스', (size / 2, 345))]):
        d.text(xy, t, font=f, fill=red, anchor='mm')
    f2 = ImageFont.truetype(FONT, 46, index=6)
    d.text((size / 2, 455), '대표이사인', font=f2, fill=red, anchor='mm')
    im.save(path)


def price_xlsx(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '단가표'
    ws.append(['품목코드', '품목', '단위', '단가', '재고'])
    stock = [120, 300, 45, 800, 260, 90]
    for (code, name, unit, price, _), s in zip(ITEMS, stock):
        ws.append([code, name, unit, price, s])
    more = [('OF-1007', '라벨 프린터 테이프 12mm', '개', 15800, 70), ('OF-1008', '문서 세단기 오일', '병', 8900, 25),
            ('OF-1009', '모니터 받침대', '개', 23000, 18), ('OF-1010', '사무용 의자 등받이 쿠션', '개', 19500, 33)]
    for r in more:
        ws.append(list(r))
    for cell in ws[1]:
        cell.font = Font(bold=True)
    ws.column_dimensions['B'].width = 32
    ws2 = wb.create_sheet('메모')
    ws2.append(['2026-11-01 기준 단가입니다. 단가는 부가세 별도.'])
    wb.save(path)


def sales_xlsx(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Sales'
    ws.append(['Month', 'Region', 'Revenue (KRW)', 'Orders'])
    months = ['2026-07', '2026-08', '2026-09', '2026-10']
    for m in months:
        for region, base in [('Seoul', 42_000_000), ('Busan', 18_000_000), ('Daegu', 11_000_000)]:
            ws.append([m, region, base + random.randint(-3, 6) * 1_000_000, random.randint(80, 210)])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    wb.save(path)


def contract_docx(path):
    d = docx.Document()
    d.add_heading('물품 공급 계약서', 0)
    d.add_paragraph('※ 테스트용 가상 문서입니다. 실제 회사·사람이 아닙니다.')
    d.add_paragraph('공급자 가나다오피스 주식회사(이하 "갑")와 구매자 라마바카페(이하 "을")는 사무용품 공급에 관하여 다음과 같이 계약한다.')
    for t in [
        '제1조 (목적) 이 계약은 갑이 을에게 사무용품을 공급하고 을이 그 대금을 지급하는 데 필요한 사항을 정한다.',
        '제2조 (계약 기간) 계약 기간은 2026년 12월 1일부터 2027년 11월 30일까지 1년으로 한다.',
        '제3조 (대금) 단가는 갑의 2026년 단가표를 따르며, 을은 매월 말일 기준으로 정산하여 익월 말일까지 지급한다.',
        '제4조 (납품) 갑은 발주일로부터 영업일 기준 3일 이내에 납품한다.',
        '제5조 (계약 해지) 일방이 이 계약을 위반하고 14일 이내에 시정하지 않으면 상대방은 서면으로 계약을 해지할 수 있다.',
    ]:
        d.add_paragraph(t)
    d.add_paragraph('')
    d.add_paragraph('2026년 11월    일')
    d.add_paragraph('갑: 가나다오피스 주식회사 대표이사 김지우 (인)')
    d.add_paragraph('을: 라마바카페 대표 ____________ (인)')
    d.save(path)


def deck_pptx(path):
    md = """---
title: 2027 신제품 소개
---

# 친환경 사무용품 라인

- 재생지 복사용지 (FSC 인증 예정)
- 리필형 볼펜, 리필 잉크 판매
- 목표: 2027년 상반기 거래처 30곳

# 가격 정책

- 기존 단가 대비 5~8% 높게
- 연간 계약 거래처는 기존 단가 유지

# 일정

- 12월: 샘플 제작
- 1월: 주요 거래처 시연
- 3월: 정식 출시
"""
    src = os.path.join(OUT, '..', '_deck.md')
    with open(src, 'w') as f:
        f.write(md)
    subprocess.run(['pandoc', src, '-o', path], check=True)
    os.remove(src)


def photo(path, label, colors, size=(1200, 800)):
    im = Image.new('RGB', size, colors[0])
    d = ImageDraw.Draw(im)
    for i in range(14):
        x0, y0 = random.randint(0, size[0]), random.randint(0, size[1])
        r = random.randint(60, 260)
        d.ellipse((x0 - r, y0 - r, x0 + r, y0 + r), fill=colors[1 + i % (len(colors) - 1)])
    im = im.filter(ImageFilter.GaussianBlur(18))
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, 64, index=6)
    d.text((size[0] / 2, size[1] - 90), label, font=f, fill=(255, 255, 255), anchor='mm')
    im.save(path)


def scanned_pdf(path):
    """An image-only PDF that looks like a scanned paper (slightly turned, grey, noisy): no text layer."""
    W, H = 1240, 1754
    im = Image.new('L', (W, H), 236)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, 34, index=0)
    fb = ImageFont.truetype(FONT, 52, index=6)
    lines = [
        ('거래처 방문 보고서', fb),
        ('', f),
        ('방문일: 2026년 11월 6일 (금)        작성: 이소라 (영업팀)', f),
        ('방문처: 라마바카페 본점 (가상의 회사)', f),
        ('', f),
        ('1. 요청 사항', f),
        ('   - 12월부터 A4 복사용지 월 20박스 정기 납품 희망', f),
        ('   - 리필형 볼펜 샘플 30개 요청 (11월 20일까지)', f),
        ('2. 가격', f),
        ('   - 연간 계약 시 복사용지 단가 26,500원 요청 (현재 28,000원)', f),
        ('   - 결제는 익월 말일 계좌이체', f),
        ('3. 경쟁사', f),
        ('   - 다른 업체가 25,900원을 제시했다고 함 (확인 필요)', f),
        ('4. 다음 할 일', f),
        ('   - 11월 13일까지 수정 견적서 발송 (이소라)', f),
        ('   - 계약서 초안 검토 요청 (박민호 이사)', f),
    ]
    y = 160
    for t, font in lines:
        d.text((120, y), t, font=font, fill=30)
        y += 70
    im = im.rotate(0.8, fillcolor=236, resample=Image.BICUBIC)
    px = im.load()
    for _ in range(26000):
        x, yy = random.randrange(W), random.randrange(H)
        px[x, yy] = random.randint(150, 250)
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'JPEG', quality=70)
    c = canvas.Canvas(path, pagesize=A4)
    from reportlab.lib.utils import ImageReader
    c.drawImage(ImageReader(io.BytesIO(buf.getvalue())), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()


def receipt_pdf(path, n):
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont('KRB', 16)
    c.drawString(60, 780, f'거래명세서 #{n}')
    c.setFont('KR', 11)
    c.drawString(60, 750, f'2026-11-0{n}  라마바카페 (가상의 회사)  합계 {120000 * n:,}원')
    c.showPage()
    c.save()


def main():
    # the text files next to these (Markdown, CSV, skills) are written by hand and kept
    os.makedirs(OUT, exist_ok=True)
    quote_pdf(out('projects/라마바카페-납품/견적서-라마바카페-2026-11.pdf'))
    quote_pdf(out('groups/영업/견적서/견적서-라마바카페-2026-11.pdf'))
    receipt_pdf(out('groups/영업/견적서/거래명세서-1.pdf'), 1)
    receipt_pdf(out('groups/영업/견적서/거래명세서-2.pdf'), 2)
    seal_png(out('shared/도장/회사직인.png'))
    price_xlsx(out('groups/영업/단가표-2026.xlsx'))
    sales_xlsx(out('groups/영업/monthly-sales-2026.xlsx'))
    contract_docx(out('groups/영업/계약서/물품공급계약서-라마바카페.docx'))
    deck_pptx(out('groups/마케팅/2027-신제품-소개.pptx'))
    photo(out('groups/마케팅/사진/매장-전경.jpg'), '매장 전경 (예시)', [(40, 70, 90), (230, 180, 90), (90, 140, 120), (200, 90, 70)])
    photo(out('groups/마케팅/사진/IMG_2041.jpg'), '신제품 볼펜 (예시)', [(240, 240, 235), (30, 60, 160), (220, 60, 60), (40, 40, 40)])
    photo(out('groups/마케팅/사진/IMG_2042.jpg'), '재생지 박스 (예시)', [(200, 190, 160), (120, 100, 70), (240, 230, 200), (90, 120, 60)])
    scanned_pdf(out('projects/라마바카페-납품/방문보고서-스캔.pdf'))
    shutil.copy(os.path.join(REPO, 'tests/fixtures/hwp/agreement.hwpx'), out('shared/양식/업무협약서-초안.hwpx'))
    shutil.copy(os.path.join(REPO, 'tests/fixtures/hwp/notice.hwpx'), out('shared/양식/공문-박람회-협조요청.hwpx'))
    print('written to', OUT)


if __name__ == '__main__':
    main()
