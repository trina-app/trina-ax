---
title: 群聊中的应用
description: 让 Sentry、GitHub、Google Forms 或其他任何服务把更新发到群聊里，以卡片形式显示，群聊里的每个人都能看到。
---

群聊可以接收团队已经在用的服务发来的更新：新的 **Google 表单** 回复、来自 **Sentry** 的错误、来自 **GitHub** 的拉取请求和
失败的检查，或者任何能向 Webhook URL 发送消息的服务。它们以应用发出的卡片显示，带有应用的标志和 **应用** 标签，从不显示为
某个人。同一件事的后续更新（同一个错误、同一个拉取请求、被修改的回复）会放进第一张卡片下的同一个话题里，第一张卡片的状态行
会随之更新。

## 添加应用

1. 打开群聊，然后选择 **⋯ › 添加应用**。
2. 选择一个服务。服务分组列出：**表单**（Google 表单、Typeform、Tally、Jotform）、**付款与订单**（Stripe、Shopify）、
   **工作**（Notion、Zendesk）和 **开发者**（GitHub、Sentry）。最后的 **其他应用** 可以接入其他任何服务。需要特定方案或角色
   的服务会在它那一行写明（例如 *需要：Notion 付费方案*）。其他应用要先起个名字（例如 *备份通知*），它的消息会以这个名字显示。
3. 按 Webhook URL 旁边的 **复制**（Google 表单为 **复制代码**），然后按照该服务中的编号步骤操作。在你复制之前，群聊里不会
   添加任何东西，所以你可以先看看，再关闭指南。
4. 指南会实时显示进展：*正在等待第一条消息*、*已连接*，或者上一次为什么没有显示。**看个示例** 会在指南里显示它的消息会是
   什么样子，不会真的发布。

谁可以添加：在团队群聊或所有人群聊中，是其中的所有者和管理员；在一对一聊天或群组聊天中，是其中的任何人。群聊里的其他人
可以看到卡片、在话题中回复，并向 Trina 询问。点一下应用的名称，可以看到是谁设置的。

群聊里的每个人都能看到应用的消息，之后加入的人也能看到。请谨慎选择群聊：错误报告或表单回答里可能有客户数据。

### Google 表单

