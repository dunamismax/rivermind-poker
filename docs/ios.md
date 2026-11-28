# The iPhone app

RiverMind Poker as a native iPhone app (D-19, Phase 5D in [BUILD.md](../BUILD.md#phase-5d--native-ios-app)). It is one more client of the same server: people in the app and in any browser share tables, invites and end-to-end encrypted table voice. This file is the design (P5D.1), kept as the app is built. CONTRIBUTING.md says how to build and test it, and AGENTS.md holds its conventions.

**Where it stands** (2026-11-27): the skeleton (P5D.1) and the protocol (P5D.2). The app builds, launches in the iOS Simulator, makes or renews its guest with `POST /api/session`, keeps the session in the Keychain, and shows a placeholder lobby with the guest and what `GET /api/config` offers. RiverMindKit has every protocol v2 and voice signalling type, generated from the TypeScript, an API client for every route below, and the page's display logic (P5D.4): hand names and the evaluator, bet sizes and labels, the hand log's and the pots' lines, seat words, faces, replay steps and card names, each matching the page on a fixture the TypeScript writes, and the table connection (P5D.3), which follows a table, acts on its views and rejoins by itself after a drop, a restart of the server, a move between networks and a return from the background. The lobby (P5D.6) and the look (P5D.5) are next; a debug build launched with `-practice` joins a practice table and shows how its connection stands until the table screen (P5D.7).

## What the app is made of

```text
ios/
  RiverMind.xcodeproj/      the app and its UI tests, with folder-synchronized groups
  RiverMind/                the app target: screens only (SwiftUI)
  RiverMindUITests/         XCUITest, against a local Node server
  RiverMindKit/             a Swift package: everything that is not a screen
    Sources/RiverMindKit/   protocol and API types, the API client, models, ported display logic
    Tests/RiverMindKitTests/  Swift Testing, run by `swift test` on a Mac
  Config/Debug-Info.plist   what debug builds add to the generated Info.plist
  test.sh                   the app's checks, as CI runs them
```

- **The package holds the logic.** Protocol and API types, the API client, the table connection, the models behind each screen, voice and everything ported from the page live in `RiverMindKit`. `swift test` runs them on this Mac without a simulator, in a second or two. The app target holds SwiftUI views and nothing a test needs to reach.
- **The app target holds the screens.** Its folders are synchronized groups (`PBXFileSystemSynchronizedRootGroup`), so adding, moving or deleting a Swift file changes no line of `project.pbxproj`. The project was made once with XcodeGen 2.48 and is now edited as Xcode edits it; no generator is needed to build it.
- **Swift 6 throughout,** with strict concurrency. The app target isolates to the main actor by default (`SWIFT_DEFAULT_ACTOR_ISOLATION`); the package states its isolation explicitly. Warnings are errors in both, and `ios/test.sh` also fails on a warning in the app's sources that the compiler keeps a warning whatever the flag (a concurrency diagnostic about an API imported with `@preconcurrency`, such as XCTest's).
- **Dependencies.** None yet. Each one added is pinned to an exact version through Swift Package Manager, with `Package.resolved` committed, and its license recorded in `licenses/` (Q-14). No analytics, crash-reporting, advertising or attribution SDK, ever (Q-6).
- **Which server.** A release build talks to https://rivermindpoker.com alone. A debug build talks to the server that `RIVERMIND_SERVER` names, an origin such as `http://127.0.0.1:4380`, and otherwise to the live site. The Simulator shares this Mac's loopback, so a debug build reaches `pnpm start` there, and only a debug build's Info.plist allows plain HTTP to a local address (`NSAllowsLocalNetworking`).
- **Placeholders until Q-13 is answered:** the name RiverMind Poker, “RiverMind” under the icon, the bundle id `com.rivermindpoker.app` (UI tests `com.rivermindpoker.app.uitests`), version 0.1.0 build 1, no development team, signed for the Simulator only.

## The oldest iOS: 26

The app supports iOS 26 and later. iOS 26 is the oldest version whose APIs the design needs:

- **Liquid Glass.** The native look the owner asked for is iOS 26's: its materials (`glassEffect`), toolbars and tab bars. An app for older versions would carry a second look of its own on them.
- **SwiftUI's own web view** (`WebView` and `WebPage`, iOS 26). P5D.9's second voice candidate runs the site's voice code in a hidden web view, and content pages a player opens to read may be web views; on iOS 26 neither needs UIKit.
- **Observation as a sequence** (`Observations`, iOS 26), which lets the socket and voice loops follow `@Observable` state without Combine.
- **Reach.** On 2026-11-27 iOS 27 is current and iOS 26 is the major version before it; the two cover the iPhones in use that get updates. iOS 26 runs on the iPhone 11 and later and the second-generation iPhone SE and later.

The package also builds for macOS 26, only so that `swift test` runs on a Mac. The app is for iPhone (`TARGETED_DEVICE_FAMILY` 1) and portrait until P5D.12 gives it iPad and landscape layouts; until then an iPad runs it as an iPhone app.

CI builds with Xcode 26.6 (Swift 6.2), the newest stable Xcode on GitHub's `macos-26` runner, and this Mac with Xcode 27.2 (Swift 6.4). The package's `swift-tools-version` is 6.2 for that reason, and code must build with both.

## What the app uses of the server

The app speaks exactly what a page speaks. Nothing on the server is for the app alone except what the App Store needs (the old-build check and deletion of a guest's data, P5D.11, and the site association file, P5D.8), and a browser sees no change.

**The HTTP API** (`/api/*`), with JSON bodies and no `Origin` header, which the server accepts from a client that is not a browser (`originAllowed`):

| Route | Used for | Step |
| --- | --- | --- |
| `GET /api/config` | protocol version, bots with their evaluations, seat counts, stakes, reactions, the practice stack | P5D.1 |
| `POST /api/session` | make or renew the guest, and its `rm_session` cookie | P5D.2 |
| `GET /api/wallet` | the play-chip balance and top-up rules | P5D.6 |
| `GET /api/tables`, `POST /api/tables` | the open tables, and a new one | P5D.6 |
| `POST`, `DELETE /api/tables/{id}/seat`, `/waitlist` | sitting down and waiting, and giving either up | P5D.6 |
| `POST /api/quick-seat`, `POST /api/practice` | quick seat and one-click practice | P5D.6 |
| `GET /api/invites/{code}` | a private table's invite | P5D.6, P5D.8 |
| `GET /api/hands`, `GET /api/hands/{id}` | “Your hands” and the replayer | P5D.8 |
| `GET`, `PUT /api/relations`, `DELETE /api/relations/{ref}`, `POST /api/reports` | mutes, blocks and reports | P5D.7 |
| `GET /api/voice`, `POST /api/tables/{id}/voice` | whether voice is offered, and a voice token | P5D.10 |

Requests stay within the API's and Caddy's rate limits; P5D.2 checks each route the app uses against them.

**Protocol v2 on `/ws`**, a WebSocket that the session cookie authenticates at the handshake. The app sends `hello`, `join_table`, `leave_table`, `sit`, `sit_out`, `sit_in`, `rebuy`, `act`, `refresh` and `react`, and reads `welcome`, `table` (a view and its events), `left_table`, `table_closed`, `reaction` and `error`. `web/src/lib/protocol-v2.ts` is the source; P5D.2 generates the Swift types from it.

**Voice signalling v1 on `/voice`**, a second WebSocket, which a 60-second voice token from the API admits (D-15, [docs/voice.md](voice.md)): `hello`, `group.create`, `group.commit`, the transport, producer and consumer requests, `status`, the notices, and the close codes in `CLOSE`. `web/src/lib/voice/signalling.ts` is the source.

**The types are generated** (P5D.2). `pnpm protocol:swift` (`web/scripts/protocol-swift.ts`) reads `protocol-v2.ts` and `signalling.ts` with TypeScript's parser and writes `ProtocolV2.swift` and `VoiceSignalling.swift` into RiverMindKit's `Protocol/`:

- An interface or object type becomes a struct with explicit coding: a required `x: T | null` is written as null, and an optional `x?: T` is left out when nil. An optional field that may also be null (`x?: T | null`) is left out unless the struct's `nulls` names it; decoding fills `nulls` with the fields that came as null, so every message encodes back to what came. The server tells the two apart: a new table's missing `bots` means the default bot, a null one no bots.
- A union of strings becomes an open type: its known values are static members, `known` lists them, and any other value decodes as itself.
- A union of messages tagged by `type` or `notice` becomes an enum; `ServerMessage` and `VoiceNotice`, which the app reads, have an `unknown` case that keeps the message whole.
- A required literal (`type: 'act'`, `protocol: 2`) is a constant, written and not stored. A number is an `Int` unless the generator lists it as fractional (times, durations and rates). mediasoup's parameters are `JSONValue`, handed on as they came.
- Voice requests conform to `VoiceRequest`, which names their response; `VoiceEnvelope` adds the `id` and `type`, and `VoiceAnswer` gives the response of the request it answers, or a `VoiceRefusal`. These envelopes are written by hand, since an answer's shape depends on its request.

`ios/RiverMindKit/Fixtures/protocol.json`, written by `pnpm ios:fixtures`, holds every socket message and HTTP body of the two sessions recorded from the retired `serve-nl` (the table session's messages come from replaying it, checked against the recording's digests). The Swift tests decode each as its type and encode it back to the same JSON, compared parsed. Vitest fails while the Swift or the fixture is stale.

**Reading a newer server.** An app build stays on phones for weeks, so it must read what a newer server sends: unknown fields are ignored, and an unknown event kind, error code, reaction or bot kind decodes as itself and is shown generically (`Reaction` in `Config.swift` is the pattern). P5D.11 adds the oldest supported build to `GET /api/config`.

## The guest's session

The site's guest is a signed `rm_session` cookie (`HttpOnly`, `SameSite=Lax`, 180 days, renewed when it is a day old). The app keeps it the same way a browser does, except that it keeps it in the **Keychain** rather than a cookie store:

- `APIClient` uses an ephemeral `URLSession` that stores no cookies, and handles `rm_session` itself: it sends `Cookie: rm_session=…` with each request and on the `/ws` handshake, and stores the value of every `Set-Cookie: rm_session=…` it is given, which is how a renewal arrives.
- The item is a generic password for the service `com.rivermindpoker.app` and the server's origin as its account, so a debug build's local guests never mix with the live one. It is `kSecAttrAccessibleAfterFirstUnlock`, so a table and voice in the background (Q-16) can reconnect with the screen locked, and not synchronizable, so it stays on this phone.
- It survives a relaunch and an update (a UI test relaunches the app and finds the same guest). Keychain items have also survived deleting and reinstalling an app, which keeps the guest's chips; that is iOS's behaviour, not a promise. In the iOS 27.2 Simulator on 2026-11-27 it did: after `simctl uninstall` and `install`, the app was the same guest with the same chips.
- A 401 means the session ended (it expired, or the server's secret changed): the client makes the guest again with `POST /api/session` and asks once more, as a page's reload does. A 429 is reported with its `Retry-After` and never retried. The client asks once for each thing a person does, as a page does, so it stays within the API's limit (a burst of 60 requests, then 2 a second, per guest) and Caddy's (30 new guests, tables and practice tables, and 60 seatings, a minute per address); a test walks every route against a local server in under 30 requests.
- The app's guest is not the browser's (Q-15): the app says so where a player would look for their chips. Deleting the guest and their data, from the app and the site, is P5D.11.

## The table connection

`TableConnection` (`RiverMindKit/Table/`, P5D.3) is the app's side of `/ws`, ported from what the page's `NlConnection` does on its socket, and held to it by tests that follow `connection.spec.ts`:

- **Hello, join, the newest view.** Following a table opens a socket with the session cookie and no `Origin`, says `hello` and `join_table`, and keeps the newest `table` view; the log keeps each event with the name in its seat when it happened (`whoWas`). The followed table is kept in `UserDefaults` per server, so a relaunch rejoins it, as a page keeps it in `localStorage`.
- **One action at a time, on the view's `seq`.** An action carries the view's `seq` and waits for the table's answer before another may go. A refused one is shown, and the connection asks for a fresh view (`refresh`) and never sends the action again: the guest decides on the new view. A flood (`rate_limited`) or `not_seated` asks for nothing. `unknown_table` and `table_closed` forget the table; `unauthorized` forgets the guest too.
- **Rejoining.** A dropped socket tries again after 1, 2, 4 and then 8 seconds, as the page does, and a view resets the wait. Frames go out one after another in the order they were sent.
- **The app's life (Q-16).** In the background, unless table voice keeps it (`keepsConnectedInBackground`, P5D.10), the connection lets go of the socket and keeps the table; back in the foreground it rejoins at once. A passing `inactive` (Control Center, a call's banner) changes nothing. `NetworkWatcher` (`NWPathMonitor`) reports a move to a new usable path, such as Wi-Fi to cellular, and the connection rejoins at once on it rather than waiting for the old socket to time out; losing the network altogether is left to the backoff. The app wires both from SwiftUI's scene phase.

Three checks run it for real. `TableConnectionSessionTests.swift` plays the seeded practice table (`web/e2e/seeded-server.ts`, seed 10, which `ios/test.sh` starts) through a real `URLSession` socket: check or call at every turn, refill once out of chips, two more hands. It must see what a TypeScript client saw on the same site (`ios/RiverMindKit/Fixtures/session.json`, written by `pnpm ios:fixtures` from `web/src/lib/server/api/ios-session.spec.ts`, which plays two fresh sites and expects the same record from both), from the second hand on, since the first may be dealt before either client joins, and the guest's own seat must be connected in its first view (`Tables.join`). `TableConnectionRestartTests.swift` kills the server mid-hand, as a crash would, and starts it again on the same PostgreSQL database (`web/e2e/restart-server.ts`, which `ios/test.sh` starts when `RIVERMIND_TEST_DATABASE_URL` names a test database; CI's macOS runner has none, so it runs locally): the connection rejoins by itself with the hand, its board, its pot, the guest's cards and the turn intact, and plays on. And a UI test sends the app to the background with the home button and back, and sees the table rejoin.

## Ported with parity, or drawn natively

The server is authoritative (D-2): the app decides nothing about cards, turns or chips. What it computes only to show is ported from the page and held to it by fixtures the TypeScript writes (`pnpm ios:fixtures`, P5D.4), as the engines are held to each other.

| Ported to Swift, with fixtures from the TypeScript | Drawn natively in SwiftUI |
| --- | --- |
| protocol v2, the API bodies and voice signalling: generated types (P5D.2) | every screen and control |
| `hand-name.ts` and the browser-safe evaluator in `src/lib/engine` (`HandName`, `Evaluator`) | the table layout at 2 to 9 seats, from the same rules as `layout.ts` (P5D.7) |
| `bet.ts`: bet and raise sizes, presets, button labels, the hand log's lines and the pots' lines (`Bet`) | the action panel, slider and haptics |
| `replay.ts`'s steps (`Replay`) | the replayer's controls |
| `faces.ts`: bot labels, pod names, avatars, chip colours, a seat's status word and spoken label, and the evaluation lines (`Faces`) | the cards themselves, from `scripts/art/deck.js`'s geometry (P5D.5) |
| `wording.ts`'s card names, `replay.ts`'s short cards and `safety.ts`'s reactions and report reasons (`Wording`, `Safety`) | animations, with Reduce Motion |
| what `connection.svelte.ts` does: hello, `seq`, errors, rejoining (`TableConnection`, P5D.3; above) | the voice panel (P5D.10) |
| the site's tokens, written into Swift by `pnpm art` from `theme.css` (P5D.5) | |

**The display fixture** (P5D.4). `pnpm ios:fixtures` also writes `ios/RiverMindKit/Fixtures/display.json` (`web/src/lib/server/api/ios-display.spec.ts`), and `DisplayParityTests.swift` expects every Swift port to give exactly what the TypeScript gave. Its cases are seeded: random sets of two to seven cards until every class of hand is there at every size, a fixed list of rare hands and words with a rule of their own (the wheel, a royal flush, sixes, an eight-high), the hand log's line for every event the recorded sessions sent and for every kind of event, and fifty hands the engine plays from random stacks, read back as the `HandDetail` a viewer gets and kept so that between them they hold every kind of replay step and every kind of pot (side pots, splits, an uncalled bet, a stack nobody covered, all-in hands tabled before the board, antes). The bet cases are the legal actions at those hands' decisions. Where the page would print `undefined` (a field a newer server leaves out, an action this build does not know), the app says something plain instead; everywhere else the two say the same. Each `toFixed` and `toLocaleString` the page calls is ported to its rule: `Faces.toFixed` rounds the double's exact value, the larger on a tie, as JavaScript does, where `String(format:)` would round 0.25 to 0.2.

The wording the table's components wrote inline (the pots' lines under the table, a seat's status word and its label for assistive technology) moved into `bet.ts` and `faces.ts` at P5D.4, so the page and the app read it from one place.

Small formatting rules that the page writes inline are ported where they are first needed and tested against the page's own output: P5D.1's `ConfigResponse.chips` matches `toLocaleString('en-US')`, and `ConfigResponse.blinds` the lobby's `small/big`.

## The screens

| Screen | What it holds | Step |
| --- | --- | --- |
| Lobby | open tables with seat and blind filters, quick seat, new table, private tables and invites through the share sheet, waitlists, the wallet, one-click practice with each bot labelled and its evaluation | P5D.6 (P5D.1's placeholder until then) |
| Table | 2 to 9 seats in portrait, the action panel, the hand log, reactions, the seat menu's mute, block and report | P5D.7 |
| Voice | joining, the voice code, mute, deafen, push-to-talk, each player's volume, mute all, the quality lamp | P5D.10 |
| Your hands and the replayer | the hands the guest played, replayed step by step, “Review last hand” from the table | P5D.8 |
| Bots | each bot's label and its published evaluations, linking each report (D-7) | P5D.8 |
| Fairness | how dealing works (D-8) | P5D.8 |
| Settings | card backs, voice settings, haptics, sounds | P5D.13 |
| How to play, privacy, terms, support | content pages, native or in an in-app Safari view | P5D.8, P5D.15 |
| Gallery (debug builds only) | every component in its states, the app's `/style` | P5D.5 |

## The App Store's requirements

| Requirement | How the app meets it | Step |
| --- | --- | --- |
| 4.2, minimum functionality: not a web site in a frame | native SwiftUI screens; a web view only where P5D.9 measures that the site's voice code is the better choice, and for content pages | every step |
| 1.2, user-generated content: people talking to strangers | reporting and blocking at the table and in voice, as the site has them (P4.5, P4C.8); a support page that reaches the operator, with how reports are handled and how fast in the terms | P5D.7, P5D.10, P5D.15 |
| 5.1.1(v), account deletion: a way to delete one's data | a guest deletes themself and their data from the app and the site | P5D.11 |
| 5.3, gaming: simulated gambling | play money only, never bought, sold or cashed out (D-1); no purchase of any kind and no ads; the age rating answered for frequent simulated gambling and unrestricted talk | P5D.15 |
| IPv6-only networks with NAT64, where App Review tests | `URLSession` and its WebSockets use the system's NAT64 synthesis, so the site's IPv4-only address (it has no AAAA record on 2026-11-27) works. Voice's media address is an IPv4 literal in ICE candidates, which is the risk: P5D.10 checks it on a NAT64 network from macOS's Internet Sharing, and the table keeps playing if voice cannot connect | P5D.3, P5D.10 |
| The privacy label | drawn from what the app actually sends, listed in this file when the app sends it; no tracking, so no tracking prompt | P5D.15 |
| Export compliance | voice's encryption (SFrame under MLS, D-15) and HTTPS; the answers recorded here | P5D.15 |
| The microphone's usage description | says voice is opt-in and end-to-end encrypted, and asked for only when a person joins voice | P5D.10 |
| Licensing (Q-14) | the app holds only code the owner wrote and permissively licensed libraries; its source is GPL-3.0-or-later with the owner's additional permission, under section 7, to distribute it through the App Store, in wording the owner confirms | P5D.15 |

## Licensing

Everything under `ios/` is written for this project, for the owner, and is GPL-3.0-or-later like the rest of the repository. Nothing from the original Poker AI project or any other GPL author goes into the app (Q-14's default): the code the app ports from `web/` was written for RiverMind, and a port of a file whose history reaches back to the Poker AI project (the Deuces-derived evaluator is MIT) records where it came from in `licenses/` before it is ported. The additional permission for the App Store is the owner's to word, at P5D.15.

## Checking the app

`ios/test.sh` runs RiverMindKit's tests with `swift test`, then the app's UI tests with `xcodebuild test` in a simulator of its own (“RiverMind Test”, an iPhone 17 on the newest iOS runtime, made if missing), both against a Node server it starts from `web/build` on 127.0.0.1:4380 with no database. CI's `ios` job runs the same script on `macos-26` with Xcode 26.6. The package's tests that need a server are skipped when `RIVERMIND_SERVER` is not set; the script always sets it. CONTRIBUTING.md has the commands.

The Simulator's microphone gives no audio on this Mac, so voice checks use a tone, as the voice check page does. A real iPhone, cellular data, TestFlight and the App Store need the owner (D-16, P5D.16 and P5D.17).
