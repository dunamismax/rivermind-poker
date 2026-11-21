# Table voice design

This is the design for live voice at the table (Phase 4C, D-15). It records what voice must do, the threat model, the tools chosen and the ones rejected, how keys are agreed and media is encrypted, and what the host has to provide. [BUILD.md](../BUILD.md#phase-4c--table-voice) holds the steps and their evidence. P4C.1 checks this design with a working prototype and corrects it where it was wrong.

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
- **The SFU.** [mediasoup](https://mediasoup.org/) 3 (npm `mediasoup`, 3.32 at the time of writing, Node 22 or later) is a selective forwarding unit with a TypeScript API and a C++ media worker shipped through npm. Each table’s voice room is one mediasoup Router. One `WebRtcServer` per worker listens on a single UDP and TCP port (ICE-lite), so the host needs one forwarded port, not a range. The browser uses `mediasoup-client` (3.26). The worker binary is fetched or built by mediasoup’s install script, so `web/pnpm-workspace.yaml` must list `mediasoup` under `allowBuilds`, as it does `esbuild`.
- **Why forwarding, not a mesh.** In a mesh every player connects to every other player, which hands each player everyone else’s IP address, makes a phone upload eight copies of its audio, and leaves the server nothing to stop when you mute someone. The SFU hides addresses from players, each phone uploads once, and a mute stops the audio at the server.
- **Authorisation.** The table server issues a voice token (HMAC-SHA256 with the site secret: table, player, seat, expiry within 60 seconds). The voice service accepts only valid tokens and asks the table server who is seated whenever seats change. Standing up, being moved, a table closing or a block ends that person’s place in the room.

## Encryption

Two layers, with a standard for each.

1. **Hop by hop:** WebRTC’s DTLS-SRTP between each browser and the SFU.
2. **End to end:** [SFrame](https://www.rfc-editor.org/rfc/rfc9605.html) (RFC 9605) encrypts every Opus frame in the sender’s browser and decrypts it in each listener’s. The keys come from an [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) group (RFC 9420) made of the people in the room.

This is the design Discord adopted for its own end-to-end encrypted voice ([DAVE](https://daveprotocol.com/)): MLS for the group key, a key per sender, WebRTC encoded transforms to encrypt frames, and a comparable code to verify the group.

**Frames.** The browser hands each encoded Opus frame to an `RTCRtpScriptTransform` running in a dedicated worker. All three engines support it: Safari from 15.4, Firefox from 117, Chrome from 141 (Baseline 2025). No browser ships SFrame natively, so `web/src/lib/voice/sframe.ts` implements it in TypeScript over WebCrypto, with cipher suite `AES_128_GCM_SHA256_128` (0x0004), and must reproduce RFC 9605’s test vectors byte for byte. The full-size tag adds about 19 bytes a frame, roughly 8 kbps at 20 ms frames. The worker is a bundled same-origin file: the CSP allows it under `script-src 'self'`, and it would block a `blob:` worker.

**Group key.** [ts-mls](https://www.npmjs.com/package/ts-mls) (1.6 at the time of writing) is a TypeScript MLS implementation. It has not had a formal audit, so P4C.3 runs the MLS working group’s interoperability test vectors against it in CI, and P7.5 reviews how it is used. The ciphersuite is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001). Credentials are basic credentials naming the player’s public reference and seat, signed by a key made for that session; guests have no long-term identity (D-12).

- The first person to join voice creates the group. Later people join by **external commit** from the group info the voice service holds, so nobody already in the room has to be online and quick for someone new to join.
- The voice service is the group’s **external sender**: when someone leaves, it proposes their removal, and the remaining member with the lowest leaf index commits it. If that member is gone, the next one does.
- The voice service orders commits: it accepts the first valid commit for an epoch and refuses the rest, the usual MLS delivery-service rule. It cannot read or forge application keys.
- **SFrame keys from MLS** follow RFC 9605 section 5.2: for each epoch, `base_key = MLS-Exporter("SFrame 1.0 Base Key", "", AEAD.Nk)`, and the key ID packs the sender’s leaf index and the low bits of the epoch, `KID = (sender_index << E) + (epoch % (1 << E))`. A receiver drops an old epoch when a new one with the same low bits arrives. P4C.3 fixes `E` and `S`.
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
- **Upload bandwidth.** The SFU sends each speaker’s audio to every other person in the room. At 64 kbps plus SFrame, RTP and UDP overhead, each listener receives about 90 kbps per person speaking. A nine-seat table with everyone talking at once needs about 6.5 Mbps out of the host; with one or two people talking, as is usual, about 1.5 Mbps. P4C.7 measures the real uplink and sets a cap on concurrent voice rooms with headroom for the site, and the table says plainly when voice is full.
- **Networks that block UDP and the voice port.** ICE over TCP 3478 covers most. A network that allows only TCP 443 would need a TURN server on 443, which shares the port with Caddy. P4C.9 measures connection success across real networks before deciding whether that is needed.

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

- **SFrame:** RFC 9605 appendix C vectors, byte for byte, plus tampering, replay and wrong-epoch tests.
- **MLS:** the MLS working group’s interoperability vectors against ts-mls, then joins, leaves, removals, simultaneous commits and restarts in Vitest with the voice service’s delivery rules.
- **Browsers:** Playwright in Chromium, Firefox and WebKit with fake capture devices feeding known audio. Chromium takes `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture`; Firefox takes the `media.navigator.streams.fake` preference. Where a test build cannot capture, the live check on a real iPhone covers it.
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
