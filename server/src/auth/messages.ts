// User-facing messages of component A that are more specific than the default per-code messages (ko / en / id).
import type { Locale } from '@mycel/shared/api'

export const AUTH_MESSAGES = {
  badLogin: { ko: '아이디 또는 비밀번호가 맞지 않습니다.', en: 'Wrong username or password.', id: 'Nama pengguna atau kata sandi salah.' },
  accountDisabled: { ko: '사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.', en: 'This account is disabled. Please contact your admin.', id: 'Akun ini dinonaktifkan. Hubungi admin Anda.' },
  tooManyAttempts: { ko: '로그인 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', en: 'Too many sign-in attempts. Please try again later.', id: 'Terlalu banyak percobaan masuk. Coba lagi nanti.' },
  wrongPassword: { ko: '비밀번호가 맞지 않습니다. 다시 입력해 주세요.', en: 'The password is wrong. Please enter it again.', id: 'Kata sandi salah. Masukkan lagi.' },
  wrongCurrentPassword: { ko: '현재 비밀번호가 맞지 않습니다.', en: 'The current password is wrong.', id: 'Kata sandi saat ini salah.' },
  weakPassword: { ko: '더 안전한 비밀번호를 정해 주세요.', en: 'Please choose a stronger password.', id: 'Pilih kata sandi yang lebih kuat.' },
  tempPasswordExpired: { ko: '임시 비밀번호의 사용 기한이 지났습니다. 관리자에게 새 임시 비밀번호를 받아 주세요.', en: 'This temporary password has expired. Ask your admin for a new one.', id: 'Kata sandi sementara ini sudah kedaluwarsa. Minta yang baru ke admin.' },
  currentPasswordRequired: { ko: '현재 비밀번호를 입력해 주세요.', en: 'Please enter your current password.', id: 'Masukkan kata sandi Anda saat ini.' },
  samePassword: { ko: '지금 비밀번호와 다른 비밀번호를 정해 주세요.', en: 'Choose a password different from the current one.', id: 'Pilih kata sandi yang berbeda dari yang sekarang.' },
  usernameTaken: { ko: '이미 쓰고 있는 아이디입니다.', en: 'This username is already taken.', id: 'Nama pengguna ini sudah dipakai.' },
  setupDone: { ko: '이미 설정을 마친 팀 서버입니다.', en: 'This team server is already set up.', id: 'Server tim ini sudah disiapkan.' },
  setupNotRemote: { ko: '첫 설정(소유자 계정 만들기)은 인터넷 주소에서 할 수 없습니다. 서버 맥에서 직접(teamax setup-link) 또는 사무실 데스크에서 해 주세요.', en: 'The first-run setup (creating the owner account) cannot be done over the internet address. Do it on the server Mac itself (teamax setup-link) or from an office desk.', id: 'Penyiapan awal (membuat akun pemilik) tidak bisa dilakukan lewat alamat internet. Lakukan langsung di Mac server (teamax setup-link) atau dari meja kantor.' },
  setupTokenWrong: { ko: '설정 토큰이 맞지 않습니다. 서버 맥에 표시된 주소로 다시 열어 주세요.', en: 'The setup token is wrong. Open the address shown on the server Mac again.', id: 'Token penyiapan salah. Buka lagi alamat yang ditampilkan di Mac server.' },
  linkInvalid: { ko: '만료되었거나 이미 사용한 링크입니다. 관리자에게 새 링크를 받아 주세요.', en: 'This link has expired or was already used. Ask your admin for a new one.', id: 'Tautan ini kedaluwarsa atau sudah dipakai. Minta tautan baru ke admin.' },
  inviteUsed: { ko: '이미 사용한 초대입니다.', en: 'This invite was already used.', id: 'Undangan ini sudah dipakai.' },
  ownerOnlyAdmins: { ko: '관리자 계정은 owner만 바꿀 수 있습니다.', en: 'Only the owner can change admin accounts.', id: 'Hanya owner yang dapat mengubah akun admin.' },
  ownerOnlyDelete: { ko: '계정 삭제는 owner만 할 수 있습니다.', en: 'Only the owner can delete accounts.', id: 'Hanya owner yang dapat menghapus akun.' },
  notOnOwner: { ko: 'owner 계정에는 할 수 없습니다. owner 넘기기를 이용해 주세요.', en: 'Not possible for the owner account. Use "transfer ownership".', id: 'Tidak bisa untuk akun owner. Gunakan "alihkan owner".' },
  notOnSelf: { ko: '자기 계정에는 할 수 없습니다.', en: 'You cannot do this to your own account.', id: 'Anda tidak dapat melakukan ini pada akun sendiri.' },
  ownerTeamName: { ko: '팀 이름은 owner만 바꿀 수 있습니다(중계 주소도 바뀝니다).', en: 'Only the owner can rename the team (the relay address changes too).', id: 'Hanya owner yang dapat mengganti nama tim (alamat relay ikut berubah).' },
  unknownGroups: { ko: '없는 그룹이 들어 있습니다.', en: 'Some groups do not exist.', id: 'Beberapa grup tidak ada.' },
  unknownUsers: { ko: '없는 사람이 들어 있습니다.', en: 'Some people do not exist.', id: 'Beberapa orang tidak ada.' },
  groupNameTaken: { ko: '같은 이름의 그룹이 있습니다.', en: 'A group with this name already exists.', id: 'Grup dengan nama ini sudah ada.' },
  rulesInUsers: { ko: '개인 폴더(users/) 안에는 권한 규칙을 둘 수 없습니다.', en: 'Personal folders (users/) cannot carry permission rules.', id: 'Folder pribadi (users/) tidak dapat diberi aturan izin.' },
  folderMissing: { ko: '폴더가 없습니다.', en: 'The folder does not exist.', id: 'Folder tidak ada.' },
  folderExists: { ko: '이미 규칙이 있는 폴더입니다.', en: 'This folder already carries rules.', id: 'Folder ini sudah memiliki aturan.' },
  duplicateRule: { ko: '같은 대상에 규칙이 두 번 있습니다.', en: 'The same subject appears twice.', id: 'Subjek yang sama muncul dua kali.' },
  engineDisabled: { ko: '꺼진 엔진은 기본 엔진으로 정할 수 없습니다.', en: 'A disabled engine cannot be the default.', id: 'Mesin yang dimatikan tidak dapat menjadi bawaan.' },
  codexBetaDefault: { ko: 'Codex는 이 설치에서 아직 시험 중(베타)이라 기본 엔진으로 정할 수 없습니다.', en: 'Codex is still in beta on this installation, so it cannot be the default engine.', id: 'Codex masih beta di instalasi ini, jadi tidak dapat menjadi mesin bawaan.' },
  budgetSubject: { ko: '예산 대상이 올바르지 않습니다.', en: 'The budget subject is not valid.', id: 'Subjek anggaran tidak valid.' },
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
