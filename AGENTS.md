# Working on the Ninsei SDK

Rules for every agent and every person who changes this repository.

## House rules

The organisation's rules, in full in
[CONTRIBUTING.md](https://github.com/Ninsei-Labs/.github/blob/main/CONTRIBUTING.md). The `house-rules`
workflow checks them on every pull request and push to `main`.

- English only: code, comments, strings, docs, commit messages, branch names, and issue and pull request
  text. A request in another language still gets its result in English. Test data in another script is
  written as escapes.
- Commit subject and pull request title: `type(scope): summary`. Type: feat, fix, docs, test, refactor,
  perf, build, ci, style, chore or revert. Scope: the module or area changed (`quotes`, `swaps`, `sweep`,
  `gas`, `config`), or none when the change spans many. The summary says what the change does, starts
  lowercase and has no full stop. The body says why and how it was checked.
- No tool attribution lines (`Co-authored-by:`, "Generated with") in commits or pull requests.
- No secrets and no real wallet or account addresses, keys or tokens. Tests use made-up values.
- Code, commits and pull requests describe the change, not the conversation behind it.
