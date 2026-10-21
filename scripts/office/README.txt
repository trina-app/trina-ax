Team AX 사무실 모드 (맥 한 대 + 같은 네트워크의 데스크 PC들)
=================================================================

자세한 안내: 저장소의 docs/OFFICE.md

1. 이 맥에서 Claude Code에 로그인되어 있어야 합니다.
     터미널에서  claude  실행 → /login → 구독 계정으로 로그인

2. 터미널을 열고 (이 폴더를 터미널 창에 끌어다 놓아도 됩니다):
     bash ~/Downloads/TeamAX-office-<버전>/office-install.sh

   관리자 암호(sudo)는 필요 없습니다. ~/TeamAX 에 설치됩니다.
   끝나면 데스크에서 열 주소와 첫 설정 링크가 나오고, 첫 설정 페이지가 이 맥의 브라우저에 열립니다.

3. 데스크(윈도우)마다 한 번:
     Edge에서  http://<이 맥의 주소>:8442  → 인증서 받기 → 설치 (페이지에 단계가 나옵니다)
     그다음  https://<이 맥의 주소>:8443  → ⋯ → 앱 → 이 사이트를 앱으로 설치

명령:  ~/TeamAX/teamax status | info | logs | restart | setup-link | reset-link | backup | archive <파일>
업데이트: 새 zip을 풀고 office-install.sh 를 다시 실행 (데이터는 그대로)
제거:     bash office-uninstall.sh            (데이터는 남김)
          bash office-uninstall.sh --delete-data


Team AX office mode (one Mac + the desk PCs on its network). Details: docs/OFFICE.md.
  1. Log in to Claude Code on this Mac (run `claude`, /login).
  2. bash ~/Downloads/TeamAX-office-<version>/office-install.sh     (no sudo; installs into ~/TeamAX)
  3. Each desk once: open http://<this Mac>:8442 in Edge, install the certificate, then https://<this Mac>:8443 and
     Edge ⋯ → Apps → Install this site as an app.
