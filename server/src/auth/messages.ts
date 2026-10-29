// User-facing messages of component A that are more specific than the default per-code messages (ko / en / id).
import type { Locale } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'

export const AUTH_MESSAGES = {
  badLogin: { ko: '아이디 또는 비밀번호가 맞지 않습니다.', en: 'Wrong username or password.', id: 'Nama pengguna atau kata sandi salah.' },
  accountDisabled: { ko: '사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.', en: 'This account is disabled. Please contact your admin.', id: 'Akun ini dinonaktifkan. Hubungi admin Anda.' },
  tooManyAttempts: { ko: '로그인 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', en: 'Too many sign-in attempts. Please try again later.', id: 'Terlalu banyak percobaan masuk. Coba lagi nanti.' },
  wrongPassword: { ko: '비밀번호가 맞지 않습니다. 다시 입력해 주세요.', en: 'The password is wrong. Please enter it again.', id: 'Kata sandi salah. Masukkan lagi.' },
  wrongCurrentPassword: { ko: '현재 비밀번호가 맞지 않습니다.', en: 'The current password is wrong.', id: 'Kata sandi saat ini salah.' },
  weakPassword: { ko: '더 안전한 비밀번호를 정해 주세요.', en: 'Please choose a stronger password.', id: 'Pilih kata sandi yang lebih kuat.' },
  tempPasswordExpired: { ko: '임시 비밀번호의 사용 기한이 지났습니다. 관리자에게 새 임시 비밀번호를 받아 주세요.', en: 'This temporary password has expired. Ask your admin for a new one.', id: 'Kata sandi sementara ini sudah kedaluwarsa. Minta yang baru ke admin.' },
  tempPasswordChars: { ko: '임시 비밀번호에는 영문·숫자·기호만 쓸 수 있습니다(공백·한글 불가). 한/영 키를 확인해 주세요.', en: 'A temporary password may only use English letters, digits and symbols (no spaces or other scripts).', id: 'Kata sandi sementara hanya boleh berisi huruf Latin, angka dan simbol (tanpa spasi atau huruf lain).' },
  currentPasswordRequired: { ko: '현재 비밀번호를 입력해 주세요.', en: 'Please enter your current password.', id: 'Masukkan kata sandi Anda saat ini.' },
  samePassword: { ko: '지금 비밀번호와 다른 비밀번호를 정해 주세요.', en: 'Choose a password different from the current one.', id: 'Pilih kata sandi yang berbeda dari yang sekarang.' },
  usernameTaken: { ko: '이미 쓰고 있는 아이디입니다.', en: 'This username is already taken.', id: 'Nama pengguna ini sudah dipakai.' },
  setupDone: { ko: '이미 설정을 마친 팀 서버입니다.', en: 'This team server is already set up.', id: 'Server tim ini sudah disiapkan.' },
  setupNotRemote: { ko: '첫 설정(팀장 계정 만들기)은 인터넷 주소에서 할 수 없습니다. 서버 맥에서 직접(teamax setup-link) 또는 사무실 데스크에서 해 주세요.', en: 'The first-run setup (creating the owner account) cannot be done over the internet address. Do it on the server Mac itself (teamax setup-link) or from an office desk.', id: 'Penyiapan awal (membuat akun pemilik) tidak bisa dilakukan lewat alamat internet. Lakukan langsung di Mac server (teamax setup-link) atau dari meja kantor.' },
  setupTokenWrong: { ko: '설정 토큰이 맞지 않습니다. 서버 맥에 표시된 주소로 다시 열어 주세요.', en: 'The setup token is wrong. Open the address shown on the server Mac again.', id: 'Token penyiapan salah. Buka lagi alamat yang ditampilkan di Mac server.' },
  linkInvalid: { ko: '만료되었거나 이미 사용한 링크입니다. 관리자에게 새 링크를 받아 주세요.', en: 'This link has expired or was already used. Ask your admin for a new one.', id: 'Tautan ini kedaluwarsa atau sudah dipakai. Minta tautan baru ke admin.' },
  inviteUsed: { ko: '이미 사용한 초대입니다.', en: 'This invite was already used.', id: 'Undangan ini sudah dipakai.' },
  ownerOnlyAdmins: { ko: '관리자 계정은 팀장만 바꿀 수 있습니다.', en: 'Only the owner can change admin accounts.', id: 'Hanya owner yang dapat mengubah akun admin.' },
  ownerOnlyDelete: { ko: '계정 삭제는 팀장만 할 수 있습니다.', en: 'Only the owner can delete accounts.', id: 'Hanya owner yang dapat menghapus akun.' },
  notOnOwner: { ko: '팀장 계정에는 할 수 없습니다. 팀장 넘김을 이용해 주세요.', en: 'Not possible for the owner account. Use "transfer ownership".', id: 'Tidak bisa untuk akun owner. Gunakan "alihkan owner".' },
  notOnSelf: { ko: '자기 계정에는 할 수 없습니다.', en: 'You cannot do this to your own account.', id: 'Anda tidak dapat melakukan ini pada akun sendiri.' },
  ownerTeamName: { ko: '팀 이름은 팀장만 바꿀 수 있습니다(중계 주소도 바뀝니다).', en: 'Only the owner can rename the team (the relay address changes too).', id: 'Hanya owner yang dapat mengganti nama tim (alamat relay ikut berubah).' },
  unknownGroups: { ko: '없는 그룹이 들어 있습니다.', en: 'Some groups do not exist.', id: 'Beberapa grup tidak ada.' },
  unknownUsers: { ko: '없는 사람이 들어 있습니다.', en: 'Some people do not exist.', id: 'Beberapa orang tidak ada.' },
  groupNameTaken: { ko: '같은 이름의 그룹이 있습니다.', en: 'A group with this name already exists.', id: 'Grup dengan nama ini sudah ada.' },
  rulesInUsers: { ko: '개인 폴더(users/) 안에는 권한 규칙을 둘 수 없습니다.', en: 'Personal folders (users/) cannot carry permission rules.', id: 'Folder pribadi (users/) tidak dapat diberi aturan izin.' },
  folderMissing: { ko: '폴더가 없습니다.', en: 'The folder does not exist.', id: 'Folder tidak ada.' },
  folderExists: { ko: '이미 규칙이 있는 폴더입니다.', en: 'This folder already carries rules.', id: 'Folder ini sudah memiliki aturan.' },
  duplicateRule: { ko: '같은 대상에 규칙이 두 번 있습니다.', en: 'The same subject appears twice.', id: 'Subjek yang sama muncul dua kali.' },
  engineDisabled: { ko: '꺼진 엔진은 기본 엔진으로 정할 수 없습니다.', en: 'A disabled engine cannot be the default.', id: 'Mesin yang dimatikan tidak dapat menjadi bawaan.' },
  codexBetaDefault: { ko: 'Codex는 이 설치에서 아직 시험 중(베타)이라 기본 엔진으로 정할 수 없습니다.', en: 'Codex is still in beta on this installation, so it cannot be the default engine.', id: 'Codex masih beta di instalasi ini, jadi tidak dapat menjadi mesin bawaan.' },
  limitFallbackNeedsCodex: { ko: 'Codex가 꺼져 있어 한도 대체를 켤 수 없습니다(사무실 모드에서는 Codex를 쓰지 않습니다).', en: 'Codex is off, so the limit fallback cannot be turned on (office mode does not use Codex).', id: 'Codex dimatikan, jadi pengalihan batas tidak dapat diaktifkan (mode kantor tidak memakai Codex).' },
  budgetSubject: { ko: '예산 대상이 올바르지 않습니다.', en: 'The budget subject is not valid.', id: 'Subjek anggaran tidak valid.' },
  connected_bad_name: { ko: '폴더 이름으로 쓸 수 없는 이름입니다.', en: 'That name can\'t be used for a folder.', id: 'Nama itu tidak bisa dipakai untuk folder.' },
  connected_not_absolute: { ko: '맥의 전체 경로를 입력해 주세요(예: /Volumes/공유).', en: 'Enter the full path on the Mac (e.g. /Volumes/Share).', id: 'Masukkan path lengkap di Mac (mis. /Volumes/Share).' },
  connected_not_found: { ko: '그 경로가 이 맥에 없습니다. NAS가 Finder에 연결되어 있는지 확인해 주세요.', en: 'That path doesn\'t exist on this Mac. Check that the NAS is connected in Finder.', id: 'Path itu tidak ada di Mac ini. Pastikan NAS tersambung di Finder.' },
  connected_not_folder: { ko: '폴더가 아닙니다.', en: 'That is not a folder.', id: 'Itu bukan folder.' },
  connected_team_folder: { ko: '팀 폴더나 서버 데이터는 연결할 수 없습니다.', en: 'The team folder and the server\'s data can\'t be connected.', id: 'Folder tim dan data server tidak bisa disambungkan.' },
  connected_hidden: { ko: '숨김 폴더는 연결할 수 없습니다.', en: 'Hidden folders can\'t be connected.', id: 'Folder tersembunyi tidak bisa disambungkan.' },
  connected_not_allowed: { ko: '연결할 수 있는 곳: /Volumes 아래(NAS·외장 디스크), 클라우드 폴더(~/Library/CloudStorage), /Users/Shared, 홈 안의 보이는 폴더.', en: 'Folders that can be connected: under /Volumes (NAS, external disks), cloud folders (~/Library/CloudStorage), /Users/Shared, and visible folders in the home.', id: 'Yang bisa disambungkan: di bawah /Volumes (NAS, disk eksternal), folder cloud (~/Library/CloudStorage), /Users/Shared, dan folder yang terlihat di home.' },
  connected_name_taken: { ko: '같은 이름의 연결 폴더가 이미 있습니다.', en: 'A connected folder with that name already exists.', id: 'Sudah ada folder tersambung dengan nama itu.' },
  connected_permission: { ko: 'macOS가 읽기를 막았습니다. 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근 권한에서 bun을 허용한 뒤 다시 시도해 주세요.', en: 'macOS blocked reading it. Allow bun in System Settings › Privacy & Security › Full Disk Access, then try again.', id: 'macOS memblokir pembacaan. Izinkan bun di System Settings › Privacy & Security › Full Disk Access, lalu coba lagi.' },
  connected_unreadable: { ko: '폴더를 읽을 수 없습니다.', en: 'The folder can\'t be read.', id: 'Folder tidak bisa dibaca.' },
  // Linux self-host (team-files/connected.ts LINUX_ROOTS) and the hosted cloud (no connected folders)
  connected_not_absolute_linux: { ko: '서버의 전체 경로를 입력해 주세요(예: /mnt/nas/공유).', en: 'Enter the full path on the server (e.g. /mnt/nas/share).', id: 'Masukkan path lengkap di server (mis. /mnt/nas/share).' },
  connected_not_found_linux: { ko: '그 경로가 서버에 없습니다. 공유 폴더가 /mnt 등에 마운트되어 있는지 확인해 주세요.', en: 'That path doesn\'t exist on the server. Check that the share is mounted (e.g. under /mnt).', id: 'Path itu tidak ada di server. Pastikan share sudah di-mount (mis. di bawah /mnt).' },
  connected_not_allowed_linux: { ko: '연결할 수 있는 곳: /mnt, /media, /srv 아래의 폴더(예: /mnt/nas/공유). 설치 폴더와 /home은 연결할 수 없습니다.', en: 'Folders that can be connected: below /mnt, /media or /srv (e.g. /mnt/nas/share). The install folder and /home cannot be connected.', id: 'Yang bisa disambungkan: folder di bawah /mnt, /media atau /srv (mis. /mnt/nas/share). Folder instalasi dan /home tidak bisa.' },
  connected_unavailable: { ko: `${PRODUCT.displayName} Cloud에서는 연결 폴더를 쓸 수 없습니다. 파일은 팀 폴더에 올려 주세요.`, en: `Connected folders are not available on ${PRODUCT.displayName} Cloud. Upload the files to the team folder instead.`, id: `Folder tersambung tidak tersedia di ${PRODUCT.displayName} Cloud. Unggah berkas ke folder tim.` },
} satisfies Record<string, Record<Locale, string>>

