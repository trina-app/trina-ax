- CI only: the dev → main release pull request no longer fails `changelog:check`. It is compared with dev, not main,
  so the notes dev gathered since the last release no longer count as lines the PR added.
