# Roadmap to RiverMind Poker 1.0

This page explains where the project is going and why the phases come in this order. Status, steps and checkboxes live in [BUILD.md](../BUILD.md); this page changes only when the plan itself does.

## Where it is going

RiverMind Poker 1.0 is a free, self-hosted poker website at rivermindpoker.com, played with play money only. Anyone can sit at no-limit Texas hold’em tables of 2 to 9 seats, against anonymous people, strong AI bots or both. The site keeps balances, hand histories and stats, and runs single-table tournaments. The bots are trained and measured in the open and always labelled as bots.

## Target architecture

| Layer | Choice | Why |
| --- | --- | --- |
| Game engine | New pure-Python package `rivermind/engine`: immutable state and randomness supplied by the caller | Training, evaluation and the live server must agree exactly on the rules. A pure engine with no global state can be property-tested and replayed. |
| Game server | FastAPI and WebSockets under Uvicorn, authoritative over every table | The engine and bots are Python, so writing the rules twice is avoided. The server owns cards, turns and chips, so clients can never see or change what they shouldn’t. |
| Storage | PostgreSQL through SQLAlchemy 2 and Alembic, with versioned JSON state | It already runs on the host. It is durable across restarts, and it holds wallets, ledgers, hand histories and stats with real queries. |
| Client | SvelteKit with Svelte 5 and TypeScript, built as a static single-page app, with types generated from the server’s protocol models | A live poker table is an app, not a content site. Svelte’s compiled reactivity and built-in transitions suit rapidly changing game state and card animation, and the same app pre-renders the content pages. |
| Bots | Monte Carlo CFR blueprints over card and action abstractions, then real-time search | This is the approach behind Pluribus. Phase 0 already proved out training, resume, checkpointing and evaluation on the prototype game. |
| Hosting | ubuntu-vm behind Caddy with automatic HTTPS, run as a sandboxed systemd service | It is already working for the prototype and the owner’s other sites. |

## Why this order

1. **Client first (Phase 1).** Moving the existing game to SvelteKit is small and low-risk, and it fixes the frontend stack before anything else is built on it. It also adds cross-browser tests, closing Phase 0’s Chromium-only gap.
2. **Engine before server (Phase 2).** Everything else depends on correct no-limit rules: side pots, all-ins, minimum raises and seat counts. Getting them right in isolation, with property tests and fuzzing, is far cheaper than debugging them through a live server.
3. **Server v2 before multiplayer (Phase 3).** One player against bots exercises durable multi-seat tables, clocks and the new protocol without the extra risks of strangers sharing a table. The live cutover happens here.
4. **Multiplayer before strong bots (Phase 4).** Identity, wallets, the lobby and fair dealing shape the data the bots and stats depend on. Simple bots fill seats in the meantime.
5. **Practice, heads-up opponent and replay (Phase 5A).** One click gets a guest into a hand at any balance. Heads-up is the cheapest format in which to train, evaluate and serve the first opponent. Replay then lets the guest revisit a decision from the table and play another hand. The three features must work together on the live site before the build expands.
6. **Multi-seat bots and difficulty levels (Phase 5B).** Extend the measured heads-up pipeline to six seats, then nine, and verify the difficulty levels and serving budgets for each format.
7. **Site features, then hardening (Phases 6 and 7).** Replay sharing, stats, tournaments and polish build on the working game. Monitoring, backups, load tests and a security review precede the 1.0 release.

## What Phase 0 established

The prototype is a three-seat, fixed-limit game with a 20-card deck. It produced the working pieces later phases reuse or replace:

- trustworthy MCCFR training (resume, discounting, consistent checkpoints);
- a reproducible evaluation harness with a measured baseline;
- a server-owned table with private seat views;
- a browser client over WebSockets;
- self-hosting with restart-safe tables.

[docs/build-history.md](build-history.md) records the evidence.
