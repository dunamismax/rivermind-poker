# Table voice design

This is the design for live voice at the table (Phase 4C, D-15). It records what voice must do, the threat model, the tools chosen and the ones rejected, how keys are agreed and media is encrypted, and what the host has to provide. [BUILD.md](../BUILD.md#phase-4c--table-voice) holds the steps and their evidence. P4C.1 checked this design with a working prototype, and [what the prototype found](#what-the-prototype-found-p4c1) lists what it confirmed, what it corrected here and what it left for later steps. P4C.2 built the frame encryption, and [frame encryption as built](#frame-encryption-as-built-p4c2) says how it works, what it refuses and what it costs.

## What voice is for

The people seated at a table talk to each other as they would at a real one. Voice is the site’s headline feature, so it has to be easy, sound good and be private.

- **Joining.** When a person takes a seat at a table with at least one other person, the table offers voice. “Join voice” asks the browser for the microphone. Declining, or the browser refusing, leaves them listening only or out of voice, as they choose. The table plays the same way either way.
- **Who is in it.** Only seated people speak and hear (Q-10). Spectators hear nothing. Bots never speak and never listen (D-7). Practice tables, where the only other seat is a bot, have no voice.
- **Controls.** One click or key mutes yourself. Each player has a mute and a volume. “Mute all” silences everyone at once (deafen). Push-to-talk is an option. A muted or blocked player (P4.5) starts muted for you, and the server stops sending you their audio.
- **Quality.** Opus at 48 kHz, 64 kbps by default, with in-band error correction and silence suppression. Echo cancellation and gain control are on by default, and noise suppression uses RNNoise on top of the browser’s own (Q-11). Voices can come from each seat’s side of the table (spatial audio).
- **Privacy.** Audio is end-to-end encrypted. The voice server forwards it but cannot hear it. Nothing is recorded, transcribed or stored.

## Threat model

**Protected against**

- **The voice server and its operator.** It forwards encrypted frames and never holds a key. A copy of everything it forwarded cannot be played.
- **The network.** DTLS-SRTP protects each hop, and SFrame protects the frames inside it.
- **People who left.** Leaving the seat removes a member, which starts a new key epoch. Someone who stood up cannot decrypt what is said after.
- **People who arrive.** Joining also starts a new epoch, so a newcomer cannot decrypt what was said before they joined, even holding a copy of the encrypted frames.
- **A hidden listener.** Every client builds its member list from the group state, not from what the server says. A member the server adds shows up on every screen and is checked against the table’s seats. The **table voice code**, derived from the epoch authenticator, is the same on every screen in the same group. Players can read it aloud to confirm nobody is between them.

**Not protected against**, and the privacy page says so

- **The people at the table.** They hear you and can record you.
- **The code the site serves.** Encryption runs in JavaScript that this server sends. A malicious operator could ship code that leaks keys. The source is public (GPL), and each release publishes a hash of its voice client files (P4C.8) so anyone can check that the code served is the code published.
- **Metadata.** The voice server sees who joined voice at which table, their IP address, and when each person sends audio and how much. It does not see what they say. Audio levels stay off the wire: the RTP audio-level extension is not negotiated, and speaking indicators are computed in each browser after decryption.
- **A compromised device or browser.**

## Architecture

```text
browser                                     ubuntu-vm
───────                                     ─────────
table page ── /ws (table protocol v2) ───▶ Caddy ─▶ rivermind-poker-web (Node, 127.0.0.1:4320)
   │                                                      │ issues a short-lived voice token
   │                                                      │ tells the voice service who is seated
   ├── /voice (voice signalling v1, wss) ─▶ Caddy ─▶ rivermind-poker-voice (Node, 127.0.0.1:4322)
   │      join, MLS messages, transports                  │ room per table, MLS delivery service
   │                                                      │ mediasoup Router per room
   └── WebRTC audio (DTLS-SRTP over UDP 3478, ─────────▶ mediasoup WebRtcServer (public UDP/TCP 3478)
          TCP 3478 fallback) carrying SFrame-encrypted Opus frames
```

- **A separate service.** `rivermind-poker-voice` is a second Node process built from `web/`, in its own sandboxed systemd unit. The web service binds only to loopback, and the voice service must bind a public port, so they keep separate privileges and limits. A deploy of the site does not cut a conversation, and a voice restart does not touch a table.
- **The SFU.** [mediasoup](https://mediasoup.org/) 3 (npm `mediasoup`, pinned at 3.32.2, Node 22 or later) is a selective forwarding unit with a TypeScript API and a C++ media worker shipped through npm. Each table’s voice room is one mediasoup Router. One `WebRtcServer` per worker listens on a single UDP and TCP port (ICE-lite), so the host needs one forwarded port, not a range. The browser uses `mediasoup-client` (pinned at 3.26.0).
- **The worker binary.** mediasoup’s install script downloads the worker built for the platform, the architecture and, on Linux, the kernel’s major version from mediasoup’s GitHub release (`linux-x64-kernel7` for ubuntu-vm, `darwin-arm64` for this Mac), and compiles one only if there is none to download. `web/pnpm-workspace.yaml` lists `mediasoup` under `allowBuilds` for it, as it does `esbuild`. So every `pnpm install --frozen-lockfile`, in CI and in a deploy, now needs github.com or a C++ toolchain. mediasoup’s JavaScript bundles into one file as the site’s server does, and a release carries the binary beside it and names it in `MEDIASOUP_WORKER_BIN` (P4C.4).
- **Why forwarding, not a mesh.** In a mesh every player connects to every other player, which hands each player everyone else’s IP address, makes a phone upload eight copies of its audio, and leaves the server nothing to stop when you mute someone. The SFU hides addresses from players, each phone uploads once, and a mute stops the audio at the server.
- **Authorisation.** The table server issues a voice token (HMAC-SHA256 with the site secret: table, player, seat, expiry within 60 seconds). The voice service accepts only valid tokens and asks the table server who is seated whenever seats change. Standing up, being moved, a table closing or a block ends that person’s place in the room.

## Encryption

Two layers, with a standard for each.

1. **Hop by hop:** WebRTC’s DTLS-SRTP between each browser and the SFU.
2. **End to end:** [SFrame](https://www.rfc-editor.org/rfc/rfc9605.html) (RFC 9605) encrypts every Opus frame in the sender’s browser and decrypts it in each listener’s. The keys come from an [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) group (RFC 9420) made of the people in the room.

This is the design Discord adopted for its own end-to-end encrypted voice ([DAVE](https://daveprotocol.com/)): MLS for the group key, a key per sender, WebRTC encoded transforms to encrypt frames, and a comparable code to verify the group.

**Frames.** The browser hands each encoded Opus frame to an `RTCRtpScriptTransform` running in a dedicated worker. All three engines support it: Safari from 15.4, Firefox from 117, Chrome from 141 (Baseline 2025). mediasoup-client hands over each `RTCRtpSender` and `RTCRtpReceiver` before it negotiates (`onRtpSender` on `produce`, `onRtpReceiver` on `consume`), and a transform set there sees every frame, with no extra setting on the connection. One worker holds a page’s sender and all of its receivers. A frame is the Opus payload alone in every engine, so what one engine encrypts the others decrypt. Keys reach the worker as non-extractable `CryptoKey`s in the transform’s options. No browser ships SFrame natively, so `web/src/lib/voice/sframe.ts` implements it in TypeScript over WebCrypto, with cipher suite `AES_128_GCM_SHA256_128` (0x0004), and reproduces RFC 9605’s test vectors byte for byte ([as built](#frame-encryption-as-built-p4c2)). The header and the full-size tag add 20 or 21 bytes a frame, about 8 kbps at 20 ms frames. The worker is a bundled same-origin file: the CSP allows it under `script-src 'self'`, and it would block a `blob:` worker.

**Group key.** [ts-mls](https://www.npmjs.com/package/ts-mls) (pinned at 1.6.4) is a TypeScript MLS implementation. It has not had a formal audit, so P4C.3 runs the MLS working group’s interoperability test vectors against it in CI, and P7.5 reviews how it is used. The ciphersuite is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001), which ts-mls runs on WebCrypto’s Ed25519 and X25519 and `@hpke/core`, with nothing else to install. Import it by subpath (`ts-mls/createCommit.js`): its package root also loads a provider that needs `@noble/hashes`, which the package does not declare, and fails under pnpm. Credentials are basic credentials naming the player’s public reference and seat, signed by a key made for that session; guests have no long-term identity (D-12).

- The first person to join voice creates the group. Later people join by **external commit** from the group info the voice service holds, so nobody already in the room has to be online and quick for someone new to join.
- **Whoever commits publishes the next group info.** A GroupInfo carries the ratchet tree and the group’s external public key and is signed by a member, so the service cannot make one: it only keeps the latest it was given. The creator sends the first, and after every commit its author sends the new one (about 0.45 kB for one member and 3 kB for nine).
- The voice service is the group’s **external sender**: when someone leaves, it proposes their removal, and the remaining member with the lowest leaf index commits it. If that member is gone, the next one does. Members refuse a proposal the service did not sign.
- The voice service orders commits: it accepts the first valid commit for an epoch and refuses the rest, the usual MLS delivery-service rule. Commits and proposals travel as MLS public messages, so the service can read their epoch and sender; they hold no secret, and it cannot read or forge application keys. A member whose commit lost drops it and applies the winner’s, which costs nothing: a ts-mls commit never changes the state it was made from.
- **A reloaded page joins as a newcomer.** It has a new signature key, so the group cannot tell it from a stranger: it joins by an ordinary external commit, and the service proposes the removal of its stale leaf. For a moment the group holds two leaves for one seat, so the check of members against seats counts seats, not leaves. A page that kept its signature key but missed commits may instead **resync**, an external commit that replaces its own leaf. Never ask ts-mls 1.6.4 to resync under a new signature key: it finds the old leaf by that key alone, and `joinGroupExternal` with `resync` set never returns when there is no match.
- **SFrame keys from MLS** follow RFC 9605 section 5.2: for each epoch, `base_key = MLS-Exporter("SFrame 1.0 Base Key", "", AEAD.Nk)`, and the key ID packs the sender’s leaf index and the low bits of the epoch, `KID = (sender_index << E) + (epoch % (1 << E))`. A receiver drops an old epoch when a new one with the same low bits arrives. P4C.3 fixes `E` and `S`; until it does the code uses the RFC’s own example, `E` = 4 and `S` = 6, sixteen epochs in flight and sixty-four leaves.
- **Changing epochs without a gap.** Receivers keep the previous epoch’s keys for a short grace window, and senders switch once the commit is applied. P4C.3 measures that no audible gap follows a join or leave.
- **The table voice code** is derived from the MLS epoch authenticator, shown as four short words, and changes whenever someone joins or leaves.

**What the server never sees:** keys, plaintext frames, or audio levels.

## Audio

| Setting | Value | Why |
| --- | --- | --- |
| Codec | Opus, 48 kHz, mono | Every browser has it; it is the voice codec WebRTC is built around. |
| Bitrate | 64 kbps average by default, with a 32 kbps saver and a 96 kbps high setting | 64 kbps is the usual default for high-quality voice chat. |
| Frame | 20 ms | The usual WebRTC frame; shorter frames cost more overhead per frame. |
| Loss | In-band FEC and NACK, with `useinbandfec` on the Router so FEC follows the worst listener | Keeps speech clear at a few percent packet loss. |
| Silence | DTX on | A silent player sends almost nothing, which matters on the host’s uplink. |
| Capture | `echoCancellation`, `noiseSuppression`, `autoGainControl` on, each switchable | The browser’s own processing. |
| Noise suppression | RNNoise in an AudioWorklet through [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) (MIT; RNNoise is BSD-3-Clause), on by default and switchable | The owner chose stronger suppression than browsers give (Q-11). It runs in the sender’s browser before encoding and encryption, so it costs no privacy. AudioWorklet works in all three engines, unlike libraries built on `MediaStreamTrackProcessor`, which only Chromium has. Running WebAssembly needs `'wasm-unsafe-eval'` in `script-src`, the one loosening of the CSP voice makes. |
| Playback | A Web Audio graph per player: gain (volume), an analyser (speaking indicator) and an optional stereo panner placed by the seat’s position | Per-player volume, local speaking indicators and spatial audio. |

## What the host needs

- **A reachable port.** ubuntu-vm (192.168.50.2) is a VM on a Windows host on the home network, behind the router’s public address. Voice media needs one UDP port, and the same port on TCP as a fallback. It is 3478, the STUN and TURN port that many restrictive networks already allow: the router forwards it to the Windows host, the Windows host passes it to the VM, and `ufw` allows it (Q-9). On the Windows host, `netsh interface portproxy` carries only TCP, so UDP needs another path (the one already used for UDP 443 and RustDesk’s UDP port). The voice service announces the host’s current public address and notices if it changes. A player on the home network itself reaches that address only if the router loops traffic back, so P4C.4 checks from both inside and outside it.
- **Upload bandwidth.** The SFU sends each speaker’s audio to every other person in the room. The prototype measured 92 kbps to each listener for each person speaking, as mediasoup counts it (161-byte Opus frames at 64 kbps, the frame’s encryption, RTP, SRTP and RTCP); the UDP and IP headers of fifty packets a second add 11 kbps, so about 103 kbps leaves the host. A nine-seat table with everyone talking at once sent 6.6 Mbps so counted, about 7.4 Mbps on the wire; each person talking costs a nine-seat table about 0.8 Mbps. P4C.7 measures the real uplink and sets a cap on concurrent voice rooms with headroom for the site, and the table says plainly when voice is full.
- **Networks that block UDP and the voice port.** ICE over TCP 3478 covers most. A network that allows only TCP 443 would need a TURN server on 443, which shares the port with Caddy. P4C.9 measures connection success across real networks before deciding whether that is needed.

## What the prototype found (P4C.1)

The prototype is in [`web/voice/prototype/`](../web/voice/prototype/): a mediasoup service, a browser page on mediasoup-client and an encoded-transform worker with an SFrame-shaped frame (a six-byte header, then AES-128-GCM), driven by Playwright (`pnpm voice:proto`). The group key was checked apart from it, in [`mls-design.spec.ts`](../web/src/lib/voice/mls-design.spec.ts). mediasoup and ts-mls both meet the design, so LiveKit stays a fallback nobody needs yet. None of the prototype ships; P4C.2 to P4C.4 replace each part. P4C.2 replaced the first: the prototype’s frame format and worker are gone, and its page seals with the site’s own.

**Confirmed**

- **The transform path, in every engine.** Two and then nine people in Chromium, in Firefox and in WebKit, and nine in one room of three from each, heard each other with every frame encrypted and decrypted in a worker. mediasoup-client chose its `Chrome111`, `Firefox120` and `Safari12` handlers, and `RTCRtpScriptTransform` set in `onRtpSender` and `onRtpReceiver` saw every frame. Where a person sent a tone of their own, every listener measured that tone.
- **A wrong key hears nothing.** A person holding another secret decrypted no frame and decoded silence, and the members dropped every frame of theirs. A frame that does not open is never passed to the decoder.
- **Audio levels stay off the wire.** A Router always lists `ssrc-audio-level`; the service leaves it out of the capabilities it gives a client and refuses a producer that names it. Browsers still offer the extension, and it is then not negotiated. A listener attached at the SFU with no key saw none in any packet, and saw it at once in a control room that left it in. What remains on a packet is the `mid` and transport-wide sequence number extensions.
- **One port.** One `WebRtcServer` carried every room on a single UDP and TCP port, and every engine also connected over TCP alone.
- **The site’s CSP.** The page ran under the site’s policy unchanged: the worker is a bundled same-origin module (`new Worker(new URL(…, import.meta.url), { type: 'module' })`), and nothing needed `blob:` or inline code.
- **The group key.** ts-mls did everything the design asks for ciphersuite 0x0001: a group grown to nine by external commits, the same exporter output (`SFrame 1.0 Base Key`, 16 bytes) and epoch authenticator for every member and a new one each epoch, a removal proposed by the external sender and committed by the lowest leaf, a removed member left at the old epoch, a second commit for an epoch refused (`epoch too old`), a proposal the service did not sign refused, and a resync. In Node on this Mac a join into a group of up to eight took 9 to 17 ms and applying one 6 to 9 ms; a commit is 0.5 to 0.8 kB.
- **The host.** `pnpm install --frozen-lockfile` on ubuntu-vm (x86_64, kernel 7.0, Node 26.13.1) fetched mediasoup’s `linux-x64-kernel7` worker. A self-test bundled into one file with the worker binary beside it ran there as a dynamic user under every sandbox setting of `rivermind-poker-web.service` (address families `AF_UNIX AF_INET AF_INET6`, no capabilities), bound UDP and TCP 3478 on the VM’s address, and passed 250 RTP packets through a Router unchanged. The same ran on this Mac (arm64).

**A nine-person room, everyone sending at once**

Thirty seconds of nine continuous senders and 72 consumers, on this Mac (Apple M5, 10 cores, macOS 27.2.1, load about 5), all nine browsers on the same machine. CPU is a share of one core.

| Engine | Worker CPU | Worker memory | Node CPU | Received | Sent | Concealed | Jitter buffer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium | 12.4% | 14 MB | 0.02% | 878 kbps | 6,605 kbps | 0.01% | 32 ms |
| Firefox | 9.6% | 14 MB | 0.01% | 891 kbps | 6,608 kbps | 0.06% | 36 ms |
| WebKit | 5.9% | 14 MB | 0.02% | 903 kbps | 6,709 kbps | 0.05% | 174 ms |

The Node side of a service holding only mediasoup was 75 to 100 MB (the self-test); the prototype’s 175 MB includes Vite, which builds its page in the same process. Signalling costs nothing once a room is up. These are this Mac’s figures: P4C.7 measures ubuntu-vm.

**Corrected here**

- Each listener costs about 103 kbps for each person speaking, not 90, and a full table about 7.4 Mbps, not 6.5 ([upload bandwidth](#what-the-host-needs)).
- The service cannot make a GroupInfo. Whoever commits publishes the next one ([group key](#encryption)).
- A reloaded page joins as a newcomer and the service removes its old leaf; resync is only for a page that kept its signature key ([group key](#encryption)).
- ts-mls is imported by subpath and needs WebCrypto’s Ed25519 and X25519. Playwright’s Chromium, Firefox and WebKit all have them: three members made on one page agreed a base key in each, with a join taking 2 to 11 ms. Which released versions of each browser do is not checked; a browser without them fails the group key and gets no voice, as the ground rules say.
- Every install now runs mediasoup’s install script, and a release must carry the worker binary ([the worker binary](#architecture)).
- What Playwright can and cannot check in each engine ([testing](#testing)).

**Left for later steps**

- **WebKit’s jitter buffer** held 174 ms in the nine-person room against about 35 ms in the others (29 ms with two people). The mock microphone and nine browsers on one machine may be the cause. P4C.7’s delay target is 150 ms, so it measures Safari first.
- **Capture in Chromium** was not exercised on this Mac (see [testing](#testing)); P4C.2 ran it on Linux, where its fake microphone works. Safari itself has not been tried at all: a real iPhone and Mac are P4C.9.
- **The prototype’s frame was not SFrame.** P4C.2 built the real one, and the prototype now seals its frames with the site’s own worker ([as built](#frame-encryption-as-built-p4c2)). Its cost a frame on a phone is still to measure (P4C.2a).
- **ICE through the home network.** The prototype connected over loopback and the LAN. The announced public address and the path through the router are P4C.4.
- **ts-mls has had no audit**, and the working group’s test vectors have not been run against it yet (P4C.3).

## Frame encryption as built (P4C.2)

[`web/src/lib/voice/`](../web/src/lib/voice/) holds SFrame and the worker that applies it. Nothing a player sees uses it yet: P4C.3 gives it keys from the MLS group, and P4C.5 puts it in a table’s voice.

**How it works**

- **The RFC, held to its vectors.** [`sframe.ts`](../web/src/lib/voice/sframe.ts) is RFC 9605 for cipher suite 0x0004: the header, the key and salt, the nonce, sealing and opening, and key ids made of an MLS sender and epoch. It reproduces all 289 header vectors of appendix C.1 and the 0x0004 vector of C.3 with every value in between (both labels, the secret, the key, the salt, the nonce, the authenticated data and the ciphertext), under Node and on the WebCrypto of Chromium, Firefox and WebKit. The vectors are read out of the RFC’s text as hex strings ([`sframe-vectors.json`](../web/src/lib/voice/sframe-vectors.json)); the working group’s JSON copy writes 64-bit key ids and counters as numbers, which JavaScript cannot read exactly. Appendix C.2 and the other four vectors of C.3 are for cipher suites the site does not use.
- **One key an epoch, and none as bytes.** The page imports each epoch’s base key into WebCrypto as a non-extractable HKDF key and posts that one `CryptoKey` to the worker. The worker derives a member’s AES key from it on first use, inside WebCrypto (`deriveKey`), non-extractable, and for sealing or for opening but never both, which WebCrypto then enforces. So a page holds one key an epoch however many people are at the table, and nothing in the page or the worker can read a key back out. WebCrypto’s HKDF with a salt of 32 zero bytes is the RFC’s `HKDF-Extract("", base_key)`; the vectors check it.
- **A key store that keeps the RFC’s promises** (`KeyStore`, section 9 of the RFC). A counter is taken before anything is awaited and only goes up; an epoch is added once and never an older one after a newer; sending under an epoch again does not restart its counter; and a key id that seals never opens. A new epoch replaces the one that had its low bits (section 5.2), and a page can retire an epoch itself, which is how P4C.3 will end the grace window.
- **A stream belongs to one person.** The server holds no key and cannot make a frame, but it could route one person’s frames into another’s stream, and the wrong seat would light up and speak. Each receiver’s transform is told which leaf its stream belongs to, and refuses a frame sealed as anyone else. (Among members SFrame has no per-sender authentication, RFC 9605 section 7.2: anyone in the group could seal a frame as another member. The people at the table are not who voice protects against.)
- **Replays.** A receiver remembers the newest counter it opened under a key and which of the 128 before it (two and a half seconds of frames) it has seen. A counter seen before, or older than that, is refused. The counter counts only after the frame is authenticated, so a forged frame cannot move the window.
- **One worker a page**, for its sender and every receiver ([`sframe.worker.ts`](../web/src/lib/voice/sframe.worker.ts), driven by `FrameCrypto` in [`sframe-client.ts`](../web/src/lib/voice/sframe-client.ts)). It is a bundled same-origin module. SvelteKit’s build writes it to `_app/immutable/workers/sframe.worker-<hash>.js`, and Chromium, Firefox and WebKit each loaded it from the Node server under the site’s CSP, tried with a throwaway route because no page uses it yet.

**What is never played, and never sent**

A frame that does not open is dropped before the decoder, which conceals it as it would a lost packet. Each is counted under its reason in the transform’s tally.

| Reason | What arrived |
| --- | --- |
| `malformed` | No SFrame header, a header written longer than it needs, or too few bytes for a tag |
| `unknown-key` | A key id this page has no key for: an epoch it was never given, or a context |
| `stale-epoch` | An epoch this page has retired |
| `wrong-sender` | A frame sealed as someone other than the stream’s person, or as this page’s own leaf |
| `tampered` | The key, the header, the frame or the tag is not what a member sealed |
| `replayed` | A counter already opened under this key, or too far behind to tell |

On the way out, a frame with no key to seal it under is dropped and counted `unsent`: no frame leaves a page as plain Opus. A listener handed plain Opus, from a sender with no worker at all, refuses every frame of it.

The header is in the clear, as section 9.2 of the RFC warns: it shows the sender’s leaf, the low four bits of the epoch and how many frames that person has sent under it. The voice server already sees who sends and when ([metadata](#threat-model)), so it learns nothing new.

**Found on the way**

- **Firefox hands a receiver frames with no bytes.** About two dozen arrive as a direct call between two Firefox pages starts, with one RTP timestamp and consecutive sequence numbers: the padding its peer probes the connection with. They hold nothing to open and nothing to play, so the transform drops them unread and counts them as `empty`, apart from `malformed`, which should stay at zero in an honest room. mediasoup forwards none; the prototype’s rooms saw none.
- **Playwright’s WebKit for Linux has no `RTCRtpScriptTransform`.** It is another WebRTC build from the macOS one. A page there reports that it cannot encrypt frames, and voice would not start: the rule for any browser without it. Its WebCrypto still passes the vectors.
- **Firefox takes no part in Web Audio on a machine with no sound device**, as a CI runner is: `AudioContext.resume()` never settles. Its fake microphone and its decoder need none.
- **Chromium’s fake microphone works on Linux**, which it does not on this Mac.

**What it costs**

Alone in a worker, one frame at a time, 3,000 frames of 161 bytes (a 20 ms Opus frame at 64 kbps), on this Mac (Apple M5, macOS 27.2). A full room asks 50 frames sealed and 400 opened of a page each second.

| Engine | Seal | Open | A full room, of one core |
| --- | --- | --- | --- |
| Chromium | 3.6 µs | 2.9 µs | 0.13% |
| Firefox | 9.7 µs | 10.9 µs | 0.48% |
| WebKit | 9.7 µs | 10.4 µs | 0.46% |

In Playwright’s Linux browsers, in an arm64 container on the same Mac, Chromium took 3.3 and 3.0 µs, Firefox 32 and 32 µs and WebKit 22 and 22 µs.

In the prototype’s nine-person room, everyone sending for thirty seconds and all nine pages on this one machine, a frame spent this long in the transform, WebCrypto’s promises and the wait behind other frames included. The figures are from two runs. Firefox and WebKit count time in whole milliseconds, so theirs are averages over about 13,000 frames a page.

| Engine | Seal | Open | A page, each second |
| --- | --- | --- | --- |
| Chromium | 56 to 58 µs | 29 to 31 µs | 14 to 15 ms |
| Firefox | 83 to 101 µs | 81 to 102 µs | 37 to 46 ms |
| WebKit | 54 to 61 µs | 76 to 103 µs | 33 to 44 ms |

Every frame was sealed and opened long before the next was due. The service’s side did not change with real SFrame: 91 to 92 kbps to each listener for each speaker as mediasoup counts it, the worker at 7 to 10% of a core, and a keyless listener at the SFU that read an SFrame header naming the sender on every packet and nothing else.

**Left for later steps**

- **A phone.** The figures above are a laptop’s. `crypto.subtle` needs a secure context, so a phone cannot load the check page from this Mac over the LAN; it is measured when a build a phone can load over HTTPS exists (P4C.2a).
- **Safari itself.** Playwright’s WebKit is not Safari. The check page runs by hand in any browser (`/?run`, and a button for a call through the microphone) and posts what it finds to the server that serves it; nobody has run it in Safari yet (P4C.2a).
- **CI’s own run.** The checks passed in Playwright’s Linux browsers in a container; GitHub’s runner has not run them yet (P4C.2a).

## Tools considered

| Option | Verdict |
| --- | --- |
| **mediasoup + mediasoup-client** (chosen) | Node and TypeScript API, npm packages, mature, low level enough to control every header extension and codec parameter, single-port ICE-lite server. End-to-end encryption is ours to build, which is the point. |
| **LiveKit** (self-hosted) | Excellent, with built-in end-to-end encryption, but the server is a Go binary with its own signalling and access tokens, and key distribution is still left to the app. The fallback if mediasoup integration stalls. |
| **Mesh WebRTC** | No media server, but it exposes every player’s IP address to every other player, costs a phone eight uploads, and offers no server-side mute. Rejected for privacy. |
| **Janus, Jitsi** | C and Java stacks with their own deployments. Rejected for the TypeScript stack. |
| **werift** (pure TypeScript WebRTC) | Pure TypeScript, but young and slower than mediasoup’s C++ worker. Not for production. |
| **A room key handed out by the server** | Not end-to-end: the server would hold the key. Rejected. |
| **Pairwise sender keys** (Olm style) | Workable, but hand-rolled. MLS is the standard, and RFC 9605 defines exactly how SFrame keys come from it. |

## Testing

- **SFrame:** RFC 9605 appendix C vectors, byte for byte, plus tampering, replay and wrong-epoch tests, in Vitest (`sframe.spec.ts`). `pnpm voice:check` runs the vectors again on each engine’s WebCrypto and sends a real call through the worker, on a page built as the client is and served under the site’s CSP; CI runs it.
- **MLS:** the MLS working group’s interoperability vectors against ts-mls, then joins, leaves, removals, simultaneous commits and restarts in Vitest with the voice service’s delivery rules.
- **Browsers:** Playwright in Chromium, Firefox and WebKit, each person a browser context sending known audio. What each engine needs under Playwright 1.65 on macOS, found at P4C.1 (`web/voice/prototype/browsers.ts`):
  - **Firefox** takes `media.navigator.streams.fake` and `media.navigator.permission.disabled`, and its fake microphone works. Every context can capture at once. With no sound device, as in CI, `AudioContext.resume()` never settles, so a Firefox check that must run there makes no AudioContext and reads WebRTC’s statistics. Between two Firefox pages connected directly, a receiver’s transform is also handed the peer’s padding as frames with no bytes.
  - **Chromium** takes `--use-fake-device-for-media-stream`, but on macOS its fake microphone did not work: `getUserMedia` never settles with `--use-fake-ui-for-media-stream`, and a granted permission without that switch gets `NotSupportedError`, in the headless shell and in the full browser. A tone made by Web Audio stands in, which takes the same road from the Opus encoder on. On Linux the fake device works (P4C.2), so `canCapture` in `web/voice/check/browsers.ts` chooses by platform.
  - **WebKit** has a mock microphone once a context is given the `microphone` permission. It finishes gathering ICE candidates only on a page that has captured, so a person who only listens cannot connect there. An `AudioContext` stops rendering about half a second after capture starts, while still saying `running`, so nothing built on Web Audio (volume, the speaking ring, spatial audio) can be checked there. Only one page of a browser captures at a time, so each person needs a browser of their own. Whether Safari itself shares any of these is for a real iPhone and Mac to say (P4C.9). Playwright’s WebKit on Linux, which CI uses, is a different WebRTC build with no `RTCRtpScriptTransform` (`canTransform`): the checks that need a call are skipped there by name, and the macOS build covers them when `pnpm voice:check` is run on a Mac.
  - Firefox’s ICE fails against a media address on loopback alone, which Chromium and WebKit connect to; a test service also listens on the LAN address.
  - Without Web Audio, judge what a page hears by `inbound-rtp` statistics (`totalAudioEnergy`, `concealedSamples`). Chromium counts no energy for a track whose only output is a muted element, so there the analyser is the measure.
- **The encryption itself:** a test listener attached at the SFU, holding no key, receives the forwarded frames and cannot decode them, while members decode the injected tone.
- **Latency and loss:** mouth-to-ear delay measured with a marked tone, `getStats` jitter-buffer and round-trip figures, and packet loss and jitter added with `tc netem` on Linux.

## Sources

- [RFC 9605, SFrame](https://www.rfc-editor.org/rfc/rfc9605.html), sections 4.5 (cipher suites), 5.2 (MLS), 7 and 9 (what the header reveals) and appendix C (test vectors).
- [RFC 9420, MLS](https://www.rfc-editor.org/rfc/rfc9420.html).
- [Discord’s DAVE protocol](https://daveprotocol.com/) and its [announcement](https://discord.com/blog/meet-dave-e2ee-for-audio-video).
- [mediasoup v3 documentation](https://mediasoup.org/documentation/v3/) and the [mediasoup-client API](https://github.com/versatica/mediasoup-client).
- [ts-mls](https://www.npmjs.com/package/ts-mls) and its README’s note that it has not been audited.
- [MDN, Using WebRTC Encoded Transforms](https://developer.mozilla.org/docs/Web/API/WebRTC_API/Using_Encoded_Transforms) and [Chrome 141 release notes](https://developer.chrome.com/release-notes/141) (Encoded Transform V2).
- [LiveKit encryption](https://docs.livekit.io/transport/encryption/), for comparison.
