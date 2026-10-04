# Security policy

## Reporting a vulnerability

Please report privately through GitHub: open the **Security** tab of this repository and choose
**Report a vulnerability**, or go straight to
https://github.com/IanYHChu/claude-mods-games/security/advisories/new. Don't open a public issue for a
security problem.

This marketplace is maintained in spare time. Reports are acknowledged as soon as possible, and
fixes for confirmed problems take priority over everything else.

## What's in scope

- A game in this marketplace that does more than [CAPABILITIES.md](CAPABILITIES.md) lists
- A way to get code past `scripts/check-mods.mjs`, or to make it report the wrong capabilities
- A pin in `.claude-plugin/marketplace.json` that doesn't resolve to the reviewed code
- Weaknesses in this repository's workflows

A problem in a game's own code can be reported here or in the game's repository.

## Supported versions

Only the versions currently pinned in `.claude-plugin/marketplace.json` are supported. A fix ships
as a new pinned version; update with `claude plugin marketplace update claude-mods-games`.
