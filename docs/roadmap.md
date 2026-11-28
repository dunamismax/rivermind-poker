# Roadmap to RiverMind Poker 1.0

This page explains where the project is going and why the phases come in this order. Status, steps and checkboxes live in [BUILD.md](../BUILD.md); this page changes only when the plan itself does.

## Where it is going

RiverMind Poker 1.0 is a free, self-hosted poker website at rivermindpoker.com, played with play money only. Anyone can sit at no-limit Texas hold’em tables of 2 to 9 seats, against anonymous people, strong AI bots or both. The site keeps balances, hand histories and stats, and runs single-table tournaments. People seated together talk over live table voice, end-to-end encrypted so that not even the site can listen. The bots are trained and measured in the open and always labelled as bots.

## Target architecture

The stack is SvelteKit 3 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 18 + Drizzle ORM · Node (`adapter-node`) · Caddy (D-14). Phase 4B moved the live site onto it: the Node server took the tables over at P4B.7, and the Python table server was retired at P4B.8.

| Layer | Choice | Why |
| --- | --- | --- |
| Game engine | A pure TypeScript engine in the web app for live play, kept byte-for-byte in step with the pure-Python reference engine `rivermind/engine` by differential tests. Both use immutable state and caller-supplied randomness. | Training, evaluation and the live server must agree exactly on the rules. Training stays in Python, so the Python engine remains the reference, and the serving engine has to prove it matches on every push. A pure engine with no global state can be property-tested and replayed. |
| Game server | The SvelteKit app on Node through `adapter-node`, with a small custom server that adds the `/ws` WebSocket (`ws`). It is authoritative over every table. | One language and one process serve the pages, the API and the tables, and the client shares types with the server directly. The server owns cards, turns and chips, so clients can never see or change what they shouldn’t. |
| Storage | PostgreSQL 18 through Drizzle ORM and `drizzle-kit` SQL migrations, with versioned JSON state | It already runs on the host. It is durable across restarts, and it holds wallets, ledgers, hand histories and stats with real queries. Drizzle keeps the schema in TypeScript beside the code that uses it, and its migrations are plain SQL that can be reviewed. |
| Client | SvelteKit 3 with Svelte 5, TypeScript and Tailwind CSS 4. The table is client-rendered, and content pages are server-rendered or pre-rendered. | A live poker table is an app, not a content site. Svelte’s compiled reactivity and built-in transitions suit rapidly changing game state and card animation. Tailwind’s theme is the site’s own palette and sizes alone, so utilities can only use the kit’s colours and sizes. |
| Bots | Monte Carlo CFR blueprints over card and action abstractions, trained and evaluated offline in Python with NumPy, then exported as versioned serving bundles for the Node server. Real-time search comes later. | This is the approach behind Pluribus, and Phase 0 already proved out training, resume, checkpointing and evaluation on the prototype game. Heavy numeric work stays where its tools are, and serving only needs table lookups and the action mapping. |
| Table voice | A mediasoup forwarding server in its own Node service, `rivermind-poker-voice`. Each browser encrypts its Opus frames with SFrame (RFC 9605) in an encoded-transform worker, under keys from an MLS group (RFC 9420, through ts-mls) of the people in voice ([docs/voice.md](voice.md)). | Forwarding keeps players’ addresses from each other and costs a phone one upload, and the server can stop audio someone has muted. The server relays frames it cannot decrypt, so the privacy claim holds even against the host. This is the design Discord adopted for its own encrypted calls, built on two IETF standards and the browsers’ own APIs. |
| Hosting | ubuntu-vm, with Caddy providing automatic HTTPS and reverse-proxying to the Node service, which runs as a sandboxed systemd unit | It is already working for the prototype and the owner’s other sites. |

## Why this order

1. **Client first (Phase 1).** Moving the existing game to SvelteKit is small and low-risk, and it fixes the frontend stack before anything else is built on it. It also adds cross-browser tests, closing Phase 0’s Chromium-only gap.
2. **Engine before server (Phase 2).** Everything else depends on correct no-limit rules: side pots, all-ins, minimum raises and seat counts. Getting them right in isolation, with property tests and fuzzing, is far cheaper than debugging them through a live server.
3. **Server v2 before multiplayer (Phase 3).** One player against bots exercises durable multi-seat tables, clocks and the new protocol without the extra risks of strangers sharing a table. The live cutover happens here.
4. **Multiplayer before strong bots (Phase 4).** Identity, wallets, the lobby and fair dealing shape the data the bots and stats depend on. Simple bots fill seats in the meantime.
5. **One stack before the bot and replay work (Phase 4B).** The owner standardised on SvelteKit on Node with Tailwind and Drizzle (D-14). Moving the server now, while it covers only Phases 3 and 4, costs less than moving it once it also serves champions, replays, stats and tournaments. Serving the first champion (P5.7a) is then built once, in TypeScript.
6. **Table voice (Phase 4C), alongside Phase 5A.** Voice is the site’s headline feature (D-15), so it must be working and tested before 1.0. Its prototype, encryption and media service touch no table code and start at once; joining voice to tables waits for the TypeScript table server, so it is built once, and it goes live after the cutover. It needs nothing from the bot or replay work, so the two run side by side, and voice goes first when both have a step ready.
7. **Practice, heads-up opponent and replay (Phase 5A).** One click gets a guest into a hand at any balance. Heads-up is the cheapest format in which to train, evaluate and serve the first opponent. Replay then lets the guest revisit a decision from the table and play another hand. The three features must work together on the live site before the build expands.
8. **Multi-seat bots and difficulty levels (Phase 5B).** These wait for both Phase 5A and table voice. Extend the measured heads-up pipeline to six seats, then nine, and verify the difficulty levels and serving budgets for each format.
9. **Site features, then hardening (Phases 6 and 7).** Replay sharing, stats, tournaments and polish build on the working game. Monitoring, backups, load tests and a security review precede the 1.0 release.

## What Phase 0 established

The prototype is a three-seat, fixed-limit game with a 20-card deck. It produced the working pieces later phases reuse or replace:

- trustworthy MCCFR training (resume, discounting, consistent checkpoints);
- a reproducible evaluation harness with a measured baseline;
- a server-owned table with private seat views;
- a browser client over WebSockets;
- self-hosting with restart-safe tables.

[docs/build-history.md](build-history.md) records the evidence.
