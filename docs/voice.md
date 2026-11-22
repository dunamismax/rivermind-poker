# Table voice design

This is the design for live voice at the table (Phase 4C, D-15). It records what voice must do, the threat model, the tools chosen and the ones rejected, how keys are agreed and media is encrypted, and what the host has to provide. [BUILD.md](../BUILD.md#phase-4c--table-voice) holds the steps and their evidence. P4C.1 checked this design with a working prototype, and [what the prototype found](#what-the-prototype-found-p4c1) lists what it confirmed, what it corrected here and what it left for later steps. P4C.2 built the frame encryption, and [frame encryption as built](#frame-encryption-as-built-p4c2) says how it works, what it refuses and what it costs. P4C.3 built the group key, and [the group key as built](#the-group-key-as-built-p4c3) says the same of it. P4C.4 built the voice service, and [the voice service as built](#the-voice-service-as-built-p4c4) says what it does, what it refuses and how it runs on the host. P4C.6 put it in front of people: [voice at the table](#voice-at-the-table-as-a-person-sees-it-p4c6). P4C.8 checked what a copy of the audio is worth to the server and added reports, suspensions and limits: [privacy, safety and moderation](#privacy-safety-and-moderation-p4c8).

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

- **A phone.** The figures above are a laptop’s. `crypto.subtle` needs a secure context, so a phone cannot load the check page from this Mac over the LAN; it is measured when a build a phone can load over HTTPS exists (P4C.2a).
- **Safari itself.** Playwright’s WebKit is not Safari. The check page runs by hand in any browser (`/?run`, and a button for a call through the microphone) and posts what it finds to the server that serves it; nobody has run it in Safari yet (P4C.2a).
- **CI’s own run.** The checks passed in Playwright’s Linux browsers in a container; GitHub’s runner has not run them yet (P4C.2a).

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
- **Timing over a real network.** The measurements are two pages on one machine. P4C.7 measures the skew between pages across the service, and whether the 250 ms wait and the 2 s grace fit it.
- **A member the service cannot hear from.** If nobody commits a removal, the leaf stays, and after three seconds every page holds. P4C.7’s recovery (a new group) is what ends that.

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
| `produce`, `producer.pause`, `producer.resume` | The page's one audio track. |
| `consume`, `consumer.pause`, `consumer.resume` | Another person's track, paused until the page resumes it. |

| Notice | When |
| --- | --- |
| `mls` | A commit the service accepted (to everyone but its author), or a removal it proposes (to everyone, the author and a newcomer included). |
| `producer` | Someone in the room sends audio, with the leaf it is sealed as. |
| `consumer.closed`, `left` | A stream ended; someone's socket closed. |
| `media.reset` | The media server started again under a new public address: make the transports again. The group stands. |

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

- A unit of its own, `rivermind-poker-voice`, running `build/voice/voice.js` of the current release on `/opt/node-26/bin/node` as a dynamic user, with the web unit's sandbox and `SocketBindAllow=` for its signalling port (TCP 4323 on loopback) and its media port (UDP and TCP 3478), and `SocketBindDeny=any`: on ubuntu-vm a process under those rules got EPERM binding any other port, TCP or UDP. Memory is the platform's 256 MB high and 512 MB most. The voice key comes as a credential from root-only `/var/lib/rivermind-poker/voice-key`, which `update.sh` derives from the session secret as a dynamic user (`voice.js derive-key`). `Restart=always`: a dead media worker stops the service, and systemd starts it again.
- `pnpm build` bundles the service into `build/voice/` on its own, with mediasoup's worker binary beside it, sharing nothing with the site's server, so `build/voice/` changes only when voice does. `update.sh` checks every release's voice service as a candidate before the switch (on loopback and free ports in 4400-4499, under the unit's sandbox: `/healthz`, and a socket from another origin refused), and after the switch restarts `rivermind-poker-voice` only if its unit, its key or `build/voice/` changed or it is not running. A deploy that does not touch voice leaves every conversation alone, and keeps the release the voice service runs from when it clears old ones.
- `ufw` allows UDP and TCP 3478, added by `update.sh` when it installs the unit (Q-9).
- Port 4322, which the plan named for signalling, belongs to fieldcadence.app on this host; the voice service takes 4323, the next free one in the host's table.

