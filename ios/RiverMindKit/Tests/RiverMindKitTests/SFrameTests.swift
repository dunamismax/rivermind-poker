import CryptoKit
import Foundation
import Testing

@testable import RiverMindKit

/// RFC 9605's appendix C against `SFrame`: every header vector (C.1) and the
/// SFrame vector of cipher suite 0x0004 (C.3), with every value in between, from
/// the file the TypeScript is held to (`web/src/lib/voice/sframe-vectors.json`).
/// Its key ids and counters are hex strings, being 64-bit.
struct SFrameTests {
    struct Vectors: Decodable {
        struct HeaderVector: Decodable { let kid, ctr, header: String }
        struct FrameVector: Decodable {
            let cipher_suite, base_key, kid, ctr, sframe_key_label, sframe_salt_label, sframe_secret,
                sframe_key, sframe_salt, metadata, nonce, aad, pt, ct: String
        }
        let header: [HeaderVector]
        let sframe: [FrameVector]
    }

    static let vectors: Vectors = {
        let url = repository.appending(path: "web/src/lib/voice/sframe-vectors.json")
        return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }()

    static func hex(_ bytes: some Sequence<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
    static func unhex(_ text: String) -> [UInt8] {
        stride(from: 0, to: text.count, by: 2).map {
            let start = text.index(text.startIndex, offsetBy: $0)
            return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
        }
    }

    @Test func everyHeaderVector() {
        #expect(Self.vectors.header.count == 289)
        for vector in Self.vectors.header {
            let kid = UInt64(vector.kid, radix: 16)!
            let ctr = UInt64(vector.ctr, radix: 16)!
            #expect(Self.hex(SFrame.encodeHeader(kid: kid, ctr: ctr)) == vector.header, "kid \(vector.kid) ctr \(vector.ctr)")
            let decoded = SFrame.decodeHeader(Self.unhex(vector.header))
            #expect(decoded == SFrame.Header(kid: kid, ctr: ctr, length: vector.header.count / 2))
        }
    }

    @Test func theFrameVectorOfCipherSuite0x0004() throws {
        let frames = Self.vectors.sframe.filter { $0.cipher_suite == "0004" }
        #expect(frames.count == 1)
        for vector in frames {
            let kid = UInt64(vector.kid, radix: 16)!
            let ctr = UInt64(vector.ctr, radix: 16)!
            let baseKey = SymmetricKey(data: Self.unhex(vector.base_key))
            #expect(Self.hex(SFrame.label("key", kid: kid)) == vector.sframe_key_label)
            #expect(Self.hex(SFrame.label("salt", kid: kid)) == vector.sframe_salt_label)
            // HKDF-Extract("", base_key) is HMAC under a hash-length run of zeros.
            let secret = HMAC<SHA256>.authenticationCode(
                for: Self.unhex(vector.base_key), using: SymmetricKey(data: [UInt8](repeating: 0, count: 32)))
            #expect(Self.hex(secret) == vector.sframe_secret)
            let key = SFrame.frameKey(baseKey: baseKey, kid: kid)
            #expect(key.key.withUnsafeBytes { Self.hex($0) } == vector.sframe_key)
            #expect(Self.hex(key.salt) == vector.sframe_salt)
            #expect(Self.hex(SFrame.nonce(salt: key.salt, ctr: ctr)) == vector.nonce)
            #expect(Self.hex(SFrame.encodeHeader(kid: kid, ctr: ctr)) + vector.metadata == vector.aad)
            let metadata = Self.unhex(vector.metadata)
            let sealed = try SFrame.seal(key, ctr: ctr, Self.unhex(vector.pt), metadata: metadata)
            #expect(Self.hex(sealed) == vector.ct)
            let ciphertext = Self.unhex(vector.ct)
            let header = try #require(SFrame.decodeHeader(ciphertext))
            #expect(Self.hex(try SFrame.open(key, header: header, ciphertext, metadata: metadata)) == vector.pt)
        }
    }

    /// A frame that is not what a member sealed never opens: a changed byte of the
    /// header, the frame or the tag, or another key id's key.
    @Test func whatWasNotSealedDoesNotOpen() throws {
        let baseKey = SymmetricKey(size: .bits128)
        let kid = SFrame.kid(sender: 3, epoch: 17)
        let key = SFrame.frameKey(baseKey: baseKey, kid: kid)
        let sealed = try SFrame.seal(key, ctr: 41, Array(repeating: 7, count: 161))
        let header = try #require(SFrame.decodeHeader(sealed))
        #expect(try SFrame.open(key, header: header, sealed) == Array(repeating: 7, count: 161))
        for at in [0, header.length, sealed.count - 1] {
            var changed = sealed
            changed[at] ^= 1
            let changedHeader = SFrame.decodeHeader(changed) ?? header
            #expect(throws: (any Error).self) { try SFrame.open(key, header: changedHeader, changed) }
        }
        let other = SFrame.frameKey(baseKey: baseKey, kid: SFrame.kid(sender: 4, epoch: 17))
        #expect(throws: (any Error).self) { try SFrame.open(other, header: header, sealed) }
    }

    /// The site's key id layout (`kidOf` in sframe.ts): sender 3 at epoch 17 is
    /// (3 << 4) | 1.
    @Test func keyIdsAreTheSitesLayout() {
        #expect(SFrame.kid(sender: 3, epoch: 17) == 0x31)
        #expect(SFrame.kid(sender: 63, epoch: 15) == 0x3ff)
        #expect(SFrame.kid(sender: 0, epoch: 16) == 0)
    }

    /// What sealing and opening a 20 ms Opus frame at 64 kbps costs on this Mac,
    /// printed for docs/voice.md (P5D.9), as the page's bench does: 3,000 frames.
    @Test func cost() throws {
        let key = SFrame.frameKey(baseKey: SymmetricKey(size: .bits128), kid: SFrame.kid(sender: 1, epoch: 1))
        let frame = [UInt8](repeating: 0x5a, count: 161)
        let clock = ContinuousClock()
        var sealed: [[UInt8]] = []
        let sealing = try clock.measure { for ctr in 0..<3000 { sealed.append(try SFrame.seal(key, ctr: UInt64(ctr), frame)) } }
        let opening = try clock.measure {
            for one in sealed { _ = try SFrame.open(key, header: SFrame.decodeHeader(one)!, one) }
        }
        let micros = { (d: Duration) in Double(d.components.attoseconds) / 1e12 / 3000 + Double(d.components.seconds) * 1e6 / 3000 }
        print("SFRAME-COST seal \(micros(sealing)) µs, open \(micros(opening)) µs a frame")
        #expect(micros(sealing) < 1000)
    }
}
