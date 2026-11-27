---
title: Sign in with Google
description: Connect your Google account once with your password, then sign in to your team with Google. What admins can turn off and remove, and how a server you run yourself offers it.
---

**Sign in with Google** lets you sign in to your team with your Google account instead of typing your password. You
connect your Google account once, from your own account and with your password. After that the sign-in page has a
**Sign in with Google** button.

Your password keeps working. Nothing is matched by e-mail: only the Google account you connected yourself signs you in,
even if someone else's Google account uses the same address.

:::note
The button is on the sign-in page in a web browser, at your team's main address. The desktop and phone apps, and an
office, LAN or Tailscale address of the server, keep the password sign-in.
:::

## Connect your Google account

:::steps
#### Open Security & devices
Open **Settings › Security & devices**. Under **Google account**, choose **Connect**.

#### Enter your password
Enter your current password. This checks that it is really you, so someone who only finds your computer open can't
add their own way in.

#### Pick your Google account
Google opens. Pick the Google account to sign in with. You come back to **Security & devices**, which shows the
account's address.
:::

Your **Activity** gets a line saying that a Google account was connected to your account, and your team's owner and
admins see one too. If you didn't do it, choose **Disconnect** in **Security & devices** and change your password.

Right after you connect, one line offers **Google Drive** and **Gmail**. When you connect them, Google picks the same
Google account, so there is no account list to choose from.

You can't connect a Google account:

- with a temporary password from an admin: change it first;
- as a guest;
- when that Google account can't be used here (Trina AX says "This Google account can't be connected"): use a
  different one;
- to swap the Google account of an account that has no password (see below): ask an admin.

## Join or set up the team with Google

In a web browser, an invite and the team invite link have **Continue with Google** at the top, above the password form.
Choose it and pick your Google account: your name comes from Google, and your username from your Google address (the
part before @, without a "+tag"; with a number added if someone has it already). There is nothing to type first and no
password. You can change your name and username later in **Profile**. The first owner sees **Sign up with Google** on
the setup page in the same way.

A guest invite has no Google button: guests choose a password.

## Sign in

On the sign-in page, choose **Sign in with Google** at the top and pick the same Google account. You land where you were going.

| What you see | What to do |
|---|---|
| This Google account isn't connected to an account in this team | Sign in with your password, then connect it in **Security & devices**. |
| An admin gave you a temporary password | Sign in with that password first and choose a new one. |
| This account was turned off | Ask your team's owner or an admin. |
| No **Sign in with Google** button | Your team turned it off, or this address doesn't offer it. Sign in with your password. |
| This team only lets in Google Workspace accounts of its company | Your team allows only work Google accounts of some domains. Use your work Google account, or your password. |
| Google sign-in can't be reached right now | Trina AX's sign-in service is down for a moment. Try again in a few minutes, or ask an admin for a temporary password. |

To stop using it, choose **Disconnect** in **Security & devices**. Your other devices are signed out; this one stays
signed in. When an admin gives you a temporary password, or you set a new password with a reset link, your Google
account is disconnected too: a reset locks out every old way in. Connect it again afterwards.

## An account made with Google (no password)

If you joined or set up the team with **Google**, your account has no password: Google is your only way in.

- **Confirming it's you.** Where others type their password again (handing over the team, updates and restores,
  removing a member, asking to delete your account, setting a password), you see **Confirm with Google**. Google opens
  in a new window and asks you to sign in to Google again, even if you are already signed in there. This works in a web
  browser; in the desktop and phone apps, open your team in a browser for it.
- **Set a password.** **Settings › Security & devices › Set a password**, after confirming with Google. Your team's
  owner and admins see a line in **Activity** when you do.
- **No Disconnect, no other Google account.** Until you set a password, you can't disconnect your Google account or
  swap it for another one. If you lost access to that Google account, ask an admin for a temporary password: you sign in
  with it, choose a password, and can then connect another Google account.

## For admins

Everything about how people sign in is on one page: **Admin › Sign-in methods**.

