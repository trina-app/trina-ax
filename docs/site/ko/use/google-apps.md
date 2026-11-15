---
title: Google 앱
description: AI가 쓸 수 있게 Google Drive, Gmail, Google Calendar, Docs, Sheets를 연결하는 방법과, 직접 운영하는 서버라면 관리자가 먼저 해 둘 일을 정리했어요.
---

Google Drive, Gmail, Google Calendar, Google Docs, Google Sheets는 Trina AX에 처음부터 들어 있어요. 각자 자기 Google
계정을 앱마다 한 번씩 연결해요. AI는 그 사람의 채팅에서만, 그 사람의 Google 권한으로 이 계정을 써요.

복사하거나 붙여 넣을 건 없어요. Google에서 로그인하면 돼요.

## Google 앱 연결하기 (모두)

:::tip
**필요한 것**

- 브라우저에 로그인된 내 Google 계정 (회사 Google Workspace 계정이나 개인 Gmail 계정).
:::

:::steps
#### 커넥터에서 앱 열기
왼쪽 막대 맨 아래의 내 사진을 누르고 **설정 › 커넥터**로 가서, **둘러보기**에서 앱(예: Gmail)을 골라요. 앱 페이지에
AI가 할 수 있는 일과 도구 목록이 나와요.

#### 연결 누르기
Google 로그인 페이지가 열려요(데스크톱 앱에서는 브라우저로 열려요). 내 계정을 골라요.

#### 모든 항목에 체크한 채로 두기
Google이 "이메일 읽기, 작성, 보내기"처럼 Trina AX가 할 수 있는 일을 보여 줘요. **모든** 항목에 체크한 채로
**계속**을 눌러요. 하나라도 체크를 풀면 로그인이 거절돼요. "일부 권한에 체크하지 않았어요. 다시 연결하고 모든 항목에
체크한 채로 두세요."

#### 계정 확인하기
Trina AX로 돌아오면 보이는 계정("이 계정을 연결할까요?")을 확인하고 **이 계정으로 연결 완료**를 눌러요. 페이지에 내
주소와 함께 **… 계정으로 연결됨**이 떠요.
:::

읽기는 묻지 않고 바로 해요. 메일을 보내거나, 일정을 추가하거나, 문서를 고치기 전에는 AI가 할 일을 모두 적은 카드를 보여 주고
내가 허락할 때까지 기다려요. 카드에서, 또는 앱의 **설정**(앱의 **⋯** 메뉴)에서 **먼저 물어보기** 대신 **항상 허용**을
고를 수도 있어요. Google Drive는 읽기만 해요. 파일을 바꾸거나 옮기거나 보내지 않아요.

### "관리자에게 추가 요청하기"가 보이면

우리 팀에 아직 그 앱이 설정되지 않은 거예요. **관리자에게 추가 요청하기**를 누르면 팀장과 관리자에게 알림이 가고,
연결할 수 있게 되면 나에게도 알려 줘요.

![멤버가 보는 설정 › 커넥터의 Google Drive 페이지: 연결 대신 관리자에게 추가 요청하기(Ask admin to add it), AI가 Drive로 하는 일, 도구 세 개](../../images/connect/google-member-ask.webp "관리자에게 추가 요청하기")

## 팀이 함께 쓰는 Google 계정 (관리자)

`sales@acme.com` 같은 공용 메일함이나 캘린더는 필요한 사람들을 위해 한 번만 연결하면 돼요. **관리자 › 연결한 서비스**에서
Google 앱을 열고 **팀 설정 › 팀이 함께 쓰는 Google 계정**에서 **팀에 연결**을 눌러요. 공용 계정으로 로그인한 뒤 쓸
사람을 골라요. Google Drive는 같은 자리에 **팀과 공유**가 있어요.

## Google 앱 설정하기 (직접 운영하는 서버의 관리자)

Trina가 운영하는 팀은 Google 로그인이 이미 준비돼 있어서 따로 설정할 게 없어요. 회사가 직접 운영하는 서버라면 관리자가
Google Cloud에서 Google 로그인 앱을 한 번 만들고 **관리자 › 연결한 서비스**에 추가해요.

:::tip
**필요한 것**

- 팀 서버의 **공개 https 주소**. Google에서 로그인한 사람이 이 주소로 돌아와요. 주소가 없으면 Google 앱에 "먼저 이
  서버의 공개 주소가 필요해요."가 떠요. 서버를 운영하는 사람이 정해요.
  방법은 [서버 설정](../../operate/configuration.md) (영어)에 있어요.
