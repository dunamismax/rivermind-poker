# Table voice design

This is the design for live voice at the table (Phase 4C, D-15). It records what voice must do, the threat model, the tools chosen and the ones rejected, how keys are agreed and media is encrypted, and what the host has to provide. [The build history](build-history.md#phase-4c--table-voice) holds the steps and their evidence. P4C.1 checked this design with a working prototype, and [what the prototype found](#what-the-prototype-found-p4c1) lists what it confirmed, what it corrected here and what it left for later steps. P4C.2 built the frame encryption, and [frame encryption as built](#frame-encryption-as-built-p4c2) says how it works, what it refuses and what it costs. P4C.3 built the group key, and [the group key as built](#the-group-key-as-built-p4c3) says the same of it. P4C.4 built the voice service, and [the voice service as built](#the-voice-service-as-built-p4c4) says what it does, what it refuses and how it runs on the host. P4C.6 put it in front of people: [voice at the table](#voice-at-the-table-as-a-person-sees-it-p4c6). P4C.8 checked what a copy of the audio is worth to the server and added reports, suspensions and limits: [privacy, safety and moderation](#privacy-safety-and-moderation-p4c8). P4C.7 measured the delay and what packet loss does, made rooms come back by themselves, and gave the service a limit: [audio quality, resilience and capacity](#audio-quality-resilience-and-capacity-p4c7).

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
- **A hidden listener.** Every client builds its member list from the group state, not from what the server says. A member the server adds shows up on every screen and is checked against the table’s seats, and a page stops sending while its group holds someone who is not seated. The **table voice code**, derived from the epoch authenticator, is the same on every screen in the same group. Players can read it aloud to confirm nobody is between them: a server that split a table into two groups, standing in for each player to the other, would pass the seat check, since a leaf only claims its seat, and the code is what would differ.

**Not protected against**, and the privacy page says so

- **The people at the table.** They hear you and can record you.
- **The code the site serves.** Encryption runs in JavaScript that this server sends. A malicious operator could ship code that leaks keys. The source is public (GPL), and each release publishes a hash of its voice client files (P4C.8) so anyone can check that the code served is the code published.
- **Metadata.** The voice server sees who joined voice at which table, their IP address, when each person sends audio and how much, whether they say they muted themself or deafened (P4C.6), and, from the table server, which pairs at the table blocked each other and who may not speak (P4C.5, P4C.8). It does not see what they say. Audio levels stay off the wire: the RTP audio-level extension is not negotiated, and speaking indicators are computed in each browser after decryption.
- **A compromised device or browser.**

## Architecture

```text
browser                                     ubuntu-vm
───────                                     ─────────
table page ── /ws (table protocol v2) ───▶ Caddy ─▶ rivermind-poker-web (Node, 127.0.0.1:4320)
   │                                                      │ issues a short-lived voice token
   │                                                      │ tells the voice service who is seated
   ├── /voice (voice signalling v1, wss) ─▶ Caddy ─▶ rivermind-poker-voice (Node, 127.0.0.1:4323)
   │      join, MLS messages, transports                  │ room per table, MLS delivery service
   │                                                      │ mediasoup Router per room
   └── WebRTC audio (DTLS-SRTP over UDP 3478, ─────────▶ mediasoup WebRtcServer (public UDP/TCP 3478)
          TCP 3478 fallback) carrying SFrame-encrypted Opus frames
```

- **A separate service.** `rivermind-poker-voice` is a second Node process built from `web/`, in its own sandboxed systemd unit. The web service binds only to loopback, and the voice service must bind a public port, so they keep separate privileges and limits. A deploy of the site does not cut a conversation, and a voice restart does not touch a table.
- **The SFU.** [mediasoup](https://mediasoup.org/) 3 (npm `mediasoup`, pinned at 3.32.2, Node 22 or later) is a selective forwarding unit with a TypeScript API and a C++ media worker shipped through npm. Each table’s voice room is one mediasoup Router. One `WebRtcServer` per worker listens on a single UDP and TCP port (ICE-lite), so the host needs one forwarded port, not a range. The browser uses `mediasoup-client` (pinned at 3.26.0).
- **The worker binary.** mediasoup’s install script downloads the worker built for the platform, the architecture and, on Linux, the kernel’s major version from mediasoup’s GitHub release (`linux-x64-kernel7` for ubuntu-vm, `darwin-arm64` for this Mac), and compiles one only if there is none to download. `web/pnpm-workspace.yaml` lists `mediasoup` under `allowBuilds` for it, as it does `esbuild`. So every `pnpm install --frozen-lockfile`, in CI and in a deploy, now needs github.com or a C++ toolchain. mediasoup’s JavaScript bundles into one file as the site’s server does, and a release carries the binary beside it and names it in `MEDIASOUP_WORKER_BIN` (P4C.4).
- **Why forwarding, not a mesh.** In a mesh every player connects to every other player, which hands each player everyone else’s IP address, makes a phone upload eight copies of its audio, and leaves the server nothing to stop when you mute someone. The SFU hides addresses from players, each phone uploads once, and a mute stops the audio at the server.
- **Authorisation.** The table server issues a voice token (HMAC-SHA256 under a key derived from the site secret: table, player, seat, expiry within 60 seconds). The voice service accepts only valid tokens and asks the table server who is seated whenever seats change. Standing up, being moved, a table closing or a block ends that person’s place in the room.

## Encryption

Two layers, with a standard for each.

1. **Hop by hop:** WebRTC’s DTLS-SRTP between each browser and the SFU.
2. **End to end:** [SFrame](https://www.rfc-editor.org/rfc/rfc9605.html) (RFC 9605) encrypts every Opus frame in the sender’s browser and decrypts it in each listener’s. The keys come from an [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) group (RFC 9420) made of the people in the room.

This is the design Discord adopted for its own end-to-end encrypted voice ([DAVE](https://daveprotocol.com/)): MLS for the group key, a key per sender, WebRTC encoded transforms to encrypt frames, and a comparable code to verify the group.

**Frames.** The browser hands each encoded Opus frame to an `RTCRtpScriptTransform` running in a dedicated worker. All three engines support it: Safari from 15.4, Firefox from 117, Chrome from 141 (Baseline 2025). mediasoup-client hands over each `RTCRtpSender` and `RTCRtpReceiver` before it negotiates (`onRtpSender` on `produce`, `onRtpReceiver` on `consume`), and a transform set there sees every frame, with no extra setting on the connection. One worker holds a page’s sender and all of its receivers. A frame is the Opus payload alone in every engine, so what one engine encrypts the others decrypt. Keys reach the worker as non-extractable `CryptoKey`s in the transform’s options. No browser ships SFrame natively, so `web/src/lib/voice/sframe.ts` implements it in TypeScript over WebCrypto, with cipher suite `AES_128_GCM_SHA256_128` (0x0004), and reproduces RFC 9605’s test vectors byte for byte ([as built](#frame-encryption-as-built-p4c2)). The header and the full-size tag add 20 or 21 bytes a frame, about 8 kbps at 20 ms frames. The worker is a bundled same-origin file: the CSP allows it under `script-src 'self'`, and it would block a `blob:` worker.

**Group key.** [ts-mls](https://www.npmjs.com/package/ts-mls) (pinned at 1.6.4) is a TypeScript MLS implementation. It has not had a formal audit, so CI runs the MLS working group’s interoperability test vectors against it ([below](#the-working-groups-test-vectors-p4c3)), and P7.5 reviews how it is used. The ciphersuite is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001), which ts-mls runs on WebCrypto’s Ed25519 and X25519 and `@hpke/core`, with nothing else to install. Import it by subpath (`ts-mls/createCommit.js`): its package root also loads a provider that needs `@noble/hashes`, which the package does not declare, and fails under pnpm. Credentials are basic credentials naming the player’s public reference and seat, signed by a key made for that session; guests have no long-term identity (D-12).

- The first person to join voice creates the group. Later people join by **external commit** from the group info the voice service holds, so nobody already in the room has to be online and quick for someone new to join.
- **Whoever commits publishes the next group info.** A GroupInfo carries the ratchet tree and the group’s external public key and is signed by a member, so the service cannot make one: it only keeps the latest it was given. The creator sends the first, and after every commit its author sends the new one (about 0.45 kB for one member and 3 kB for nine).
- The voice service is the group’s **external sender**: when someone leaves, it proposes their removal, and the remaining member with the lowest leaf index commits it. If that member is gone, the next one does. Members refuse a proposal the service did not sign.
- The voice service orders commits: it accepts the first valid commit for an epoch and refuses the rest, the usual MLS delivery-service rule. Commits and proposals travel as MLS public messages, so the service can read their epoch and sender; they hold no secret, and it cannot read or forge application keys. A member whose commit lost drops it and applies the winner’s, which costs nothing: a ts-mls commit never changes the state it was made from.
- **A reloaded page joins as a newcomer.** It has a new signature key, so the group cannot tell it from a stranger: it joins by an ordinary external commit, and the service proposes the removal of its stale leaf. For a moment the group holds two leaves for one seat, so the check of members against seats counts seats, not leaves. A page that kept its signature key but missed commits may instead **resync**, an external commit that replaces its own leaf. Never ask ts-mls 1.6.4 to resync under a new signature key: it finds the old leaf by that key alone, and `joinGroupExternal` with `resync` set never returns when there is no match.
- **SFrame keys from MLS** follow RFC 9605 section 5.2: for each epoch, `base_key = MLS-Exporter("SFrame 1.0 Base Key", "", AEAD.Nk)`, and the key ID packs the sender’s leaf index and the low bits of the epoch, `KID = (sender_index << E) + (epoch % (1 << E))`. A receiver drops an old epoch when a new one with the same low bits arrives. `E` = 4 and `S` = 6, the RFC’s own example: sixteen epochs in flight, where a page holds two, and sixty-four leaves, where a table of nine with every page reloading at once needs eighteen.
- **Changing epochs without a gap.** A page takes a new epoch’s key the moment it has applied the commit and sends under it at once, so nothing said after someone left is sealed under a key they hold. It keeps the epoch before for two seconds, for frames still on their way. A listener handed a frame before it has the key waits up to 250 ms for the key and then opens the frame, with the stream’s later frames queued behind it in order. A join and a leave during a call cost a listener no frame and, with both pages moving at their own pace, no concealed audio at all ([measured](#the-group-key-as-built-p4c3)).
- **The table voice code** is four words of the 2,048-word BIP-39 list, 44 bits, made from the MLS epoch authenticator stretched through 600,000 iterations of PBKDF2. It changes whenever someone joins or leaves.

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
- **Upload bandwidth.** The SFU sends each speaker’s audio to every other person in the room. The prototype measured 92 kbps to each listener for each person speaking, as mediasoup counts it (161-byte Opus frames at 64 kbps, the frame’s encryption, RTP, SRTP and RTCP); the UDP and IP headers of fifty packets a second add 11 kbps, so about 103 kbps leaves the host. A nine-seat table with everyone talking at once sent 6.6 Mbps so counted, about 7.4 Mbps on the wire; each person talking costs a nine-seat table about 0.8 Mbps. [P4C.7](#capacity) measured the line at 556 Mbps and more up, and gave the service a limit on rooms and people, at which the table says plainly that voice is full.
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

The Node side of a service holding only mediasoup was 75 to 100 MB (the self-test); the prototype’s 175 MB includes Vite, which builds its page in the same process. Signalling costs nothing once a room is up. These are this Mac’s figures; so are [P4C.7’s](#capacity), and ubuntu-vm’s own are still to measure.

**Corrected here**

- Each listener costs about 103 kbps for each person speaking, not 90, and a full table about 7.4 Mbps, not 6.5 ([upload bandwidth](#what-the-host-needs)).
- The service cannot make a GroupInfo. Whoever commits publishes the next one ([group key](#encryption)).
- A reloaded page joins as a newcomer and the service removes its old leaf; resync is only for a page that kept its signature key ([group key](#encryption)).
- ts-mls is imported by subpath and needs WebCrypto’s Ed25519 and X25519. Playwright’s Chromium, Firefox and WebKit all have them: three members made on one page agreed a base key in each, with a join taking 2 to 11 ms. Which released versions of each browser do is not checked; a browser without them fails the group key and gets no voice, as the ground rules say.
- Every install now runs mediasoup’s install script, and a release must carry the worker binary ([the worker binary](#architecture)).
- What Playwright can and cannot check in each engine ([testing](#testing)).

**Left for later steps**

- **WebKit’s jitter buffer** held 174 ms in the nine-person room against about 35 ms in the others (29 ms with two people). The mock microphone and nine browsers on one machine may be the cause. It was the mock microphone: [P4C.7](#delay) found every listener's buffer grows for a speaker in Playwright's WebKit, in any engine, while WebKit as a listener held 56 ms of well-paced speakers.
- **Capture in Chromium** was not exercised on this Mac (see [testing](#testing)); P4C.2 ran it on Linux, where its fake microphone works. Safari itself was first tried at [P4C.9](#the-launch-p4c9), in the iOS Simulator; a real iPhone is P7.1b.
- **The prototype’s frame was not SFrame.** P4C.2 built the real one, and the prototype now seals its frames with the site’s own worker ([as built](#frame-encryption-as-built-p4c2)). Its cost a frame on a phone is still to measure (P4C.2a).
- **ICE through the home network.** The prototype connected over loopback and the LAN. The announced public address and the path through the router are P4C.4.
- **ts-mls has had no audit.** The working group’s test vectors now run against it in CI ([P4C.3](#the-working-groups-test-vectors-p4c3)).

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

- **A phone.** The figures above are a laptop’s. `crypto.subtle` needs a secure context, so a phone cannot load the check page from this Mac over the LAN; a real iPhone and an Android phone are measured at P7.1b, from the live site's own tallies.
- **Safari itself.** Playwright’s WebKit is not Safari. The check page runs by hand in any browser (`/?run`, a button for a call through the microphone and one for a call with a tone) and posts what it finds to the server that serves it. [P4C.9](#the-launch-p4c9) ran it in Safari 27.2 in the iOS Simulator: the vectors, the key check, the cost and a call sealed, opened and heard.
- **CI’s own run.** The checks passed in Playwright’s Linux browsers in a container, and then on GitHub’s runner (run 44960250047).

## The group key as built (P4C.3)

Four files in [`web/src/lib/voice/`](../web/src/lib/voice/) on ts-mls, with nothing a player sees yet: P4C.4’s service carries their messages, and P4C.5 puts them at a table.

**The parts**

- [`group.ts`](../web/src/lib/voice/group.ts), one member’s side. `Member.create` makes the group, naming the service as its only external sender. `Member.join` joins by external commit from the GroupInfo the service holds, and refuses a group that names any other external sender. `receive` applies what the service passes on. `commitRank` says whose turn it is to commit the removals the service proposed: 0 for the lowest leaf that is not itself going, 1 for the next, who steps in if the first stays quiet. `commit` and `join` each return a candidate: the commit, the GroupInfo that follows it, and the member as it will be if the service accepts. The member a commit was made from stands until then, and applies the winner if it loses.
- [`delivery.ts`](../web/src/lib/voice/delivery.ts), the service’s side. It holds the latest GroupInfo and a signature key made for the room, in memory. `submit` accepts the first commit made from the current epoch and refuses the rest (`epoch-taken`). `remove` signs a removal as the external sender.
- [`group-keys.ts`](../web/src/lib/voice/group-keys.ts), from the group to the audio. `EpochKeys.advance` exports the epoch’s base key, `MLS-Exporter("SFrame 1.0 Base Key", "", 16)`, imports it into WebCrypto, wipes the bytes, gives the key to the worker and moves the page’s sending to it. It returns the voice code and the seat check.
- [`voice-code.ts`](../web/src/lib/voice/voice-code.ts), the four words. The list is BIP-39’s English one (`voice-words.json`, MIT, `licenses/python-mnemonic.txt`): 2,048 common words, no two alike in their first four letters.

**What a member will apply, and what the service will pass on**

A member applies three things and nothing else: a removal proposal signed by the service, a member’s commit of such removals (at least one, and no other proposal), and a newcomer’s external commit (its external init alone). So no member can add anyone, remove anyone the service did not name, or change who the external sender is, and a commit of nothing is refused too. ts-mls has checked the signatures and the membership tag before the rule is asked.

The service cannot check a commit as a member does, because the membership tag is keyed with a group secret. It checks what is public. The GroupInfo with each commit must be for the next epoch, name the service as the only external sender, and be signed by a member in its own tree. Comparing the tree before and after, a newcomer’s commit must add exactly one leaf, carrying the identity of the socket it came from, and remove none; a member’s commit must come from that member’s own socket and remove only leaves the service asked to have removed. A member who lies to the service in a GroupInfo can break the room for newcomers and learns nothing; the room then starts a new group (P4C.7).

**Found on the way**

- **A removal proposal dies with its epoch.** If a join takes the epoch before anyone commits a pending removal, the proposal is gone. The service keeps the list of leaves it wants removed and proposes each again after every commit it accepts.
- **A newcomer must be sent those proposals too.** The commit that carries out a removal refers to the proposal, and a member who never saw the proposal cannot apply the commit. The test that found this had the newcomer miss one, and the next commit left it behind.
- **A long WebCrypto call stops the audio in Firefox.** The voice code was first stretched in one PBKDF2 call of 600,000 iterations, about 50 ms. Firefox ran it in the same queue as the worker’s AES, and every listener concealed 25 to 50 ms of audio at each join and leave. The stretching is now sixty chained rounds of 10,000 iterations, each fed the last one’s output: the same work, in the same order, with frames going between rounds. Nothing else on a page in voice should make a WebCrypto call that takes more than a few milliseconds.
- **Holding the instant a seat empties would cut every speaker off.** The table reports an empty seat before the group has removed its leaf: the removal takes a proposal, a commit and a round trip. A page that stopped sending the moment the two disagreed dropped its own frames for that long, every time anyone stood up. Someone a page saw seated now has three seconds after leaving their seat before they count as a stranger. Someone who never held a seat has none.

**What the group’s members are checked against**

A leaf says who it is in a basic credential, `<seat>:<player>`, signed by a key made for the session. It is a claim: guests have no long-term identity (D-12). A page compares every leaf of its own copy of the tree with the people the table shows seated, by player and seat together, and stops sending (`hold`) while any leaf is a stranger. It counts seats, not leaves, since a reloaded page’s old leaf stays beside its new one until it is removed.

The same operator runs the table and the voice service, so this check alone would not stop it lying about both. What it gives is that everyone in the voice group is someone every player can see at the table. The voice code covers the rest. Its 44 bits are few: someone running both halves of a split table could make commits until the two halves’ codes agreed, about four million tries for each half by the birthday bound. The stretching makes each try cost about 50 ms of one core, some hundred core-hours for every epoch, to be done again at each join and leave before anyone notices the pause.

**Measured**

In Playwright’s Chromium, Firefox and WebKit on this Mac, a call between two pages of one table’s group, a continuous signal playing, someone joining and then leaving, 1.5 s apart (`pnpm voice:check`):

| | Frames refused or unsent | Concealed audio, of 20 ms a frame |
| --- | --- | --- |
| Both pages at their own pace, five runs an engine | 0 | 0 samples in all fifteen |
| The listener’s page 60 ms behind the speaker’s, five runs an engine | 0 | 0 to 39 ms |

A listener behind the speaker waited for the key at each of the two changes and opened every frame. In Playwright’s Linux Chromium and Firefox, in a container, the same check concealed nothing at the pages’ own pace and 12 to 18 ms with the listener behind. The voice code came out the same words on all three engines and under Node. In Vitest, a seeded random walk of 120 joins, leaves, reloads, simultaneous joins and quiet committers at up to nine seats ended every step with one epoch, one base key and one authenticator for everyone in voice, and every page that had left unable to follow.

**Left for later steps**

- **The wire.** Members and the service are driven directly in the tests. Voice signalling v1 (P4C.4) carries the messages, and P4C.5’s client decides when to act: it commits after `commitRank` turns of a timeout, joins again when its commit loses, and asks for a new group when its state cannot follow.
- **Timing over a real network.** The measurements are two pages on one machine. [P4C.7](#recovery) put a join and a leave through a network that delays and loses audio, and the 250 ms wait and the 2 s grace held.
- **A member the service cannot hear from.** If nobody commits a removal, the leaf stays, and after three seconds every page holds. [P4C.7](#recovery) says why the members' turns are enough, and why a page that holds should go on holding.

## The working group’s test vectors (P4C.3)

ts-mls is the one part of voice’s encryption this project did not write and nobody has audited, so the pinned package, as pnpm installs it, is held to the MLS working group’s interoperability test vectors in this repository’s own test run, on every push.

- **What runs.** All sixteen files of [`mlswg/mls-implementations`](https://github.com/mlswg/mls-implementations/tree/main/test-vectors) at commit `89134d5` (2025-11-30): every case for ciphersuite 0x0001, and the four files that are for no ciphersuite in particular. That is 395 cases: tree math, the crypto basics, the key schedule, the secret tree, message protection, PSK secrets, transcript hashes, the welcome, tree operations, tree validation, TreeKEM, the serialization of every message, and the three passive-client scenarios, in which a member joins by a Welcome and follows other people’s proposals and commits, checking the epoch authenticator at every epoch. All pass on ts-mls 1.6.4 under Node 26.
- **The runners** are [`web/src/lib/voice/mls-vectors/*.spec.ts`](../web/src/lib/voice/mls-vectors/), adapted from ts-mls’s own test suite (MIT, `licenses/ts-mls.txt`) to import the installed package by subpath and to read the working group’s files. ts-mls runs older copies of the same vectors in its own repository; these are the working group’s current ones, against the published build.
- **The vectors are fetched, not kept.** The working group’s repository states no license, so its files are not copied into this one. [`load.ts`](../web/src/lib/voice/mls-vectors/load.ts) fetches each from GitHub at the pinned commit, checks it against the SHA-256 in [`source.json`](../web/src/lib/voice/mls-vectors/source.json) and keeps it under `node_modules/.cache/mls-vectors/`. In CI a file that cannot be fetched fails the run. Anywhere else its checks are reported as skipped, so a deploy does not wait on GitHub.

## The voice service as built (P4C.4)

`rivermind-poker-voice` is [`web/voice/server.ts`](../web/voice/server.ts) on the parts in [`web/src/lib/server/voice/`](../web/src/lib/server/voice/), and speaks voice signalling v1 ([`signalling.ts`](../web/src/lib/voice/signalling.ts)) with pages. A page's side is [`VoiceRoom`](../web/src/lib/voice/room.ts). No table offers voice yet: P4C.5 issues the tokens and puts `VoiceRoom` at the table, and P4C.9 gives Caddy the `/voice` route.

**Voice signalling v1**

One JSON text frame a message, 32 KiB at most. A page's requests carry an `id`, and each is answered with the same `id`, in the order asked; notices carry none.

| Request | What it does |
| --- | --- |
| `hello` | The first message, with `v: 1`, the table and a voice token. The answer has the page's seat and player as the token names them, the service's signature key and the group id for `Member.create` and `Member.join`, the GroupInfo to join from (or none, to create the group), the Router's capabilities without the audio-level extension, and who else is in the room. |
| `group.create`, `group.commit` | The delivery rules of [`delivery.ts`](../web/src/lib/voice/delivery.ts). A refusal carries the GroupInfo to start again from: none to create the group, else join it. |
| `transport.create`, `transport.connect` | A send and a receive WebRTC transport, one of each. |
| `transport.restart` | New ICE credentials for a transport that lost its path ([P4C.7](#recovery)). |
| `produce`, `producer.pause`, `producer.resume` | The page's one audio track. |
| `consume`, `consumer.pause`, `consumer.resume` | Another person's track, paused until the page resumes it. |

| Notice | When |
| --- | --- |
| `mls` | A commit the service accepted (to everyone but its author), or a removal it proposes (to everyone, the author and a newcomer included). |
| `producer` | Someone in the room sends audio, with the leaf it is sealed as. |
| `consumer.closed`, `left` | A stream ended; someone's socket closed. |
| `media.reset` | The media server's listener started again under a new public address: make the transports again. The group stands. |

**What it lets in**

- **A voice token** for the table the hello names: `v1.<table>.<seat>.<player>.<expires>.<nonce>.<signature>`, the player being the public reference the group's leaves carry, never the player id behind the session cookie. It is signed with HMAC-SHA256 over `voice:` and its fields, and good for 60 seconds. A forged token, one for another table, an expired one, one that claims a longer life, or one already used is refused (`bad-token`) and the socket closed with 4401. A used token's nonce is kept until it would have expired.
- **The voice key, not the site secret.** Tokens are signed with `HMAC-SHA256(site secret, "rivermind-poker voice token key v1")` ([`tokens.ts`](../web/src/lib/server/voice/tokens.ts)), which the table server can compute and the voice service is given as a file. The voice service is the one process facing the internet on a UDP port, through a C++ media worker running as the same user; holding the site secret, a compromise of it would let anyone forge any guest's session cookie. It cannot.
- **One socket a seat.** A second hello for a seat closes the first socket (4409) and asks the group to remove its leaf, so a reloaded page takes its own place, and a room holds at most nine.
- **A page from the site.** The handshake must carry an `Origin` the service is configured with (`VOICE_ORIGINS`); any other is refused with 403 before the socket opens. A socket that sends more than 60 messages at once or 20 a second after, a frame over 32 KiB, a binary frame, or anything before `hello` that is not `hello`, is closed (4429, 4400). A socket that misses a ping, sent every 15 seconds, is let go, so the group removes a phone that lost its signal.

**How a room runs**

- **In one order.** A room's requests, from all its sockets, and its departures run one at a time. The delivery service sees one commit at a time, a commit's author hears it was accepted before the removals that follow it, and every page hears of each change in the order it happened.
- **The group on the wire.** The service holds the room's `Delivery` and passes on what it accepts. It records the leaf each socket holds, from the GroupInfo after the socket's own create or join, and a member's commit must come from that leaf (`Delivery.submit`'s `fromLeaf`): a reloaded page's old leaf cannot commit through the new socket. When the last socket holding a leaf goes, the group is gone, and the next to join makes a new one.
- **Audio only from the group.** A page may send only once it holds a leaf, and never with the audio-level extension. Each producer's notice names the leaf it is sealed as, and a listener's transform opens it only as that leaf (`wrong-sender`), so the service cannot route one person's voice into another's seat. Consumers start paused.
- **Nothing kept.** Rooms live in memory and end when their last socket closes.

**What it logs.** Counts, durations and errors: `room 6 opened`, `room 6: someone joined (3 in voice)`, `room 6 closed after 6 s, at most 3 in voice`, `refused a token: forged`. Rooms are numbered by the process, never named by their table. Every line also passes through a redaction of addresses and of anything shaped like a token, key or public reference ([`log.ts`](../web/src/lib/server/voice/log.ts)), mediasoup's own warnings included. A test runs a session of three people, a refused token and a departure, and finds none of the table, the players' ids, public references or handles, the tokens, their nonces, the sockets' names or an address in the log.

**The public address.** ubuntu-vm is behind the home router, so ICE candidates must name the router's address. The site's own name already points there, kept current by the host's dynamic DNS, so the service resolves `rivermindpoker.com` (`VOICE_ANNOUNCED_HOST`) before it starts, and every minute after ([`address.ts`](../web/src/lib/server/voice/address.ts)). When it changes, the media server starts again under the new address, which closes every transport, and pages are told `media.reset`; rooms and their groups stand. A name that does not resolve at start-up stops the service, and systemd tries again.

**On the host** ([`deploy/rivermind-poker-voice.service`](../deploy/rivermind-poker-voice.service), [`deploy/update.sh`](../deploy/update.sh)):

- A unit of its own, `rivermind-poker-voice`, running `build/voice/voice.js` of the current release on `/opt/node-26/bin/node` as a dynamic user, with the web unit's sandbox and `SocketBindAllow=` for its signalling port (TCP 4323 on loopback) and its media port (UDP and TCP 3478), and `SocketBindDeny=any`: on ubuntu-vm a process under those rules got EPERM binding any other port, TCP or UDP. [P4C.9](#the-launch-p4c9) added a system call filter, a private view of `/proc` and a user namespace. Memory is the platform's 256 MB high and 512 MB most. The voice key comes as a credential from root-only `/var/lib/rivermind-poker/voice-key`, which `update.sh` derives from the session secret as a dynamic user (`voice.js derive-key`). `Restart=always`: since [P4C.7](#recovery) a dead media worker is replaced inside the service, and only when none can be started does the service stop for systemd to start it again.
- `pnpm build` bundles the service into `build/voice/` on its own, with mediasoup's worker binary beside it, sharing nothing with the site's server, so `build/voice/` changes only when voice does. `update.sh` checks every release's voice service as a candidate before the switch (on loopback and free ports in 4400-4499, under the unit's sandbox: `/healthz`, and a socket from another origin refused), and after the switch restarts `rivermind-poker-voice` only if its unit, its key or `build/voice/` changed or it is not running. A deploy that does not touch voice leaves every conversation alone, and keeps the release the voice service runs from when it clears old ones.
- `ufw` allows UDP and TCP 3478, added by `update.sh` when it installs the unit (Q-9). Since [P4C.9](#the-launch-p4c9) a table of the site's own caps TCP connections to it at 32 an address.
- Port 4322, which the plan named for signalling, belongs to fieldcadence.app on this host; the voice service takes 4323, the next free one in the host's table.

**Measured on ubuntu-vm.** The bundle built on the host ran there under a copy of the unit, on the real port and announcing the router's address, with a key from a test secret and the checks' origin (scratch files, removed afterwards). From this Mac, inside the home network, the room checks ran against it with signalling through an SSH tunnel: Chromium, Firefox and WebKit pages made and joined a group, talked, and took a join and a leave, with no frame refused. Chromium and Firefox reported their media on `udp 71.215.196.157:3478`, the router's public address, looped back by the router; Chromium told to use no UDP connected on `tcp 71.215.196.157:3478`. WebKit does not report addresses, and had no other candidate. After ten rooms the service held 46 MB (48 MB at most), and its journal held only counts, durations and `refused a token: forged`.

**Found on the way**

- **A transport's `id` and the request's.** The first draft spread a transport's description, which has an `id`, over its answer's envelope, and the transport's id replaced the request's: the page never heard back. The answer envelope now goes last, and the protocol names the transport `transport`.
- **mediasoup in an ES module bundle** looks for its own directory with `__dirname` when there is no `node_modules` to resolve it from, as in a release, and an ES module has none: the bundle failed on the host and ran on this Mac only because `web/node_modules` sat above it. The voice bundle defines `__dirname` and `__filename` from `import.meta` in a banner, and the worker binary is passed to mediasoup by path.

**Left for later steps**

- **From outside the home network.** Checked from inside it only, through the router's loopback, at the launch too ([P4C.9](#the-launch-p4c9)); a phone on a mobile network is P7.1b.
- **Live.** The unit is installed and `ufw` opened by the first deploy that carries it, an owner gate; [P4C.9](#the-launch-p4c9) added the `/voice` route that reaches its signalling.
- **The table server's side** (P4C.5): `POST /api/tables/{id}/voice` issues tokens with `issueToken`, and the table tells the service when seats change.
- **Recovery**: a restart, a dead worker or a lost path cost a room its transports or its group until [P4C.7](#recovery) made each mend itself and measured it.
- **The prototype** kept its keyless listener at the SFU and its audio-level control until P4C.8 moved them into a test build of this service ([`tap-server.ts`](../web/voice/check/tap-server.ts)); nothing it holds is needed now.

## Voice at the table (P4C.5)

The table server decides who is in a table's voice, and tells the voice service.

- **Who.** The people seated at a table that is not a practice table, when two or more are: never a spectator, someone holding a seat they have not sat in, a bot (D-7), or someone gone bust (no chips, no rebuy coming, not in the hand). `voicePeople` in [`api/voice.ts`](../web/src/lib/server/api/voice.ts) is the rule.
- **Tokens.** `POST /api/tables/{id}/voice` answers that person `{ table, seat, token, url }` (`VoiceTokenResponse` in `signalling.ts`): a token for `hello`, good once within a minute, and `/voice`. A spectator or a practice table gets 403, someone alone or bust 409, a server without a voice service 503. The table's list goes to the voice service before the token is issued, so a voice service that has just started knows the room's people before anyone reaches it.
- **Seat lists.** Each change at a table that alters who is in voice (someone sits, stands up, busts, leaves, blocks or unblocks another) sends the voice service the whole list, signed with the voice key ([`seats.ts`](../web/src/lib/server/voice/seats.ts)) and ordered by when it was made; a change of stacks or turns sends nothing. A table that closes sends an empty one. The voice service lets in only someone the list names (`not-seated` otherwise, and the socket closed with 4403), and takes out at once anyone who leaves it (4403), asking the group to remove their leaf, so the rest move to a new epoch. In Vitest, on the whole table server with its manual clock and a real voice service, a person who stood up was out of the room in well under a second, and the two who stayed agreed on a new key the leaver could not derive. A list older than one applied is ignored. Until the first list after the voice service starts, a token alone admits.
- **Blocks.** A list names the pairs at the table either of whom blocked the other. The voice service never makes either a consumer of the other's audio and closes any it had made; each stays in the room for everyone else, and no new epoch starts. Removing a blocked person from the room would let anyone silence anyone for the whole table, and taking them out of the group adds nothing: the people at a table are not who voice protects against.
- **Mutes** stay the listener's own business: `VoiceRoom` takes the public references a person has muted (`muted`), and a muted person's consumer stays paused at the voice service from the start, so none of their audio reaches the page; `mute(player, on)` pauses or resumes it.

- **Restarts.** A deploy of the web service does not touch voice: the units are apart, a table server that stops publishes no change and so sends no list, and the next one restores the tables and carries on, its tokens and lists working as the last one's did (`restart.db.spec.ts`, on PostgreSQL). A restart of the voice service, or a lost connection, ends a page's session, and `VoiceRoom` comes back by itself: it asks for a new token (`token` may be a function), joins a new group, and keeps the person's mutes. Each connection is a `VoiceSession` with a worker and keys of its own, because a new group starts again at epoch 0, which a key store never goes back to; the microphone outlives the session. It comes back after 1001, 1006, 1011, 1012 and 1013, and after 1005, which is how Playwright's WebKit reports the service's 1012; never after being refused, replaced by another page in the seat, taken out for leaving it, or closed on purpose. In the room checks, three people were back in a new group 0.7 to 0.8 seconds after their voice service was sent SIGTERM and started again, in each engine, with a muted person still muted. A page that joins with everyone else at once can be handed a few frames sealed before it joined, which it refuses as `unknown-key`.

## Voice at the table, as a person sees it (P4C.6)

[`web/src/lib/nl/voice.svelte.ts`](../web/src/lib/nl/voice.svelte.ts) (`TableVoice`) is what the table holds of voice, and [`NlVoice.svelte`](../web/src/lib/nl/NlVoice.svelte) its controls in the table's bar. They sit on `VoiceRoom` and three page-side parts in [`web/src/lib/voice/`](../web/src/lib/voice/): [`microphone.ts`](../web/src/lib/voice/microphone.ts), [`playback.ts`](../web/src/lib/voice/playback.ts) and [`settings.ts`](../web/src/lib/voice/settings.ts).

**When voice is offered.** To someone seated at a table where another person is too, not bust, never at a practice table, and only where the site offers it at all: `GET /api/voice` answers `{ "offered": true }` only with a voice service configured and `RIVERMIND_VOICE_OFFER=1`. That switch stayed off on the live site until [P4C.9](#the-launch-p4c9) gave Caddy the `/voice` route, so no deploy before then showed anybody a voice card that could not connect. In development and the browser tests the Node server passes `/voice` on to the voice service itself (`RIVERMIND_VOICE_PROXY`), byte for byte; the live site never does that, since a deploy of the web server would then cut every conversation.

**The card.** Sitting down there brings the voice card over the table: “Join voice”, “Listen only” and “Not now”, with the line that voice is end-to-end encrypted, recorded nowhere and for adults (Q-10). “Join voice” asks for the microphone then, never before (D-15). A refusal is explained (`explainMic`: how to allow it, or what else went wrong) in the voice panel, which opens by itself, and the person listens meanwhile. The choice is kept in this browser (`localStorage`, `rivermind.voice`) and made by itself at the next table unless the person ticked “Ask each time”; the bar's “Voice” button opens the card again after “Not now”. A browser without `RTCRtpScriptTransform` gets no voice and the card says why.

**Sound.** The Web Audio context is made inside the card's click, so autoplay rules never silence the room; a remembered choice made with no click, which a browser may hold back, shows “Turn on sound”. Each voice goes through a gain (the volume the listener gave it, 0 to 200%), a stereo panner (its seat's side of the table, from the wide seat map, at most 70% to one side) and an analyser for its speaking ring. Where the mix goes depends on the engine:

- **Chromium** cancels echo only on audio it plays from a peer connection, so a mix played straight from Web Audio would come back through a laptop's microphone to everyone ([crbug 687574](https://bugs.chromium.org/p/chromium/issues/detail?id=687574)). There the mix goes through two local peer connections on the page, asking for stereo Opus at 256 kbps, and an audio element plays what arrives (`loopback`), as Mozilla Hubs does it. That element takes the chosen speakers. Nothing on that pair leaves the machine.
- **Firefox and Safari** play the mix to the context's destination (`direct`); their echo cancellers hear all the page plays.
- **No graph** (`elements`): a context that says it runs but stops rendering (Playwright's WebKit does once the microphone is live), or one that never starts after a click (Firefox with no sound device), gives way to an audio element a voice: volume up to 100%, no panning, and the speaking ring from WebRTC's statistics (`totalAudioEnergy`).

Chromium is told apart by `navigator.userAgentData`, which only it has: Playwright gives every engine its project's user agent string, so a Firefox page claimed to be Chrome and took the loopback until the check stopped reading the string.

**The controls.** In the bar: the microphone (mute, `M`; with push-to-talk, a button to hold, or `V`), deafen (`D`, which also stops the microphone), a red “Live” mark whenever the microphone sends (pinned to the corner once the bar has scrolled away), and “Voice”, which opens the panel and shows the connection's quality as a lamp. The panel has the voice code with the prompt to read it aloud, the warning when the group holds someone not seated (the microphone is then off, from P4C.3's seat check), the input meter, “Listen only” or “Use my microphone”, “Leave voice”, and the settings: push-to-talk, the microphone and the speakers where the browser can choose them, echo cancellation, noise suppression and gain control (each change starts the microphone again), the bitrate (32, 64 or 96 kbps, changed on the running sender with `setRtpEncodingParameters`), spatial audio and “Ask before joining”. Each player's seat menu gains “Mute voice” and a volume from 0 to 200%. A P4.5 mute starts someone muted in voice; a voice mute of the listener's own wins over it, and both, with the volumes, are kept by public reference in this browser (the newest 200). Keys act only when no text field has focus. Your own mute and deafen are announced to screen readers.

**Stronger noise suppression** (Q-11). With “Stronger noise suppression (RNNoise)” on, as it is by default, the microphone goes through RNNoise before it is encoded and sealed ([`denoise.ts`](../web/src/lib/voice/denoise.ts)): `@sapphi-red/web-noise-suppressor` 0.4.1's `RnnoiseWorkletNode` in an AudioWorklet, on a capture context of its own at 48 kHz, since RNNoise works on 48 kHz audio in 10 ms frames. The worklet and the WebAssembly (the SIMD build where the browser has SIMD) are bundled same-origin files, never inlined (`assetsInlineLimit`), and the page's policy gains `'wasm-unsafe-eval'` in `script-src` and nothing else. The library defines its node when it is imported, so the page loads it only when a microphone asks for it. A browser that cannot run it keeps its own processing and the settings say so; a capture context that stops (as Playwright's WebKit's does once the microphone is live) hands the room the raw microphone (`Microphone.ontrack`). The meter then reads what is sent. Its three parts' notices are in [`licenses/web-noise-suppressor.txt`](../licenses/web-noise-suppressor.txt): MIT for the library, Apache 2.0 for Shiguredo's WebAssembly build, BSD 3-Clause for RNNoise.

Measured by `pnpm voice:check` ([`denoise.check.ts`](../web/voice/check/denoise.check.ts)) on this Mac, on a page under the site's policy: a room made in the page and the same in every engine (a fan's pink noise, keyboard clicks every 120 to 300 ms and three muffled voices of chatter), the first and last quarter of eight seconds the room alone and the middle half a voice over it, rendered through RNNoise on a 48 kHz `OfflineAudioContext`. The processor starts RNNoise's WebAssembly asynchronously inside the worklet and plays silence until it has, so the render waits at its first block where the engine can (`suspend`), and Firefox, which has no `suspend` and renders the whole signal in a few tens of milliseconds, gets an unmeasured lead of room noise long enough for RNNoise to have started. “Speech” is macOS's `say` voice over the same room, measured once by hand and not kept.

| Voice | Engine | Room where nobody speaks | Speech's level | Added delay | Rendering, of one core |
| --- | --- | --- | --- | --- | --- |
| The check's voice-like signal | Chromium, WebKit | 16.6 dB quieter | −4.5 dB | 20.7 ms | 0.8 to 1% |
| | Firefox | 21.0 to 22.2 dB quieter | −4.5 dB | 20.7 ms | 0.5 to 0.7% |
| Speech | Chromium, WebKit | 30.3 dB quieter | −0.1 dB | 20.7 ms | 0.7 to 1.1% |
| | Firefox | 24.8 to 29.3 dB quieter | −0.1 dB | 20.7 ms | 0.5% |

The delay is the lag at which the output best matches the input, 994 samples at 48 kHz in every engine and run. It is over P4C.6's target of 20 ms by 0.7 ms, and mostly fixed by design: the processor reads its ring buffer 640 samples (13.3 ms) behind where it writes, which is about the least a 10 ms frame allows when audio arrives in blocks of 128 samples (608 would do), and RNNoise's own analysis adds the rest. The room's figure depends on how long RNNoise has been listening when the measure starts, which is how much of the chatter it has learned to take for noise: the first two rows are with three seconds or more of the room behind it (four in Chromium and WebKit, where the figure is then the same every run, and up to sixteen in Firefox). Before P4C.7 the check let the measure start a tenth of a second after RNNoise did, and Firefox then read anything from 9.6 to 20.1 dB; the speech rows were taken that way, by hand. Not measured yet: the cost on a phone.

**Against the browser's own suppression**, through a real capture path (measured with P4C.7's tools, [`denoise.measure.ts`](../web/voice/check/denoise.measure.ts), `scripts/voice-measure-linux.sh denoise`). Chromium on Linux takes a file as its microphone, so the same room with the Mac's voice over its middle half was played into `getUserMedia` four times, in Playwright 1.65.1's Chromium in a container, with echo cancellation and gain control off:

| The microphone's processing | The room where nobody speaks | The voice | The room against the voice |
| --- | --- | --- | --- |
| None | as it is | as it is | 22.6 dB below |
| The browser's own noise suppression | 16.8 dB quieter | −0.3 dB | 39.1 dB below |
| RNNoise alone | 32.8 dB quieter | −0.1 dB | 55.3 dB below |
| Both, as a table sends by default | 25.6 dB quieter | −0.3 dB | 47.9 dB below |

With RNNoise the room is 9 dB further under the voice than with the browser's own alone, which is what the criterion asks. RNNoise by itself does 7 dB better still: the browser's suppression, coming first, seems to leave it noise it knows less well. That is one made-up room through one engine's fake microphone, so the default stays as the owner set it (both), for a real microphone to confirm or change.

The same run found the voice 6 dB quieter through RNNoise than without it. The worklet node, left to its defaults, gave two channels with the second silent, and the mix down to one halved the level; a Web Audio render of one channel, which is all the earlier check did, never showed it. `rnnoiseNode` now takes one channel explicitly, and the voice comes through at −0.1 dB.

**What the seats show.** A glyph by each person's stack (talking, muted, deafened, listening only, not in voice; drawn in `web/art/ui.pxl`) and a ring round the seat while they speak, measured in the listener's browser after decryption, never sent. The ring keeps still for reduced motion.

**Voice signalling v1, added to.** A page tells the room it muted itself or deafened with `status` `{ muted, deafened }`, and the service passes it on as a `peer` notice with the socket's whole `PeerInfo`, which now carries `muted` and `deafened`; the welcome lists them for everyone already there. A page sends `status` only to a service whose welcome says `statuses: true`, because a service from before would close a socket that sends a request it does not know. A page from before ignores the new notice and fields. A muted page also pauses its producer at the page and at the service, so its silence never depends on what it says of itself. Someone who only listens has no producer; a page learns of them from its own copy of the group, and of their status from the `peer` notice.

**Phones.** On a phone the bar keeps to one line in voice (the Voice button becomes its glyph, deafen moves to the panel), and the card and the panel open over the table from the bar and stop above the zone the action panel rises into, scrolling inside. Pages send `Permissions-Policy: camera=(), microphone=(self), geolocation=()`, and since P4C.9 Caddy sends the same on the live site, where it sent `microphone=()` before.

**Checked.** `voice.e2e.ts`, in Chromium, Firefox and WebKit at desktop and phone sizes, against the built server with a voice service of its own: two people at a private three-seat table take the card, join, see the same voice code on screen and in the group, and Bob sees Alice's ring when she speaks; mute by key and button, deafen, push-to-talk by key and by holding the button, Bob's own mute of Alice and her volume at 200%, panning to her side and back to the middle with spatial audio off, the bitrate and echo cancellation changed mid-call, keys ignored in a text field, a reload that rejoins by itself with the remembered choice, and leaving voice. Where Chromium cannot capture (this Mac) its person is refused the microphone, told why, and listens to a Firefox speaker. A practice table and a table of bots offer nothing. No page broke the CSP.

**Left for later steps**

- **RNNoise's cost on a phone**: still unmeasured; no session has had a phone (P7.1b).
- **A page hidden and shown again** resumes the context, starts a microphone the system stopped and says why when it cannot. Playwright does not hide pages, so it was checked by hand at [P4C.9](#the-launch-p4c9), in Safari in the iOS Simulator, where it did each of those.
- **The warning for a stranger in the group** is P4C.3's check shown on screen. It was seen on the live site at [P7.1b](#real-phones-a-second-network-and-the-stranger-warning-p71b), which found the panel closed over it and made the panel open by itself for it.

## Audio quality, resilience and capacity (P4C.7)

How late a voice arrives, what a bad network does to it, what brings a room back by itself, and how much voice the host carries. The measuring tools are `pnpm voice:measure` ([`delay.measure.ts`](../web/voice/check/delay.measure.ts), [`loss.measure.ts`](../web/voice/check/loss.measure.ts)) and `pnpm voice:load` ([`scripts/voice-load.ts`](../web/scripts/voice-load.ts)); the recovery checks are in `pnpm voice:check` ([`recovery.check.ts`](../web/voice/check/recovery.check.ts)) and run in CI.

### Delay

**How it is measured.** Each person's page plays marks into the call and times the marks it hears from the others ([`delay.ts`](../web/voice/check/delay.ts), [`marks.worklet.js`](../web/voice/check/marks.worklet.js)). A mark is made by an AudioWorklet, which notes the wall clock in the block it starts in, as if a microphone had delivered it then; an AudioWorklet at the listener notes the clock in the block where the sound passes a threshold. Both read the clock on the audio thread, never the page's, so the two ends of a call on one machine agree to within a block or two (3 to 5 ms). Marks come every 487 ms from one seat and 513 ms from the next, so they fall everywhere in a 20 ms frame. The figure runs from the mark's making to its arrival in the listener's playback graph, after the decoder and the jitter buffer: it leaves out the microphone's own delay and the speakers', which the browsers put at 19 to 25 ms for this Mac's output. A run is 40 seconds and about 80 marks each way. `pnpm voice:measure delay` prints them.

**On this Mac** (Apple M5, macOS 27.2, Playwright 1.65.1's browsers, both people on the same machine through the voice service from the source, round trip to it 0 to 1 ms, load 4 to 8). Milliseconds, mouth to ear; a range is the two listeners of a pair, or several runs.

| What the audio passes | Listener | Median | 95th percentile | Jitter buffer |
| --- | --- | --- | --- | --- |
| The call alone: Opus, SFrame, the service, the jitter buffer, the decoder | Chromium | 64 to 107 | 67 to 112 | 30 to 41 |
| | Firefox | 59 to 65 | 61 to 69 | 30 to 33 |
| | Chromium and Firefox, each hearing the other | 60 to 68 | 64 to 75 | 31 to 33 |
| The call and the site's playback graph (volume, panning) | Firefox | 46 to 64 | 49 to 70 | 20 to 33 |
| | Chromium, through its loopback | 131 to 144 | 135 to 145 | 30 to 35 |
| RNNoise at the speaker, the call, the playback graph: what a table gets by default | Firefox | 77 to 80 | 91 to 97 | 29 to 39 |
| | Firefox, of a Chromium speaker | 98 | 117 | 36 |
| | Chromium | 167 to 187 | 170 to 189 | 30 |
| | Chromium, of a Firefox speaker | 158 | 188 | 41 |
| Nine in a room, one playing marks, the call alone | Chromium, eight listeners | 64 to 78 | 67 to 80 | 31 to 33 |
| | Firefox, eight listeners | 61 to 86 | 158 to 204 | 51 to 69 |

**What each part costs**

- **The call itself** is 60 to 105 ms on a perfect network: a 20 ms Opus frame has to fill before it is sent, the codec looks 6.5 ms ahead, and the listener's jitter buffer holds 30 to 40 ms even when every packet is on time. The service adds nothing that shows.
- **RNNoise** adds 30 to 40 ms as the page uses it: the 20.7 ms of its own (P4C.6), and the rest in carrying the microphone into its AudioContext and out again to the encoder.
- **Chromium's loopback** (the pair of local peer connections that lets Chromium cancel the echo of what the graph plays, P4C.6) is a second Opus encoder and a second jitter buffer on the listener's side. Measured alone it added 73 ms with 20 ms frames and 53 ms with 10 ms frames, so it now asks for 10 ms frames (`forLoopback`); before that the graph's row read 138 to 148 and 139 to 152, and the default row 179 to 188 and 183 to 190. Asking its jitter buffer for less (`jitterBufferTarget = 0`) changed nothing: it held 31 ms either way, 22 at the least. The request stays in, for the day it is honoured.
- **Firefox's nine-person tail** is nine pages, each decoding eight streams, in one browser on one machine; the median is the pair's. One listener's own machine decodes eight streams, not seventy-two.
- **WebKit** cannot be measured with marks here: Playwright's build stops rendering Web Audio once it captures (see [testing](#testing)). Its jitter buffer held 56 ms of two well-paced speakers in a room with Chromium and Firefox, against their 31 to 33 ms. And the 174 ms that P4C.1 saw was not the listener: whenever the speaker is Playwright's WebKit, every listener's buffer for that stream grows to 200 to 250 ms, in Chromium and Firefox too, because its mock microphone delivers audio in bursts. A real Safari, with a real microphone, is P4C.9's to measure.

**Against the target** (a 95th percentile under 150 ms). The call alone meets it in every engine measured, with 40 ms to spare. As a table plays it by default, Firefox meets it (91 to 117 ms) and Chromium does not (170 to 189 ms): RNNoise and the loopback together cost it 80 to 90 ms. Without RNNoise, Chromium is just inside (135 to 145 ms). The owner chose the third of three ways out on 2026-11-22: about 180 ms in Chromium is fine, and both stay on by default. The three were:

1. **Drop the loopback where Chromium does not need it.** If Chrome on the hardware people use cancels the echo of what Web Audio plays (its newer echo canceller runs for the whole browser on some platforms), the mix can play straight from the graph, and Chromium would read as Firefox does. Nothing here can tell: it takes a real microphone and speakers. For a session by hand, setting `rivermind.voice.direct` to `1` in a browser's `localStorage` plays the mix without the loopback (P4C.9).
2. **Leave RNNoise off by default in Chromium**, whose own noise suppression still runs: 135 to 145 ms.
3. **Accept about 180 ms in Chromium.** ITU-T G.114 puts most conversations untroubled under 150 ms one way and still workable well beyond it; P4C.9's own target between two networks is 250 ms.

### Packet loss and jitter

**How it is measured.** One person plays recorded speech to another through a network that loses a share of the packets and holds the rest 30 ms, give or take 30 (so packets also arrive out of order), and the listener's own WebRTC statistics say how much of what it played was made up to cover a gap (`concealedSamples` over `totalSamplesReceived`). Each condition runs 30 seconds after 10 to settle. The speech is the Mac's own voice reading four sentences, round and round; a tone would measure the wrong thing, as below. `pnpm voice:measure loss` prints the figures and writes ten seconds of what the listener heard under each condition to `artifacts/voice-loss/`, for a person to listen to.

The network is one of two. On this Mac it is a relay between the pages and the service's media port ([`relay.ts`](../web/voice/check/relay.ts)), which works for all three engines. On Linux it is the kernel's own `tc netem` on the loopback interface, for packets to or from the media port (`scripts/voice-measure-linux.sh`, in Playwright's Linux browsers in a container). Loss “to the listener” is on the leg from the service to the listener, “from the speaker” on the leg from the speaker to the service, and “both ways” on both, as when both people are on bad networks: a packet then crosses two lossy legs.

Concealed audio, as a share of what the listener played, through the relay on this Mac (the listener's engine; the speaker is the same engine, or Firefox for WebKit, which plays no Web Audio here):

| Network | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Clear | 0% | 0% | 0% |
| 30 ms of jitter both ways, nothing lost | 0.63% | 0.06% | 0.17% |
| 2% lost to the listener | 0.28% | 0.20% | 0.32% |
| 5% lost to the listener | 0.73% | 0.82% | 0.48% |
| 10% lost to the listener | 2.25% | 1.55% | 2.11% |
| 2% lost from the speaker | 0.46% | 0.32% | 0.50% |
| 5% lost from the speaker | 0.74% | 0.99% | 0.92% |
| 10% lost from the speaker | 2.21% | 2.04% | 1.99% |
| 5% lost both ways | 1.11% | 2.54% | 2.14% |

Every row with loss also has the 30 ms of jitter. The target, under 5% concealed at 5% lost, is met five times over on one bad leg and twice over on two.

The same through `tc netem` in Playwright 1.65.1's Linux browsers, in an arm64 container on this Mac (Playwright's WebKit for Linux cannot seal frames, so it has no row; Firefox there plays no Web Audio and listens to a Chromium speaker):

| Network | Chromium | Firefox |
| --- | --- | --- |
| Clear | 0% | 0% |
| 30 ms of jitter both ways, nothing lost | 0.14% | 0.32% |
| 2% lost to the listener | 0.32% | 0.12% |
| 5% lost to the listener | 0.77% | 0.86% |
| 10% lost to the listener | 1.91% | 1.34% |
| 2% lost from the speaker | 0.31% | 0.39% |
| 5% lost from the speaker | 0.85% | 1.04% |
| 10% lost from the speaker | 1.46% | 1.93% |
| 5% lost both ways | 1.57% | 0.87% |

The relay and the kernel agree to within what one 30-second run varies by. Firefox's column is its second run: in the first, one condition (10% to the listener) read no loss and no concealment at all with half the usual count of repaired packets, as if its statistics had stood still for the window, and the rest matched this one.

**What was found**

- **Opus repairs most of it, for speech.** The encoder adds a coarse copy of each frame to the packet after it (in-band FEC), so a single lost packet is rebuilt from the next. It does so only when told the listener is losing packets, and mediasoup tells each speaker the worst loss among their listeners, as the design meant: the listener's statistics count a repaired frame in nearly every packet (`fecPacketsReceived`) from the first lossy condition on. At 5% lost with 30 ms of jitter, under 1% of what a listener played was concealed, and about 2% at 10%.
- **A tone gets none of this.** The first run of this measure used the delay measure's marked tone, and concealment matched the loss one for one: 2.0% at 2% lost, 4.7% at 5%, 8.5% at 10%, whichever leg lost them. Opus encodes a tone in its music mode, which has no FEC. Speech is what voice carries, so speech is what is measured; a test that plays tones at a lossy network will mislead.
- **Nothing is sent again.** mediasoup offers retransmission (NACK) for Opus, but no browser here lists it for audio, so none is negotiated. FEC covers single losses without it and without the wait.
- **Jitter costs delay, not sound.** With 30 ms of jitter each way and no loss, 0.1 to 0.6% was concealed, and the jitter buffer grew from 30 to 50 ms to about 80; with loss too it held 65 to 120 ms. That is on top of the network's own delay.
- **`packetsLost` is no guide here.** With packets arriving out of order, the browsers' count of lost packets ran to 10 to 38% under conditions that lost 2 to 10%; what was concealed is the measure.

### Recovery

Three things take a room's audio away without anyone leaving, and each now mends itself. The target for each is five seconds.

| What happened | What the page does | The group | Measured, in Chromium, Firefox and WebKit |
| --- | --- | --- | --- |
| The voice service restarted (a deploy that changed it) | Its socket closes with 1012; it asks the table for a new token and joins again (P4C.5) | A new one | 0.7 to 0.8 s from the SIGTERM to three people talking again |
| The media worker died | The same: the service closes every socket with 1012 the moment the worker goes, and has another worker on the same port for the pages that come back | A new one | 0.66, 0.76 and 0.86 s from the kill to four people talking again (0.99 and 0.79 s in Linux Chromium and Firefox) |
| The person's network went and came back as another | ICE starts again on both transports under new credentials from the service (`transport.restart`) | The same one, with every stream | 0.24, 0.18 and 0.35 s from the network's return to audio both ways (0.49 and 0.20 s on Linux) |

- **A media worker that dies** used to stop the whole service, which systemd started again three seconds later (`RestartSec=3`): five to six seconds of silence, and every table's seat list forgotten. Now [`Media`](../web/src/lib/server/voice/media.ts) starts another worker in the same process and takes the same port, and the service ends every room at once, since nothing of a Router outlives its worker: every socket is closed with 1012, as for a restart, and pages come back into new rooms and new groups on the next worker, their hello waiting for it if it is not up yet. The tables' seat lists stand. A worker that dies more than three times in a minute, or cannot be started, stops the service as before, and systemd takes over. `/healthz` answers 503 while there is no worker.
- **A network that changes** is seen two ways. The browser says so (`online`), and the page starts ICE again on both transports at once without waiting to find out what broke. Or a transport reports that it lost its path (`disconnected`, `failed`), and the page does the same for that transport. The service gives the transport new ICE credentials (`transport.restart`, voice signalling v1's one new request, asked only of a service whose welcome says `restarts: true`), mediasoup-client restarts ICE with them, and the transport, its producer and consumers, the group and its epoch all stand. A transport that is still not connected three seconds later ends the session, and the room makes a new one, as after a restart; with a service from before P4C.7, that is all that happens.
- **A network that lets no audio through.** Signalling goes through Caddy on 443; audio needs UDP or TCP 3478 ([what the host needs](#what-the-host-needs)). On a network that blocks both, a page used to sit in voice, connected and silent, with nothing to say why. Now a transport that has not connected ten seconds after it began is treated as one that lost its path, and when two sessions in a row end without their audio ever reaching the media server, the room ends with a reason of its own (`unreachable`, 4504, a code only the page uses) and the table says the network may block the port voice uses. The check takes a relay that passes nothing and finds both people told so.
- **A service that stays away.** A room that lost the service used to ask again every second for as long as the page stayed open, a new token each time. It now waits 0.25, 0.5, 1, 2, 4 and then 8 seconds between tries and gives up after two minutes, when the table says the connection to voice was lost and offers to join again. A hello the service refuses for good (voice is full, the seat is gone, the token is bad) ends the room at once with that reason.
- **Every control's state is kept** by `VoiceRoom`, which outlives its sessions: the person's own mute, deafen and push-to-talk, their mutes of others (paused at the service again from the first moment), and the bitrate. The check has four people, one who muted another, one who muted themself and one who deafened, and finds each as it was after the worker died: the mute still holding at the service, the deafened page still sent nothing, and everyone else still shown who is muted and deafened.

How the network change is checked: a UDP relay ([`relay.ts`](../web/voice/check/relay.ts)) stands between the pages and the service's media port, as a home router does, with a mapping for each page. It drops everything for a second and a half and forgets every mapping, so the service then hears each page from an address it has never seen, as when a phone moves from Wi-Fi to its mobile network; the pages are told the network is back, as the browser tells them. What the relay cannot do is change a browser's own address, the case where ICE must gather again; the same request covers it, and a real phone at P4C.9 checks it.

**Epochs over a bad network.** P4C.3 measured a join and a leave between two pages on one machine and left the real network to this step. Through the relay, with audio up to 60 ms late each way, out of order and 5% of it lost, a third person joined and left a call of two, and nobody refused a frame for want of its key in any engine: frames sealed under the epoch before arrive well inside the two-second grace, and the group's own messages, which travel on the signalling socket, are not held up with the audio. What would cost frames is the opposite, signalling that lags the audio by more than the 250 ms a listener waits for a key, as a stalled TCP connection could for a moment; a listener then conceals those frames, at a join or a leave only.

**Someone nobody removes.** P4C.3 also left the case where a removal the service proposed is never committed. The members' turns cover it: whoever is first commits at once, and each one after takes their turn a second later, so one person whose page has hung delays a removal by a second, and a page that waits longer than the three-second grace holds its microphone until it is done. If the group holds someone the service is not removing at all, holding is the protection working, not a fault to mend: the page keeps its microphone off and the table says why. That warning used to wait for the next change at the table; `EpochKeys.onseats` now tells the table the moment the grace runs out.

**Signalling, added to.** `transport.restart` `{ transport }` answers `{ iceParameters }`. The welcome gains `restarts: true`. A hello may now be refused with `full`, and the socket closed with 4503. `/healthz` also counts `rooms` and `people`. A page from before P4C.7 never asks for a restart, and shows `full` as a failure to start; a service from before never offers one, and the page falls back to a new session.

**Found on the way**

- **A room left open for nobody.** A hello that opened a room and was then refused (a seat the table no longer listed) left the room open, with a Router, for as long as the service ran. Rooms are now closed when their last person goes or their first is refused; with a limit on rooms, each one left behind would have been a table's place lost for good.
- **A relay on loopback, and Firefox.** The service tells each page the address it saw the page at. Through a relay whose own sockets were on loopback, that address was 127.0.0.1, and Firefox's ICE dropped the path, as it drops a loopback media address ([testing](#testing)). The relay now reaches the service from its LAN address.
- **A worklet as a `data:` URL.** Vite inlines a small asset, and the site's CSP then blocks it as a worklet module. The check pages now never inline, as the site's build already did for scripts.

### Capacity

**The uplink.** Voice leaves the host over the home line. This Mac is on the same line (it reaches the internet from the address `rivermindpoker.com` resolves to), and from it 200 MB went up to Cloudflare's speed-test endpoint at 556, 578 and 686 Mbps, with 776 Mbps coming down and 11 ms to the nearest edge. That is the line. From ubuntu-vm itself (a VM on a Windows host), once it could be reached, the same 200 MB went up at 385, 477 and 484 Mbps.

**What a room costs.** `pnpm voice:load` fills a mediasoup worker, set up as the service sets its own, with rooms of nine whose audio arrives encrypted and is forwarded, encrypted again, to the other eight: the work of a call without the browsers. On this Mac (Apple M5, load 5 to 10), fifteen seconds each:

| Rooms of nine | Talking at once | Worker, of one core | Worker memory | Sent |
| --- | --- | --- | --- | --- |
| 1 | all 9 | 2.9% | 20 MB | 6.5 Mbps |
| 2 | all 18 | 4.4% | 38 MB | 13.0 Mbps |
| 4 | all 36 | 11.5% | 59 MB | 26.0 Mbps |
| 8 | all 72 | 27.5% | 117 MB | 52.0 Mbps |
| 16 | all 144 | 37.8% | 237 MB | 104.1 Mbps |
| 1 | 2 | 2.2% | 13 MB | 1.4 Mbps |
| 4 | 8 | 7.3% | 29 MB | 5.8 Mbps |
| 8 | 16 | 11.1% | 41 MB | 11.6 Mbps |
| 16 | 32 | 21.4% | 84 MB | 23.1 Mbps |

The same on ubuntu-vm (AMD Ryzen 7 5800H, six cores given to the VM, Linux x64, load 0.4), from the tree the deploy of `28fd8d2` had built, beside the live services:

| Rooms of nine | Talking at once | Worker, of one core | Worker memory | Sent |
| --- | --- | --- | --- | --- |
| 1 | all 9 | 7.4% | 26 MB | 6.5 Mbps |
| 2 | all 18 | 13.1% | 39 MB | 13.0 Mbps |
| 4 | all 36 | 23.6% | 65 MB | 26.0 Mbps |
| 8 | all 72 | 44.5% | 118 MB | 52.1 Mbps |
| 16 | all 144 | 81.1% | 224 MB | 104.1 Mbps |
| 1 | 2 | 2.7% | 17 MB | 1.4 Mbps |
| 4 | 8 | 7.5% | 31 MB | 5.8 Mbps |
| 8 | 16 | 12.7% | 46 MB | 11.6 Mbps |
| 16 | 32 | 23.5% | 79 MB | 23.1 Mbps |

The host's core does the work at about half this Mac's speed, and its memory is the same. One room with everyone talking reads as P4C.1's nine real browsers did (6.6 Mbps, 6 to 12% of a core, 14 MB), so the tool stands in for them. “Sent” is as mediasoup counts it; the UDP and IP headers add an eighth, 7.4 Mbps on the wire for a room with all nine talking and 1.6 Mbps with two. A room where two people talk at once, which is what a table sounds like, costs a quarter of one where all nine do. Memory follows the streams in flight, about 14 MB a room at the worst.

**The limit.** The voice service takes `VOICE_MAX_ROOMS` and `VOICE_MAX_PEOPLE`. At either, a hello is refused with `full` and the socket closed with 4503; the table says “Table voice is full right now” and offers to try again, and plays on. Someone coming back to their own seat is not counted twice, a room nobody is in is closed at once and frees its place, and a room that comes back after a restart to find no place is told the same, not left trying. The live unit sets **8 rooms and 72 people**, which the host's own figures bear out:

| | 8 rooms, all 72 talking | 8 rooms, two talking in each | The host's limit |
| --- | --- | --- | --- |
| Uplink | 59 Mbps | 13 Mbps | 70% of what the host uploads, about 270 Mbps of 385 |
| Worker memory | 118 MB, beside 40 to 100 MB of Node | 46 MB | `MemoryHigh=256M` |
| Worker CPU, on ubuntu-vm | 45% of a core | 13% | one core |

The uplink would carry four times that. What decides the number is the media worker's one core and the unit's memory: sixteen rooms with everyone talking would take 81% of the core and, with Node, more than `MemoryHigh`. Eight leaves half the core free in the worst case, which no table reaches (everyone at every table talking at once), and nothing on the site needs more yet. To go past it, raise `MemoryHigh` with the limit, and past sixteen or so, give the service a second worker.

**The media port.** P4C.8's review asked for a limit on TCP connections to 3478 from one address, sized here. A person holds two (a send and a receive transport) when their network blocks UDP, and none otherwise; a household or an office behind one address might be a full table, so 9 people and 18 connections. A limit of **32 TCP connections to 3478 per address** leaves that room and stops one address holding hundreds. It is the owner's to apply (P4C.8's Remaining).

## Privacy, safety and moderation (P4C.8)

### What a copy of the audio is worth: the keyless listener

[`web/voice/check/tap-server.ts`](../web/voice/check/tap-server.ts) is a test build of the voice service: `voice/server.ts` as it is, with a listener attached at the SFU that holds no key, as the server's operator could attach one. Through mediasoup's observers it makes a consumer on a `DirectTransport` of each Router for every producer, from the moment the producer exists, and keeps each packet's payload, its RTP sequence number and the header extensions it carries. Nothing bundles or deploys it; only [`tap.check.ts`](../web/voice/check/tap.check.ts) starts it, in `pnpm voice:check`. It replaces the prototype's listener (P4C.1).

In the check, three people in one engine talk through it: a alone (epoch 0), b arriving (1), c arriving (2), a leaving (3), each stage a second and a half or more. Then:

- **The listener got every frame.** It held each producer's packets from its start, before any listener could consume it, with no sequence number skipped, and at least as many as any person received from that producer.
- **Every frame is sealed, and nothing else.** Every payload it kept is an SFrame frame naming the producer's own leaf, under one of the room's four epochs, with room for a tag. Each packet carries the `mid` and transport-wide sequence number extensions, which the listener reads, and never the audio level.
- **Each person opens exactly their own epochs.** The check page keeps the non-extractable base keys its room was given (a wrapper round `FrameCrypto.addEpoch` in [`voice/check/room.ts`](../web/voice/check/room.ts); the site's pages keep nothing of the kind) and tries them on every frame the listener kept. a opens every frame of epochs 0 to 2 and none of epoch 3, said after it left; c opens every frame of epochs 2 and 3 and none of 0 and 1, said before it arrived; b opens all but epoch 0. So every frame the listener holds is a ciphertext under a key of the group, and someone who left, or arrived, holding a copy of everything, opens nothing outside the epochs they were in.
- **The copy holds no sound.** Three seconds of each person's frames under epoch 2 go through WebCodecs' Opus decoder twice: as the listener kept them, and as b opened them. Opened, they are the tone each person sent, standing 60 to 74 dB above the sound around it in Chromium and Firefox and 27 to 60 dB with WebKit's mock microphone. As kept, the decoder refused 0 to 6 of the 150 frames and made noise of the rest, in which the tone's frequency stood at most 3.1 dB above its surroundings (the check allows 10).

On this Mac, in Chromium, Firefox and WebKit, about ten seconds each. Each person sealed 40 to 170 frames under each epoch they were in.

### Voice reports and suspended speaking

- **The reason.** A report can say “Something said in voice” (`voice`; a Drizzle migration, `0001_voice_reports`, allows it; `rivermind/db` is gone, so there is no Alembic revision). The report form then says that voice is never recorded, so no audio goes with the report, and what several reports do. Reports also keep the reporter's address as a keyed hash (`addressTag`), never the address.
- **The rule** (`speakingDue` in [`safety.ts`](../web/src/lib/server/api/safety.ts)): voice reports against one guest from three different people, made at three different tables and from three different addresses, within a day. Reports without a table or an address do not count. A few friends at one table, or one person with several guests on one address, cannot silence anyone. The report that completes it suspends the guest's speaking for a day from then (`voice_suspensions`); a report that comes while three still count carries it on.
- **How it reaches the voice service.** The table server's signed seat lists (P4C.5) gain `silenced`: each person in voice whose speaking is suspended, with when it ends, in milliseconds. A suspension sends the lists of every table the guest sits at at once; later lists, a token's included, carry it while it lasts. A list from before P4C.8 has no `silenced`, and a voice service from before ignores it.
- **What the voice service does.** It refuses a suspended person's `produce` (`not-allowed`); when a list first names someone, it closes their producer and everyone's consumers of it, and sends their page `silenced` with the end. The welcome carries `silenced` too, for a page that joins while suspended. They stay in the room and the group, and hear everyone. When the time comes, or a later list no longer names them, their page hears `silenced` with `until: null` and sends again. In the browsers, the voice panel says why the microphone is off and until when, the “Live” mark goes, and screen readers are told.
- **Moderators** list suspensions with `pnpm moderation suspensions` and end one with `pnpm moderation lift PLAYER_ID`; a lifted guest speaks again when they next join voice, whose token sends a fresh list.

### Limits on joining and signalling

| Where | What | Limit |
| --- | --- | --- |
| Table server | Voice tokens per player | 10 at once, then one every 6 s |
| Table server | Voice tokens per address | 30 at once, then one every 2 s |
| Voice service | Hellos per player, however many tokens they hold | 20 at once, then one every 3 s |
| Voice service | Messages per socket (P4C.4), and per player across all their sockets | 60, then 20 a second; 120, then 40 a second |
| Voice service | New sockets per address, from Caddy's `X-Forwarded-For` | 30 at once, then one every 2 s |
| Voice service | Time to say hello | 10 s, then the socket is closed |
| Caddy | `voice` zone: `/api/tables/*/voice` and `/voice` | 30 a minute per address |

The voice service keys an address's limit by a keyed hash under a key made for the process, held in memory only, and logs only that it refused. A socket from this machine itself with no forwarded address (the checks, a development server passing `/voice` on) is not limited by address: the service listens on loopback alone, behind Caddy.

### The code the site serves

The encryption runs in JavaScript this site sends, so it is only as good as that code (the [threat model](#threat-model)). Every build now writes `voice-files.json` ([`scripts/voice-files.js`](../web/scripts/voice-files.js)): the SHA-256 of every file under `/_app/immutable/` that the release's pages run, with table voice's own first (`voice`: the chunks of `src/lib/voice/` and everything they import, the encoded-transform worker, and RNNoise's worklet and WebAssembly) and every other script, style and asset after (`page`), since any script on a page can reach its keys. The Node server serves it at `/voice-files.json` (the adapter's list of static files is fixed before it is written), and the fairness page links to it. `site.e2e.ts` fetches every file it names and checks each hash against the bytes served. What it does not cover: the HTML of each page, which the server renders, and whether a given build is reproducible byte for byte from the source, which nobody has checked yet.

### For the privacy page (P6.7)

Plain words for the privacy page to use, as they stand at P4C.8:

> **Table voice.** When you talk at a table, your browser encrypts your voice before it leaves your device, and only the people in voice at that table can decrypt it. The key changes each time someone joins or leaves, so people who leave cannot hear what is said after, and people who join cannot hear what was said before.
>
> **What we never keep.** Our voice server passes the encrypted audio between the people at the table. It cannot decrypt it. Nothing said in voice is recorded, transcribed or stored, by us or by this site's code in anyone's browser. A report of something said in voice carries no audio, because there is none.
>
> **What our voice server does see.** That you joined voice at a table, and when you left. Your IP address, which it needs to send you audio; it does not write it down. When you send audio and how much, but not what you say, and not how loud: your browser works out who is speaking after it decrypts. Whether you muted yourself or turned everyone off. Which players at the table blocked each other, so it never connects them. It forgets all of this when the table's voice ends.
>
> **What encryption cannot protect.** The people at the table hear you and could record you on their own devices. Voice is for adults (18+).
>
> **The code.** The encryption runs in code this site sends your browser, so you are trusting that code. Its source is public, and each release publishes the hash of every file its pages run, linked from the fairness page, so anyone can check that what we serve is what the source builds.
>
> **Reports.** When people at three different tables, on three different networks, report the same player for what they said in voice within a day, nobody hears that player in voice for the next day. They can still listen.

### Review of the voice service (for P7.5)

| Area | Found | Done |
| --- | --- | --- |
| Dependencies | `pnpm audit`: one moderate advisory, [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), in esbuild 0.18 under drizzle-kit's loader, a development tool that no release or service runs. GitHub's advisories name none for mediasoup 3.32.2 (the one there is, an SCTP cookie, is for 3.20.0 to 3.20.5, and voice opens no data channel), mediasoup-client 3.26.0, ts-mls 1.6.4, ws 8.23.0 (every `ws` advisory is fixed by 8.21.0) or `@sapphi-red/web-noise-suppressor` 0.4.1. | Accepted at P4C.9 (the owner left it to judgment): nothing a release runs holds it; leaves with drizzle-kit's next release |
| Tokens | HMAC-SHA256 under the voice key, compared in constant time, 60 s, once only, naming the public reference and never the player id (P4C.4). | Nothing to change |
| Origin | Exact match against `VOICE_ORIGINS`; a handshake with no `Origin` is refused. | Nothing to change |
| Limits | Each socket was limited; a player and an address were not, and a socket that never said hello stayed open as long as it answered pings. | Fixed (above) |
| The media port | mediasoup's worker answers ICE only for a transport's own credentials, but keeps a TCP connection to 3478 that never sends a byte open: one was still open after 90 s on this Mac. Anyone could hold many. The voice service cannot close them; the host's firewall can cap TCP connections to 3478 per address (two transports a person, a few people behind one address). | Fixed at [P4C.9](#the-launch-p4c9): a table of the site's own, `inet rivermind_voice`, refuses a 33rd TCP connection to 3478 from one address |
| The unit's sandbox | `systemd-analyze security` scores it 3.0, as the web unit. Not set: `SystemCallFilter=@system-service`, `ProtectProc=invisible`, `ProcSubset=pid`, `PrivateUsers=yes`, each of which could stop mediasoup's worker or Node and none of which has been tried there. | Fixed at [P4C.9](#the-launch-p4c9): all four are set, tried with calls through it; it scores 1.3 |
| `Permissions-Policy` | Pages send `microphone=(self)`; Caddy sent `microphone=()` on the live site. | Fixed at P4C.9: Caddy sends what the pages do |
| CSP | `'wasm-unsafe-eval'` is the one addition (Q-11); `/voice-files.json` goes out with the site's headers. | Nothing to change |

## The launch (P4C.9)

What turned voice on for the live site, and what was tried on the host first.

**What changed.** Three things, none of them in the code a page or a service runs:

- **The route.** Caddy sends `wss://rivermindpoker.com/voice` to the voice service's signalling port, 127.0.0.1:4323 ([`deploy/rivermindpoker.com.caddy`](../deploy/rivermindpoker.com.caddy)), matched by path alone, as `/ws` is, and kept open across a reload of Caddy's configuration (`stream_close_delay`). Nothing else of the voice service is routed: `/healthz` and `/seats` stay on loopback. The audio never passes through Caddy.
- **The switch.** The web unit sets `RIVERMIND_VOICE_OFFER=1`, so `GET /api/voice` answers `{"offered":true}` and a table with two people shows the voice card. Taking that line out and deploying takes voice off the site again; the voice service can stay.
- **The header.** Caddy sends `Permissions-Policy: camera=(), microphone=(self), geolocation=()`, as the Node server always has. Caddy's own value replaced the server's on the way out, so until this change the live pages were told `microphone=()`.

`deploy/smoke.sh` checks all three after a deploy: the header, `/api/voice`, and that a handshake on `/voice` from another origin gets the voice service's 403 (the Node server would drop it instead).

**The cap on TCP connections** (the review's first finding). mediasoup's worker keeps a TCP connection to 3478 open however long it stays silent, and the service cannot close it. [`deploy/voice-firewall.nft`](../deploy/voice-firewall.nft) is an nftables table of the site's own, `inet rivermind_voice`, with one rule for each address family: a new TCP connection to 3478 from an address that already holds 32 is reset (IPv6 is counted by /64). It hooks the input path ahead of `ufw`'s table and decides nothing else, so `ufw` still allows the port and still refuses everything it refused. The voice unit loads it before it starts (`ExecStartPre=+`, the one command that runs as root), so it is there after a reboot, and `update.sh` loads it when it changed. A candidate leaves the line out.

- The host sees real client addresses on 3478, the same as Caddy does on 443: a connection from this Mac through the router's public address arrived as that address, and a scanner's as its own. A cap by address would have been a cap on everyone had the Windows host's forwarding hidden them.
- 32 is P4C.7's sizing: a person in voice has two transports, most on UDP, and a full table behind one address needs 18 over TCP at the very worst.
- Tried on the host with 40 connections from one address: 32 were held, the 33rd and every one after got a reset, and the table counted 8 refusals. The address's entry left the set by itself once its connections closed.

**The stricter sandbox** (the review's second finding). The voice unit now also sets `SystemCallFilter=@system-service` (with `SystemCallErrorNumber=EPERM`), `ProtectProc=invisible`, `ProcSubset=pid` and `PrivateUsers=yes`; `systemd-analyze security` scores it 1.3, from 3.0. Each could have stopped mediasoup's worker or Node, so before it went into the unit a scratch copy of the live unit with all four ran on ubuntu-vm in the live service's place (no page could reach voice yet), on the real media port with the checks' own key and origin, and this Mac ran the room checks against it through an SSH tunnel:

- Two people talked, and a third joined and left, in Chromium, Firefox and WebKit, over `udp 71.215.196.157:3478`; Chromium told to avoid UDP talked over `tcp 71.215.196.157:3478`; a mute stopped a stream at the service; a forged token and another origin were refused. 14 checks passed, 4 skipped as they are at home (the Chromium-only ones in the other engines).
- Its media worker, killed with SIGKILL, was replaced inside the service under the same sandbox, and `/healthz` answered `ok` three seconds later.
- The firewall table loaded from the unit's `ExecStartPre=+` under those settings, twice.

The scratch unit, its key and its table were removed afterwards and the live unit started again. To try a new mediasoup or Node the same way: copy the live unit to `/run/systemd/system/` under another name with another signalling port, `VOICE_ORIGINS=http://127.0.0.1:4391`, a key derived from the checks' secret (`voice.js derive-key`) and `Restart=no`; stop the live unit while nobody is in voice (`/healthz` says `"people":0`), start the copy, and run `VOICE_REMOTE=1 pnpm voice:check room.check` through `ssh -N -L 4392:127.0.0.1:<port> root@ubuntu-vm`.

**The third finding**, the one moderate `pnpm audit` advisory in the esbuild under drizzle-kit's loader, is accepted as it stands: no release and no service runs that code, and the host's pinned versions move for every site at once.

**Checked on a deployed site.** `pnpm e2e:live` now puts guests in voice ([`voice.live.ts`](../web/e2e/voice.live.ts)), through the site's own `/voice` and the voice service's public media port: two at a private table, at desktop size and at a phone's, join with fake microphones, see one voice code on both screens, hear each other, mute and unmute, and leave; and three people, in Chromium, Firefox and WebKit at a phone's size, share one table, each hearing every speaker, and the two who stay move to a new code together when the third leaves. On a Mac the Chromium person is refused the microphone and listens (its fake microphone does not work there). A site that does not offer voice skips both.

**On the live site** (2026-11-22, release `20261122T194132Z-bcbf4c9290b2`, from this Mac inside the home network; every figure below went through the router's public address, 71.215.196.157, over UDP):

- `pnpm e2e:live` passed 21 with 3 skipped (the two restart tests, and the three-engine table in its second project): the two-guest voice check in Chromium at 1440 × 900 with a Firefox speaker, and in WebKit at 375 × 812 with both speaking, and the three-engine table. The voice service logged the three rooms and nothing else of them: opened, the joins and leaves, closed.
- **Three people at one table, one of them Safari.** A Firefox speaker and a Chromium listener (Playwright, at desktop size) sat at a private six-seat table, and Safari 27.2 on a simulated iPhone 17 Pro (iOS 27.2) opened their invite link, took a seat and chose “Join voice”. Safari asked for the microphone only then. All three screens showed the same four words, in the panel and in each page's own account of its group; Safari showed the Firefox speaker's ring, its own microphone as live, and the listener's headphones. In Safari, mute by the bar's button showed on its own seat and on the Firefox person's screen; deafen turned the playback off and the microphone with it; and leaving the table moved the two who stayed to new words together. The voice service counted `"rooms":1,"people":3` while it lasted.
- **Hidden and shown again, in Safari.** With the home button pressed for twenty seconds, the Safari person stayed in the room and the group kept its words. Back in front, the panel said the browser was holding the sound back, with “Turn on sound”, and that the microphone had stopped and was being tried again; Safari asked for the microphone once more, and with that allowed and the button tapped, both were back. A line saying the browser had paused the sound stayed on screen after the sound had come back, and now goes with it.
- **What each browser measured** over a minute at one table (a script reading every peer connection's own statistics, three people, two of them talking): a round trip of 0 to 3.5 ms to the media server, 1 to 7 ms of jitter, and no packet lost of about 2,900 a stream. Firefox held 34 to 38 ms in its jitter buffer and concealed nothing until the last seconds (0.09% over the minute); Chromium held 38 to 42 ms for the Firefox speaker and 25 ms in its own loopback, and concealed 0.3%, all of it in its first ten seconds. So on the home network the live path adds about a millisecond to [P4C.7's figures](#delay), which stand as they are: within 150 ms for Firefox and 170 to 189 ms for Chromium with everything on. Playwright's WebKit held 380 to 590 ms and cannot be read for this, as before; a real Safari's delay needs a real device.
- **The check page in Safari** (`http://127.0.0.1:4391/?run`, which the Simulator shares with this Mac): all 289 header vectors and the frame vector with no failure, the base key not extractable, the worker loaded under the site's policy, and sealing and opening at 27 and 63 µs a frame in a nine-person room, 2.6% of a core, at a load of 9 to 13 (a first run at a load of 700 read 571 and 935 µs, which says nothing of Safari). A call with a tone sealed 275 frames and opened 275, refused none and concealed nothing, and the listener's analyser read 0.177, a tone of 0.25 as it was made. A call through the microphone connected and sent no frame at all: the Simulator's microphone delivered no audio on this Mac, which is why the page has the tone.

**What a session without a phone could not check**, and where it went (P7.1b in BUILD.md): a real iPhone and an Android phone, on their own microphones and speakers; a second network, a mobile one above all, and with it the path from outside the home network and the delay between two networks; a network that allows only TCP 443, which decides whether a TURN server on 443 is needed; the worker's and RNNoise's cost on a phone; echo with and without Chromium's loopback (`rivermind.voice.direct`); and the stranger warning seen on a screen.

**Found on the way, and fixed.**

- **The invitation was unreadable and a screen down.** “You are invited” was written in ink on the gold frame's dark panel, since some earlier restyling, and stood below practice and the wallet, so someone who followed a friend's link on a phone saw the ordinary lobby. No browser test had looked at its colours and the screenshot scenes never showed it; Safari on a phone's screen did. It is first on the page now, in the panel's own colours, and `lobby.e2e.ts` checks both.
- **“Away”, for about 20 ms, at your own seat.** A rejoining player's first view was sent before they were marked connected, and their hand log opened with their own “reconnected”. They are marked first now. The recorded table session changed in one step: the joiner gets one message where it got two.
- **A table closed mid-hand kept the pot.** `Tables.close` paid back stacks and not what had gone into the hand under way. It now pays back both. Only a close by hand can meet a hand in progress, since a table with one never sits idle.

## Real phones, a second network and the stranger warning (P7.1b)

What only real devices can show, gathered from P4C.2a, P4C.6 and P4C.9 under D-16. On 2026-11-24 the owner chose to test the phones and the networks on their own, after the session, rather than in a session guided step by step. So this section has two parts: what was done without a phone, and how to test what is left.

### The warning for someone in the group who is not seated

P4C.3's check: when a page's copy of the group holds someone its table does not show seated, the page holds its microphone and says why. No browser test could bring that about before, because an honest service and honest pages remove a departed person within a second. Now one can, with nothing in the site or the service changed for it ([`e2e/stranger.ts`](../web/e2e/stranger.ts)). It rests on the group's own rule for removals: when the service proposes one, the member with the lowest leaf commits it at once and each member after it a second later (`COMMIT_TURN_MS`). So members that hang ahead of you keep someone who left. The pages hang for real: their scripts are paused in Chromium's debugger.

1. A host and the others who will hang sit at a private table and listen in voice. A ghost listens too, and all of them share one group.
2. All of them hang except the ghost, who then leaves the table. The service takes the ghost out of the room and proposes its removal, but nobody awake is left to commit it, so its leaf stays in the group.
3. An observer sits down and joins voice. Its group holds the ghost, whom its table never showed seated, so its microphone is held at once. Its own turn to commit the removal comes as many seconds after it joined as there are hung members, and then it talks.

**On the live site** (`713f093`, release `20261124T020259Z-713f093c5c64`, on 2026-11-24 at 14:49 to 14:56 local time; [`e2e/stranger.tool.ts`](../web/e2e/stranger.tool.ts), run by hand with `pnpm exec playwright test --config playwright.voice-stranger.config.ts`): six hung Chromium members, and an observer in Firefox at 1440 × 900 with its fake microphone, all from this Mac through the public site, `/voice` and the media port. In each of three runs the observer joined the group 1.4 to 1.8 s after its click on “Join voice”. Its microphone was held from then until 7.6 to 8.2 s, when it had removed the ghost on its own turn, and then it sent. While held, nothing on its page read as live. With its panel open, the warning stood in it the whole time, in the alert's own words: “Someone who is not seated at this table is in the voice group. Your microphone is off until they are gone.” The screenshots are in `artifacts/voice-stranger/`, outside Git.

**What was found.** The panel closes itself once someone has joined, and the warning is only in the panel. In the first two runs the panel stayed closed, and the observer's screen showed only a crossed-out microphone on the bar's Mute button and on its own seat, as if they had muted themselves, with nothing to say why. A person would press Mute to unmute and find it did nothing. Now the panel opens by itself when the warning starts, as it does when the microphone is refused (`TableVoice`'s `#epoch`), and it stays open until the person closes it. `voice.e2e.ts` checks this against its own voice service, in the desktop Chromium project, with four members hung. Nothing there opens the panel, so the check fails without the change: in that run the microphone was held for four seconds with no warning on screen, as on the live site. The live site gets the change at its next deploy.

### What is left for real devices, and how to test it

Each check below is one criterion of P7.1b in BUILD.md. None needs a change to the site.

**Reading a page's own figures on a phone.** Plug the phone into this Mac. For an iPhone, turn on Settings → Apps → Safari → Advanced → Web Inspector, and in Safari on the Mac, Settings → Advanced → “Show features for web developers”; the phone's page is then under Develop. For an Android phone, turn on Developer options (tap Build number seven times) and USB debugging, and open `chrome://inspect` in Chrome on the Mac. In that page's console:

- `rivermindVoice()` is the table's own account of voice: the phase, the four words, whether the microphone sends (`live`), the connection's quality, how the mix is played (`loopback`, `direct` or `elements`), whether RNNoise runs, and each person heard, with their gain and pan. It holds no key, and no audio.
- The connection's statistics and the transform's tallies are not kept anywhere the console can reach. Paste this before “Join voice”, or after “Leave voice” and before joining again, so that it sees the next session's connections and worker:

  ```js
  const pcs = new Set(), workers = new Set();
  const sld = RTCPeerConnection.prototype.setLocalDescription;
  RTCPeerConnection.prototype.setLocalDescription = function (...a) { pcs.add(this); return sld.apply(this, a); };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...a) { workers.add(this); return post.apply(this, a); };
  ```

  It only notes which connections and which worker the page makes, never what it sends them. After a minute in voice, this prints the path each connection took, what was concealed and the jitter buffer:

  ```js
  for (const pc of pcs) {
    const stats = await pc.getStats();
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        const local = stats.get(s.localCandidateId);
        console.log('path', local?.protocol, local?.candidateType, local?.networkType ?? '', 'round trip ms', Math.round(1000 * (s.currentRoundTripTime ?? 0)));
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.totalSamplesReceived)
        console.log('heard: concealed %', (100 * s.concealedSamples / s.totalSamplesReceived).toFixed(2), 'jitter buffer ms', Math.round(1000 * s.jitterBufferDelay / s.jitterBufferEmittedCount));
      if (s.type === 'outbound-rtp' && s.kind === 'audio') console.log('sent kB', Math.round(s.bytesSent / 1000));
    }
  }
  ```

  And this asks the worker for its tallies, which hold counts and times only (`FrameCrypto` ignores an answer it did not ask for):

  ```js
  const worker = [...workers].at(-1);
  const tallies = await new Promise((done) => {
    const on = (e) => { if (e.data?.id === 424242) { worker.removeEventListener('message', on); done(e.data.tallies); } };
    worker.addEventListener('message', on);
    post.call(worker, { type: 'tallies', id: 424242 });
  });
  console.table(tallies.map((t) => ({ direction: t.direction, frames: t.frames, usPerFrame: Math.round(1000 * t.ms / Math.max(1, t.frames)), slowestMs: t.slowestMs, ...t.refused })));
  ```

  In Chromium the playback loopback's two connections are among `pcs` too. Their path is a host candidate on the phone itself.

**1. Three people across two networks.** An iPhone in Safari, an Android phone in Chrome and a desktop browser, at one private table, with one phone on its mobile network and Wi-Fi off. Each talks and is heard by the others, the four words match on every screen, and each control works by touch: Mute, Deafen, push-to-talk (in the voice settings), a player's “Mute voice” and volume from their seat, and “Leave voice”. The path line says whether the media port was reached over UDP or TCP from outside the home network (Q-9). If a network cannot connect, the table says the network may block the port voice uses. From that network, `nc -vz rivermindpoker.com 3478` tells whether TCP 3478 is blocked too. A network that lets only TCP 443 through is the one that would need a TURN server on 443.

**2. Delay between the two networks.** The marked-tone measure (`pnpm voice:measure delay`) needs both ends' clocks on one machine, which two phones are not. Across real devices, time the sound itself instead. Put the speaking phone and the listening phone side by side by this Mac. Record with this Mac's microphone (`sox -d -r 48000 -c 1 delay.wav trim 0 120`) while short sharp syllables (“ta”) are spoken near the speaking phone, about every two seconds. Each one is then in the recording twice: once from the air, and once from the listening phone's speaker. The gap between the two onsets is mouth to ear, the phones' own microphone and speaker included, which P4C.7's figures leave out. Its error is a few milliseconds: the onset picked to within a frame of audio, and about 3 ms for each metre between the sources and the Mac. Fifty syllables give a 95th percentile. Do it both ways, so that Safari's own figure is the iPhone as listener, and note concealment from the statistics above and which network each phone used. The target is a 95th percentile under 250 ms.

**3. On each phone.** The transform's cost per frame is `usPerFrame` in the tallies, against [this Mac's](#frame-encryption-as-built-p4c2) and the Simulator's Safari (27 and 63 µs in a room of nine, [the launch](#the-launch-p4c9)). RNNoise's CPU is the difference in the page's CPU with “Stronger noise suppression” on and off in the same call: Safari's Timelines → CPU, or the AudioWorklet thread in Chrome's Performance panel. Compare it with 0.5 to 1.1% of a core on this Mac. For a page hidden and shown again, switch to the home screen for twenty seconds and come back: the page should stay in voice, or say why not and offer one tap to bring the sound and the microphone back. For echo without the loopback, run `localStorage.setItem('rivermind.voice.direct', '1')` in Chrome's console, leave voice and join again (`rivermindVoice().output` then reads `direct`), and talk with the speakers on. If the far side does not hear itself, Chrome cancels echo without the loopback on that device, which would take about 53 ms off Chromium's delay. Changing the default is the owner's decision. `localStorage.removeItem('rivermind.voice.direct')` puts it back.

## Voice in the app: the design check (P5D.9)

P5D.9 chooses how the iPhone app does table voice under D-15, by building and measuring two candidates against a local voice service and a browser peer: **(a) native**, WebRTC's framework with `libmediasoupclient`, SFrame in Swift and an MLS library that interoperates with ts-mls; and **(b) the site's own voice code** (mediasoup-client, ts-mls, `sframe.ts` and its worker) in a web view, with native controls over a message bridge. It is not decided yet: (b) is built and measured, and of (a) only SFrame so far. This section is kept as the check goes on.

**How (b) is checked.** A debug build launched with `RIVERMIND_VOICE_CHECK` set to a voice check page opens that page in a `WKWebView` and nothing else ([`VoiceCheckView.swift`](../ios/RiverMind/VoiceCheckView.swift); a release build has none of it). The pages run unattended: `/?run&call=tone` runs the vectors, the key check, the cost and a call, and `room.html#join=…` joins a table's room and posts its report every two seconds to the check server, which keeps them for `GET /results`. `pnpm voice:app` ([`app.tool.ts`](../web/voice/check/app.tool.ts), run by hand with `VOICE_APP_DEVICE` naming a booted simulator with the debug build installed) puts a person in Chromium and the app in one room, checks that each hears the other, samples the web view's processes for a minute, then puts the Settings app in front for twenty seconds and brings the app back; what it finds goes to `artifacts/voice-app/`. `RIVERMIND_VOICE_CHECK_ROOT` serves the pages from the app's own files through a `WKURLSchemeHandler` (`rivermind-check://app/`), as bundled voice code would be served.

**What (b) measured** (2026-11-28, the iOS 27.2 Simulator on this Mac, an iPhone 17 simulator of its own, load 2 to 30; eight runs):

| | Result |
| --- | --- |
| The engine | `RTCRtpScriptTransform`, workers, WebCrypto's Ed25519 and X25519 (ts-mls ran), `AudioContext` and WebAssembly are all there. mediasoup-client chose its `Safari12` handler. |
| SFrame's vectors in the web view | All 289 headers and the 0x0004 frame, from the check server and from the app's own files over the custom scheme alike. A seal costs 10 µs and an open 10 µs on a quiet machine (89 and 357 µs at a load near 30). |
| The app and Chromium in one room | Heard each other in every run, a tone each way, on one epoch with one voice code and the seat check passing, in 6 to 9 s from launch. Every frame was sealed and opened: no frame `unsent`, none refused, in either direction, over a minute (about 3,300 frames each way); the app's page concealed nothing. |
| A frame sent unsealed | The same `KeyStore` and worker as the site, so no path the site lacks. |
| `ssrc-audio-level` | Not negotiated: the service refuses a producer that names it, and the app's producer was accepted. |
| Cost, over a minute of talk | The web view's processes: WebContent 7.4 to 8.6% of one of this Mac's cores, GPU 0.5 to 1.7%, Networking 1.9 to 2.3%; the app itself 0 to 0.1%. Resident memory: the app 320 to 338 MB, WebContent 204 to 243 MB, GPU 128 to 161 MB, Networking 122 to 147 MB. A Simulator's figures, not a phone's: battery waits for a real iPhone (P5D.16). |
| The audio session | The app's own, `playAndRecord` in `voiceChat` mode to the speaker, stayed as the app set it through capture, the background and the return: WebKit did not change it in the app's process. |
| A web view in no window | Never ran: the page posted nothing in two runs. In the window as a transparent point it ran as a shown one does, so a hidden engine is a one-point view in the window. |
| **The background (Q-16)** | **Fails.** With the `audio` background mode and an active session, the moment the app went to the background the page's `AudioContext` became `interrupted` and the browser received nothing from it (0 packets a second, against 48 to 50 in front). With the microphone, WebKit **ended** the capture track (`readyState` `ended`): it stayed ended after the return, so the person was silent until the page captured again. What the app heard stopped too: its page decoded 19,000 samples a second over the twenty seconds, where playing all the time would be 48,000. The page's script went on running. |
| The app's added size | The check pages' whole bundle is 1.2 MB, RNNoise's WebAssembly included; the voice code alone is less. |
| Licenses | Nothing beyond what the site already ships and records. |
| Bundled code | Pages from the app's files over a custom scheme are a secure context there (WebCrypto ran). A page's origin is then the scheme's, which the voice service's origin check (`VOICE_ORIGINS`) would have to allow. A `file://` page could not post its results to a relative address, so it was not measured further. |

**What (a) has so far.** [`SFrame.swift`](../ios/RiverMindKit/Sources/RiverMindKit/Voice/SFrame.swift) in RiverMindKit is the RFC's part of `sframe.ts` on CryptoKit: the header, the key and salt, the nonce, sealing and opening, and the site's key id layout. `SFrameTests` holds it to the same `sframe-vectors.json` the TypeScript is held to: all 289 headers and the 0x0004 vector with every value in between, so a frame either side seals the other opens. A seal costs about 5 µs and an open 4 µs in a debug build on this Mac. Unlike WebCrypto, CryptoKit keeps a key as bytes the process can read; a native client would keep each epoch's key only in its key store.

**Still to measure for (a)**, each needing a download the owner approves first:

- **WebRTC for iOS with `libmediasoupclient`.** The frame encryptor and decryptor (`SetFrameEncryptor`, `SetFrameDecryptor`) are on WebRTC's C++ `RtpSenderInterface` and `RtpReceiverInterface`, which `libmediasoupclient` hands back for each producer and consumer, so they are reached through a C++ bridge rather than the Objective-C SDK. That needs a WebRTC build whose headers match `libmediasoupclient`'s, either a prebuilt framework that ships both or a build of WebRTC from source (a checkout of tens of gigabytes and hours of compiling).
- **MLS.** No Swift MLS library is mature; the likely choice is Rust's `mls-rs` (Apache 2.0 or MIT) through its Swift bindings, built for the iOS targets, which needs Rust's iOS targets and the crates. It must interoperate with ts-mls on ciphersuite 0x0001 for external commits, the external sender's removals and the exporter, proven by the working group's vectors and by a group shared with ts-mls.
- Then the same measurements as (b): a room with a browser, delay by `pnpm voice:measure`'s method, cost, the audio session and interruptions, the background, size and licenses.

**Where it leans.** (b) passes everything measured but the background, which Q-16 asks for and a call app is expected to do; WebKit stops a page's capture and audio when the app leaves the screen, by design. Native WebRTC with the `audio` background mode keeps a call going, as call apps do, so (a) is the likely choice if its pieces interoperate. The decision is recorded here once (a) is measured.

**The code the app runs.** For whichever is chosen, the threat model's point about [the code the site serves](#the-code-the-site-serves) becomes, for the app, the App Store build of a tagged commit: the app's voice code is what that commit holds, which anyone can build and compare, and it cannot change between App Store releases. With (b) the bundled pages would be the app's own files, never fetched from the site.

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
- **MLS:** the MLS working group’s interoperability vectors against ts-mls ([above](#the-working-groups-test-vectors-p4c3)), then joins, leaves, removals, simultaneous commits and restarts in Vitest with the voice service’s delivery rules.
- **Browsers:** Playwright in Chromium, Firefox and WebKit, each person a browser context sending known audio. What each engine needs under Playwright 1.65 on macOS, found at P4C.1 (`web/voice/prototype/browsers.ts`):
  - **Firefox** takes `media.navigator.streams.fake` and `media.navigator.permission.disabled`, and its fake microphone works. Every context can capture at once. With no sound device, as in CI, `AudioContext.resume()` never settles, so a Firefox check that must run there makes no AudioContext and reads WebRTC’s statistics. Between two Firefox pages connected directly, a receiver’s transform is also handed the peer’s padding as frames with no bytes.
  - **Chromium** takes `--use-fake-device-for-media-stream`, but on macOS its fake microphone did not work: `getUserMedia` never settles with `--use-fake-ui-for-media-stream`, and a granted permission without that switch gets `NotSupportedError`, in the headless shell and in the full browser. A tone made by Web Audio stands in, which takes the same road from the Opus encoder on. On Linux the fake device works (P4C.2), so `canCapture` in `web/voice/check/browsers.ts` chooses by platform.
  - **WebKit** has a mock microphone once a context is given the `microphone` permission. It finishes gathering ICE candidates only on a page that has captured, so a person who only listens cannot connect there. An `AudioContext` stops rendering about half a second after capture starts, while still saying `running`, so nothing built on Web Audio (volume, the speaking ring, spatial audio) can be checked there. Only one page of a browser captures at a time, so each person needs a browser of their own. Whether Safari itself shares any of these is for a real iPhone and Mac to say (P4C.9). Playwright’s WebKit on Linux, which CI uses, is a different WebRTC build with no `RTCRtpScriptTransform` (`canTransform`): the checks that need a call are skipped there by name, and the macOS build covers them when `pnpm voice:check` is run on a Mac.
  - Firefox’s ICE fails against a media address on loopback alone, which Chromium and WebKit connect to; a test service also listens on the LAN address.
  - Without Web Audio, judge what a page hears by `inbound-rtp` statistics (`totalAudioEnergy`, `concealedSamples`). Chromium counts no energy for a track whose only output is a muted element, so there the analyser is the measure.
- **The voice service:** Vitest drives it with a real mediasoup worker and real MLS members over the wire (`service.spec.ts`), and `pnpm voice:check` puts people in each engine in a room on it (`room.check.ts`), through the site's own `VoiceRoom`, with media over UDP and, for Chromium told to avoid UDP, TCP.
- **The encryption itself:** a test build of the voice service with a listener attached at the SFU, holding no key, receives every forwarded frame and cannot decode them, while members decode the injected tone, and someone who left or arrived opens nothing outside their epochs (`tap.check.ts`, [P4C.8](#what-a-copy-of-the-audio-is-worth-the-keyless-listener)).
- **Someone in the group who is not seated:** `voice.e2e.ts` brings it about with members that really hang, paused in Chromium's debugger ([`e2e/stranger.ts`](../web/e2e/stranger.ts), P7.1b), and checks that the panel says so with the microphone held; `e2e/stranger.tool.ts` does the same on a deployed site, by hand.
- **Recovery:** `recovery.check.ts` in `pnpm voice:check` kills a service's media worker under four people, takes the network away with a relay and brings back another, has someone join and leave through a network that loses and delays packets, blocks all audio, and fills a service ([P4C.7](#recovery)).
- **Latency and loss:** `pnpm voice:measure`, by hand on a quiet machine: mouth-to-ear delay with a marked tone timed on each page's audio thread, with `getStats` jitter-buffer and round-trip figures, and speech through packet loss and jitter from a relay or from `tc netem` on Linux ([P4C.7](#audio-quality-resilience-and-capacity-p4c7)). Playwright's WebKit can take no part in the marks, and its mock microphone delivers audio in bursts, which fills every listener's jitter buffer: never judge a listener's delay by a WebKit speaker there.

## Sources

- [RFC 9605, SFrame](https://www.rfc-editor.org/rfc/rfc9605.html), sections 4.5 (cipher suites), 5.2 (MLS), 7 and 9 (what the header reveals) and appendix C (test vectors).
- [RFC 9420, MLS](https://www.rfc-editor.org/rfc/rfc9420.html).
- [Discord’s DAVE protocol](https://daveprotocol.com/) and its [announcement](https://discord.com/blog/meet-dave-e2ee-for-audio-video).
- [mediasoup v3 documentation](https://mediasoup.org/documentation/v3/) and the [mediasoup-client API](https://github.com/versatica/mediasoup-client).
- [ts-mls](https://www.npmjs.com/package/ts-mls) and its README’s note that it has not been audited.
- [MDN, Using WebRTC Encoded Transforms](https://developer.mozilla.org/docs/Web/API/WebRTC_API/Using_Encoded_Transforms) and [Chrome 141 release notes](https://developer.chrome.com/release-notes/141) (Encoded Transform V2).
- [LiveKit encryption](https://docs.livekit.io/transport/encryption/), for comparison.
