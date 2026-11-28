import CryptoKit
import Foundation

/// SFrame (RFC 9605) in Swift, for voice's design check (P5D.9, candidate (a)):
/// the RFC's part of `web/src/lib/voice/sframe.ts`, the header (4.3), the key and
/// salt (4.4.2), the nonce and the sealed frame (4.4.3, 4.4.4) and key ids made of an
/// MLS sender and epoch (5.2), for cipher suite AES_128_GCM_SHA256_128 (0x0004) on
/// CryptoKit. `SFrameTests` holds it to appendix C's vectors, the same file the
/// TypeScript is held to, so a frame one seals the other opens.
///
/// What the page's `KeyStore` adds (counters that never repeat, the replay window,
/// retired epochs, a stream's own sender) is the application's part, ported with
/// native voice if P5D.9 chooses it.
public enum SFrame {
    public static let cipherSuite: UInt16 = 0x0004
    /// AEAD.Nk, AEAD.Nn and AEAD.Nt of RFC 9605's table 1, in bytes.
    public static let keyBytes = 16
    public static let nonceBytes = 12
    public static let tagBytes = 16

    public struct Header: Equatable, Sendable {
        public let kid: UInt64
        public let ctr: UInt64
        /// How many bytes the header takes.
        public let length: Int
    }

    /// How many bytes a value of 8 or more takes, written with no leading zero.
    static func size(of value: UInt64) -> Int {
        var bytes = 1
        while bytes < 8 && value >> UInt64(8 * bytes) != 0 { bytes += 1 }
        return bytes
    }

    static func bigEndian(_ value: UInt64, bytes: Int) -> [UInt8] {
        (0..<bytes).map { UInt8(truncatingIfNeeded: value >> UInt64(8 * (bytes - 1 - $0))) }
    }

    /// Section 4.3: a config byte, then the key id and the counter. A value under 8
    /// sits in the config byte; a larger one follows in as few bytes as hold it, and
    /// the config byte carries that length less one.
    public static func encodeHeader(kid: UInt64, ctr: UInt64) -> [UInt8] {
        let kidBytes = kid < 8 ? 0 : size(of: kid)
        let ctrBytes = ctr < 8 ? 0 : size(of: ctr)
        let k = kidBytes > 0 ? 0x80 | UInt8((kidBytes - 1) << 4) : UInt8(kid) << 4
        let c = ctrBytes > 0 ? 0x08 | UInt8(ctrBytes - 1) : UInt8(ctr)
        return [k | c] + bigEndian(kid, bytes: kidBytes) + bigEndian(ctr, bytes: ctrBytes)
    }

    /// The header at the start of `data`, or nil where there is none: too few bytes,
    /// or a value written in more bytes than it needs, which the RFC forbids.
    public static func decodeHeader<D: RandomAccessCollection>(_ data: D) -> Header?
    where D.Element == UInt8, D.Index == Int {
        guard let config = data.first else { return nil }
        let start = data.startIndex
        let kidBytes = config & 0x80 != 0 ? Int((config >> 4) & 7) + 1 : 0
        let ctrBytes = config & 0x08 != 0 ? Int(config & 7) + 1 : 0
        let length = 1 + kidBytes + ctrBytes
        guard data.count >= length else { return nil }
        func read(_ at: Int, _ bytes: Int) -> UInt64 {
            (0..<bytes).reduce(0) { ($0 << 8) | UInt64(data[start + at + $1]) }
        }
        let kid = kidBytes > 0 ? read(1, kidBytes) : UInt64((config >> 4) & 7)
        let ctr = ctrBytes > 0 ? read(1 + kidBytes, ctrBytes) : UInt64(config & 7)
        if kidBytes > 0 && (kid < 8 || data[start + 1] == 0) { return nil }
        if ctrBytes > 0 && (ctr < 8 || data[start + 1 + kidBytes] == 0) { return nil }
        return Header(kid: kid, ctr: ctr, length: length)
    }

    /// Section 4.4.2's labels: the text, the key id as eight bytes and the cipher
    /// suite as two, all big endian.
    public static func label(_ what: String, kid: UInt64) -> [UInt8] {
        Array("SFrame 1.0 Secret \(what) ".utf8) + bigEndian(kid, bytes: 8)
            + bigEndian(UInt64(cipherSuite), bytes: 2)
    }

    /// One key id's key and salt.
    public struct FrameKey: Sendable {
        public let kid: UInt64
        let key: SymmetricKey
        public let salt: [UInt8]
    }

    /// HKDF-Expand(HKDF-Extract("", base_key), label, …): an empty salt is HKDF's
    /// hash-length run of zeros (RFC 5869 section 2.2).
    static func expand(_ baseKey: SymmetricKey, _ info: [UInt8], _ bytes: Int) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: baseKey, salt: [UInt8](repeating: 0, count: 32), info: info,
            outputByteCount: bytes)
    }

    public static func frameKey(baseKey: SymmetricKey, kid: UInt64) -> FrameKey {
        let salt = expand(baseKey, label("salt", kid: kid), nonceBytes).withUnsafeBytes { Array($0) }
        return FrameKey(kid: kid, key: expand(baseKey, label("key", kid: kid), keyBytes), salt: salt)
    }

    /// Section 4.4.3: the counter as a big-endian integer of the nonce's length,
    /// XORed into the salt; a counter is 64 bits, so only the last eight bytes change.
    public static func nonce(salt: [UInt8], ctr: UInt64) -> [UInt8] {
        var nonce = salt
        for (n, byte) in bigEndian(ctr, bytes: 8).enumerated() { nonce[nonceBytes - 8 + n] ^= byte }
        return nonce
    }

    /// An SFrame ciphertext: the header, the encrypted frame and the tag.
    public static func seal(_ key: FrameKey, ctr: UInt64, _ plaintext: [UInt8], metadata: [UInt8] = [])
        throws -> [UInt8]
    {
        let header = encodeHeader(kid: key.kid, ctr: ctr)
        let box = try AES.GCM.seal(
            plaintext, using: key.key, nonce: AES.GCM.Nonce(data: nonce(salt: key.salt, ctr: ctr)),
            authenticating: header + metadata)
        return header + box.ciphertext + box.tag
    }

    /// The frame inside an SFrame ciphertext whose header has been read. It throws
    /// when the key, the header, the frame or the tag is not what was sealed.
    public static func open(_ key: FrameKey, header: Header, _ ciphertext: [UInt8], metadata: [UInt8] = [])
        throws -> [UInt8]
    {
        guard ciphertext.count >= header.length + tagBytes else { throw CryptoKitError.incorrectParameterSize }
        let body = ciphertext[header.length..<(ciphertext.count - tagBytes)]
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce(salt: key.salt, ctr: header.ctr)), ciphertext: body,
            tag: ciphertext.suffix(tagBytes))
        return Array(try AES.GCM.open(box, using: key.key, authenticating: Array(ciphertext.prefix(header.length)) + metadata))
    }

    /// Section 5.2's key id, laid out as the site's (`LAYOUT` in sframe.ts): the low
    /// four bits the epoch's, the next six the sender's leaf.
    public static let epochBits = 4
    public static let senderBits = 6

    public static func kid(sender: Int, epoch: UInt64) -> UInt64 {
        precondition(sender >= 0 && sender < 1 << senderBits, "no room in a key id for sender \(sender)")
        return UInt64(sender) << UInt64(epochBits) | (epoch & ((1 << UInt64(epochBits)) - 1))
    }
}
