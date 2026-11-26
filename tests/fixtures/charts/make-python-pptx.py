"""Makes python-pptx-chart.pptx, read by tests/unit/chart-data.test.ts: one native chart the way python-pptx 1.0.2 writes
it (its data workbook written by XlsxWriter), as a run's python3 has them (scripts/system/packages.json).
Run: python3 make-python-pptx.py <out.pptx>"""
import sys
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[6])
data = CategoryChartData()
data.categories = ["Seoul", "Busan", "Incheon"]
data.add_series("2025", (310, 120, 95))
data.add_series("2026", (355.5, 131, 102))
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1), Inches(8), Inches(5), data)
prs.save(sys.argv[1])