- **Google Cloud 프로젝트**, 앱마다 필요한 **API** 켜기, 유형이 **Web application**인 **로그인 클라이언트**.
- Google Cloud에서 받는 것: 클라이언트의 **JSON 파일** (또는 **클라이언트 ID**와 **클라이언트 보안 비밀번호**).
- Google Cloud에 넣는 것: Trina AX가 보여 주는 **돌아올 주소** 두 개. 하나는 Google Drive용, 하나는 나머지 네 앱용이에요.
:::

![공개 주소가 없는 서버의 관리자 › 연결한 서비스 Gmail 페이지: 설정 안 됨(Not set up), 먼저 이 서버의 공개 주소가 필요해요, 팀 설정 아래에 켜야 할 Google API](../../images/connect/google-admin-gmail.webp "아직 설정 안 된 Gmail")

:::steps
#### Google Cloud에서 앱 만들기
회사 앱 페이지의 [Google Cloud에서](google-own-app.md#google-cloud에서)를 따라 해요. 프로젝트, API, 앱 이름과 대상
(Google Workspace 회사는 **Internal**, 그 밖에는 **External**과 테스트 사용자), 권한, **Web application** 클라이언트를
만들어요.

#### 돌아올 주소 넣기
클라이언트의 **Authorized redirect URIs**에, 앱마다 **설정** 창에 보이는 주소를 복사 버튼으로 복사해 넣어요.

```
https://<your team address>/api/integrations/google-drive/callback
https://<your team address>/api/integrations/google-apps/callback
```

#### Trina AX에 파일 올리기
**관리자 › 연결한 서비스**에서 **Google Drive**를 열고 **설정**을 눌러요. 내려받은 JSON 파일을 올리거나
**클라이언트 ID**와 **클라이언트 보안 비밀번호**를 붙여 넣고 저장해요. 그다음 Gmail, Google Calendar, Docs, Sheets를
하나씩 열어 **설정**을 누르고 **Google Drive와 같은 Google 앱 사용**을 켜요. 더 올릴 건 없어요.
:::

각 앱 페이지의 **Google API** 아래에 그 앱에 켜야 할 API가 나와 있어요.

| 앱 | 켜야 할 Google API |
|---|---|
| Google Drive | Google Drive API |
| Gmail | Gmail API |
| Google Calendar | Google Calendar API |
| Google Docs | Google Docs API, Google Drive API |
| Google Sheets | Google Sheets API, Google Drive API |

Gmail, Calendar, Docs, Sheets 앱은 Linux 서버에서 돌아가요. 맥 앱에서는 이 앱들 페이지에 "이 팀 서버에서는 아직 못
써요"가 떠요.

## Google 화면에 회사 이름 보이기

Google Workspace를 쓰는 회사는 모든 Google 앱이 회사의 Google 앱으로 로그인하게 할 수 있어요. 그러면 Google 화면에 회사
이름이 보이고 경고도 뜨지 않아요. 방법은 [회사의 Google 앱 쓰기](google-own-app.md)에 있어요.

## 문제가 생기면

| 이런 게 보이면 | 이렇게 해요 |
|---|---|
| **일부 권한에 체크하지 않았어요. 다시 연결하고 모든 항목에 체크한 채로 두세요.** | 다시 연결하고 Google 화면의 모든 항목에 체크한 채로 둬요. |
| **Google에서 다시 로그인하라고 해요.** | 앱 페이지에서 **다시 연결**을 눌러요. 비밀번호를 바꿨거나 회사 관리자가 접근 권한을 없앴을 때 생겨요. |
| Google 페이지에 **`redirect_uri_mismatch`** (직접 운영하는 서버) | Google Cloud에 넣은 돌아올 주소가 Trina AX에 보이는 주소와 달라요. **설정** 창에서 다시 복사해요. |
| **"This app is blocked"** 또는 **`admin_policy_enforced`** | 회사의 Google 관리자가 Google 계정을 쓸 수 있는 앱을 제한하고 있어요. 관리자에게 앱을 신뢰해 달라고 부탁해요. 방법은 [Admin console에서 앱 신뢰하기](google-own-app.md#선택-admin-console에서-앱-신뢰하기)에 있어요. |
| **Google에서 확인하지 않은 앱**이라고 떠요 | 테스트 중인 External 앱이에요. 관리자가 만든 앱일 때만 **Advanced** › **Go to …** 순서로 눌러요. 아니면 회사의 Google 앱으로 바꿔 달라고 관리자에게 부탁해요. |

개발자와 운영자를 위한 자세한 내용: [Google 앱](../../../GOOGLE-APPS.md) (영어), [Google Drive](../../../GOOGLE-DRIVE.md) (영어).
