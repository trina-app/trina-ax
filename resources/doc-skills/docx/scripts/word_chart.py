# Added by Trina AX (not part of Anthropic's skill; AGPL-3.0-only like the rest of Trina AX).
"""Put native, editable charts into a Word file.

docx-js and python-docx write no charts, and a picture of a chart cannot be edited. This puts a real Word chart, with
its data sheet (right-click > Edit Data opens the numbers), where a placeholder paragraph stands.

Build the document as usual with one paragraph per chart whose whole text is its placeholder, e.g. "[[chart:sales]]",
then run:

    python3 scripts/word_chart.py report.docx report-charts.docx charts.json

charts.json is a list (or {"charts": [...]}) of charts:

    [{"placeholder": "[[chart:sales]]", "type": "column", "title": "Sales by quarter",
      "categories": ["Q1", "Q2", "Q3"],
      "series": [{"name": "2025", "values": [120, 135, 150]}, {"name": "2026", "values": [130, 150, 170]}],
      "number_format": "#,##0", "width_cm": 16, "height_cm": 9.5, "data_labels": false}]

type: column, stacked_column, bar (horizontal), stacked_bar, line, area, pie, doughnut. Values are plain numbers
(null for a gap). The output is a new file; the placeholder paragraph keeps its alignment.
"""
import json
import re
import sys

from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml.ns import qn
from docx.shared import Cm
from lxml import etree
from pptx.chart.chart import Chart
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.oxml import parse_xml

CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
TYPES = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "stacked_column": XL_CHART_TYPE.COLUMN_STACKED,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "stacked_bar": XL_CHART_TYPE.BAR_STACKED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "area": XL_CHART_TYPE.AREA,
    "pie": XL_CHART_TYPE.PIE,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
}


# characters XML 1.0 cannot hold (control characters other than tab, line feed and carriage return; lone surrogates)
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")


def clean(s):
    """text for the chart's XML: characters XML cannot hold dropped"""
    return _NOT_XML.sub("", str(s))


def fail(msg):
    sys.stderr.write("word_chart.py: " + msg + "\n")
    sys.exit(1)


def chart_parts(spec, i):
    what = "chart %d (%s)" % (i + 1, spec.get("placeholder", "?"))
    kind = spec.get("type", "column")
    if kind not in TYPES:
        fail("%s: type must be one of %s" % (what, ", ".join(TYPES)))
    cats = spec.get("categories")
    series = spec.get("series")
    if not isinstance(cats, list) or not cats:
        fail("%s: categories must be a list of labels" % what)
    if not isinstance(series, list) or not series:
        fail("%s: series must be a list of {name, values}" % what)
    if kind in ("pie", "doughnut") and len(series) != 1:
        fail("%s: a %s chart takes one series" % (what, kind))
    data = CategoryChartData(number_format=spec.get("number_format", "General"))
    data.categories = [clean(c) if not isinstance(c, (int, float)) or isinstance(c, bool) else c for c in cats]
    for s in series:
        vals = s.get("values")
        if not isinstance(vals, list) or len(vals) != len(cats):
            fail("%s: series %r needs one value per category (%d)" % (what, s.get("name"), len(cats)))
        for v in vals:
            if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))):
                fail("%s: series %r: values must be plain numbers (no units or %%), null for a gap" % (what, s.get("name")))
        data.add_series(clean(s.get("name", "")), vals)
    space = parse_xml(data.xml_bytes(TYPES[kind]))
    chart = Chart(space, None)
    title = spec.get("title")
    if title:
        chart.has_title = True
        chart.chart_title.text_frame.text = clean(title)
    else:
        chart.has_title = False
    if kind in ("pie", "doughnut") or len(series) > 1:
        chart.has_legend = True
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
    else:
        chart.has_legend = False
    if spec.get("data_labels"):
        plot = chart.plots[0]
        plot.has_data_labels = True
        if kind in ("pie", "doughnut"):
            plot.data_labels.show_percentage = True
    # python-pptx sizes chart text for a slide (18 pt); a page wants 10 pt
    for r in space.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}defRPr"):
        if r.get("sz") == "1800":
            r.set("sz", "1000")
    return space, data.xlsx_blob


