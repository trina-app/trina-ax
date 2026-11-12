// Native screens only (setup, offline, errors). The web app has its own locales. Korean when the phone's first
// language is Korean, English otherwise. No native imports here: tests load this file directly.
const en = {
  setupTitle: 'Join your team',
  setupHint: 'Paste the invite link your team lead sent you. If you know the team address (e.g. acme), that works too.',
  setupPlaceholder: 'Invite link or team address',
  connect: 'Continue',
  noAddress: "I don't know the address",
  noTeam: "I don't have a team yet",
  noAddressPaste: 'Paste the invite link you got in a chat app such as Slack or KakaoTalk. A link that was already used is fine: it leads to the sign-in page.',
  noAddressDevice: 'On another device where you are signed in, the team address is in Settings › Apps.',
  noAddressAsk: 'Still not sure? Ask your team lead for the team address.',
  back: 'Back',
  noTeamBody: 'A team lead creates the team, and members join with an invite link.',
  noTeamDocs: 'Install it yourself',
  noTeamEnter: 'Enter a team address',
  backTo: 'Back to {team}',
  outsideBody: 'This address is not run by Trina. Make sure it is a server your company installed itself.',
  outsideConnect: 'Connect',
  renamed: 'This team moved to {host}. Connect to the new address?',
  switchTitle: 'Leave {old} and connect to {new}?',
  switchBody: 'Notifications from {old} will no longer come to this phone.',
  switchYes: 'Switch',
  linkTitle: 'Connect to {host}?',
  linkBody: 'Connect only if this is a link you were sent and opened yourself.',
  linkBad: 'This link cannot open a team. Paste the invite link you got as it is.',
  cancel: 'Cancel',
  emptyAddress: 'Paste an invite link or enter a team address.',
  hangul: 'That was typed in Korean letters. Switch the keyboard to English and type it again, or paste the invite link.',
  email: "Email addresses aren't used here. Paste an invite link or enter a team address.",
  cutLink: 'The link looks cut off. Copy the whole link again and paste it.',
  invalidAddress: 'Enter an HTTPS team address or invitation link.',
  teamUnknown: "No team called '{name}' was found. Check the spelling or paste the invite link.",
  suspended: "This team's service is paused right now. Ask your team lead.",
  notTeam: 'This address is not a team server. Paste the invite link you got.',
  unreachableSetup: 'Could not reach the team server. Check the address, connection and HTTPS certificate.',
  linkUnreachable: 'Could not reach the team server. Check your internet connection and try again.',
  saveFailed: 'Could not save the team address. Try again.',
  offlineTitle: 'You are offline',
  offlineHint: 'Connect to Wi-Fi or mobile data, then try again.',
  unreachableTitle: 'Could not reach your team',
  unreachableHint: 'The team server did not answer. Check your connection and try again in a moment.',
  retry: 'Try again',
  changeTeam: 'Change team address',
  otherTeam: 'Connect to another team',
  browserFailed: 'Could not open the browser.',
  channelName: 'Notifications',
}
export type Strings = typeof en
const ko: Strings = {
  setupTitle: '팀에 들어가요',
  setupHint: '팀장에게 받은 초대 링크를 붙여 넣어 주세요. 팀 주소(예: acme)를 알면 주소만 넣어도 돼요.',
  setupPlaceholder: '초대 링크 또는 팀 주소',
  connect: '들어가기',
  noAddress: '주소를 모르겠어요',
  noTeam: '아직 팀이 없어요',
  noAddressPaste: '카카오톡이나 슬랙으로 받은 초대 링크를 붙여 넣어 주세요. 이미 쓴 링크도 괜찮아요. 로그인 화면으로 이어져요.',
  noAddressDevice: '로그인된 다른 기기가 있으면 설정 › 앱에서 팀 주소를 볼 수 있어요.',
  noAddressAsk: '그래도 모르겠으면 팀장에게 팀 주소를 물어보세요.',
  back: '뒤로',
  noTeamBody: '팀은 팀장이 만들고, 팀원은 초대 링크로 들어와요.',
  noTeamDocs: '직접 설치 안내',
  noTeamEnter: '팀 주소 넣기',
  backTo: '{team}(으)로 돌아가기',
  outsideBody: '트리나가 운영하는 주소가 아니에요. 회사에서 직접 설치한 서버인지 확인하세요.',
  outsideConnect: '연결',
  renamed: '팀 주소가 {host}(으)로 바뀌었어요. 새 주소로 연결할까요?',
  switchTitle: '{old}에서 나가고 {new}에 연결할까요?',
  switchBody: '이제 {old} 알림은 이 휴대폰으로 오지 않아요.',
  switchYes: '바꾸기',
  linkTitle: '{host}에 연결할까요?',
  linkBody: '직접 받은 링크가 맞을 때만 연결하세요.',
  linkBad: '이 링크로는 팀을 열 수 없어요. 받은 초대 링크를 그대로 붙여 넣어 주세요.',
  cancel: '취소',
  emptyAddress: '초대 링크나 팀 주소를 넣어 주세요.',
  hangul: '한글로 입력됐어요. 한/영 키를 누르고 다시 입력하거나 초대 링크를 붙여 넣어 주세요.',
  email: '이메일 주소는 쓰지 않아요. 초대 링크나 팀 주소를 넣어 주세요.',
  cutLink: '링크가 중간에 잘린 것 같아요. 받은 링크 전체를 다시 복사해 붙여 넣어 주세요.',
  invalidAddress: 'HTTPS 팀 주소나 초대 링크를 입력하세요.',
  teamUnknown: "'{name}' 팀을 찾지 못했어요. 철자를 확인하거나 초대 링크를 붙여 넣어 주세요.",
  suspended: '이 팀은 지금 이용이 멈춰 있어요. 팀장에게 물어보세요.',
  notTeam: '이 주소는 팀 서버가 아니에요. 받은 초대 링크를 붙여 넣어 주세요.',
  unreachableSetup: '팀 서버에 연결할 수 없어요. 주소, 인터넷 연결, HTTPS 인증서를 확인해 주세요.',
  linkUnreachable: '팀 서버에 연결할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  saveFailed: '팀 주소를 저장하지 못했어요. 다시 시도해 주세요.',
  offlineTitle: '인터넷에 연결되어 있지 않아요',
  offlineHint: 'Wi-Fi나 모바일 데이터를 켠 뒤 다시 시도해 주세요.',
  unreachableTitle: '팀에 연결할 수 없어요',
  unreachableHint: '팀 서버가 응답하지 않아요. 연결을 확인하고 잠시 뒤 다시 시도해 주세요.',
  retry: '다시 시도',
  changeTeam: '팀 주소 바꾸기',
  otherTeam: '다른 팀에 연결',
  browserFailed: '브라우저를 열지 못했어요.',
  channelName: '알림',
}
/** "{team}(으)로 돌아가기" with its values (a value is never read as a pattern). */
export function fill(s: string, params: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m)
}
/** The first-run box's reading errors (src/team-link.ts TeamInputError) as a sentence. */
export function inputError(t: Strings, error: string): string {
  return error === 'empty' ? t.emptyAddress : error === 'hangul' ? t.hangul : error === 'email' ? t.email : error === 'link' ? t.cutLink : t.invalidAddress
}
export function stringsFor(languageCode: string | null | undefined): Strings {
  return languageCode?.toLowerCase().startsWith('ko') ? ko : en
}

/** iOS permission texts (Info.plist), Korean and English. The web app asks for the camera (photo attachment), the
 * microphone (voice input) and the photo library (file picker) inside the WebView. */
export const IOS_USAGE = {
  en: {
    NSCameraUsageDescription: 'Take a photo to attach in chat.',
    NSMicrophoneUsageDescription: 'Use your voice to type in chat.',
    NSPhotoLibraryUsageDescription: 'Choose a photo to attach in chat.',
  },
  ko: {
    NSCameraUsageDescription: '채팅에 첨부할 사진을 찍을 때 사용해요.',
    NSMicrophoneUsageDescription: '채팅에서 음성으로 입력할 때 사용해요.',
    NSPhotoLibraryUsageDescription: '채팅에 첨부할 사진을 고를 때 사용해요.',
  },
} as const

/** Which WebView load errors mean "this phone has no network" rather than "the team server did not answer". */
export function offlineError(code: number | undefined, description: string | undefined): boolean {
  // iOS NSURLErrorNotConnectedToInternet (-1009), NSURLErrorDataNotAllowed (-1020); Android net error text.
  return code === -1009 || code === -1020 || /ERR_INTERNET_DISCONNECTED/.test(description ?? '')
}
