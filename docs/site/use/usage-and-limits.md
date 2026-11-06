---
title: Usage and limits
description: See answers, tokens and estimated cost per person, and set token limits for people, groups or the team.
---

Trina AX counts every answer: who asked, which engine and model, how many tokens, and an estimated cost.

:::note
Costs are estimates of the equivalent API price, not bills. Subscription connections add 0 per request, but their tokens still count.
:::

## Your own usage

Open **Usage** from your account menu. It shows your answers, tokens and estimated cost, and how full each limit that applies to you is. You only ever see your own numbers.

![Settings › Usage: Your usage, your answers by model for this month, and answers, tokens and estimated cost](../images/usage/mine.webp "Your own usage, in Settings")

:::note
Personal usage is new in 0.4.0. Before that, only admins see usage, in **Admin › Usage**.
:::

## The team's usage

Admins open **Admin › Usage**. It is laid out like the Claude Console's usage page.

- **Filters** at the top, each a small button that shows what is chosen:
  - **Group** (only when the team has groups) and **Range**: today, the last 7 or 30 days, this month, or a custom range.
  - **Person**, **Engine**, **Model** and **AI connection**, to look at one of them. **Clear filters** shows everything again.
  - **Group by** person, group, engine, model, day, AI connection or skill.
- **Cards** with the totals: tokens in, tokens out, answers and the estimated cost.
- **Token usage**: tokens per day as stacked bars, one colour per Group by value (the five biggest, the rest as "Other"). Point at a day, or focus the chart and use the arrow keys, to see that day's numbers.
- **Breakdown**: a row per Group by value with answers, tokens, its share and the estimated cost.
- The **download** button saves the breakdown as CSV.

![Admin › Usage: filter buttons, cards with the totals, the Token usage chart and the breakdown](../images/usage/team.webp "The team's usage, in Admin")

Personal skills are never counted by name, so no admin sees what someone keeps privately.

## Set limits

There are no limits by default. Admins add them in **Admin › Team settings**, under **Usage limits**.

| Limit for | Period |
|---|---|
| A person | per day or per month |
| A group | per day or per month |
| The whole team | per day or per month |

When a limit is reached, the people it covers cannot start new answers until the period resets. Their usage page says when that is.