- **Password.** Everyone can sign in with a username and password. It is always on.
- **Sign in with Google: the switch.** On by default. Off: nobody new connects or joins with Google, and people with a
  password sign in with it. While anyone in the team has no password (made with Google), the sign-in page keeps the
  **Sign in with Google** button for them: it's their only way in. The Google accounts people connected stay, and work
  again when you turn it back on.
- **The line under it** says how Google signs in on your server:

  | Line | What it means |
  |---|---|
  | Through Trina AX's sign-in service | A team hosted by Trina, or a server you run yourself with a public web address: nothing to set up. |
  | Through your company's Google app | Your server has its own Google app (the one Google Drive uses). |
  | Needs a public web address | Google can't come back to your server. **How** opens the section below. |
  | The sign-in service doesn't serve this server yet | Your server registered itself and waits for the service. It checks again every few minutes. |
  | The sign-in service can't be reached right now | People with a password sign in as usual; people without one get the message on the sign-in page. |

- **Only Google Workspace accounts from.** Optional. Type your company's Google Workspace domains, such as
  `acme.com` (several with commas). Then only Google accounts of those Workspaces can sign in, connect or join with
  Google. Trina AX asks Google which Workspace the account belongs to; it never goes by the e-mail address, because a
  personal Google account can use a company address too. Empty (the default): any Google account, personal Gmail too.
- **Try it.** Opens Google. Pick an account: the page after says **Works: <address>**, or that your domain list keeps
  that account out. Nobody is signed in and nothing is connected. It works with the switch off too, so you can try
  before turning it on.
- **See who uses it.** **Admin › Members & invites** shows **Google** beside each person who connected one.
- **Remove someone's.** In the person's **⋯**, choose **Disconnect Google**. They sign in with their password from
  then on, and they are signed out on every device. The usual rules apply: nobody changes the owner here, and only the
  owner changes admins. For someone without a password it's refused (Google is their only way in): give them a
  temporary password instead, which disconnects Google too.
- **See changes.** Your **Activity** gets a line whenever someone's Google sign-in is connected, swapped or
  disconnected, or someone sets a first password, with who did it. If it wasn't expected, check the person in
  **Admin › Members & invites**.

:::warning
Suspending someone in Google Workspace doesn't sign them out of Trina AX, and their password still works. When someone
leaves, disable them in **Admin › Members & invites**: that signs them out on every device at once.
:::

## On a server you run yourself

A server you run yourself signs in with Google through **Trina AX's sign-in service**, as a hosted team does. There is no
Google Cloud project to make and nothing to paste:

- **A public web address** is all it needs, such as `trina.acme.com` (the installer's `--public-host`, or `tunnel.host`
  in [Configuration](../operate/configuration.md)). Google comes back to Trina AX's sign-in service, which sends the
  browser on to your server's address, and only to an address it checked belongs to your server.
- **It registers itself.** Your server proves its address to the service once, as it does for Google Drive, and checks
  again every few minutes. **Admin › Sign-in methods** shows **Through Trina AX's sign-in service** once it works.
- **What the service sees.** When someone signs in, Trina AX's sign-in service passes Google's answer to your server. In
  passing it sees the Google account's name and e-mail address. It keeps none of it after the sign-in finishes (at most
  2 minutes), only that your server used Google sign-in, and when.
- **When the service is down.** People with a password sign in as usual. People who joined with Google and have no
  password see "Google sign-in can't be reached right now"; an admin can give them a temporary password meanwhile
  (which disconnects their Google account; they connect it again later).
- **The office, LAN or Tailscale address** keeps the password sign-in: Google comes back only to the public address.

**Your company's own Google app instead.** If your server already has a Google app (the one Google Drive uses: see
[Google with your own Google app](../operate/google-own-app-self-installed.md)), sign-in uses that app and nothing goes
through Trina. Google comes back to the address Google Drive already uses:

```
https://<your address>/api/integrations/google-drive/callback
```

A Google Workspace company can make that app **Internal**: only your company's accounts can use it, and Google doesn't
review it. Signing in asks Google only for the person's name, e-mail address and account id.

A team hosted by Trina can use its company's own Google app too:
[Use your company's own Google app](google-own-app.md).
