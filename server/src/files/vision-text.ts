// Notes the AI gets instead of an image (server/src/files/vision.ts), in the person's language: the AI usually passes
// them on ("I can't see this picture because ..."). Contract errors of read itself (a bad `pages` value) stay English
// like the other tool errors.
import type { Database } from 'bun:sqlite'

export const VISION_TEXT = {
  off: {
    ko: '이 팀은 AI에게 이미지를 보내지 않도록 설정돼 있어 이미지를 보여 줄 수 없어요. 관리자가 팀 설정에서 "이미지·PDF 페이지·영상 장면을 AI에게 보내기"를 켤 수 있어요.',
    en: 'This team does not send images to the AI, so the image was not shown. An admin can turn on "Send images, PDF pages and video frames to the AI" in Team settings.',
    id: 'Tim ini tidak mengirim gambar ke AI, jadi gambar tidak ditampilkan. Admin dapat mengaktifkan "Kirim gambar, halaman PDF, dan cuplikan video ke AI" di Pengaturan tim.',
    ja: 'このチームは画像を AI に送信しない設定のため、画像は表示されませんでした。管理者は「チーム設定」で「画像・PDF のページ・動画の場面を AI に送信」をオンにできます。',
    es: 'Este equipo no envía imágenes a la IA, por lo que la imagen no se mostró. Un administrador puede activar "Enviar imágenes, páginas PDF y fotogramas de video a la IA" en la configuración del equipo.',
    zh: '这个团队不把图片发送给 AI，所以没有显示图片。管理员可以在“团队设置”中开启“把图片、PDF 页面和视频截图发送给 AI”。',
  },
  engine: {
    ko: '이 대화의 AI 엔진(API 엔진)은 글자만 읽을 수 있어 이미지를 보여 줄 수 없어요. 이미지를 보려면 Claude나 Codex를 사용하세요.',
    en: 'The AI engine of this chat (the API engine) reads text only, so the image cannot be shown. Use Claude or Codex to look at images.',
    id: 'Mesin AI percakapan ini (mesin API) hanya membaca teks, jadi gambar tidak dapat ditampilkan. Gunakan Claude atau Codex untuk melihat gambar.',
    ja: 'このチャットの AI エンジン（API エンジン）はテキストのみを読み取るため、画像を表示できません。画像を見るには Claude または Codex を使用してください。',
    es: 'El motor de IA de este chat (el motor API) solo lee texto, por lo que la imagen no se puede mostrar. Usa Claude o Codex para ver imágenes.',
    zh: '这个对话的 AI 引擎（API 引擎）只能读文字，所以无法显示图片。要查看图片，请使用 Claude 或 Codex。',
  },
  connection: {
    ko: '이 연결로는 글자만 보낼 수 있어 이미지를 보여 줄 수 없어요.',
    en: 'This connection carries text only, so the image cannot be shown.',
    id: 'Koneksi ini hanya membawa teks, jadi gambar tidak dapat ditampilkan.',
    ja: 'この接続はテキストのみを送信するため、画像を表示できません。',
    es: 'Esta conexión solo transmite texto, por lo que la imagen no se puede mostrar.',
    zh: '这个连接只能传输文字，所以无法显示图片。',
  },
  budget: {
    ko: '이번 답변에 보낼 수 있는 이미지 한도({images}장 또는 {mb}MB)에 도달해 보여 주지 않았어요. 새 메시지에서 이어서 볼 수 있어요.',
    en: 'Not shown: this reply already reached its image limit ({images} images or {mb} MB). Continue in a new message.',
    id: 'Tidak ditampilkan: balasan ini sudah mencapai batas gambar ({images} gambar atau {mb} MB). Lanjutkan di pesan baru.',
    ja: '表示されませんでした: この返信で送信できる画像の上限（{images} 枚または {mb} MB）に達しました。新しいメッセージで続けてください。',
    es: 'No se mostró: esta respuesta ya alcanzó su límite de imágenes ({images} imágenes o {mb} MB). Continúa en un mensaje nuevo.',
    zh: '未显示：这次回复已达到图片上限（{images}张图片或{mb} MB）。请在新消息中继续。',
  },
  unavailable: {
    ko: '이 서버에는 AI에게 보낼 이미지를 변환하는 도구가 없어 이미지를 보여 줄 수 없어요.',
    en: 'This server has no converter for images sent to the AI, so the image cannot be shown.',
    id: 'Server ini tidak memiliki pengonversi gambar untuk AI, jadi gambar tidak dapat ditampilkan.',
    ja: 'このサーバーには AI に送る画像の変換ツールがないため、画像を表示できません。',
    es: 'Este servidor no tiene un conversor de imágenes para la IA, por lo que la imagen no se puede mostrar.',
    zh: '这台服务器没有转换发送给 AI 的图片的工具，所以无法显示图片。',
  },
  tooLarge: {
    ko: '이미지가 너무 커서(5천만 화소 또는 32MB 초과) 보여 줄 수 없어요.',
    en: 'The image is too large to show (over 50 megapixels or 32 MB).',
    id: 'Gambar terlalu besar untuk ditampilkan (lebih dari 50 megapiksel atau 32 MB).',
    ja: '画像が大きすぎるため表示できません（5,000 万画素または 32 MB 超）。',
    es: 'La imagen es demasiado grande para mostrarla (más de 50 megapíxeles o 32 MB).',
    zh: '图片太大，无法显示（超过5000万像素或32 MB）。',
  },
  unsupported: {
    ko: '이 형식의 이미지는 보여 줄 수 없어요(PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP 지원).',
    en: 'Images in this format cannot be shown (PNG, JPEG, GIF, WebP, HEIC, TIFF and BMP are supported).',
    id: 'Gambar dengan format ini tidak dapat ditampilkan (PNG, JPEG, GIF, WebP, HEIC, TIFF, dan BMP didukung).',
    ja: 'この形式の画像は表示できません（PNG、JPEG、GIF、WebP、HEIC、TIFF、BMP に対応）。',
    es: 'Las imágenes en este formato no se pueden mostrar (se admiten PNG, JPEG, GIF, WebP, HEIC, TIFF y BMP).',
    zh: '无法显示这种格式的图片（支持 PNG、JPEG、GIF、WebP、HEIC、TIFF 和 BMP）。',
  },
  damaged: {
    ko: '이미지가 손상됐거나 읽을 수 없어 보여 줄 수 없어요.',
    en: 'The image is damaged or unreadable, so it cannot be shown.',
    id: 'Gambar rusak atau tidak dapat dibaca, jadi tidak dapat ditampilkan.',
    ja: '画像が破損しているか読み取れないため、表示できません。',
    es: 'La imagen está dañada o no se puede leer, por lo que no se puede mostrar.',
    zh: '图片已损坏或无法读取，所以无法显示。',
  },
  heavy: {
    ko: '이미지를 변환하는 데 시간이나 메모리가 너무 많이 들어 보여 주지 않았어요.',
    en: 'Converting the image took too long or needed too much memory, so it was not shown.',
    id: 'Konversi gambar memakan waktu atau memori terlalu banyak, jadi tidak ditampilkan.',
    ja: '画像の変換に時間またはメモリがかかりすぎたため、表示しませんでした。',
    es: 'Convertir la imagen tardó demasiado o necesitó demasiada memoria, por lo que no se mostró.',
    zh: '转换图片用时太长或占用内存太多，所以没有显示。',
  },
  busy: {
    ko: '지금은 이미지 변환 요청이 많아요. 잠시 뒤 다시 읽어 주세요.',
    en: 'Many images are being converted right now. Read it again in a moment.',
    id: 'Saat ini banyak gambar sedang dikonversi. Baca lagi sebentar lagi.',
    ja: '現在、多くの画像を変換しています。しばらくしてからもう一度読み取ってください。',
    es: 'Se están convirtiendo muchas imágenes en este momento. Vuelve a leerla en un momento.',
    zh: '现在有很多图片正在转换。请稍后再读取一次。',
  },
  scanned: {
    ko: '텍스트 레이어가 없는 페이지(스캔·그림): {pages}.',
    en: 'Pages without a text layer (scans or pictures): {pages}.',
    id: 'Halaman tanpa lapisan teks (pindaian atau gambar): {pages}.',
    ja: 'テキスト層のないページ（スキャンまたは画像）: {pages}。',
    es: 'Páginas sin capa de texto (escaneos o imágenes): {pages}.',
    zh: '没有文字层的页面（扫描件或图片）：{pages}。',
  },
  scannedHint: {
    ko: '이미지로 보려면 pages로 그 페이지를 읽으세요(예: pages: "{first}").',
    en: 'Read them with pages to see them as images (for example pages: "{first}").',
    id: 'Baca dengan pages untuk melihatnya sebagai gambar (misalnya pages: "{first}").',
    ja: 'pages で読み取ると画像として表示されます（例: pages: "{first}"）。',
    es: 'Léelas con pages para verlas como imágenes (por ejemplo pages: "{first}").',
    zh: '用 pages 读取它们，可以作为图片查看（例如 pages: "{first}"）。',
  },
  scannedOcrHint: {
    ko: '글자 인식 결과를 보려면 pages로 그 페이지를 읽으세요(예: pages: "{first}").',
    en: 'Read them with pages for their recognized text (for example pages: "{first}").',
    id: 'Baca dengan pages untuk mendapatkan teks yang dikenali (misalnya pages: "{first}").',
    ja: 'pages で読み取ると認識したテキストが得られます（例: pages: "{first}"）。',
    es: 'Léelas con pages para obtener su texto reconocido (por ejemplo pages: "{first}").',
    zh: '用 pages 读取它们，可以获得识别出的文字（例如 pages: "{first}"）。',
  },
  hwpInstead: {
    ko: '문서의 글자는 read로 읽을 수 있어요.',
    en: 'The document\'s text can be read with read.',
    id: 'Teks dokumen dapat dibaca dengan read.',
    ja: '文書のテキストは read で読み取れます。',
    es: 'El texto del documento se puede leer con read.',
    zh: '可以用 read 读取文档的文字。',
  },
  browserInstead: {
    ko: '페이지의 글자는 read_page로 볼 수 있어요.',
    en: 'read_page gives the page as text.',
    id: 'read_page memberikan halaman sebagai teks.',
    ja: 'read_page でページをテキストとして取得できます。',
    es: 'read_page devuelve la página como texto.',
    zh: 'read_page 会以文字形式返回页面。',
  },
  ocrPage: {
    ko: '{page}쪽(스캔, 글자 인식 결과):',
    en: 'Page {page} (scanned; recognized text):',
    id: 'Halaman {page} (pindaian; teks yang dikenali):',
    ja: '{page} ページ（スキャン、認識したテキスト）:',
    es: 'Página {page} (escaneada; texto reconocido):',
    zh: '第{page}页（扫描件；识别出的文字）：',
  },
} as const

export type VisionTextKey = keyof typeof VISION_TEXT

export function visionText(db: Database, userId: string, key: VisionTextKey, vars: Record<string, string | number> = {}): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' || u?.locale === 'zh' ? u.locale : 'en'
  return VISION_TEXT[key][locale].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
