<div align="center">

<img src="web/public/favicon.svg" width="72" alt="Trina AX Logo">

# Trina AX

**全队共用的 AI。**

团队的文件、技能和工具，都放在一台服务器上。每个人的 AI 都从这里开始。

[官网](https://ax.trina.app) · [下载](https://ax.trina.app/download) · [文档](docs/README.md) · [Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax)

<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="在 App Store 下载"></a>&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="40" alt="在 Google Play 下载"></a>

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md) · 简体中文

</div>

<br>

<a href="https://ax.trina.app/#watch"><img src="docs/images/readme/v3/film.png" width="100%" alt="观看 97 秒的故事：团队负责人 Alex 只写一句话，就拿到一份 7 页的提案；入职第一天的 Mina 问了同样的问题，她的 AI 却回答“Trina Logistics? Who are they?”"></a>

<p align="center"><sub>新同事的 AI 从一个空文件夹开始。Trina 把团队的文件夹交给它。</sub></p>

## 工作原理

<img src="docs/images/readme/v3/how.png" width="100%" alt="1 放入文件和技能：文件窗口里能看到每个文件夹谁能打开，还有 Customer quote 技能的四个步骤。2 连接你的工具：Higgsfield、Notion、Linear、GitHub 和公司 API 都经过你的 Trina 服务器，按人检查权限；一份用 Higgsfield 照片做的幻灯片。3 邀请团队成员：Mina、Alex 和 Sam 在各自的设备上提问，都连到同一台 Trina 服务器，各用各的权限。">

## 团队能得到什么

<img src="docs/images/readme/v3/room.png" width="100%" alt="在任何对话旁边提问，一键发出：在 Expo booth crew 对话里，Mina 在只有她能看到的侧边聊天里问 Trina，再把回答发到对话里。">

<p>
<img src="docs/images/readme/v3/access.png" width="49%" alt="每个人只看到自己能打开的内容：每个文件夹旁显示能打开它的人的头像；Mina 打不开 shared/Finance。">
<img src="docs/images/readme/v3/handoff.png" width="49%" alt="接着同事的 AI 聊天做：Sam 用自己的权限继续 Mina 的项目聊天。">
</p>

<p>
<img src="docs/images/readme/v3/skills.png" width="32%" alt="把团队的做法写下来：团队负责人的 Customer quote 技能，Mina、Sam 和 Jordan 都在用。">
<img src="docs/images/readme/v3/tools.png" width="32%" alt="连接你们在用的工具：任何 MCP 服务器、Google Drive、Slack、公司 API。">
<img src="docs/images/readme/v3/versions.png" width="32%" alt="每次改动都会保留：Alex、Mina 和 Sam 保存的 Price sheet.xlsx 各个版本，其中一个是在 AI 回答时保存的，都可以恢复。">
</p>

<img src="docs/images/readme/v3/access-answers.png" width="100%" alt="Alex 和 Mina 都问“What was our revenue last quarter?”。Alex 能打开 Finance，得到 $498,000；Mina 打不开，所以她的 AI 说，在她能打开的文件里没有找到营收数据。">

AI 打开的每个文件，都会以提问者本人的身份检查权限。[权限如何运作](docs/PERMISSIONS.md)

## 开始使用

- **Trina 托管：** 不用自己运维服务器。14 天免费试用，之后按月订阅。[套餐](https://ax.trina.app/#pricing)
- **应用：** Mac、iPhone、Android 和 Windows，或任何浏览器。[下载](https://ax.trina.app/download)
- **自托管：** 你们自己的 Linux 服务器、Docker 或办公室 Mac。免费。[Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) · [办公室 Mac](docs/OFFICE.en.md)

<details>
<summary><b>10 分钟在你的电脑上试用</b>（虚构团队，AI 关闭）</summary>

<br>

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # → http://127.0.0.1:19760 · alice / teamax-demo-1
```

需要 Bun 1.3.12 和 Go 1.27+。这不是生产环境的安装方式。[详细步骤](docs/QUICKSTART.md)

</details>

Trina 提供的是工作空间，不是 AI 本身：请接入你们获得授权的 Claude 或 OpenAI 账号与套餐。AI 用量费由你接入的账号计费。

<details>
<summary><b>数据、限制，以及我们不做的承诺</b></summary>

### 我们不做的承诺

- 自托管不等于离线运行：每次请求所需的上下文都会发给你接入的 AI 服务商，已配置的集成也会收到各自的请求。Codex 每次联网搜索，都会把截至当时的对话发给 OpenAI 的搜索服务。如果管理员允许用 OpenRouter 处理语音，视频和音频文件的声音会发给 OpenRouter。服务器每 30 分钟会向 `updates.trina.app` 查询一次自己的公网地址（设置 `MYCEL_EXIT_ADDRESS_CHECK=off` 即可关闭）。[详情](docs/security-and-permissions.md)
- 服务器运维人员可以读取存储的文件和聊天记录；使用托管时，这也包括 Trina 的运维人员。应用管理员没有可以浏览所有人私人对话的界面。
- 撤销文件夹权限并不会删除之前的回答。扩大共享范围时的确认提示，也不等于全面的数据防泄漏（DLP）。
- 不具备任何安全认证，不保证回答完美、一定省钱，也不会自动做出法务、财务或人事决策。请自行审核输出结果和部署边界。
- Linux 服务器不做 OCR：AI 会把照片和扫描页面当作图片来看，但无法按文字搜索。办公室 Mac 还不能读取视频。
- 任何团队都能读取 HWP/HWPX 的文字；[预览和新建韩文（Hangul）文档](resources/hwp/README.md)需要可选的 HWP Preview 插件（macOS，或 glibc 2.39 及以上的 Linux；不支持 Debian 12）。
- 连接：优先使用本人符合条件的连接，然后依次是分配给本人、组和整个团队的连接。新建的 Trina 团队默认可以让一个公司连接供整个团队使用；已经保存过的选择保持不变。**这个软件设置并不代表你获得了 Anthropic 或 OpenAI 条款下的许可。** [连接详情](docs/FAQ.md)
- Linux 自托管需要 Debian 12/13 或 Ubuntu 24.04、启用 cgroup v2 的 systemd、amd64 或 arm64 架构、4 GB 内存和 20 GB 磁盘。安装、升级和从备份恢复都由你们的 IT 团队负责。

</details>

## 社区

[Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax) · [版本发布](https://github.com/trina-app/trina-ax/releases/latest) · [更新日志](CHANGELOG.md) · [获取支持](SUPPORT.md) · [参与贡献](CONTRIBUTING.md) · [安全](SECURITY.md) · [开发](docs/DEVELOPMENT.md) · [配置](docs/CONFIGURATION.md) · [llms.txt](llms.txt)

应用界面支持英语、韩语、印尼语、日语和西班牙语。所有图片中的公司和人物都是虚构的。

## 许可证

基于 [AGPL-3.0-only](LICENSE) 许可证发布，可免费使用，包括商业用途。如果你通过网络提供修改后的版本，需要向这些用户提供对应的源代码。云协议部分单独采用 MIT 许可证（[许可证文本](shared/src/cloud-protocol/LICENSE)）。[声明](NOTICE) · [第三方声明](docs/THIRD-PARTY-NOTICES.md)

Claude Code 和 Codex 各有其使用条款；本项目并未获得 Anthropic 或 OpenAI 的认可或背书。Claude 是 Anthropic 的商标。
