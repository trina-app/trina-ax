# Microsoft Store 등록 정보

Partner Center 제출 화면에 넣는 값입니다. 문구는 Mac App Store 등록 문구와 같고, "맥 앱"만 "윈도우 앱"으로 바꿨습니다.
스크린샷은 Mac App Store용 5장을 윈도우 창 모양(제목 표시줄·메뉴, Ctrl 단축키)으로 바꾼 것입니다(2880×1800, 저장소 밖
`plans/microsoft-store-2026-11-07/screenshots/`). 한국어 등록 정보에도 같은 영어 스크린샷을 씁니다.

## 가격 및 사용 가능 여부

- 시장: 중국을 뺀 모든 시장(Mac App Store와 같음)
- 표시 여부: 공개, Microsoft Store에서 검색 가능
- 가격: 무료
- 출시: 인증 통과 후 바로

## 속성

- 범주: 생산성(Productivity)
- 개인정보처리방침 URL: https://ax.trina.app/privacy
- 웹 사이트: https://ax.trina.app
- 지원 연락처: contact@trina.app
- 시스템 요구 사항: Windows 10 1809 이상, x64, 인터넷 연결
- 제품 선언: 기본값 그대로

## 연령 등급 (IARC 설문)

- 앱 범주: 앱(게임 아님)
- 폭력, 성적 내용, 욕설, 약물, 도박: 없음
- 사용자끼리 소통: 같은 팀 안에서만(팀 채팅방, 파일 공유). 공개 채팅은 없음
- 위치 공유, 개인 정보 공유: 없음
- 제한 없는 인터넷 접속: 있음(앱 안 브라우저)
- 디지털 구매: 없음

## 제출 옵션

- 게시 보류: 인증 통과 후 바로 게시
- 인증 담당자에게 남길 메모(Notes for certification): 아래 "인증 메모". 데모 계정은 Mac App Store 심사용과 같다
  (`~/.config/trina-ax/asc/review-account.txt`, 저장소에 넣지 않음).
- 제한된 권한 `runFullTrust` 사유: 아래 "runFullTrust 사유".

### 인증 메모

```
Trina AX is a desktop client for a company's own Trina AX team server (open source; self-hosted by the company or
hosted by Trina). Accounts are created and removed by each team's administrator on their server; there is no public
sign-up in the app.

How to test:
1. Open the app. On the welcome screen, enter the team address: https://qa-test.trina.app
2. Sign in with the demo account below. It is a regular team member on a demo team with fictional data.
   Username: <demo account>  Password: <demo password>
3. Start a new chat and send: /sales-follow-up Read shared/demo/sales-meeting.md and shared/demo/follow-up-style.md
   and draft a follow-up email. Claude reads the team files this member may open and writes a draft.
4. Files: the sidebar shows only the folders this member may open (shared, skills and the personal folder).
   Team skills: type / in the message box to see the six team skills.
5. Built-in browser pane: ask "Open https://en.wikipedia.org/wiki/Request_for_proposal and summarize it". The app asks
   before the AI opens a new site.

Microphone: used only for voice input in chats, after the person presses the microphone button.
Updates come from the Microsoft Store; the app does not update itself.

Questions: contact@trina.app
```

### runFullTrust 사유

```
Trina AX is a Win32 desktop app built with Electron and packaged as MSIX. runFullTrust is required for the Win32
entry point (Windows.FullTrustApplication). The app does not install drivers or services and does not update itself.
```

## 등록 정보: English (en-US)

- Product name: Trina AX
- Short description: Your company's AI workspace. Put Claude, your company files and your team's skills on one company
  server. Everyone works from the same files and playbooks, within their own permissions.
- Search terms (7): AI workspace, team AI, company files, team skills, Claude, HWP, AI agent
- Copyright and trademark info: © 2026 Trina Inc.
- Developed by: Trina Inc.

Product features:

1. Chat with Claude Code or Codex running on your team server
2. Claude reads the team folders you are allowed to open
3. Run the skills your team lead set up with a /command
4. Per-person and per-group folder permissions, enforced
5. Hand over PDF, Word, Excel, PowerPoint and Korean HWP files
6. A built-in browser pane the AI can use, with your permission
7. Switch between several teams

Description:

```
Trina AX is your company's own AI workspace. Claude runs on your company's server, and everyone on the team hands it work in plain words, with the company files and team skills already in place.

This Windows app connects to your team's Trina AX server. Your team admin gives you the team address and an account.

START FROM YOUR COMPANY'S FILES
Claude reads the team folders you are allowed to open: proposals, price lists, meeting notes, policies. No need to explain your company from scratch.

THE SAME RESULT, WHOEVER ASKS
Run the skills your team lead set up with a /command. Proposal writing, meeting summaries and sales follow-ups follow the same steps and standards every time.

FIND ANY FILE
Ask in plain words and Claude searches the folders you can open. It can help tidy them too.

YOUR PERMISSIONS, ENFORCED
Every file and every answer follows per-person and per-group folder permissions. What you can't open, Claude can't read for you.

IN THE APP
• Chat with Claude Code or Codex running on your team server
• Hand over PDF, Word, Excel, PowerPoint and Korean HWP files
• Browse and manage team folders and your personal folder
• Use team skills and suggest new ones
• Let the AI look things up in a built-in browser pane. It asks before opening a new site and never fills in password or card fields.
• Switch between several teams

YOUR SERVER, YOUR DATA
Run Trina AX on your own Mac mini or server, or on a dedicated AWS Seoul server hosted by Trina. Trina AX is open source (AGPL-3.0): github.com/trina-app/trina-ax

GETTING STARTED
You need a Trina AX team server and an account. Self-hosting is free. Learn about hosting at ax.trina.app. AI usage is billed separately by your AI provider, such as Anthropic or OpenAI.

Claude is a trademark of Anthropic. Codex is a trademark of OpenAI. Trina AX is an independent product of Trina Inc.
```

## 등록 정보: 한국어 (ko-KR)

- 제품 이름: Trina AX (Partner Center에 "트리나 AX"도 예약했으면 그 이름)
- 간단한 설명: 우리 회사 전용 AI 업무 공간. 회사 서버 하나에 Claude와 회사 자료, 팀 스킬을 올려요. 신입사원도 첫날부터
  대표님의 자료와 방식으로, 각자 권한 안에서 일해요.
- 검색어(7개): AI 업무 공간, 팀 AI, 회사 자료, 팀 스킬, Claude, 한글 HWP, AI 에이전트
- 저작권 및 상표 정보: © 2026 Trina Inc.
- 개발자: Trina Inc.

제품 기능:

1. 팀 서버의 Claude Code·Codex와 채팅
2. 내가 열 수 있는 팀 폴더를 Claude가 바로 읽어요
3. 대표님이 만든 팀 스킬을 /명령어 하나로
4. 사람별·그룹별 폴더 권한을 그대로 지켜요
5. PDF·Word·Excel·PPT·한글(HWP) 파일을 첨부해서 맡기기
6. 허락한 사이트만 여는 앱 안 브라우저
7. 여러 팀을 오가며 쓰기

설명:

```
트리나 AX는 우리 회사 전용 AI 업무 공간이에요. 회사 서버에서 Claude가 돌아가고, 직원은 평소 하던 말로 일을 맡겨요. AI는 대표님이 넣어 둔 회사 자료와 팀 스킬을 같이 써요.

이 윈도우 앱은 우리 팀의 트리나 AX 서버에 연결해요. 팀 주소와 계정은 팀 관리자에게 받으세요.

■ 빈 폴더가 아닌, 회사 자료에서 시작
제안서, 가격표, 회의록, 사내 규정처럼 내가 열 수 있는 팀 폴더를 Claude가 바로 읽어요. 회사 설명을 처음부터 다시 할 필요가 없어요.

■ 누가 맡겨도 같은 결과
대표님이 만든 팀 스킬을 /명령어 하나로 써요. 제안서 작성, 회의록 정리, 영업 후속 메일이 정해 둔 순서와 기준을 그대로 따라요.

■ 오래 일한 사람만 알던 파일도 바로
찾는 파일을 평소 말로 물어보면 내가 열 수 있는 폴더에서 찾아 드려요. 폴더 정리도 같이 도와드려요.

■ 사람마다 다른 권한, 그대로
모든 파일과 답변은 사람별·그룹별 폴더 권한을 따라요. 내가 못 여는 파일은 Claude도 대신 읽지 않아요.

■ 앱에서 할 수 있는 일
• 팀 서버의 Claude Code·Codex와 채팅
• PDF·Word·Excel·PPT·한글(HWP) 파일을 첨부해서 맡기기
• 팀 폴더와 내 폴더 보기·관리
• 팀 스킬 쓰기, 새 스킬 제안하기
• AI가 앱 안 브라우저로 자료 조사하기. 처음 여는 사이트는 먼저 물어보고, 비밀번호·카드 입력칸은 채우지 않아요.
• 여러 팀을 오가며 쓰기

■ 우리 서버, 우리 자료
사무실 맥 미니나 회사 서버에 직접 설치하거나, 트리나가 운영하는 AWS 서울 전용 서버를 쓸 수 있어요. 코드는 GitHub에 공개된 오픈소스(AGPL-3.0)예요. github.com/trina-app/trina-ax

■ 시작하기
트리나 AX 팀 서버와 계정이 필요해요. 직접 설치는 무료예요. 호스팅과 도입 상담은 ax.trina.app에서 안내해 드려요. AI 사용료는 Anthropic·OpenAI 같은 AI 회사에 따로 내요.

Claude는 Anthropic의, Codex는 OpenAI의 상표예요. 트리나 AX는 주식회사 트리나가 만든 별도 제품이에요.
```