def free_name(package, pattern):
    taken = {str(p.partname) for p in package.iter_parts()}
    n = 1
    while pattern % n in taken:
        n += 1
    return pattern % n


def inline_xml(rid, cx, cy, pid, name):
    return (
        '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
        ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:c="%s" xmlns:r="%s"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="%d" name="Chart %d" descr="%s"/>'
        '<wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="%s"><c:chart r:id="%s"/></a:graphicData></a:graphic>'
        "</wp:inline></w:drawing></w:r>"
    ) % (C_NS, R_NS, cx, cy, pid, pid, name, C_NS, rid)


def main():
    if len(sys.argv) != 4:
        fail("usage: python3 word_chart.py in.docx out.docx charts.json")
    src, out, spec_path = sys.argv[1:]
    with open(spec_path, encoding="utf-8") as f:
        specs = json.load(f)
    if isinstance(specs, dict):
        specs = specs.get("charts", [])
    if not isinstance(specs, list) or not specs:
        fail("charts.json must be a list of charts")
    doc = Document(src)
    part = doc.part
    package = part.package
    paras = list(doc.element.body.iter(qn("w:p")))
    text_of = lambda p: "".join(t.text or "" for t in p.iter(qn("w:t"))).strip()
    ids = [int(x) for x in doc.element.body.xpath("//wp:docPr/@id") if str(x).isdigit()]
    pid = max(ids + [0]) + 1
    for i, spec in enumerate(specs):
        if not isinstance(spec, dict):
            fail("chart %d: each chart is an object with placeholder, type, categories and series" % (i + 1))
        ph = spec.get("placeholder")
        hits = [p for p in paras if ph and text_of(p) == ph]
        if not hits:
            fail("chart %d: no paragraph whose whole text is %r" % (i + 1, ph))
        space, xlsx = chart_parts(spec, i)
        chart_part = Part(PackURI(free_name(package, "/word/charts/chart%d.xml")), CT_CHART, b"", package)
        book = Part(PackURI(free_name(package, "/word/embeddings/Microsoft_Excel_Worksheet%d.xlsx")), CT_XLSX, xlsx, package)
        # a part is in the package once something relates to it, so relate the chart first
        rid = part.relate_to(chart_part, RT.CHART)
        xrid = chart_part.relate_to(book, RT.PACKAGE)
        ext = etree.SubElement(space, "{%s}externalData" % C_NS)
        ext.set("{%s}id" % R_NS, xrid)
        etree.SubElement(ext, "{%s}autoUpdate" % C_NS).set("val", "0")
        chart_part._blob = etree.tostring(space, xml_declaration=True, encoding="UTF-8", standalone=True)
        cx = int(Cm(float(spec.get("width_cm", 16))))
        cy = int(Cm(float(spec.get("height_cm", 9.5))))
        for n, p in enumerate(hits):
            if n:  # the same placeholder twice: each gets its own copy of the chart
                fail("chart %d: placeholder %r stands in more than one paragraph; give each chart its own" % (i + 1, ph))
            for child in list(p):
                if child.tag != qn("w:pPr"):
                    p.remove(child)
            name = clean(spec.get("title", "Chart")).replace("&", "").replace("<", "").replace(">", "").replace('"', "")[:80]
            p.append(etree.fromstring(inline_xml(rid, cx, cy, pid, name)))
            pid += 1
    doc.save(out)
    print("%s: %d native chart%s with %s data sheet" % (out, len(specs), "" if len(specs) == 1 else "s", "its" if len(specs) == 1 else "their"))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except (ValueError, TypeError, KeyError, OSError) as e:
        fail("could not make the charts: %s" % str(e)[:300])
