// Makes pptxgenjs-charts.pptx, the deck tests/unit/chart-data.test.ts reads: four native charts the way the pptx
// skill builds them (addChart), with pptxgenjs 4.0.1 as the dev environment has it (scripts/dev-env/srt/node-libs.package.json).
// Run: NODE_PATH=<folder with pptxgenjs 4.0.1>/node_modules node make-deck.cjs <out.pptx>
const PptxGenJS = require('pptxgenjs')
const pres = new PptxGenJS()
const quarters = ['Q1', 'Q2', 'Q3', 'Q4']
pres.addSlide().addChart(pres.charts.BAR, [
  { name: 'North', labels: quarters, values: [120, 135, 150, 171] },
  { name: 'South', labels: quarters, values: [80, 92.5, 101, 99] },
], { x: 0.5, y: 0.5, w: 9, h: 4.5, barDir: 'col', showTitle: true, title: 'Sales by region' })
pres.addSlide().addChart([
  { type: pres.charts.BAR, data: [{ name: 'Units', labels: quarters, values: [40, 52, 61, 70] }], options: { barDir: 'col' } },
  { type: pres.charts.LINE, data: [{ name: 'Margin %', labels: quarters, values: [12.5, 13.1, 14, 15.2] }], options: { secondaryValAxis: true, secondaryCatAxis: true } },
], { x: 0.5, y: 0.5, w: 9, h: 4.5, valAxes: [{ showValAxisTitle: true, valAxisTitle: 'Units' }, { showValAxisTitle: true, valAxisTitle: 'Margin %' }], catAxes: [{ catAxisTitle: 'Quarter' }, { catAxisHidden: true }] })
pres.addSlide().addChart(pres.charts.PIE, [{ name: 'Product mix', labels: ['Basic', 'Pro', 'Team'], values: [45, 35, 20] }], { x: 1, y: 0.5, w: 6, h: 4.5 })
pres.addSlide().addChart(pres.charts.SCATTER, [
  { name: 'Ad spend', values: [1, 2, 3, 4] },
  { name: 'Sign-ups', values: [10, 19, 33, 41] },
], { x: 1, y: 0.5, w: 7, h: 4.5 })
pres.writeFile({ fileName: process.argv[2] }).then((f) => console.log(f))
