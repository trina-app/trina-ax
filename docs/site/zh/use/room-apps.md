---
title: 群聊中的应用
description: 让 Sentry、GitHub、Google Forms 或其他任何服务把更新发到群聊里，以卡片形式显示，群聊里的每个人都能看到。
---

群聊可以接收团队已经在用的服务发来的更新：来自 **Sentry** 的错误、来自 **GitHub** 的拉取请求和失败的检查、新的
**Google Forms** 回复，或者任何能向网址发送消息的服务。它们以应用发出的卡片显示（带有 **应用** 标签），从不显示为某个人。
同一件事的后续更新（同一个错误、同一个拉取请求、被修改的回复）会放进第一张卡片下的同一个话题里，第一张卡片的状态行会随之更新。

## 添加应用

1. 打开群聊，然后选择 **⋯ › 添加应用**。
2. 选择 **Sentry**、**GitHub**、**Google Forms** 或 **其他应用**。
3. 按 **复制地址**（Google Forms 为 **复制代码**），然后按照该服务中的编号步骤操作。在你复制之前，群聊里不会添加任何东西，
   所以你可以先看看，再关闭指南。
4. 指南会实时显示进展：*正在等待第一条消息…*、*已连接*，或者上一次为什么没有显示。**看个示例** 会发一张示例卡片，
   让群聊里的人先看看会收到什么。

谁可以添加：在团队群聊或所有人群聊中，是其中的所有者和管理员；在一对一聊天或群组聊天中，是其中的任何人。群聊里的其他人
可以看到卡片、在话题中回复，并向 Trina 询问。点一下应用的名称，可以看到是谁设置的。

群聊里的每个人都能看到应用发来的消息，之后加入的人也能看到。请谨慎选择群聊：错误报告或表单回答中可能含有客户数据。

### Sentry

Sentry 把它叫作内部集成（[Sentry 文档](https://docs.sentry.io/organization/integrations/integration-platform/)）。
你需要是 Sentry 中的所有者或经理。

- 在 Sentry 中打开 **Settings › Developer Settings › Custom Integrations**，选择 **Create New Integration ›
  Internal Integration**。
- 把地址粘贴到 **Webhook URL**。
- 在 **Permissions** 下把 **Issue & Event** 设为 **Read**；在 **Webhooks** 下勾选 **issue**。保存。
- *可选，更安全：* 把集成的 **Client Secret** 粘贴到指南中。之后 Trina 只显示 Sentry 签名过的消息
  （[Sentry 如何签名](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/)）。
- *可选：* 如果也想在告警规则触发时发消息，在规则中添加动作 **Send a notification via an integration** 并选择这个集成，
  然后在应用设置中打开 **告警触发**。

### GitHub

按仓库设置；你需要该仓库的管理员权限（[GitHub 文档](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)）。

- 在仓库中打开 **Settings › Webhooks › Add webhook**。
- 把地址粘贴到 **Payload URL**，并选择 **application/json**。
- 选择 **Send me everything**，然后按 **Add webhook**。Trina 只显示你在应用设置中打开的内容。
- *可选，更安全：* 在指南中按 **复制密钥**，粘贴到 **Secret**。之后 Trina 只显示 GitHub 签名过的消息
  （[验证投递](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)）。

如果什么都没收到，GitHub 中该设置页面上的 **Recent Deliveries** 会显示发送了什么。

### Google Forms

Google Forms 没有可以粘贴地址的地方，所以 Trina 会给你一段用于表单的简短脚本
（[Apps Script 触发器](https://developers.google.com/apps-script/guides/triggers/installable)）。

- 在表单中打开 **⋮ › Apps Script**，删除原有内容，粘贴代码并保存。
- 在顶部选择 **setUp**，然后按 **Run**。Google 会显示 **Google hasn't verified this app**：这是正常的，因为脚本是你自己的。
  选择 **Advanced › Go to … (unsafe)**，然后允许访问。
- 如果表单收集电子邮件地址，每条回复都会显示回复者的邮箱。在应用设置中关闭 **回复者的邮箱** 即可不显示。能编辑表单的人
  都能在脚本中看到这个地址。

### 其他应用

任何能向网址发送消息的服务都可以（Zapier、Grafana、Uptime Kuma、你自己的脚本）。把地址粘贴到该服务发送消息的位置，
然后发一条测试：名为 `text` 的字段中的文字会出现在群聊里（与 Slack 接收消息的格式相同）。

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"text":"Backup finished"}' <address>
```

## 设置

**⋯ › 在这里发消息的应用** 列出群聊中的应用。单个应用的页面包括：

- **状态行**：最后一条消息、上一次为什么没有显示、*已暂停*，或 *已离开的人知道这个地址*。
- **在这个群聊中显示**：要发哪些类型的更新。
- **安静**：简短的一行，不计入未读，也不会提醒任何人。
- **地址**：再次复制，或 **获取新地址**（旧地址会立即失效；把新地址粘贴到该服务中）。
- **从这个群聊移除**：应用不能再发消息；已有的消息会保留。

## 限制

一个应用每天最多发 500 条消息。超过后会暂停到午夜（按团队的时区）：群聊里会出现一行说明，管理它的人会收到一条带有
**立即恢复**（每天一次）的通知。卡片是纯文本：其中的内容不能提及任何人、不能运行任何东西，也不能隐藏链接。

## 应用无法连接到服务器时

服务通过团队的互联网地址连接到你的团队。托管的团队和使用 Trina 中继的服务器都有这个地址。只在办公网络中运行的服务器没有：
群聊的 **添加应用** 会说明这一点，所有者可以在 **管理 › 系统 › 连接** 中打开中继。有自己公网地址、并设置了国家或网络限制
的服务器，仍然可以接收来自任何地方的应用消息；**管理 › 系统 › 连接** 会说明这一点。