export type MessageKey = keyof typeof AUTH_MESSAGES
export const msg = (key: MessageKey, locale: Locale): string => AUTH_MESSAGES[key][locale] ?? AUTH_MESSAGES[key].en

/** Localized reasons of passwordProblem() (its English strings stay the API's `fields` detail). */
const PASSWORD_REASONS: Record<string, Record<Locale, string>> = {
  'at least 8 characters': { ko: '8자 이상이어야 합니다.', en: 'Use at least 8 characters.', id: 'Gunakan minimal 8 karakter.' },
  'at most 128 characters': { ko: '128자를 넘을 수 없습니다.', en: 'Use at most 128 characters.', id: 'Gunakan paling banyak 128 karakter.' },
  'this password is too common': { ko: '너무 흔한 비밀번호입니다.', en: 'This password is too common.', id: 'Kata sandi ini terlalu umum.' },
  'must not be the username': { ko: '아이디와 같은 비밀번호는 쓸 수 없습니다.', en: 'The password must not be the same as the username.', id: 'Kata sandi tidak boleh sama dengan nama pengguna.' },
}

/** "Please choose a stronger password. <why>" in the person's language. */
export function weakPasswordMessage(reason: string, locale: Locale): string {
  const why = PASSWORD_REASONS[reason]
  return why ? `${msg('weakPassword', locale)} ${why[locale] ?? why.en}` : msg('weakPassword', locale)
}
