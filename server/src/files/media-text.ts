// Notes the AI gets about a video or audio read (files/media.ts, files/service.ts readMedia), in the person's language:
// why the file could not be read, why its sound was not transcribed. The AI usually passes them on. What the AI must
// send next (a `time` value) stays English in the result itself, like the other tool contracts. The frames follow the
// image notes of vision-text.ts (switch off, API engine, connection, turn budget).
import type { Database } from 'bun:sqlite'

export const MEDIA_TEXT = {
  mac: {
    ko: '이 맥 서버에서는 아직 영상·오디오 파일을 읽을 수 없어요. Linux 서버에서는 읽을 수 있어요.',
    en: 'This Mac server cannot read video and audio files yet. Linux servers can.',
    id: 'Server Mac ini belum bisa membaca berkas video dan audio. Server Linux bisa.',
    ja: 'この Mac サーバーではまだ動画・音声ファイルを読み取れません。Linux サーバーでは読み取れます。',
    es: 'Este servidor Mac todavía no puede leer archivos de video y audio. Los servidores Linux sí pueden.',
  },
  noTool: {
    ko: '이 서버에 영상 도구(ffmpeg)가 없어 영상·오디오 파일을 읽을 수 없어요. 관리자가 ffmpeg 패키지를 설치하면 읽을 수 있어요.',
    en: 'This server has no video tool (ffmpeg), so video and audio files cannot be read. An admin can install the ffmpeg package.',
    id: 'Server ini tidak memiliki alat video (ffmpeg), jadi berkas video dan audio tidak dapat dibaca. Admin dapat memasang paket ffmpeg.',
    ja: 'このサーバーには動画ツール（ffmpeg）がないため、動画・音声ファイルを読み取れません。管理者が ffmpeg パッケージをインストールできます。',
    es: 'Este servidor no tiene la herramienta de video (ffmpeg), por lo que no se pueden leer archivos de video y audio. Un administrador puede instalar el paquete ffmpeg.',
  },
  tooLarge: {
    ko: '파일이 너무 커서({gb}GB 초과) 읽을 수 없어요. 잘라서 올려 주세요.',
    en: 'The file is too large to read (over {gb} GB). Split it into shorter parts.',
    id: 'Berkas terlalu besar untuk dibaca (lebih dari {gb} GB). Bagi menjadi bagian yang lebih pendek.',
    ja: 'ファイルが大きすぎるため読み取れません（{gb} GB 超）。短く分割してください。',
    es: 'El archivo es demasiado grande para leerlo (más de {gb} GB). Divídalo en partes más cortas.',
  },
  tooLong: {
    ko: '파일이 {h}시간보다 길어 읽을 수 없어요.',
    en: 'The file is longer than {h} hours, so it cannot be read.',
    id: 'Berkas lebih panjang dari {h} jam, jadi tidak dapat dibaca.',
    ja: 'ファイルが {h} 時間より長いため読み取れません。',
    es: 'El archivo dura más de {h} horas, por lo que no se puede leer.',
  },
  unsupported: {
    ko: '이 형식의 영상·오디오는 읽을 수 없어요. 서버가 열지 않는 형식의 트랙이 들어 있을 수도 있어요.',
    en: 'Video or audio in this format cannot be read. The file may also hold a track in a format the server does not open.',
    id: 'Video atau audio dengan format ini tidak dapat dibaca. Berkas mungkin juga berisi trek dengan format yang tidak dibuka server.',
    ja: 'この形式の動画・音声は読み取れません。サーバーが開かない形式のトラックが含まれている可能性もあります。',
    es: 'No se puede leer video o audio en este formato. El archivo también puede contener una pista en un formato que el servidor no abre.',
  },
  damaged: {
    ko: '파일이 손상됐거나 읽을 수 없어요.',
    en: 'The file is damaged or unreadable.',
    id: 'Berkas rusak atau tidak dapat dibaca.',
    ja: 'ファイルが破損しているか、読み取れません。',
    es: 'El archivo está dañado o no se puede leer.',
  },
  heavy: {
    ko: '파일을 읽는 데 시간이나 메모리가 너무 많이 들어 멈췄어요.',
    en: 'Reading the file took too long or needed too much memory, so it stopped.',
    id: 'Membaca berkas memakan waktu atau memori terlalu banyak, jadi dihentikan.',
    ja: 'ファイルの読み取りに時間またはメモリがかかりすぎたため、停止しました。',
    es: 'Leer el archivo tardó demasiado o necesitó demasiada memoria, por lo que se detuvo.',
  },
  busy: {
    ko: '지금 다른 영상을 읽고 있어요. 잠시 뒤 다시 읽어 주세요.',
    en: 'Other videos are being read right now. Read it again in a moment.',
    id: 'Video lain sedang dibaca saat ini. Baca lagi sebentar lagi.',
    ja: '現在ほかの動画を読み取っています。しばらくしてからもう一度読み取ってください。',
    es: 'Ahora se están leyendo otros videos. Vuelva a leerlo en un momento.',
  },
  noRoom: {
    ko: '서버에 남은 디스크 공간이 부족해 이 파일을 읽을 수 없어요.',
    en: 'The server does not have enough free disk space to read this file.',
    id: 'Server tidak memiliki cukup ruang disk kosong untuk membaca berkas ini.',
    ja: 'サーバーの空きディスク容量が足りないため、このファイルを読み取れません。',
    es: 'El servidor no tiene suficiente espacio libre en disco para leer este archivo.',
  },
  noAudio: {
    ko: '이 영상에는 소리 트랙이 없어요.',
    en: 'This video has no sound track.',
    id: 'Video ini tidak memiliki trek suara.',
    ja: 'この動画には音声トラックがありません。',
    es: 'Este video no tiene pista de sonido.',
  },
  noPicture: {
    ko: '이 파일에는 화면이 없고 소리만 있어요.',
    en: 'This file has no picture, only sound.',
    id: 'Berkas ini tidak memiliki gambar, hanya suara.',
    ja: 'このファイルには映像がなく、音声だけです。',
    es: 'Este archivo no tiene imagen, solo sonido.',
  },
  pictureTooLarge: {
    ko: '화면 크기가 너무 커서 장면을 만들지 않았어요.',
    en: 'The picture is too large, so no frames were made.',
    id: 'Gambarnya terlalu besar, jadi tidak ada cuplikan yang dibuat.',
    ja: '映像のサイズが大きすぎるため、場面を作りませんでした。',
    es: 'La imagen es demasiado grande, por lo que no se crearon fotogramas.',
  },
  voiceOff: {
    ko: '이 팀은 음성 입력이 꺼져 있어 소리를 글로 바꾸지 않았어요. 관리자가 팀 설정 › 음성 입력에서 켤 수 있어요.',
    en: 'Voice input is off for this team, so the sound was not turned into text. An admin can turn it on in Team settings › Voice input.',
    id: 'Input suara nonaktif untuk tim ini, jadi suara tidak diubah menjadi teks. Admin dapat mengaktifkannya di Pengaturan tim › Input suara.',
    ja: 'このチームは音声入力がオフのため、音声をテキストにしませんでした。管理者が「チーム設定 › 音声入力」でオンにできます。',
    es: 'La entrada de voz está desactivada en este equipo, por lo que el sonido no se convirtió en texto. Un administrador puede activarla en Configuración del equipo › Entrada de voz.',
  },
  transcriptsOff: {
    ko: '이 팀은 영상 소리를 글로 바꾸지 않도록 설정돼 있어 소리를 받아쓰지 않았어요. 관리자가 팀 설정 › 음성 입력에서 "영상 소리를 글로 바꾸기"를 켤 수 있어요.',
    en: 'This team does not turn video sound into text, so the sound was not transcribed. An admin can turn on "Turn video sound into text" in Team settings › Voice input.',
    id: 'Tim ini tidak mengubah suara video menjadi teks, jadi suara tidak ditranskripsi. Admin dapat mengaktifkan "Ubah suara video menjadi teks" di Pengaturan tim › Input suara.',
    ja: 'このチームは動画の音声をテキストにしない設定のため、文字起こししませんでした。管理者が「チーム設定 › 音声入力」で「動画の音声をテキストにする」をオンにできます。',
    es: 'Este equipo no convierte el sonido de los videos en texto, por lo que no se transcribió. Un administrador puede activar "Convertir el sonido de los videos en texto" en Configuración del equipo › Entrada de voz.',
  },
  transcriptsOffSmall: {
    ko: '이 서버에서는 소리를 글로 바꾸는 데 오래 걸려서 꺼 두었어요. 관리자가 팀 설정 › 음성 입력에서 "영상 소리를 글로 바꾸기"를 켤 수 있어요.',
    en: 'Turning sound into text takes long on this server, so it is off. An admin can turn on "Turn video sound into text" in Team settings › Voice input.',
    id: 'Mengubah suara menjadi teks memakan waktu lama di server ini, jadi dimatikan. Admin dapat mengaktifkan "Ubah suara video menjadi teks" di Pengaturan tim › Input suara.',
    ja: 'このサーバーでは音声をテキストにするのに時間がかかるため、オフにしています。管理者が「チーム設定 › 音声入力」で「動画の音声をテキストにする」をオンにできます。',
    es: 'Convertir el sonido en texto tarda mucho en este servidor, por eso está desactivado. Un administrador puede activar "Convertir el sonido de los videos en texto" en Configuración del equipo › Entrada de voz.',
  },
  noKey: {
    ko: '받아쓰기에 쓸 OpenRouter 키가 없어 소리를 받아쓰지 않았어요. 관리자가 팀 설정 › 음성 입력에서 키를 넣을 수 있어요.',
    en: 'There is no OpenRouter key for transcripts, so the sound was not transcribed. An admin can add it in Team settings › Voice input.',
    id: 'Belum ada kunci OpenRouter untuk transkrip, jadi suara tidak ditranskripsi. Admin dapat menambahkannya di Pengaturan tim › Input suara.',
    ja: '文字起こしに使う OpenRouter キーがないため、文字起こししませんでした。管理者が「チーム設定 › 音声入力」で追加できます。',
    es: 'No hay clave de OpenRouter para las transcripciones, por lo que el sonido no se transcribió. Un administrador puede añadirla en Configuración del equipo › Entrada de voz.',
  },
  /** {hours}: the plan's free hours a month (credentials/hosted-speech.ts hostedSpeechFreeHours) */
  freeUsed: {
    ko: '이번 달 무료 받아쓰기 {hours}시간을 다 써서 소리를 받아쓰지 않았어요. 다음 달 1일에 다시 생겨요. 관리자가 팀 설정 › 음성 입력에 팀의 OpenRouter 키를 넣으면 바로 이어서 쓸 수 있어요.',
    en: 'This month\'s {hours} free hours of transcription are used up, so the sound was not transcribed. They come back on the 1st. An admin can add the team\'s own OpenRouter key in Team settings › Voice input to go on now.',
    id: '{hours} jam transkripsi gratis bulan ini sudah habis, jadi suara tidak ditranskripsi. Jatahnya kembali tanggal 1. Admin dapat menambahkan kunci OpenRouter tim di Pengaturan tim › Input suara untuk lanjut sekarang.',
    ja: '今月の無料文字起こし{hours}時間を使い切ったため、文字起こししませんでした。来月1日にまた使えます。管理者が「チーム設定 › 音声入力」でチームの OpenRouter キーを追加すれば、すぐに続けられます。',
    es: 'Se agotaron las {hours} horas gratuitas de transcripción de este mes, por lo que el sonido no se transcribió. Vuelven el día 1. Un administrador puede añadir la clave de OpenRouter del equipo en Configuración del equipo › Entrada de voz para seguir ahora.',
  },
  confidential: {
    ko: '기밀 대화에서는 소리를 바깥 서비스로 보내지 않아 받아쓰지 않았어요.',
    en: 'In a confidential chat the sound is not sent to an outside service, so it was not transcribed.',
    id: 'Dalam percakapan rahasia, suara tidak dikirim ke layanan luar, jadi tidak ditranskripsi.',
    ja: '機密チャットでは音声を外部サービスに送らないため、文字起こししませんでした。',
    es: 'En un chat confidencial el sonido no se envía a un servicio externo, por lo que no se transcribió.',
  },
  noWhisper: {
    ko: '이 서버에 받아쓰기 도구(whisper.cpp)가 없어 소리를 받아쓰지 않았어요.',
    en: 'The transcription tool (whisper.cpp) is not on this server, so the sound was not transcribed.',
    id: 'Alat transkripsi (whisper.cpp) tidak ada di server ini, jadi suara tidak ditranskripsi.',
    ja: 'このサーバーには文字起こしツール（whisper.cpp）がないため、文字起こししませんでした。',
    es: 'La herramienta de transcripción (whisper.cpp) no está en este servidor, por lo que el sonido no se transcribió.',
  },
  noModel: {
    ko: '이 서버에 음성 인식 모델이 아직 없어 소리를 받아쓰지 않았어요. 채팅에서 음성 입력을 처음 쓰면 모델을 내려받아요.',
    en: 'The speech model is not on this server yet, so the sound was not transcribed. It is downloaded the first time someone uses voice input in chat.',
    id: 'Model suara belum ada di server ini, jadi suara tidak ditranskripsi. Model diunduh saat input suara pertama kali dipakai di percakapan.',
    ja: 'このサーバーにはまだ音声認識モデルがないため、文字起こししませんでした。チャットで初めて音声入力を使うとダウンロードされます。',
    es: 'El modelo de voz todavía no está en este servidor, por lo que el sonido no se transcribió. Se descarga la primera vez que alguien usa la entrada de voz en el chat.',
  },
  slow: {
    ko: '이 서버에서는 한 번 읽을 때 새 소리를 {min}분까지만 글로 바꿔요.',
    en: 'On this server one read turns at most {min} minutes of new sound into text.',
    id: 'Di server ini satu kali baca mengubah paling banyak {min} menit suara baru menjadi teks.',
    ja: 'このサーバーでは 1 回の読み取りでテキストにできる新しい音声は {min} 分までです。',
    es: 'En este servidor una lectura convierte en texto como máximo {min} minutos de sonido nuevo.',
  },
  connection: {
    ko: '이 연결로는 한 번에 1분 안에 끝나는 만큼만 받아써요.',
    en: 'Over this connection a read transcribes only what fits in about a minute.',
    id: 'Melalui koneksi ini satu kali baca hanya mentranskripsi yang selesai dalam sekitar satu menit.',
    ja: 'この接続では、1 回の読み取りで約 1 分以内に終わる分だけ文字起こしします。',
    es: 'Por esta conexión una lectura solo transcribe lo que cabe en aproximadamente un minuto.',
  },
  timeUp: {
    ko: '이번에 읽는 시간 안에 소리를 {from}–{to}까지 글로 바꿨어요. 다시 읽으면 그다음부터 이어서 바꿔요(바꾼 부분은 서버에 남아 있어요).',
    en: 'This read had time to turn the sound from {from} to {to} into text. Reading again goes on from there (what was done is kept on the server).',
    id: 'Bacaan ini sempat mengubah suara dari {from} sampai {to} menjadi teks. Membaca lagi akan melanjutkan dari sana (yang sudah selesai disimpan di server).',
    ja: '今回の読み取り時間内に、{from}–{to} の音声をテキストにしました。もう一度読み取ると、その続きから処理します（済んだ部分はサーバーに残っています）。',
    es: 'Esta lectura tuvo tiempo de convertir en texto el sonido de {from} a {to}. Al leer de nuevo se sigue desde ahí (lo ya hecho se guarda en el servidor).',
  },
  timeNone: {
    ko: '이번에 읽는 시간 안에는 소리를 글로 바꾸지 못했어요. 장면 없이(frames: 0) 다시 읽으면 소리에 시간을 더 쓸 수 있어요.',
    en: 'This read had no time left to turn the sound into text. Reading again without frames (frames: 0) leaves more time for the sound.',
    id: 'Bacaan ini tidak sempat mengubah suara menjadi teks. Membaca lagi tanpa cuplikan (frames: 0) memberi lebih banyak waktu untuk suara.',
    ja: '今回の読み取り時間内には音声をテキストにできませんでした。場面なし（frames: 0）でもう一度読み取ると、音声により多くの時間を使えます。',
    es: 'Esta lectura no tuvo tiempo de convertir el sonido en texto. Leer de nuevo sin fotogramas (frames: 0) deja más tiempo para el sonido.',
  },
  voiceBusy: {
    ko: '지금 음성 입력이 이 서버의 받아쓰기를 쓰고 있어서 소리를 더 글로 바꾸지 못했어요. 잠시 뒤 다시 읽으면 이어서 바꿔요.',
    en: 'Voice input is using this server\'s transcription right now, so no more of the sound was turned into text. Reading again in a moment goes on from there.',
    id: 'Input suara sedang memakai transkripsi server ini, jadi suara tidak diubah lagi menjadi teks. Membaca lagi sebentar lagi akan melanjutkan dari sana.',
    ja: '音声入力がこのサーバーの文字起こしを使っているため、これ以上は音声をテキストにできませんでした。しばらくしてからもう一度読み取ると続きから処理します。',
    es: 'La entrada de voz está usando ahora la transcripción de este servidor, así que no se convirtió más sonido en texto. Al leer de nuevo en un momento se sigue desde ahí.',
  },
  failed: {
    ko: '받아쓰기에 실패했어요({why}).',
    en: 'The transcript failed ({why}).',
    id: 'Transkripsi gagal ({why}).',
    ja: '文字起こしに失敗しました（{why}）。',
    es: 'La transcripción falló ({why}).',
  },
  framesSlow: {
    ko: '장면을 만드는 데 시간이 너무 오래 걸려 일부만 보여 줘요.',
    en: 'Making the frames took too long, so only some are shown.',
    id: 'Membuat cuplikan memakan waktu terlalu lama, jadi hanya sebagian yang ditampilkan.',
    ja: '場面の作成に時間がかかりすぎたため、一部だけ表示します。',
    es: 'Crear los fotogramas tardó demasiado, por lo que solo se muestran algunos.',
  },
} as const

export type MediaTextKey = keyof typeof MEDIA_TEXT

export function mediaText(db: Database, userId: string, key: MediaTextKey, vars: Record<string, string | number> = {}): string {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  const locale = u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' ? u.locale : 'en'
  return MEDIA_TEXT[key][locale].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** a JobFailure's message (OpenRouter refused the key, no credits …) in the person's language, for `failed` */
export function personLocale(db: Database, userId: string): 'ko' | 'en' | 'id' | 'ja' | 'es' {
  const u = db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale?: string } | null
  return u?.locale === 'ko' || u?.locale === 'id' || u?.locale === 'ja' || u?.locale === 'es' ? u.locale : 'en'
}