Google 表单没有可以粘贴网址的地方，所以 Trina 会给你一段用于表单的短脚本
（[Apps Script 触发器](https://developers.google.com/apps-script/guides/triggers/installable)）。

- 在表单中打开 **⋮ › Apps Script**，删除原有内容，粘贴代码并保存。
- 在顶部选择 **setUp**，然后点 **Run**。Google 会显示 **Google hasn't verified this app**：这是正常的，因为脚本是你自己的，
  只在你的账号里运行。选择 **Advanced › Go to … (unsafe)**，然后允许访问。
- 如果表单收集电子邮件地址，每条回复都会显示回复者的邮箱。在应用设置中关闭 **回复者的邮箱** 即可不显示。能编辑表单的人都能
  看到这段代码。

### 表单、付款和工作工具

Typeform、Tally、Jotform、Stripe、Shopify、Notion 和 Zendesk 各有自己的指南，步骤用的是该服务自己的界面名称。简单来说：

- **Typeform**：在表单的 **Connect › Webhooks › Add a webhook** 中粘贴、保存并打开。
- **Tally**：在表单的 **Integrations › Webhooks › Connect** 中，粘贴到 **Endpoint URL**。
- **Jotform**：在表单的 **Settings › Integrations** 中搜索 **WebHooks** 并粘贴。
- **Stripe**（需要 Admin 或 Developer 角色）：**Developers › Workbench › Webhooks › Create an event destination**，勾选指南
  列出的事件，选择 **Webhook endpoint**，粘贴到 **Endpoint URL**。
- **Shopify**（店主或可访问设置的员工）：在 **Settings › Notifications › Webhooks › Create webhook** 中为 **Order
  creation** 创建；也可以再为 Order payment、Order cancellation 和 Refund create 各创建一个。
- **Notion**（付费方案）：数据库的 **Automations**，操作选 **Send webhook**；至少勾选标题和 Status。
- **Zendesk**（Team 方案或更高，管理员）：先创建 webhook，再创建一个触发器，发送指南给出的正文（**复制正文** 就在那一步里）。

表单回答会按原样显示在群聊里，包括电子邮件地址；上传的文件只显示文件名。付款和订单卡片只显示客户的名字（Shopify 还显示城市），
从不显示邮箱、电话或银行卡。

Stripe、Shopify、Zendesk、Typeform 和 Tally 可以为发送的内容签名。指南中的 **可选：提高安全性** 用来填入该服务的签名密钥
（或给你一个密钥粘贴到服务里）；之后只显示签名过的消息。

### 其他应用

要求填写 **Slack、Discord 或 JANDI 的 webhook URL** 的工具，可以把 Trina 的 Webhook URL 粘贴到那个位置。两者都没有的工具，
可以通过 Zapier 或 Make 连接；指南中的 **没有你用的应用？** 为两者各举了一个例子。

任何能向 Webhook URL 发送消息的服务（Zapier、Make、Grafana、Uptime Kuma、你自己的脚本）都可以。把 Webhook URL 粘贴到该服务
发送消息的位置，然后发一条测试消息。指南和应用设置里的 **发送方法** 有可以复制的示例：

```json
{ "text": "备份完成：1,204 个文件", "title": "夜间备份", "url": "https://example.com/report", "thread": "nightly-backup" }
```

- `text` 是消息内容，也是唯一必需的字段（也可以用 `content`）。
- `title` 会成为标题，`url` 会成为一个链接，`thread` 相同的消息会归入同一个话题。
- 也接受 Slack 格式的消息（`blocks`、`attachments`）和纯文本。加上 `Idempotency-Key` 请求头，重试时只会发布一次。

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"text":"Hello from my app"}' <Webhook URL>
```

### GitHub

按仓库设置；你需要该仓库的管理员权限（[GitHub 文档](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)）。

- 在仓库中打开 **Settings › Webhooks › Add webhook**。
- 把 Webhook URL 粘贴到 **Payload URL**，并选择 **application/json**。
- 选择 **Send me everything**，然后点 **Add webhook**。Trina 只显示你在应用设置中打开的内容。
- *可选，更安全：* 在指南中按 **复制密钥**，粘贴到 **Secret**。之后 Trina 只显示 GitHub 签名过的内容
  （[验证投递](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)）。

如果什么都没收到，GitHub 中该 webhook 页面上的 **Recent Deliveries** 会显示发送了什么。

### Sentry

Sentry 把它称为内部集成（[Sentry 文档](https://docs.sentry.io/organization/integrations/integration-platform/)）。你需要是
Sentry 中的所有者或管理者。

- 在 Sentry 中打开 **Settings › Developer Settings › Custom Integrations**，选择 **Create New Integration › Internal
  Integration**。
- 把 Webhook URL 粘贴到 **Webhook URL**。
- 在 **Permissions** 下把 **Issue & Event** 设为 **Read**；在 **Webhooks** 下勾选 **issue**。保存。
- *可选，更安全：* 把集成的 **Client Secret** 粘贴到指南中。之后 Trina 只显示 Sentry 签名过的内容
  （[Sentry 如何签名](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/)）。
- *可选：* 如果也想在告警规则触发时发布，在规则中添加 **Send a notification via an integration** 操作并选择这个集成，
  然后在应用设置中打开 **告警触发**。

## 设置

**⋯ › 集成** 在 **应用** 下列出群聊的应用，并有 **添加应用**。每个应用的页面有：

- 是谁设置的，以及 **连接方法**（再次查看步骤）。
- **状态行**：上一条消息、*已暂停* 或 *正在等待第一条消息*。
- **提醒**，每条只有一个操作：上一次为什么没有显示（**检查密钥**）、*已离开的成员知道这个 Webhook URL*（**重新生成**），
  以及能签名但还没有设置密钥的服务的 *未签名：知道 Webhook URL 的任何人都能发布*（**提高安全性**）。
- **名称**：它的消息显示的名字。
- **在此群聊中显示**：要发布的更新类型（适用于会发送多种更新的应用）。在服务中从未设置过的可选事件（例如 Shopify 的退款）
  会显示 *尚未在 Shopify 中设置*，并附有通往那一步的链接。
- **安静发布**：一行简短显示，没有未读标记和提醒。
- **发送方法**（其他应用）。
- **Webhook URL**：再次 **复制**，或 **重新生成**（旧的会立即失效；把新的粘贴到该服务中）。
- **移除应用**：应用不能再发布；它的消息会保留。

## 限制

一个应用每天最多发布 500 条消息（Google 表单：500 条回复）。超过后会暂停到午夜（按团队的时区）：群聊里会出现一行说明，管理
它的人会收到带有 **立即恢复** 的通知（每天一次）。跳过的表单回复仍在表单的“回复”标签页里。卡片是纯文本：其中的内容不能提及
任何人、不能运行任何东西，也不能隐藏链接。

## 当应用无法连接到服务器时

应用要给你的团队发送消息，需要外部连接。托管团队和使用 Trina 中继的服务器都有。只在办公室网络中的服务器没有：群聊的
**添加应用** 会说明这一点，所有者可以在 **管理 › 系统 › 连接** 中 **开启连接**。有自己公网地址并设置了国家或网络限制的服务器，
仍然会接收来自任何地方的应用消息；管理 › 系统 › 连接 中会说明这一点。
