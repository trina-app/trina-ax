<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Trina AX ロゴ">

# Trina AX

**Claude Code を一度セットアップすれば、全社で使える。**

会社のサーバー1台で Claude Code と Codex を動かします。会社のファイルもチームのスキルも、一人ひとりのフォルダー権限も、そのサーバーにそろっています。ほかのメンバーはブラウザーを開くだけです。

[Web サイト](https://ax.trina.app) · [10分で試す](#10分で試す) · [セルフホスト](docs/for-admins.md) · [ドキュメント](docs/README.md)

[English](README.md) · [한국어](README.ko.md) · 日本語 · [Español](README.es.md)

<img src="docs/images/readme/hero-day-one.gif" width="100%" alt="新しく入ったメンバーが「Write a proposal for Trina Logistics.」と1行入力すると、AI が社長の提案書スキルとチームの営業資料を読み、7ページの提案書を保存してチャットの横に開きます。">

<sub><b>入社初日、1行だけ：</b>「Write a proposal for Trina Logistics.」と頼むと、AI がチームの営業資料を読み、社長の <code>proposal</code> スキルに沿って7ページの提案書を保存しました。<br>実際のアプリ（画面は英語）に、架空の会社のデータを入れています。生成には81秒かかりました。動画は早送りです。</sub>

</div>

## 同じ依頼、違う答え

<table>
<tr>
<td width="50%" valign="top"><b>空のフォルダーで開いた Claude Code</b><br><sub>会社のことを知りようがないので、まず質問を6つ返します。</sub></td>
<td width="50%" valign="top"><b>Trina AX に同じ1行</b><br><sub>チームのファイルと社長の提案書スキルをもとに書き始めます。</sub></td>
</tr>
<tr>
<td><img src="docs/images/readme/before-empty-claude.png" alt="空のフォルダーで開いた Claude Code は、「Write a proposal for Trina Logistics」に対して、会社・顧客・形式について6つの質問を返します。"></td>
<td><img src="docs/images/readme/after-trina-deck.png" alt="Trina AX は同じ依頼に対して、表紙に「Lead time from 2.1 to 1.4 days」と書かれた7ページの提案書を返します。"></td>
</tr>
</table>

<sub>2026-10-31 に架空の会社 Dawnroute で実際に出力した結果です。Claude Code が聞き返すのは正しい判断です。空のフォルダーには、どんな会社なのかを伝えるものが何もないからです。Trina は、そのフォルダーを Claude Code に渡します。</sub>

## しくみ

1. **一度入れておく。** 会社の資料は `shared/` に、提案書の書き方は `skills/proposal/SKILL.md` に置きます。
2. **誰でも質問できる。** パソコンでもスマートフォンでも、ブラウザーのチャットアプリから使えます。ターミナルも、ノートPCへのインストールも要りません。
3. **権限は人ごと。** AI がファイルを開くたびに、サーバーが質問者本人の権限でチェックします。自分に見えないフォルダーは、自分の AI にとっても存在しません。

<img src="docs/images/readme/permission-answer.png" width="100%" alt="営業チームのメンバーが「What was our revenue last quarter?」と聞くと、AI は本人がアクセスできるチームのファイルには売上の数字が見つからなかったと答えます。">

<sub><b>同じ質問でも、聞く人によって答えが変わります。</b> 営業の Mina は、売上ファイルのある <code>shared/Finance</code> を開けません。そのため、Mina の AI も開けません。</sub>

## 10分で試す

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile
bun run demo        # → http://127.0.0.1:19760 · alice / teamax-demo-1 でログイン
```

架空のチームと、スタータースキル6つが入っています。AI はオフなので、AI アカウントは要りません。シークレットウィンドウで `bob` としてもログインしてみてください。alice とは見えるグループフォルダーが違います。Git、Bun 1.3.12、Go 1.27 以上が必要です。**本番環境向けのインストールではありません。** [詳しい手順](docs/QUICKSTART.md)

## できること

| | 具体的には |
|---|---|
| **本物の Claude Code・Codex エージェント** | 自社のサーバーで動きます。ツール実行は1回の回答につき既定で最大150ラウンド、サブエージェントは同時に最大4つまでです。Web 検索とスケジュール実行にも対応しています。 |
| **会社のフォルダーがそのまま知識に** | `shared/`、`groups/`、`projects/`、個人フォルダーを、バージョン履歴付きで扱います。PDF、Office、HWP/HWPX ファイルからテキストも読み取ります。 |
| **チームスキルもファイルと同じように管理** | スキルの実体は `SKILL.md` ファイルです。誰が使えるかはフォルダーのルールで決まり、AI がスキルを変更する前には人に確認を求めます。 |
| **ファイル操作のたびに権限チェック** | アクセス権のないファイルは、ファイル画面、AI の回答、検索、プレビュー、バージョン履歴、ごみ箱のどこにも表示されません。 |
| **自分たちの AI 接続を使う** | Claude または OpenAI を、サブスクリプションか API キーで接続します。接続は個人、グループ、チーム全体のいずれかに割り当てられます。使用量は人ごとに確認でき、上限も設定できます。 |
| **セルフホストもホスティングも** | Linux サーバー、オフィスの Mac、AWS ソウルリージョンの Trina ホスティングから選べます。パソコンやスマートフォンのブラウザーで使えるほか、Windows 用インストーラーもあります。 |

## 内部構造

```mermaid
flowchart LR
  P["チーム<br/>ブラウザー・スマートフォン・Windows アプリ"] --> S["Trina サーバー"]
  E["Claude Code / Codex<br/>組み込みのシェルとファイルツールはオフ"] -->|"唯一の経路：Trina のファイルツール"| C{"権限チェック<br/>質問者本人として"}
  S --> C
  C --> D[("会社のフォルダー<br/>shared · groups · projects · users")]
  E -. "ディスクへの直接アクセスは OS が拒否" .-x D
```

- **エージェントは本物です。** サブエージェントも同じ本人として動き、同じチェックを通り、同じ操作記録を残します。
- **入り口を絞っています。** エンジン組み込みのシェルとファイルツールはオフにしてあり、エンジンごとの回帰テストで確認しています。フォルダーにアクセスする経路は Trina のファイルツールだけで、呼び出しのたびにチェックされます。
- **キーはエンジンに渡しません。** トークンはブラウザー内で暗号化してから送信します。エンジンが受け取るのはターンごとの代理トークンだけで、本物のトークンはモデルプロキシが付け加えます。
- **管理者でもチャットは読めません。** 管理者に見えるのは AI がどのファイルを読んだかで、会話の内容は見えません。ただし、サーバーの運用者は保存データを読めます。この点は[後述の「データと制限」](#データと制限)にも明記しています。

<sub>OS レベルの分離（エンジン専用アカウント）が適用されるのは、Linux と、ロールアカウント方式で導入した Mac だけです。オフィス Mac はサインイン中のユーザーとして動作し、ローカルデモには OS 分離がありません。→ <a href="docs/security-and-permissions.md">セキュリティと権限（英語）</a> · <a href="docs/PERMISSIONS.md">権限モデル（韓国語）</a></sub>

## チームの最初の1週間

オーナーアカウントを作ったら、**権限 → AI 接続 → メンバー招待 → 最初のスキル → 最初のバックアップ**の順に進めます。以下のスタータースキルは、架空の入力データを使います。

| 役割 | 実際の業務 | コピーして使えるスキル |
|---|---|---|
| 社長・チームリーダー | 週次メモを決定事項・リスク・次のアクションに整理 | [Weekly report](examples/skills/weekly-team-report/SKILL.md) |
| 営業 | 打ち合わせ内容から、勝手な約束を書かずにフォローアップを下書き | [Sales follow-up](examples/skills/sales-follow-up/SKILL.md) |
| マーケティング | 承認済みのブランド資料からキャンペーンブリーフを作成 | [Brand brief](examples/skills/brand-brief/SKILL.md) |
| 経理 | 不足している領収書や不確かな金額を洗い出し、確認に回す | [Expense review](examples/skills/expense-review/SKILL.md) |
| 人事 | 閲覧を許可された規程をもとに、新入社員の質問に回答 | [New-hire guide](examples/skills/new-hire-guide/SKILL.md) |
| 全員 | 議事録から決定事項とタスクを抽出 | [Meeting summary](examples/skills/meeting-summary/SKILL.md) |

スキルは繰り返し使える指示のまとめです。モデルの学習でも、追加の権限でもありません。結果は人が確認してから使います。[チームリーダー向けチェックリスト](docs/for-teams.md) · [すべての例](examples/README.md)

## 導入方法

| | Trina ホスティング | Linux でセルフホスト | オフィス Mac | ローカルデモ |
|---|---|---|---|---|
| 向いているケース | IT 担当者がいないチーム | IT 担当者がいるチーム | 専用の Mac がある小規模オフィス | まずは触ってみたい |
| 運用するのは | Trina（AWS ソウル） | 社内の IT 担当者 | オフィスの運用担当者 | 自分 |
| AI | 利用が認められた Claude・OpenAI の接続 | 同上 | Claude のみ（Codex なし） | オフ |
| 費用 | 月額 $39〜 + AI 利用料 | ソフトウェアは無料 + サーバー費用 | ソフトウェアは無料 | 無料 |
| 始め方 | [お問い合わせ](https://ax.trina.app/#contact) | [Linux ガイド](docs/INSTALL-LINUX.en.md) | [オフィスガイド](docs/OFFICE.en.md) | [クイックスタート](docs/QUICKSTART.md) |

Trina が提供するのはワークスペースで、AI そのものではありません。Claude と OpenAI は、自分たちの使い方が認められているアカウントとプランだけを使ってください。ホスティングプランの料金（2026-10-30 時点、米ドル、税抜き）：**Starter 月額 $39（5人まで）、Team $69（15人まで）、Business $129（40人まで）**。AI の利用料は別途かかります。ホスティングはお問い合わせ制で、申し込んですぐ使える無料トライアルではありません。[最新の料金](https://ax.trina.app/#pricing)

Linux でセルフホストするには、Debian 12/13 または Ubuntu 24.04、systemd と cgroup v2、amd64 または arm64 が必要です。RAM は 4 GB を推奨、ディスクは 20 GB 以上が必要です。インストール、アップデート、バックアップからの復元は社内の IT 担当者が行います。

## データと制限

セルフホストでも、オフラインで動くわけではありません。依頼の処理に必要なコンテキストは、接続した AI プロバイダーに送られます。サーバーの運用者（ホスティングの場合は Trina も含む）は、保存されたファイルとチャットを読めます。アプリの管理者は、他人の個人的な会話を閲覧できません。

<details>
<summary><b>サーバーの外に出るもの、接続のルール、保証しないこと</b></summary>

<br>

- 選択されたコンテキストは選んだ AI プロバイダーに、各リクエストは設定済みの外部連携に送られます。Codex が Web 検索をするたびに、それまでの会話が OpenAI の検索サービスに送られます。サーバーは30分ごとに、自身の公開アドレスを `updates.trina.app` に問い合わせます（`MYCEL_EXIT_ADDRESS_CHECK=off` で無効にできます）。[詳細](docs/security-and-permissions.md)
- サーバーの運用者は、保存されたファイルとチャットを読めます。ホスティングの場合は Trina の運用者も含まれます。アプリの管理者には、全員の個人的な会話を閲覧する機能はありません。
- フォルダーへのアクセス権を外しても、それ以前の回答は消えません。共有範囲を広げるときの確認は、包括的な情報漏えい対策（DLP）ではありません。
- セキュリティ認証、完璧な回答、確実なコスト削減、法務・財務・人事判断の自動化は、いずれもうたっていません。出力内容と導入範囲は人が確認してください。
- AI は写真やスキャンした PDF のページを画像として扱います（管理者がオフにできます）。ただし Linux サーバーでは OCR を実行しないため、スキャン文書や写真はテキスト検索できません。
- HWP/HWPX のテキスト抽出に対応しています。[見た目のプレビュー](resources/hwp/README.md)はオプションの HWP Preview プラグインで提供され、macOS か glibc 2.39 以降の Linux が必要です。そのため Debian 12 では**使えません**。
- 管理型のインストールでは、条件を満たす本人の接続が最優先で、その次は個人、グループ、チーム全体に割り当てられた接続の順に使われます。新規の Trina チームでは、共有サブスクリプションが既定で許可されています。既存の保存済み設定はそのまま維持されます。接続ごとの同意は引き続き適用されます。**このソフトウェアの設定によって、Anthropic や OpenAI の規約上の許可が得られるわけではありません。** ローカルデモでは AI が無効です。開発モードとオフィスのローカルログインモードでは、接続の挙動が異なります。[接続の詳細](docs/FAQ.md)

</details>

## よくある質問

<details>
<summary><b>全員に Claude のシートを用意するのと何が違いますか？</b></summary>

<br>シートを配っても、各自に渡るのは空のワークスペースです。Trina では、1台のサーバー上で全員が同じ会社のフォルダーとチームスキルを使え、各自のフォルダー権限はサーバーが確認します。その上で、人ごとのアカウントを接続することもできます。

</details>

<details>
<summary><b>試すのに AI アカウントは必要ですか？</b></summary>

<br>いいえ。[ローカルデモ](docs/QUICKSTART.md)は AI をオフにした状態で、架空のデータを使って動きます。まずはファイル、スキル、権限を確かめられます。

</details>

<details>
<summary><b>管理者はチャットを読めますか？</b></summary>

<br>いいえ。チャットを見られるのは本人だけです。操作記録からわかるのは AI がどのファイルを読んだかだけで、会話の内容はわかりません。ただし、サーバーやそのストレージを運用する人は保存データを読めます。

</details>

<details>
<summary><b>韓国の HWP ファイルにも対応していますか？</b></summary>

<br>テキストなら対応しています。AI が HWP/HWPX ファイルのテキストを読み取ります。見た目のプレビューにはオプションのプラグインが必要で、Debian 12 では動作しません。詳しくは [FAQ](docs/FAQ.md) をご覧ください。

</details>

## コミュニティと貢献

[最新リリースとチェックサム](https://github.com/trina-app/trina-ax/releases/latest) · [変更履歴](CHANGELOG.md) · [サポート](SUPPORT.md) · [貢献ガイド](CONTRIBUTING.md) · [セキュリティ報告](SECURITY.md) · [開発](docs/DEVELOPMENT.md) · [設定](docs/CONFIGURATION.md) · [機械可読の索引](llms.txt)

アプリは英語、韓国語、インドネシア語、日本語、スペイン語に対応しています。公開済みのインストーラーには、ソースの最新の変更がまだ反映されていないことがあります。各リリースノートを確認してください。

## ライセンス

[AGPL-3.0-only](LICENSE) のもとで、商用利用も含めて自由に使えます。改変版をネットワーク経由で提供する場合は、その利用者にソースコードを提供してください。クラウドプロトコルは別途 MIT ライセンスで提供しています（[ライセンス](shared/src/cloud-protocol/LICENSE)）。[NOTICE](NOTICE) · [サードパーティ通知](docs/THIRD-PARTY-NOTICES.md)

Claude Code と Codex にはそれぞれ独自の規約があります。本プロジェクトは Anthropic および OpenAI の公認を受けたものではありません。Claude は Anthropic の商標です。
