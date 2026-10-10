# Working on the Ninsei SDK

Rules for every agent and every person who changes this repository.

## House rules

The organisation's rules, in full in
[CONTRIBUTING.md](https://github.com/Ninsei-Labs/.github/blob/main/CONTRIBUTING.md). The `house-rules`
workflow checks the commit form and the attribution lines on every pull request and push to `main`; the rest
is kept by whoever writes and reviews a change.

- Commit subject and pull request title: `type(scope): summary`, at most 72 characters. Type: feat, fix,
  docs, test, refactor, perf, build, ci, style, chore or revert. Scope: the module or area changed
  (`quotes`, `swaps`, `sweep`, `gas`, `config`), or none when the change spans many. The summary says what
  the change does, starts lowercase and has no full stop. The body says why and how it was checked.
- One commit is one logical change; work-in-progress and fixup commits are squashed into it before merging.
- No tool attribution lines (`Co-authored-by:`, "Generated with") in commits or pull requests.
- No secrets and no real wallet or account addresses, keys or tokens. Tests use made-up values.
- Code, commits and pull requests describe the change, not the conversation behind it.
