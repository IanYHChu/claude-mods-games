# claude-mods-games

[![mod check](https://img.shields.io/github/actions/workflow/status/IanYHChu/claude-mods-games/mod-check.yml?branch=main&label=mods%3A%20pinned%20%26%20checked)](CAPABILITIES.md)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/IanYHChu/claude-mods-games/badge)](https://scorecard.dev/viewer/?uri=github.com/IanYHChu/claude-mods-games)

Small games built with Claude Mods. While Claude is thinking or running your tests, the space above
the prompt is your game table. The games run entirely on your machine: they spend no tokens and
stay out of your conversation with Claude.

## Requirements

Claude Code 2.1.288 or later (Claude Mods shipped in 2.1.287; 2.1.288 fixed the mod button and the
band above the prompt). Check with `claude --version`, update with `claude update`.

## Install

Add the marketplace once. Inside Claude Code:

```
/plugin marketplace add IanYHChu/claude-mods-games
```

Or in a terminal:

```sh
claude plugin marketplace add IanYHChu/claude-mods-games
```

Then install a game, for example:

```sh
claude plugin install mah-jong@claude-mods-games
```

Start a new session and the game appears above the prompt.

## Games

| Game | What it is | Install |
|---|---|---|
| [mah-jong](https://github.com/IanYHChu/mah-jong) | Taiwanese 16-tile mahjong against three bots, with full tai scoring and payouts | `claude plugin install mah-jong@claude-mods-games` |
| [hold-em](https://github.com/IanYHChu/hold-em) | A six-player Texas Hold'em Sit & Go against five bots, with side pots, rising blinds and finishing places | `claude plugin install hold-em@claude-mods-games` |
| [code-quest](https://github.com/IanYHChu/code-quest-cli) | A gear-driven roguelike: the smells in the code Claude reads become the monsters, and Claude's tool calls drive the run | `claude plugin install code-quest@claude-mods-games` |

## Security

Claude Code mods are not sandboxed: once installed, a mod runs inside the Claude Code process with
your user's permissions. What this marketplace can do is make what each mod does checkable, and
keep a compromised upstream from reaching you.

- **Pinned versions.** Every game is pinned in `marketplace.json` to a fixed commit (GitHub) or an
  exact version (npm). A new commit in a game's repository doesn't reach you on its own: the pin
  has to be bumped here in a pull request, and the checks have to pass.
- **Automated checks.** [`mod check`](.github/workflows/mod-check.yml) runs on every push, every
  pull request and weekly. It fetches each game at its pinned version and checks that:
  - npm packages pass registry signature verification (and provenance, when they have it)
  - there are no install scripts, no runtime dependencies, and no MCP servers, LSP servers or
    shell-command hooks
  - the code a mod loads imports only `claude-code` and its own files, and touches no globals such
    as `process`, `fetch`, `require` or `eval`, so everything it does goes through the Mods API
  - the hooks and API calls that `claude plugin validate` reports for each mod match
    [CAPABILITIES.md](CAPABILITIES.md)
- **Capability list.** [CAPABILITIES.md](CAPABILITIES.md) lists the hooks each mod registers and the
  API calls it makes, and flags anything that touches your files, programs, network, settings,
  conversation or usage. Any change in what a mod can do shows up in the pull request's diff.

These checks are static, so deliberately obfuscated code could still get past them; they are not
a substitute for a sandbox. For an extra layer:

- Third-party marketplaces don't auto-update by default. Keep it that way, and look at the
  CAPABILITIES.md changes before you update.
- Before installing, clone a game's repository and run `claude plugin validate .` to see which
  hooks it registers and which APIs it calls.
- Organization admins can use `strictKnownMarketplaces` in managed settings to allow only reviewed
  marketplaces, or `allowManagedModsOnly` to allow only mods the organization deploys.

## Update

```sh
claude plugin marketplace update claude-mods-games
```

## Maintaining: bumping a game

1. In `.claude-plugin/marketplace.json`, change the game's `sha` (GitHub) or `version` (npm) to the
   new release.
2. Run `npm ci && npm run check-mods`. When the checks pass, it rewrites CAPABILITIES.md (needs
   `claude` installed).
3. Open a pull request with both files, link the compare view between the old and new versions in
   the description, and review the CAPABILITIES.md diff before merging.

## License

MIT
