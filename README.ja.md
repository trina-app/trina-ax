<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="editions/trina/branding/logo/mark-dark.svg"><img src="editions/trina/branding/logo/mark-light.svg" width="64" alt="Trina AX ロゴ"></picture>

<h1>Trina AX</h1>

<b>チーム全員で使う AI。</b><br>
Trina AX は、チームのファイル、スキル、ツールを1台のサーバーにまとめます。みんなの AI がそこから始まり、<br>AI が開くファイルは、すべて質問した本人の権限でチェックされます。

<a href="https://ax.trina.app/download"><img src="docs/images/readme/v4/download-mac-ja.png" height="40" alt="Mac 版をダウンロード"></a>&nbsp;&nbsp;<a href="https://ax.trina.app/download"><img src="docs/images/readme/v4/download-windows-ja.png" height="40" alt="Windows 版をダウンロード"></a>&nbsp;&nbsp;<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="App Store からダウンロード"></a>&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="40" alt="Google Play で手に入れよう"></a>

[Web サイト](https://ax.trina.app) · [ドキュメント](docs/README.md) · [プラン](https://ax.trina.app/pricing) · [Discord](https://discord.gg/zUVfSR8MVk)

[English](README.md) · [한국어](README.ko.md) · 日本語 · [Español](README.es.md) · [简体中文](README.zh-CN.md)

</div>

https://github.com/user-attachments/assets/4d795cf7-202c-4299-9d74-d0d569a1869f

<p align="center"><sub>同じ Claude、同じ依頼、違う結果。97秒のストーリー。</sub><br>オープンソース（AGPL-3.0）・セルフホストは無料、人数制限なし<br><br><a href="https://github.com/trina-app/trina-ax"><img src="docs/images/readme/v4/star-ja.png" height="44" alt="GitHub で Trina AX にスター"></a><br><sub>チームの役に立ちそうなら、スターをお願いします。より多くのチームが Trina AX を見つけやすくなります。</sub></p>

## 設定は一度だけ。チーム全員が使える。

**AI アカウント1つでチーム全員が使える。** Claude か OpenAI の API キーを1つ（または規約上許されるプランを）接続すれば、チーム全員がそれで質問できます。トークン上限は人、グループ、チームごとに設定できます。

1人がチームのサーバーで設定すれば、全員の AI が最初の質問からそれを使えます。ブラウザーでもアプリでも。ほかの人は Claude Code を入れたり、スキルをコピーしたりする必要はありません。せいぜい自分のアカウントにサインインするくらいです。

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/set-up-once-ja-dark.webp"><img src="docs/images/readme/v4/set-up-once-ja-light.webp" width="100%" alt="1人が AI アカウント、Google、アプリ、会社の API、Slack、スキル、チームのファイルを Trina サーバーで一度設定すると、Mac の Alex、iPhone の Mina、Windows の Sam、ブラウザーの Leo、Android の Jordan の AI がみんなそれを使えます。"></picture>

| 一度だけ設定 | 全員が使えるもの |
| --- | --- |
| **AI アカウント。** オーナーか管理者が Claude か OpenAI の API キー、または規約上許されるプランを接続します。 | チーム全員が回答を受け取れます。トークン上限は人、グループ、チームごとに設定できます。 |
| **Google。** ドライブのフォルダーをチームと共有するか、チームのアカウント（共有メールボックスやカレンダー）を1つ Gmail、Calendar、Docs、Sheets に接続します。 | 選んだ人が自分のチャットで使えます。各自の Google アカウントを別に接続することもできます。 |
| **アプリ。** アプリ一覧の Higgsfield、Notion、Linear、Figma など、またはアドレスさえあればどの MCP サーバーでも（例：Bright Data）。 | 全員のチャットでそのアプリのツールが使えます。チームで1つのサインインか、各自のサインインかを選べます。 |
| **会社の API。** アドレス、キー、使い方のメモ。 | AI が自社のシステムを呼び出します。そのアドレスの配下だけです。 |
| **Slack。** オーナーか管理者が一度追加します。 | DM や Trina を招待したチャンネルで Trina に聞けます。自分の権限で。 |
| **スキル。** `SKILL.md` を書くか、`.claude` や `.codex` フォルダーのスキルをそのまま持ち込みます。 | 全員の AI が同じ手順で動きます。`/` で呼び出せます。 |
| **チームのファイル。** 1つのドライブ：全社、グループ、プロジェクト、チームのスキル、個人フォルダー。 | 全員の AI がチームのファイルから始め、その人が開けるものだけを開きます。 |

<table>
<tr>
<td colspan="2"><img src="docs/images/readme/v4/connected-apps.webp" alt="チーム全員に適用される管理 › 連携サービス：Google Drive、Gmail、Calendar、Docs、Sheets（一度設定すれば各自 Google にサインインするだけ）、Slack、Notion、Linear、Atlassian、Canva、アドレスで追加"><br><sub>管理 › 連携サービス：一度設定すればチーム全員が使えます</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/images/readme/v4/team-drive.webp" alt="チームのドライブ：Company-wide、Groups、Projects、Team skills、Personal"><br><sub>チームのドライブは1つ</sub></td>
<td width="50%"><img src="docs/images/readme/v4/team-skills.webp" alt="チームのスキル一覧と Bring my skills"><br><sub>チームのスキル、手元のスキルも持ち込める</sub></td>
</tr>
</table>

## みんなでできること

**どのトークの横でも聞けて、ワンクリックで送れる。** 自分にだけ見えるサイドチャットで聞いて、ワンクリックで Trina の回答をトークに送れます。

<img src="docs/images/readme/v4/room-share.gif" width="100%" alt="Expo booth crew トークで、Mina が自分にだけ見えるサイドチャットで Trina に出展規定をチェックリストにしてもらい、トークに送ります。">

**それぞれの AI も、本人が開けるものだけが見える。** Mina が Finance を開けなければ、Mina の AI も開けません。[権限のしくみ](docs/PERMISSIONS.md)

<img src="docs/images/readme/v4/folder-access.gif" width="100%" alt="管理者が Sales フォルダーを開ける人を変え、Mina が開けるフォルダーを確認します。Finance は一覧にありません。">

**チームプロジェクトで同僚のセッションを引き継げる。** チームプロジェクトのセッションはメンバーに共有されます。同僚のセッションを開いて続きを進められ、自分の質問は自分の権限で処理されます。ほかのセッションも、Google ドライブのファイルのように人やグループに共有できます。

<img src="docs/images/readme/v4/shared-sessions.gif" width="100%" alt="Mina が Sam のプロジェクトセッションを開いて、カードニュースの続きを直します。Mina の質問は Mina の権限で処理されます。">

**ファイルを中身で探せる。** 毎晩、チームの AI が共有・グループ・プロジェクトのフォルダーの新しいファイルと変更されたファイルを読み、ファイルごとに何なのかを1行で残します。だから `temp.pdf` という名前のスキャンや `IMG_2031.jpg` という写真も中身で見つかります。チームの AI アカウントを使い、個人フォルダーは読みません。架空の2,238ファイルでのテストでは、Claude Code は184問のうち、この一覧があると181問、ないと172問で正しいファイルを見つけました。

<table>
<tr>
<td width="50%"><b>予約タスク。</b> 一度頼めば、Trina が決めたスケジュールで繰り返します。時刻はチームのタイムゾーンです。<br><br><img src="docs/images/readme/v4/scheduled-run.webp" alt="予約タスクが作った週次サマリー：見つけたこと、決定事項、未完了の作業、ファイルに保存"></td>
<td width="50%"><b>ゲスト。</b> 社外の人をグループトークやプロジェクトに招待し、AI を使えるかどうかを決められます。<br><br><img src="docs/images/readme/v4/guest-room.webp" alt="代理店のゲスト Morgan Reyes がいる Launch email グループトーク：件名の案、メンション、Trina の回答"></td>
</tr>
<tr>
<td width="50%"><b>使用量と上限。</b> 人ごとの回答数、トークン、推定コスト。トークン上限は人、グループ、チームごとに。<br><br><img src="docs/site/images/usage/team.webp" alt="管理者の使用量画面：人ごとのトークン、回答数、推定コスト"></td>
<td width="50%"><b>すべてを検索。</b> ⌘K でチャット、履歴、プロジェクト、ファイル、スキル、予約タスクを探せます。<br><br><img src="docs/site/images/search/palette.webp" alt="チャット、履歴、プロジェクト、ファイル、スキル、予約タスクを探す ⌘K 検索"></td>
</tr>
<tr>
<td colspan="2"><b>Slack のようなチームチャット。</b> 全員・グループのチャンネル、非公開チャンネル、DM、グループトーク、スレッド、@メンション。Web、デスクトップ、スマホで使えて、どのトークでも、横の自分だけに見えるチャットで Trina に聞けます。<br><br><img src="docs/images/readme/v4/team-chat.webp" alt="チームチャットの Marketing チャンネル：左にチャンネルと DM、リアクションと @メンション、チャンネルに送られた回答、右に開いたスレッド"></td>
</tr>
</table>

- **変更はすべて残る。** 人が変えても、その人の AI が変えても、どのバージョンにも戻せます。
- **アプリ内ブラウザー。** デスクトップアプリでは、Trina がチャットの横のパネルで Web サイトを開き、読み、クリックし、フォームに入力します。見ながら Stop でいつでも止められます。すべてのサイトを許可していなければ、新しいサイトを開く前に確認します。
- **アプリの更新をトークに。** Sentry、GitHub、Stripe、Jira、HubSpot の更新がカードで届きます。
- **議事録。** Mac アプリ（macOS 14.4 以降）が Zoom、Meet、Teams の通話を書き起こします。
- **仕事のファイルを探す。** デスクトップアプリが手元のパソコンから最近の仕事のファイルを見つけ、選んだものだけ追加します。
- **ドキュメント。** ハングル（HWP/HWPX）の本文を読み、PDF と PowerPoint をプレビューできます。
- **どの端末でも。** Mac、Windows、iPhone、Android、そしてどのブラウザーからでも。6つの言語で。

## はじめる

- **Trina ホスティング：** サーバーの運用は要りません。14日間の無料トライアルのあと、月額プランになります。[プラン](https://ax.trina.app/pricing)
- **アプリ：** [Mac、iPhone、Android、Windows](https://ax.trina.app/download)、またはどのブラウザーからでも。
- **セルフホスト：** 自社の Linux サーバー、Docker、オフィスの Mac で。無料です。[Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) · [オフィス Mac](docs/OFFICE.en.md) · [AI エージェントでインストール](docs/INSTALL-LINUX.en.md#install-with-your-ai-agent)

<b>Docker でセルフホスト</b>（Linux、または OrbStack を使う Mac）

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax/docker
cp env.example .env && docker compose up -d --build
docker compose exec trina-ax trina-ax-setup-link   # リンクを開いてオーナーを作成
```

Linux インストールより新しく、テストはまだ少なめです。Ubuntu 24.04 のサーバーは、先にホストの設定が1つ必要です。[Docker ガイド](docs/INSTALL-DOCKER.md)

<b>自分のパソコンで10分で試す</b>（架空のチーム、AI はオフ）

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # → http://127.0.0.1:19760 · alice / teamax-demo-1
```

Bun 1.3.12 と Go 1.27 以上が必要です。本番環境向けのインストールではありません。[詳しい手順](docs/QUICKSTART.md)

## しくみ

1台のサーバーで Claude Code と Codex がエンジンとして動きます。人でもその人の AI でも、ファイルへのリクエストはすべてサーバーの1つの権限チェックを通ります。Linux サーバーでは、エンジンは専用アカウントで bubblewrap、Landlock、seccomp のサンドボックス内で動きます。シェルと組み込みのファイルツールはオフなので、ファイルは Trina のツール経由でしか開けません。[セキュリティと権限](docs/security-and-permissions.md)

Trina が提供するのはワークスペースで、AI そのものではありません。自分たちの使い方が認められている Claude や OpenAI のアカウントとプランを接続してください。AI の利用料は、接続したアカウントに請求されます。

<details>
<summary><b>データ、制限、保証しないこと</b></summary>

### 保証しないこと

- セルフホストでも、オフラインで動くわけではありません。依頼に必要なコンテキストは接続した AI プロバイダーに送られ、設定済みの外部連携もそれぞれのリクエストを受け取ります。Codex が Web 検索をするたびに、それまでの会話が OpenAI の検索サービスに送られます。管理者の許可のもとで音声認識に OpenRouter を使う場合、動画・音声ファイルの音声は OpenRouter に送られます。サーバーは30分ごとに、自身の公開アドレスを `updates.trina.app` に問い合わせます（`MYCEL_EXIT_ADDRESS_CHECK=off` で無効にできます）。[詳細](docs/security-and-permissions.md)
- サーバーの運用者は、保存されたファイルとチャットを読めます。ホスティングの場合は Trina の運用者も含まれます。アプリの管理者には、全員の個人的な会話を閲覧する機能はありません。
- フォルダーへのアクセス権を外しても、それ以前の回答は消えません。共有範囲を広げるときの確認は、包括的な情報漏えい対策（DLP）ではありません。
- セキュリティ認証、完璧な回答、確実なコスト削減、法務・財務・人事判断の自動化は、いずれもうたっていません。出力内容と導入範囲は人が確認してください。
- Linux サーバーでは OCR を実行しません。AI は写真やスキャンしたページを画像として見ますが、テキスト検索はできません。オフィス Mac はまだ動画を読めません。
- HWP/HWPX のテキストはどのチームでも使えます。[プレビューとハングル文書の作成](resources/hwp/README.md)には、オプションの HWP Preview プラグインが必要です（macOS、または glibc 2.39 以降の Linux。Debian 12 は不可）。
- 接続：本人の条件を満たす接続が最優先で、その次は本人、グループ、チーム全体に割り当てられた接続の順に使われます。新規の Trina チームでは、会社の接続ひとつをチーム全体で使えるのが既定です。既存の保存済み設定はそのまま維持されます。**このソフトウェアの設定によって、Anthropic や OpenAI の規約上の許可が得られるわけではありません。** [接続の詳細](docs/FAQ.md)
- Linux でのセルフホストには、Debian 12/13 または Ubuntu 24.04、systemd と cgroup v2、amd64 または arm64、RAM 4 GB、ディスク 20 GB が必要です。インストール、アップデート、バックアップからの復元は社内の IT 担当者が行います。

</details>

## コミュニティ

Trina AX がチームの役に立ったら、⭐ で応援してください。ほかのチームが見つけやすくなります。

[Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax) · [リリース](https://github.com/trina-app/trina-ax/releases/latest) · [変更履歴](CHANGELOG.md) · [サポート](SUPPORT.md) · [貢献ガイド](CONTRIBUTING.md) · [セキュリティ](SECURITY.md) · [開発](docs/DEVELOPMENT.md) · [設定](docs/CONFIGURATION.md) · [llms.txt](llms.txt)

アプリは英語、韓国語、インドネシア語、日本語、スペイン語、簡体字中国語に対応しています。画像に出てくる会社と人物はすべて架空です。

## ライセンス

[AGPL-3.0-only](LICENSE) のもとで、商用利用も含めて自由に使えます。改変版をネットワーク経由で提供する場合は、その利用者にソースコードを提供してください。クラウドプロトコルは別途 MIT ライセンスで提供しています（[ライセンス](shared/src/cloud-protocol/LICENSE)）。[NOTICE](NOTICE) · [サードパーティ通知](docs/THIRD-PARTY-NOTICES.md)

Claude Code と Codex にはそれぞれ独自の規約があります。本プロジェクトは Anthropic および OpenAI の公認を受けたものではありません。Claude は Anthropic の商標です。
