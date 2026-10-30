# IT 담당자용 도입·운영 안내

[English](for-admins.md)

자료 민감도, 서버 운영자, 허용된 AI 연결, 필요한 클라이언트, 외부 통신과 복구 담당자를 먼저 정하세요. 모델 제공사로 문맥이 전송되며 호스팅 운영자도 저장 자료를 읽을 수 있습니다. [보안 경계](security-and-permissions.ko.md).

| 방식 | 안내 | 운영 경계 |
|---|---|---|
| Linux 서버·VM | [설치](INSTALL-LINUX.md) | systemd·cgroup v2, 전용 계정·OS 격리. 일반 Docker 컨테이너는 운영 설치 대상이 아님 |
| 사무실 Mac | [설치](OFFICE.md) | 로그인 사용자로 실행, 로그아웃하면 중단. Claude 전용 경로, Codex 없음 |
| 역할 계정 Mac | [영문 상세](INSTALL.md) | 별도 계정·LaunchDaemon. 운영자가 소스 번들 관리; 배포 DMG 경로 아님 |
| 가상 로컬 체험 | [빠른 체험](QUICKSTART.ko.md) | AI 비활성화, loopback, 운영 격리 검증 아님 |

소유자 계정 생성 후 **권한 → AI 연결 → 팀원 초대 → 첫 스킬 → 첫 백업** 순서로 진행하세요. 관리형 연결은 개인 우선이며 새 팀의 구독 공유는 기본 켜짐입니다. 기존 선택과 연결별 동의는 유지되고 제공사 약관은 별도입니다.

시범 운영 합격 기준: 두 계정의 파일 접근 차이, 원본을 확인한 스킬 결과, 사용량 확인, 암호화한 외부 백업과 복구 검증입니다. [예제](../examples/README.ko.md) · [백업·복원](BACKUP-RESTORE.md).

업데이트 전에 [최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)와 기본값 변경을 읽고 백업하세요. Linux·사무실 Mac은 트리나 피드를 사용합니다. 앱 롤백이 DB·파일 롤백은 아닙니다. [설정](CONFIGURATION.md) · [문제 해결](TROUBLESHOOTING.md).

현재 브라우저·모바일 웹과 Windows 설치 파일을 사용합니다. Mac 서버 ZIP과 데스크톱 DMG는 다릅니다. 현재 소스는 EN/KO/ID/JA/ES를 지원합니다. 실험용 HWP 시각 미리보기는 기본 꺼짐이며 Debian 12에서 지원하지 않고 기본 번들에는 실행 도구가 없습니다. 설치 파일을 받기 전에 릴리스 설명을 확인하세요. [지원](../SUPPORT.md).

플러그인(한글 문서 미리보기 등) 설치·관리와 서명 키 절차: [플러그인 설치·관리](PLUGINS.md).
