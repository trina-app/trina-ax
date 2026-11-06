// Native screens only (setup, offline, errors). The web app has its own locales. Korean when the phone's first
// language is Korean, English otherwise. No native imports here: tests load this file directly.
const en = {
  setupHint: 'Enter the team address or invitation link your team shared with you.',
  setupPlaceholder: 'https://acme.example.com',
  connect: 'Connect',
  invalidAddress: 'Enter an HTTPS team address or invitation link.',
  unreachableSetup: 'Could not reach the team server. Check the address, connection and HTTPS certificate.',
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
  setupHint: '팀에서 받은 팀 주소나 초대 링크를 입력하세요.',
  setupPlaceholder: 'https://acme.example.com',
  connect: '연결',
  invalidAddress: 'HTTPS 팀 주소나 초대 링크를 입력하세요.',
  unreachableSetup: '팀 서버에 연결할 수 없어요. 주소, 인터넷 연결, HTTPS 인증서를 확인해 주세요.',
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
