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

## Sign in

On the sign-in page, choose **Sign in with Google** and pick the same Google account. You land where you were going.

| What you see | What to do |
|---|---|
| This Google account isn't connected to an account in this team | Sign in with your password, then connect it in **Security & devices**. |
| An admin gave you a temporary password | Sign in with that password first and choose a new one. |
| This account was turned off | Ask your team's owner or an admin. |
| No **Sign in with Google** button | Your team turned it off, or this address doesn't offer it. Sign in with your password. |

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

- **Turn it on or off.** **Admin › Team settings › Members and AI › Sign in with Google**, on by default. Off: nobody
  new connects or joins with Google, and people with a password sign in with it. While anyone in the team has no
  password (made with Google), the sign-in page keeps the **Sign in with Google** button for them: it's their only way
  in. The Google accounts people connected stay, and work again when you turn it back on. The row is there only when
  your server has a Google app (see below).
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

Sign in with Google uses the same Google app as Google Drive. If Google Drive is set up on your server, there is
nothing more to do: the sign-in page shows the button, and each person connects their Google account once.

- **The Google app.** Set it up once in **Admin › Connected apps › Google Drive**: see
  [Set up the Google apps](google-apps.md#set-up-the-google-apps-admins-of-a-server-you-run-yourself). Without it, the
  row in **Team settings** says so and links there.
- **The return address.** Google comes back to the address Google Drive already uses. Nothing new to add in Google
  Cloud:

  ```
  https://<your address>/api/integrations/google-drive/callback
  ```

- **No Google review for a company.** A Google Workspace company can make the app **Internal**: only your company's
  accounts can use it, and Google doesn't review it. Signing in asks Google only for the person's name, e-mail address
  and account id.

A team hosted by Trina uses its company's own Google app for this:
[Use your company's own Google app](google-own-app.md).
