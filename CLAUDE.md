# ShapeForge – working rules

## Version numbers
- Format is `MAJOR.MINOR.PATCH`. PATCH runs from 0 to 99 only.
- After `x.y.99` the next version is `x.(y+1).0` — never `x.y.100`.
  Example: 0.4.98 → 0.4.99 → 0.5.0 → 0.5.1.
- 0.4.107 overshot this rule, so the next version is **0.5.0**.
- Bump `version` in `package.json` (and `package-lock.json`) with every change.
- `npm run release` (`npm version patch`) does NOT know this rule — don't use it
  to bump past .99; set the version yourself.

## Commit and merge messages
- Every commit message starts with the version: `v0.5.0: what changed`.
- Merge commits too, e.g. `v0.5.0: merge feature/xyz – what it brings`.
  GitHub's default "Merge pull request #N from …" message is not acceptable.

## Git: terminal, not the browser
- Do all git and GitHub work (branches, commits, push, merging into `main`) from the
  terminal with `git` (and `gh` if needed). Don't click through the GitHub website.
- Merging a branch into main:
  ```
  git checkout main
  git pull
  git merge --no-ff feature/xyz -m "v0.5.0: merge feature/xyz – summary"
  git push
  ```
- Pushing to `main` deploys the live site (GitHub Pages) automatically.