**Measured on ubuntu-vm.** The bundle built on the host ran there under a copy of the unit, on the real port and announcing the router's address, with a key from a test secret and the checks' origin (scratch files, removed afterwards). From this Mac, inside the home network, the room checks ran against it with signalling through an SSH tunnel: Chromium, Firefox and WebKit pages made and joined a group, talked, and took a join and a leave, with no frame refused. Chromium and Firefox reported their media on `udp 71.215.196.157:3478`, the router's public address, looped back by the router; Chromium told to use no UDP connected on `tcp 71.215.196.157:3478`. WebKit does not report addresses, and had no other candidate. After ten rooms the service held 46 MB (48 MB at most), and its journal held only counts, durations and `refused a token: forged`.

**Found on the way**

- **A transport's `id` and the request's.** The first draft spread a transport's description, which has an `id`, over its answer's envelope, and the transport's id replaced the request's: the page never heard back. The answer envelope now goes last, and the protocol names the transport `transport`.
- **mediasoup in an ES module bundle** looks for its own directory with `__dirname` when there is no `node_modules` to resolve it from, as in a release, and an ES module has none: the bundle failed on the host and ran on this Mac only because `web/node_modules` sat above it. The voice bundle defines `__dirname` and `__filename` from `import.meta` in a banner, and the worker binary is passed to mediasoup by path.

**Left for later steps**

- **From outside the home network.** Checked from inside it only, through the router's loopback; a phone on a mobile network is P4C.9's, or the owner's sooner.
- **Live.** The unit is installed and `ufw` opened by the first deploy that carries it, an owner gate; until P4C.9 adds the `/voice` route nothing reaches its signalling.
- **The table server's side** (P4C.5): `POST /api/tables/{id}/voice` issues tokens with `issueToken`, and the table tells the service when seats change.
- **Recovery** (P4C.7): a restart, a dead worker or a changed address now costs a room its transports or its group, and pages start again by hand; P4C.7 makes it automatic and measures it.
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

**When voice is offered.** To someone seated at a table where another person is too, not bust, never at a practice table, and only where the site offers it at all: `GET /api/voice` answers `{ "offered": true }` only with a voice service configured and `RIVERMIND_VOICE_OFFER=1`. That switch is off on the live site until P4C.9 gives Caddy the `/voice` route, so a deploy before then shows nobody a voice card that cannot connect. In development and the browser tests the Node server passes `/voice` on to the voice service itself (`RIVERMIND_VOICE_PROXY`), byte for byte; the live site never does that, since a deploy of the web server would then cut every conversation.

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
| The check's voice-like signal | Chromium, WebKit | 20.1 dB quieter | −4.5 dB | 20.7 ms | 0.7 to 1% |
| | Firefox | 12.5 to 20.1 dB quieter | −4.3 to −4.4 dB | 20.7 ms | 0.5% |
| Speech | Chromium, WebKit | 30.3 dB quieter | −0.1 dB | 20.7 ms | 0.7 to 1.1% |
| | Firefox | 24.8 to 29.3 dB quieter | −0.1 dB | 20.7 ms | 0.5% |

The delay is the lag at which the output best matches the input, 994 samples at 48 kHz in every engine and run. It is over P4C.6's target of 20 ms by 0.7 ms, and mostly fixed by design: the processor reads its ring buffer 640 samples (13.3 ms) behind where it writes, which is about the least a 10 ms frame allows when audio arrives in blocks of 128 samples (608 would do), and RNNoise's own analysis adds the rest. Firefox's spread in the room's figure follows where in the lead RNNoise started. Not measured yet: the comparison with the browser's own suppression, which needs the room played into a real capture path (Chromium on Linux takes a file as its fake microphone), and the cost on a phone.

**What the seats show.** A glyph by each person's stack (talking, muted, deafened, listening only, not in voice; drawn in `web/art/ui.pxl`) and a ring round the seat while they speak, measured in the listener's browser after decryption, never sent. The ring keeps still for reduced motion.

**Voice signalling v1, added to.** A page tells the room it muted itself or deafened with `status` `{ muted, deafened }`, and the service passes it on as a `peer` notice with the socket's whole `PeerInfo`, which now carries `muted` and `deafened`; the welcome lists them for everyone already there. A page sends `status` only to a service whose welcome says `statuses: true`, because a service from before would close a socket that sends a request it does not know. A page from before ignores the new notice and fields. A muted page also pauses its producer at the page and at the service, so its silence never depends on what it says of itself. Someone who only listens has no producer; a page learns of them from its own copy of the group, and of their status from the `peer` notice.

**Phones.** On a phone the bar keeps to one line in voice (the Voice button becomes its glyph, deafen moves to the panel), and the card and the panel open over the table from the bar and stop above the zone the action panel rises into, scrolling inside. Pages send `Permissions-Policy: camera=(), microphone=(self), geolocation=()`; Caddy still sends `microphone=()` on the live site until P4C.9 changes it.

