Team AX 사무실 모드 (맥 한 대 + 같은 네트워크의 데스크 PC들)
=================================================================

자세한 안내: 이 폴더의 Team-AX-치과-설치가이드.pdf (설치 후에는 ~/TeamAX/app/docs/OFFICE.md)
데스크 직원용: 이 폴더의 Team-AX-윈도우-데스크-가이드.pdf (Edge 앱, AI 브라우저 자리의 데스크톱 앱, 문제 해결)

1. 이 맥에서 Claude Code에 로그인되어 있어야 합니다.
     터미널에서  claude  실행 → /login → 구독 계정으로 로그인

2. 터미널을 열고 (이 폴더를 터미널 창에 끌어다 놓아도 됩니다):
     bash ~/Downloads/TeamAX-office-<버전>/office-install.sh \
       --public-host exampleteam.example.com --tunnel-token-file ~/Downloads/exampleteam.example.com.tunnel-token

   인터넷 주소(--public-host)와 연결 토큰 파일은 원장님 맥에서 미리 만든 것입니다(가이드 2-0). 없으면 두 옵션을 빼고
   설치하고 나중에  ~/TeamAX/teamax public-address set <주소> <토큰 파일>.
   설치가 끝나면 받은 토큰 파일은 지웁니다 (~/TeamAX/config 에 복사됨):
     rm ~/Downloads/exampleteam.example.com.tunnel-token
   --app-port 로 앱 포트를 바꿨다면 원장님 맥에서 public-address.ts set <주소> --port <그 포트> 를 한 번 더.

   관리자 암호(sudo)는 필요 없습니다. ~/TeamAX 에 설치됩니다.
   끝나면 데스크에서 열 주소와 첫 설정 링크가 나오고, 첫 설정 페이지가 이 맥의 브라우저에 열립니다.

3. 데스크 카드를 인쇄합니다 (주소와 인증서 지문이 있는 한 장):
     ~/TeamAX/teamax card     → 열린 페이지를 인쇄(⌘P)

4. 데스크(윈도우)마다:  Edge에서 인터넷 주소(https://exampleteam.example.com) → ⋯ → 앱 → 이 사이트를 앱으로 설치
   (인증서 설치 필요 없음). 인터넷이 끊겨도 쓰려는 데스크만 사무실 안 경로를 한 번:
     Edge에서  http://<이 맥의 주소>:8442  → 인증서 받기 → 열기 → 자세히 → 지문이 카드와 같은지 확인
     → 일반 → 인증서 설치 → 현재 사용자 → 신뢰할 수 있는 루트 인증 기관
     (USB로 ~/TeamAX/tls/ca.cer 를 나눠 주면 더 안전합니다)
     그다음  https://<이 맥의 주소>:8443  → ⋯ → 앱 → 이 사이트를 앱으로 설치

5. 데스크톱 앱(선택): Team-AX-Setup-<버전>-x64.exe / Team-AX-<버전>-mac-universal.dmg 를 이 zip과 같은 폴더에 두고
   설치하면 자동으로 올라갑니다 (팀원은 설정 → 앱에서 내려받음). 다른 폴더(~/Downloads)의 파일은 물어본 뒤에만 올립니다.
   나중에 올리려면:
     ~/TeamAX/teamax desktop add ~/Downloads/Team-AX-Setup-<버전>-x64.exe

명령:  ~/TeamAX/teamax status | info | card | logs | restart | setup-link | reset-link | backup | archive <파일>
       | public-address status | set <주소> <토큰 파일> | off | desktop list | add <설치 파일> | remove <파일>
업데이트: 새 zip을 풀고 office-install.sh 를 다시 실행 (데이터는 그대로)
제거:     bash office-uninstall.sh            (데이터는 남김)
          bash office-uninstall.sh --delete-data


Team AX office mode (one Mac + the desk PCs on its network). Details: Team-AX-치과-설치가이드.pdf (Korean) or app/docs/OFFICE.md.
  1. Log in to Claude Code on this Mac (run `claude`, /login).
  2. bash ~/Downloads/TeamAX-office-<version>/office-install.sh [--public-host <name> --tunnel-token-file <file>]
     (no sudo; installs into ~/TeamAX; the internet address and its connector token come from the owner's Mac)
  3. Print the desk card (~/TeamAX/teamax card): the address and the certificate thumbprint.
  4. Each desk: open https://<internet address> in Edge and install it as an app (no certificate). In-office fallback, once:
     open http://<this Mac>:8442 in Edge, open the certificate, compare Details → Thumbprint with the
     card, install it for the Current User into Trusted Root Certification Authorities (or hand out
     ~/TeamAX/tls/ca.cer on a USB stick), then https://<this Mac>:8443 and Edge ⋯ → Apps → Install this site as an app.
  5. Desktop app (optional): put Team-AX-Setup-<version>-x64.exe / Team-AX-<version>-mac-universal.dmg in the same folder
     as this zip before installing and they are offered under Settings → Apps (a file elsewhere in ~/Downloads only after
     you answer yes); later: ~/TeamAX/teamax desktop add <file>.
