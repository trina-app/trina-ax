<div align="center">

<img src="web/public/favicon.svg" width="64" alt="트리나 AX 로고">

<h1>팀 모두가 같이 쓰는 AI.</h1>

트리나 AX는 팀의 파일, 스킬, 도구를 서버 하나에 모아요. 모두의 AI가 거기서 시작하고,<br>AI가 여는 파일은 모두 물어본 사람의 권한으로 확인해요.

<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="App Store에서 다운로드"></a>&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="40" alt="Google Play에서 다운로드"></a>

[웹사이트](https://ax.trina.app) · [맥·Windows용 다운로드](https://ax.trina.app/download) · [문서](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk)

[English](README.md) · 한국어 · [日本語](README.ja.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md)

<br>

<a href="https://ax.trina.app/#watch"><img src="docs/images/readme/v3/film.png" width="100%" alt="97초 이야기 보기. 같은 Claude에 같은 부탁을 했는데 결과가 달라요. 팀장 Alex는 7쪽짜리 제안서를 받고, 빈 폴더로 첫 출근한 Mina는 'Trina Logistics? Who are they?'라는 답을 받아요. 트리나가 있으면 Mina의 AI도 팀의 파일과 스킬에서 시작해요."></a>

</div>

## 팀이 얻는 것

**어느 대화방 옆에서든 묻고, 클릭 한 번으로 보내요.** 나만 보는 옆 채팅에서 묻고, 클릭 한 번이면 트리나의 답이 대화방에 올라가요.

<img src="docs/images/readme/v3/room.gif" width="100%" alt="Expo booth crew 대화방에서 Mina가 자기만 보는 옆 채팅으로 트리나에게 11월 17일 반입 일정을 묻고, 버튼 하나로 그 답을 대화방에 올려요.">

**각자 열 수 있는 것만 봐요.** Mina가 Finance를 못 열면 Mina의 AI도 못 열어요. [권한은 이렇게 돌아가요](docs/PERMISSIONS.md)

<img src="docs/images/readme/v3/access-band.png" width="100%" alt="폴더마다 열 수 있는 사람의 얼굴이 보여요. Mina는 shared/Finance를 열 수 없어요.">

- 🤝 **동료의 AI 채팅을 이어받아요.** 동료의 프로젝트 채팅을 이어서 하고, 내가 묻는 건 내 권한으로 처리돼요.
- 📋 **팀 스킬.** 팀이 일하는 방식을 한 번 적어 두면, 모두의 AI가 그대로 따라요.
- 🔌 **쓰던 도구.** 어떤 MCP 서버든, Google Drive, Slack, 회사 API까지. 사람마다 권한을 확인해요.
- 🕘 **바뀐 내용은 모두 남아요.** 사람이 바꿨든 그 사람의 AI가 바꿨든, 어느 버전이든 되돌릴 수 있어요.
- 📱 **어느 기기에서든.** 맥, 아이폰, 안드로이드, Windows, 그리고 어떤 브라우저에서든요.

## 시작하기

- **트리나 호스팅:** 서버를 따로 운영할 필요가 없어요. 14일 무료 체험 뒤 월 요금제예요. [요금제](https://ax.trina.app/pricing)
- **앱:** [맥, 아이폰, 안드로이드, Windows](https://ax.trina.app/download), 또는 어떤 브라우저에서든 써요.
- **직접 설치:** 회사 리눅스 서버, Docker, 사무실 맥에 설치해요. 무료예요. [리눅스](docs/INSTALL-LINUX.md) · [Docker](docs/INSTALL-DOCKER.md) · [사무실 맥](docs/OFFICE.md)

<details>
<summary><b>10분 만에 내 컴퓨터에서 써 보기</b> (가상 팀, AI 꺼짐)</summary>

<br>

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # → http://127.0.0.1:19760 · alice / teamax-demo-1
```

Bun 1.3.12와 Go 1.27 이상이 필요해요. 실제 운영용 설치는 아니에요. [자세한 안내](docs/QUICKSTART.ko.md)

</details>

트리나는 업무 공간을 드리고, AI는 드리지 않아요. 쓰임새에 맞게 허용된 Claude·OpenAI 계정과 요금제를 연결하세요. AI 이용료는 연결한 계정으로 나가요.

<details>
<summary><b>데이터, 한계, 약속하지 않는 것</b></summary>

### 약속하지 않는 것

- 직접 설치해도 오프라인으로 도는 건 아니에요. 요청에 필요한 내용은 연결한 AI 회사로 가고, 설정한 외부 연동도 요청을 받아요. Codex 웹 검색은 할 때마다 그때까지의 대화를 OpenAI 검색 서비스로 보내요. 관리자가 허용해서 음성에 OpenRouter를 쓰면, 영상·오디오 파일의 소리가 OpenRouter로 가요. 서버는 30분마다 `updates.trina.app`에 자기 공인 주소를 물어요(`MYCEL_EXIT_ADDRESS_CHECK=off`로 끌 수 있어요). [자세히](docs/security-and-permissions.ko.md)
- 서버 운영자는 저장된 파일과 채팅을 볼 수 있어요. 호스팅이면 트리나 운영자도 포함돼요. 앱 관리자에게는 모두의 개인 대화를 보는 화면이 없어요.
- 폴더 권한을 빼도 예전 답은 지워지지 않아요. 더 넓게 공유할 때 받는 확인이 모든 유출을 막아 주지는 않아요.
- 보안 인증, 완벽한 답, 비용 절감, 법무·재무·인사 결정의 자동화는 약속하지 않아요. 결과와 운영 범위는 사람이 검토하세요.
- 리눅스 서버에는 OCR이 없어요. AI는 사진과 스캔한 쪽을 이미지로 보지만, 글자로 검색되지는 않아요. 사무실 맥은 아직 영상을 읽지 못해요.
- HWP/HWPX 글자는 어느 팀이든 읽어요. [미리보기와 한글 문서 만들기](resources/hwp/README.md)에는 선택 플러그인(한글 문서 미리보기)이 필요해요(macOS, 또는 glibc 2.39 이상의 리눅스. Debian 12는 안 돼요).
- 연결: 그 사람이 쓸 수 있는 개인 연결이 먼저 쓰이고, 그다음 그 사람, 그룹, 팀 전체에 배정한 연결 순서예요. 새 트리나 팀은 회사 연결 하나를 팀 전체가 기본으로 쓸 수 있고, 이미 저장한 선택은 그대로 유지돼요. **이 설정이 Anthropic이나 OpenAI 약관상의 허락을 뜻하지는 않아요.** [연결 자세히](docs/FAQ.ko.md)
- 리눅스 직접 설치에는 Debian 12/13 또는 Ubuntu 24.04, systemd와 cgroup v2, amd64나 arm64, RAM 4 GB, 디스크 20 GB가 필요해요. 설치, 업데이트, 백업 복구는 회사 IT 담당자가 맡아요.

</details>

## 커뮤니티

[Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax) · [릴리스](https://github.com/trina-app/trina-ax/releases/latest) · [변경 기록](CHANGELOG.md) · [도움 받기](SUPPORT.md) · [기여하기](CONTRIBUTING.md) · [보안 신고](SECURITY.md) · [개발](docs/DEVELOPMENT.md) · [설정](docs/CONFIGURATION.md) · [llms.txt](llms.txt)

앱은 영어, 한국어, 인도네시아어, 일본어, 스페인어로 쓸 수 있어요. 모든 그림 속 회사와 사람은 가상이에요.

## 라이선스

[AGPL-3.0-only](LICENSE)로 상업적인 용도까지 자유롭게 쓸 수 있어요. 고친 버전을 네트워크로 제공한다면 그 사용자에게 소스도 제공해야 해요. 클라우드 프로토콜은 따로 MIT 라이선스예요([라이선스](shared/src/cloud-protocol/LICENSE)). [고지](NOTICE) · [제3자 고지](docs/THIRD-PARTY-NOTICES.md)

Claude Code와 Codex에는 각자의 약관이 있고, 이 프로젝트는 Anthropic이나 OpenAI의 보증을 받지 않았어요. Claude는 Anthropic의 상표예요.