**Checked.** `voice.e2e.ts`, in Chromium, Firefox and WebKit at desktop and phone sizes, against the built server with a voice service of its own: two people at a private three-seat table take the card, join, see the same voice code on screen and in the group, and Bob sees Alice's ring when she speaks; mute by key and button, deafen, push-to-talk by key and by holding the button, Bob's own mute of Alice and her volume at 200%, panning to her side and back to the middle with spatial audio off, the bitrate and echo cancellation changed mid-call, keys ignored in a text field, a reload that rejoins by itself with the remembered choice, and leaving voice. Where Chromium cannot capture (this Mac) its person is refused the microphone, told why, and listens to a Firefox speaker. A practice table and a table of bots offer nothing. No page broke the CSP.

**Left for later steps**

- **RNNoise against the browser's own suppression**, and its cost on a phone: P4C.6's last measurements (above).
- **A page hidden and shown again** resumes the context, starts a microphone the system stopped and says why when it cannot; that is checked by hand on a phone (P4C.9), since Playwright does not hide pages.
- **The warning for a stranger in the group** is P4C.3's check shown on screen, with no honest way to bring it about in a browser test.

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
| Dependencies | `pnpm audit`: one moderate advisory, [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), in esbuild 0.18 under drizzle-kit's loader, a development tool that no release or service runs. GitHub's advisories name none for mediasoup 3.32.2 (the one there is, an SCTP cookie, is for 3.20.0 to 3.20.5, and voice opens no data channel), mediasoup-client 3.26.0, ts-mls 1.6.4, ws 8.23.0 (every `ws` advisory is fixed by 8.21.0) or `@sapphi-red/web-noise-suppressor` 0.4.1. | Recorded; leaves with drizzle-kit's next release |
| Tokens | HMAC-SHA256 under the voice key, compared in constant time, 60 s, once only, naming the public reference and never the player id (P4C.4). | Nothing to change |
| Origin | Exact match against `VOICE_ORIGINS`; a handshake with no `Origin` is refused. | Nothing to change |
| Limits | Each socket was limited; a player and an address were not, and a socket that never said hello stayed open as long as it answered pings. | Fixed (above) |
| The media port | mediasoup's worker answers ICE only for a transport's own credentials, but keeps a TCP connection to 3478 that never sends a byte open: one was still open after 90 s on this Mac. Anyone could hold many. The voice service cannot close them; the host's firewall can cap TCP connections to 3478 per address (two transports a person, a few people behind one address). | Open, for the owner: a per-address cap on TCP 3478 in `ufw` or nftables on ubuntu-vm, sized with P4C.7's capacity work |
| The unit's sandbox | `systemd-analyze security` scores it 3.0, as the web unit. Not set: `SystemCallFilter=@system-service`, `ProtectProc=invisible`, `ProcSubset=pid`, `PrivateUsers=yes`, each of which could stop mediasoup's worker or Node and none of which has been tried there. | Open, for the owner: try them under `update.sh voice-candidate` with a room through it at P4C.9's deploy |
| `Permissions-Policy` | Pages send `microphone=(self)`; Caddy still sends `microphone=()` on the live site. | P4C.9 changes Caddy's |
| CSP | `'wasm-unsafe-eval'` is the one addition (Q-11); `/voice-files.json` goes out with the site's headers. | Nothing to change |

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
- **Latency and loss:** mouth-to-ear delay measured with a marked tone, `getStats` jitter-buffer and round-trip figures, and packet loss and jitter added with `tc netem` on Linux.

## Sources

- [RFC 9605, SFrame](https://www.rfc-editor.org/rfc/rfc9605.html), sections 4.5 (cipher suites), 5.2 (MLS), 7 and 9 (what the header reveals) and appendix C (test vectors).
- [RFC 9420, MLS](https://www.rfc-editor.org/rfc/rfc9420.html).
- [Discord’s DAVE protocol](https://daveprotocol.com/) and its [announcement](https://discord.com/blog/meet-dave-e2ee-for-audio-video).
- [mediasoup v3 documentation](https://mediasoup.org/documentation/v3/) and the [mediasoup-client API](https://github.com/versatica/mediasoup-client).
- [ts-mls](https://www.npmjs.com/package/ts-mls) and its README’s note that it has not been audited.
- [MDN, Using WebRTC Encoded Transforms](https://developer.mozilla.org/docs/Web/API/WebRTC_API/Using_Encoded_Transforms) and [Chrome 141 release notes](https://developer.chrome.com/release-notes/141) (Encoded Transform V2).
- [LiveKit encryption](https://docs.livekit.io/transport/encryption/), for comparison.
