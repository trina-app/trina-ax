- A page on one team address could leave a pile of cookies on the shared parent domain, and from then on every
  team address answered a blank "400 Bad Request" in that browser until the person cleared cookies by hand. The
  relay now reads request heads up to 128 KB and passes on only the cookies a team server uses (its own `__Host-`
  sign-in cookie), so such cookies no longer reach or break the team. When there are even more of them, the
  address shows a page in the team's language that explains what happened, with a button that removes the extra
  cookies (the sign-in stays) and steps for the browser settings if the page comes back.
