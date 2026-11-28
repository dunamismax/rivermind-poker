# RiverMind Poker

**Free no-limit Texas hold’em against honest poker bots, for play money only.** At [rivermindpoker.com](https://rivermindpoker.com) you sit down at a table of 2 to 9 seats against anonymous people, bots or both, in a desktop or phone browser. There is nothing to install and no sign-up, and the chips can never be bought, sold or cashed out.

RiverMind is also a poker AI project. Its bots are trained offline with Monte Carlo counterfactual regret minimization (MCCFR), the approach behind Pluribus. They are always labelled as bots, and every claim about their strength links to a published, reproducible evaluation.

[![Test](https://github.com/dunamismax/rivermind-poker/actions/workflows/test.yml/badge.svg)](https://github.com/dunamismax/rivermind-poker/actions/workflows/test.yml)

| | |
| --- | --- |
| **Play** | [rivermindpoker.com](https://rivermindpoker.com) |
| **Progress** | [BUILD.md](BUILD.md), starting at **Now** |
| **Roadmap** | [docs/roadmap.md](docs/roadmap.md): where 1.0 is going and why the phases come in this order |
| **Source** | [GitHub](https://github.com/dunamismax/rivermind-poker) · [Codeberg](https://codeberg.org/dunamismax/rivermind-poker) |

## Status

**Phase 5D, the iPhone app. Pre-1.0, live and playable.**

The live site has no-limit hold’em at 2 to 9 seats against labelled bots: random, calling station, RiverMind Easy, a tight-aggressive rule-based player, and the trained RiverMind Medium and RiverMind Hard, each with a [published evaluation](https://rivermindpoker.com/bots). Hard plays a heads-up champion at two seats, a six-seat champion at three to six and a nine-seat model built on it at seven to nine. Guests keep a play-chip wallet and find each other in a lobby with quick seat, waitlists and private tables with invite links. They can react with presets, mute, block and report, and step through any hand they played, from “Your hands” or from the table without leaving their seat. A guest at any balance can start a practice hand in one click. People seated together can talk over table voice, end-to-end encrypted so that the site relays sound it cannot hear. Tables, mid-hand included, are stored in PostgreSQL and survive restarts.

**Now:** RiverMind Poker comes to the iPhone as a native app (decision D-19 in [BUILD.md](BUILD.md#settled-decisions)), written in Swift and SwiftUI and sharing every table, invite and voice room with people in browsers. Its design is in [docs/ios.md](docs/ios.md). Its protocol, table connection, the site's look, drawn natively from the site's own art, and its lobby are built; its table is next. The site has one clean, professional look, drawn in CSS and SVG (D-18).

**Next:** after the app, the full-featured site (Phase 6): replay sharing, friend invites, stats, leaderboards, sit-and-go tournaments, settings, accessibility, content pages and installability. Then hardening and the 1.0 release (Phase 7).

## What RiverMind is

- **Play money only, forever.** Chips can never be bought, sold, cashed out or transferred for value, and the site says so.
- **Bots are honest.** They are always labelled, never pose as people, and their strength claims come from published evaluations.
- **The server decides.** It owns the deck, turn order, validation and payouts. Each browser sees only its own seat’s cards.
- **Fair dealing.** Live tables shuffle with the operating system’s cryptographic randomness. Seeded generators are only for tests, training and evaluation. The site’s fairness page explains how dealing works.
- **Guests, not accounts.** Players stay anonymous with a signed session cookie until at least 1.0.
- **Self-hosted, with no third-party tracking.** No ads, no analytics services and no trackers.

### What it is not

- Not real-money gambling, and never will be.
- No sign-in or user accounts before 1.0.
- No free-text chat in 1.0, only preset reactions.
- No bot that pretends to be a person, and no strength claim without an evaluation behind it.

## Roadmap

[BUILD.md](BUILD.md) has every step with its acceptance criteria and evidence.

| Phase | What | Status |
| --- | --- | --- |
| 0 | Prototype and foundation: training repairs, a bot baseline, a server-owned table, self-hosting | Done |
| 1 | SvelteKit client, with browser tests in Chromium, Firefox and WebKit, and CI | Done |
| 2 | No-limit hold’em engine for 2 to 9 seats: rules, fixtures, property tests, fuzzing, hand histories | Done |
| 3 | Table server v2: multi-seat tables in PostgreSQL, action clocks, the live cutover | Done |
| 4 | Multiplayer and identity: guests, play-chip wallets, the lobby, safety controls, fair dealing | Done |
| 4B | TypeScript stack migration: SvelteKit on Node, Tailwind CSS 4, Drizzle | Done |
| 4C | Table voice, end-to-end encrypted with SFrame under MLS keys | Done |
| 5A | One-click practice, an evaluated heads-up opponent, replay from the table | Done |
| 5B | 6-max and 9-max bots, difficulty levels | Done |
| 5C | A clean, professional look, now the site's only one | Done |
| 5D | A native iPhone app on the App Store, with cross-play | In progress |
| 6 | Full-featured site: replay sharing, stats, leaderboards, sit-and-go tournaments, accessibility | |
| 7 | Hardening and the 1.0 release: monitoring, backups, load tests, a security review | |

## How it works

| Layer | Target (D-14) | Live today |
| --- | --- | --- |
| Pages and assets | SvelteKit 3, Svelte 5 and strict TypeScript on Node through `adapter-node` | The same, since P4B.1 |
| Styling | Tailwind CSS 4 on the site's own theme, one look drawn in CSS and SVG | Tailwind since P4B.2; the look since Phase 5C |
| Table server and API | TypeScript in the same Node server, with the `/ws` WebSocket on the same port | The same, since the P4B.7 cutover. The Python `serve-nl` was retired at P4B.8 |
| Game engine | A TypeScript engine kept byte-identical to the Python reference engine by differential tests | The same, since P4B.7 |
| Bots | Trained and evaluated offline in Python, exported as serving bundles that Node reads | The same: the rule-based bots since P4B.7, the heads-up champion since P5.7a, six seats and nine seats since Phase 5B |
| Database | PostgreSQL 18 with Drizzle ORM migrations | The same, since P4B.7. Alembic was retired at P4B.8 |
| Table voice | SFrame (RFC 9605) under MLS (RFC 9420) keys, relayed by a mediasoup service that cannot decrypt it | The same, since P4C.9 |
| Hosting | The owner’s server, with Caddy for HTTPS and systemd services | The same |

Hands follow the written [no-limit rules](docs/rules.md). The engines are pure: states are immutable and randomness comes only from the caller, so every hand can be replayed exactly. The bot design, card abstraction, training and evaluation method are in [docs/bots.md](docs/bots.md), and the art rules in [docs/design.md](docs/design.md).

## Play locally

Use [uv](https://docs.astral.sh/uv/getting-started/installation/) from the repository root. The project develops on Python 3.12.15 (`.python-version`), with the packages pinned in `uv.lock`.

### In the browser

The browser game is the no-limit game from the live site. Build the SvelteKit client once, with Node and pnpm as in [CONTRIBUTING.md](CONTRIBUTING.md#sveltekit-client), and start the Node server, which serves the pages, the API and the tables.

```sh
cd web
pnpm install --frozen-lockfile && pnpm build
PORT=8000 ORIGIN=http://127.0.0.1:8000 RIVERMIND_API=1 pnpm start
```

Open http://127.0.0.1:8000, choose the seats, bots, blinds and buy-in, and sit down. A reload or dropped connection rejoins your table. Set `DATABASE_URL` to a migrated PostgreSQL database ([CONTRIBUTING.md](CONTRIBUTING.md#postgresql)) to keep tables, mid-hand included, across server restarts.

### In the terminal

The terminal still runs the original prototype: a three-seat, fixed-limit game with a 20-card deck, played against random bots or a trained short-deck checkpoint.

```sh
uv run --locked rivermind-poker play --agent random
```

Use the left and right arrows to choose an action, Enter to confirm, and Q on your turn to leave. To play a learned strategy, pass its checkpoint and the card tables it was trained with. These paths are examples for files you generated yourself.

```sh
uv run --locked rivermind-poker play --agent offline \
  --lut_path artifacts/tables --strategy_path artifacts/my-run/agent.joblib
```

The terminal records completed hands in `~/.poker/results.yaml`.

## Repository layout

```text
rivermind-poker/
├── AGENTS.md, BUILD.md, CONTRIBUTING.md   How work is done, where it stands, how to develop
├── web/                    The site: SvelteKit app, its Node server and the TypeScript serving code
│   ├── src/lib/nl/         The lobby and no-limit table UI
│   ├── src/lib/engine/     Browser-safe cards and hand evaluator
│   ├── src/lib/server/     Server-only code: engine, bots, Drizzle schema and migrator, CSP
│   ├── server/             The Node server: SvelteKit's handler plus the /ws WebSocket
│   ├── drizzle/            SQL migrations
│   └── e2e/                Playwright tests
├── rivermind/
│   ├── engine/             The reference no-limit engine, fuzzing and benchmarks
│   ├── bots/               Simple bots, card tables, blueprint training, evaluation, serving bundles
│   └── server/             The Python table model, the reference for `pnpm table:parity`
├── ios/                    The iPhone app: SwiftUI screens and the RiverMindKit package
├── poker_ai/               The short-deck prototype and the terminal client (legacy)
├── test/                   pytest: engine, table model, unit and functional tests
├── deploy/                 systemd units, the Caddy site, database setup and the update script
├── docs/                   Rules, bots, design, roadmap, evaluations and build history
└── artifacts/              Generated card tables, checkpoints and bundles (ignored by Git)
```

## Develop

[CONTRIBUTING.md](CONTRIBUTING.md) covers the engine, the database, training and evaluation, the table server, the client and deploys. The two test suites, which CI runs on every push, are:

```sh
uv run --locked pytest
(cd web && pnpm check && pnpm lint && pnpm test && pnpm build && pnpm e2e)
```

The database tests need a disposable PostgreSQL database whose name contains `test` ([how](CONTRIBUTING.md#postgresql)). The installed command is `rivermind-poker`; the Python namespace and legacy command `poker_ai` remain for existing scripts and saved artifacts.

| Area | Start here |
| --- | --- |
| No-limit rules, with worked examples | [docs/rules.md](docs/rules.md) |
| Reference engine, hand histories and fuzzing | [rivermind/engine](rivermind/engine/) |
| Bots, card tables, blueprint training and evaluation | [rivermind/bots](rivermind/bots/) and [docs/bots.md](docs/bots.md) |
| Published bot evaluations | [docs/evaluations](docs/evaluations/) |
| Champions and promotion decisions | [docs/models.md](docs/models.md) |
| Python table server, protocol v2 and safety controls | [rivermind/server](rivermind/server/) |
| SvelteKit client, Node server and TypeScript ports | [web](web/) |
| The look and the design kit | [docs/design.md](docs/design.md) and [web/scripts/art](web/scripts/art/) |
| Live site operations | [deploy](deploy/) and [CONTRIBUTING.md](CONTRIBUTING.md#deploy-rivermindpokercom) |
| Short-deck prototype, its training and the terminal client | [poker_ai](poker_ai/) |

[AGENTS.md](AGENTS.md) is the working manual for anyone changing the code, people and coding agents alike.

## Feedback

Bug reports and ideas are welcome as issues on [GitHub](https://github.com/dunamismax/rivermind-poker/issues) or [Codeberg](https://codeberg.org/dunamismax/rivermind-poker/issues). The [Code of Conduct](CODE_OF_CONDUCT.md) applies.

## Origins and license

RiverMind started with a copy of Keith Lee’s Pluribus-inspired repository, which builds on the Poker AI implementation by Leon Fedden, Colin Manko and contributors. These projects implement published research ideas independently. The hand evaluator derives from Will Drevo’s Deuces. [Starting source](https://github.com/keithlee96/pluribus-poker-AI/tree/73fb394b26623c897459ffa3e66d7a5cb47e9962) · [Original Poker AI project](https://github.com/fedden/poker_ai) · [Deuces](https://github.com/worldveil/deuces)

On November 18, 2026, RiverMind introduced its own packaging, command-line entry point and training fixes. RiverMind Poker uses the same GNU General Public License, version 3 or later. The original project’s license file added an indemnification section to that license; it is kept, word for word, as a separate notice. The evaluator retains its MIT notice, the SFrame test vectors copied from RFC 9605 carry the IETF Trust’s, the MLS test-vector runners adapted from ts-mls carry its MIT notice, the voice code’s word list, BIP-39’s English one, carries python-mnemonic’s, and table voice’s noise suppression, RNNoise in WebAssembly through web-noise-suppressor, carries the MIT, Apache 2.0 and BSD notices of its three parts. [GPL license](LICENSE) · [Poker AI additional terms](licenses/Poker-AI-additional-terms.txt) · [Deuces notice](licenses/Deuces.txt) · [RFC 9605 notice](licenses/RFC9605.txt) · [ts-mls notice](licenses/ts-mls.txt) · [python-mnemonic notice](licenses/python-mnemonic.txt) · [noise suppression notices](licenses/web-noise-suppressor.txt)

The site’s interface art is original to this project. Its deck is drawn after the code-drawn cards of the owner’s FeltPrep project, whose artwork is otherwise reserved; the owner contributes these card drawings to RiverMind under GPL-3.0-or-later. [Deck notice](licenses/FeltPrep-cards.txt)
