// The words of an in-app browser step ("Open page · https://…"), in every language. Their own file (re-exported by
// step-labels.ts) so the desktop app's permission question (desktop/src/common/browser-action.ts) can use them without
// bundling the rest of the step list's words and the API schemas behind them (tests/unit/desktop-shared-imports.test.ts).
import type { Locale } from './api/common'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

/** Verb of an in-app browser step: "<verb> · <url>". */
export const BROWSER_STEP_VERB: Record<string, T> = {
  preview_start: t('브라우저 열기', 'Open browser', 'Buka browser', "ブラウザーを開く", "Abrir navegador", "打开浏览器"),
  navigate: t('페이지 열기', 'Open page', 'Buka halaman', "ページを開く", "Abrir página", "打开网页"),
  read_page: t('페이지 읽기', 'Read page', 'Baca halaman', "ページを読む", "Leer página", "读取网页"),
  get_page_text: t('페이지 읽기', 'Read page', 'Baca halaman', "ページを読む", "Leer página", "读取网页"),
  find: t('페이지에서 찾기', 'Find on page', 'Cari di halaman', "ページ内を検索", "Buscar en la página", "在网页中查找"),
  computer: t('브라우저 조작', 'Use browser', 'Operasikan browser', "ブラウザーを操作", "Usar navegador", "操作浏览器"),
  form_input: t('양식 채우기', 'Fill form', 'Isi formulir', "フォームに入力", "Rellenar formulario", "填写表单"),
  javascript_tool: t('페이지에서 동작 실행', 'Run an action on the page', 'Jalankan aksi di halaman', "ページで操作を実行", "Ejecutar una acción en la página", "在网页上执行操作"),
  // the AI attaches files to the page (file_upload): "파일 첨부 · 견적서.pdf, 사업자등록증.pdf"; once they are in,
  // STEP_TEXT.browserFilesAttached (step-labels.ts) names how many and the page's site
  file_upload: t('파일 첨부', 'Attach files', 'Lampirkan berkas', 'ファイルを添付', 'Adjuntar archivos', '附加文件'),
  browser_batch: t('브라우저 여러 단계', 'Browser steps', 'Beberapa langkah browser', "ブラウザーの手順", "Pasos del navegador", "浏览器步骤"),
  resize_window: t('화면 크기 바꾸기', 'Resize', 'Ubah ukuran', "サイズを変更", "Cambiar tamaño", "调整大小"),
  read_console_messages: t('페이지 오류 보기', 'Check page errors', 'Periksa galat halaman', "ページのエラーを確認", "Revisar errores de la página", "检查网页错误"),
  read_network_requests: t('페이지 통신 보기', 'Check page traffic', 'Periksa lalu lintas halaman', "ページの通信を確認", "Revisar el tráfico de la página", "检查网页流量"),
  tabs_context: t('탭 보기', 'List tabs', 'Lihat tab', "タブを一覧表示", "Listar pestañas", "查看标签页"),
  tabs_create: t('새 탭', 'New tab', 'Tab baru', "新しいタブ", "Nueva pestaña", "新标签页"),
  tabs_select: t('탭 바꾸기', 'Switch tab', 'Ganti tab', "タブを切り替え", "Cambiar pestaña", "切换标签页"),
  tabs_close: t('탭 닫기', 'Close tab', 'Tutup tab', "タブを閉じる", "Cerrar pestaña", "关闭标签页"),
}

export const BROWSER_STEP_FALLBACK: T = t('브라우저', 'Browser', 'Browser', "ブラウザー", "Navegador", "浏览器")
