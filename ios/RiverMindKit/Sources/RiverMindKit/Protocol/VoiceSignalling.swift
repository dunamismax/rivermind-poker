// Voice signalling v1 on `/voice` (P5D.2).
// Written by `pnpm protocol:swift` (web/scripts/protocol-swift.ts) from
// web/src/lib/voice/signalling.ts. Do not edit: change the TypeScript and run it again.

import Foundation

/// Voice signalling's constants.
public enum VoiceSignalling {
    public static let protocolVersion = 1

    public static let path = "/voice"

    /// The largest frame either side sends. A GroupInfo for a table of nine whose
    /// pages all reloaded at once (eighteen leaves) is about 6 kB, 8 kB in base64.
    public static let maxMessageBytes = 32768

    /// Close codes, in the range RFC 6455 leaves to applications.
    public enum Close {
        /// The service is stopping (a restart or deploy).
        public static let restarting = 1012
        /// Not this protocol, or a frame over the limit.
        public static let `protocol` = 4400
        /// The hello's token was refused.
        public static let unauthorised = 4401
        /// Too many messages, or hellos from one player.
        public static let rate = 4429
        /// The same seat joined again from another socket.
        public static let replaced = 4409
        /// The group removed this page's leaf.
        public static let removed = 4410
        /// The table no longer has this person in voice: they stood up, went bust or
        /// left, the table closed, or nobody else is seated (P4C.5).
        public static let unseated = 4403
        /// The service is full: the hello was refused for that alone (P4C.7).
        public static let full = 4503
        /// Never sent: what a page's own room ends with when its audio could not
        /// reach the media server at all, though signalling did (room.ts, P4C.7).
        public static let unreachable = 4504
    }

    /// Every request, in the order signalling.ts lists them.
    public static let requestTypes: [String] = [
        "hello",
        "group.create",
        "group.commit",
        "transport.create",
        "transport.connect",
        "transport.restart",
        "produce",
        "producer.pause",
        "producer.resume",
        "consume",
        "consumer.pause",
        "consumer.resume",
        "status",
    ]
}

/// An MLS message or GroupInfo, as base64 (RFC 4648 section 4, with padding).
public typealias Base64 = String

/// What `POST /api/tables/{id}/voice` answers a seated person (P4C.5): a token
/// for `hello`, good for one socket within a minute, and the path of the voice
/// service on the site's own origin.
public struct VoiceTokenResponse: Codable, Sendable, Hashable {
    public var table: String
    public var seat: Int
    public var token: String
    public var url: String

    public init(
        table: String,
        seat: Int,
        token: String,
        url: String
    ) {
        self.table = table
        self.seat = seat
        self.token = token
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case table
        case seat
        case token
        case url
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        table = try container.decode(String.self, forKey: .table)
        seat = try container.decode(Int.self, forKey: .seat)
        token = try container.decode(String.self, forKey: .token)
        url = try container.decode(String.self, forKey: .url)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(table, forKey: .table)
        try container.encode(seat, forKey: .seat)
        try container.encode(token, forKey: .token)
        try container.encode(url, forKey: .url)
    }
}

/// What `GET /api/voice` answers (P4C.6): whether pages offer table voice. It is
/// off wherever the voice service cannot be reached from a page, as on the live
/// site until P4C.9 gives Caddy its route, so no table offers what cannot work.
public struct VoiceOffer: Codable, Sendable, Hashable {
    public var offered: Bool

    public init(
        offered: Bool
    ) {
        self.offered = offered
    }

    enum CodingKeys: String, CodingKey {
        case offered
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        offered = try container.decode(Bool.self, forKey: .offered)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(offered, forKey: .offered)
    }
}

/// Someone else in the room, as the service knows them: a name for their
/// socket, the leaf they hold in the group once they are in it, and their
/// audio once they send it. Who a leaf is, a page reads from its own copy of
/// the group, never from the service (docs/voice.md, threat model).
///
/// `muted` and `deafened` are what that person last said of themself with
/// `status` (P4C.6). A service from before P4C.6 leaves them out: read them as
/// false.
public struct VoicePeerInfo: Codable, Sendable, Hashable {
    public var peer: String
    public var leaf: Int?
    public var producer: String?
    public var muted: Bool?
    public var deafened: Bool?

    public init(
        peer: String,
        leaf: Int? = nil,
        producer: String? = nil,
        muted: Bool? = nil,
        deafened: Bool? = nil
    ) {
        self.peer = peer
        self.leaf = leaf
        self.producer = producer
        self.muted = muted
        self.deafened = deafened
    }

    enum CodingKeys: String, CodingKey {
        case peer
        case leaf
        case producer
        case muted
        case deafened
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        peer = try container.decode(String.self, forKey: .peer)
        leaf = try container.decodeIfPresent(Int.self, forKey: .leaf)
        producer = try container.decodeIfPresent(String.self, forKey: .producer)
        muted = try container.decodeIfPresent(Bool.self, forKey: .muted)
        deafened = try container.decodeIfPresent(Bool.self, forKey: .deafened)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(peer, forKey: .peer)
        if let leaf { try container.encode(leaf, forKey: .leaf) } else { try container.encodeNil(forKey: .leaf) }
        if let producer { try container.encode(producer, forKey: .producer) } else { try container.encodeNil(forKey: .producer) }
        try container.encodeIfPresent(muted, forKey: .muted)
        try container.encodeIfPresent(deafened, forKey: .deafened)
    }
}

/// What a person says of themself (`status`): their own microphone is muted,
/// or they hear nobody. The service only passes it on; a muted page also
/// pauses its producer, so its silence does not depend on this.
public struct VoicePeerStatus: Codable, Sendable, Hashable {
    public var muted: Bool
    public var deafened: Bool

    public init(
        muted: Bool,
        deafened: Bool
    ) {
        self.muted = muted
        self.deafened = deafened
    }

    enum CodingKeys: String, CodingKey {
        case muted
        case deafened
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        muted = try container.decode(Bool.self, forKey: .muted)
        deafened = try container.decode(Bool.self, forKey: .deafened)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(muted, forKey: .muted)
        try container.encode(deafened, forKey: .deafened)
    }
}

/// A WebRTC transport, for mediasoup-client's createSendTransport and
/// createRecvTransport (which call `transport` its `id`).
public struct VoiceTransportInfo: Codable, Sendable, Hashable {
    public var transport: String
    public var iceParameters: JSONValue
    public var iceCandidates: [JSONValue]
    public var dtlsParameters: JSONValue

    public init(
        transport: String,
        iceParameters: JSONValue,
        iceCandidates: [JSONValue],
        dtlsParameters: JSONValue
    ) {
        self.transport = transport
        self.iceParameters = iceParameters
        self.iceCandidates = iceCandidates
        self.dtlsParameters = dtlsParameters
    }

    enum CodingKeys: String, CodingKey {
        case transport
        case iceParameters
        case iceCandidates
        case dtlsParameters
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transport = try container.decode(String.self, forKey: .transport)
        iceParameters = try container.decode(JSONValue.self, forKey: .iceParameters)
        iceCandidates = try container.decode([JSONValue].self, forKey: .iceCandidates)
        dtlsParameters = try container.decode(JSONValue.self, forKey: .dtlsParameters)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(transport, forKey: .transport)
        try container.encode(iceParameters, forKey: .iceParameters)
        try container.encode(iceCandidates, forKey: .iceCandidates)
        try container.encode(dtlsParameters, forKey: .dtlsParameters)
    }
}

public struct VoiceHelloRequest: Codable, Sendable, Hashable {
    public var v: Int
    public var table: String
    public var token: String

    public init(
        v: Int,
        table: String,
        token: String
    ) {
        self.v = v
        self.table = table
        self.token = token
    }

    enum CodingKeys: String, CodingKey {
        case v
        case table
        case token
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = try container.decode(Int.self, forKey: .v)
        table = try container.decode(String.self, forKey: .table)
        token = try container.decode(String.self, forKey: .token)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(table, forKey: .table)
        try container.encode(token, forKey: .token)
    }
}

public struct VoiceHelloResponse: Codable, Sendable, Hashable {
    public var v: Int
    /// This socket's name in the room.
    public var peer: String
    /// Who the token says this page is: a leaf's identity must say the same (group.ts).
    public var seat: Int
    public var player: String
    /// What Member.create and Member.join need.
    public var service: Base64
    public var group: Base64
    /// The GroupInfo to join from, or null to create the group.
    public var groupInfo: Base64?
    /// The Router's capabilities, without the audio-level extension.
    public var routerRtpCapabilities: JSONValue
    public var peers: [VoicePeerInfo]
    /// The service takes `status` and passes it on (P4C.6). A page sends
    /// `status` only to a service that says so: one from before closes a
    /// socket that sends a request it does not know.
    public var statuses: Bool?
    /// Until when this person may not speak, in milliseconds since the
    /// epoch, after reports of what they said in voice (P4C.8); null when
    /// they may. The service refuses their `produce` until then.
    public var silenced: Int?
    /// The service takes `transport.restart` (P4C.7). A page asks only a
    /// service that says so, as with `status`.
    public var restarts: Bool?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case silenced
    }

    public init(
        v: Int,
        peer: String,
        seat: Int,
        player: String,
        service: Base64,
        group: Base64,
        groupInfo: Base64? = nil,
        routerRtpCapabilities: JSONValue,
        peers: [VoicePeerInfo],
        statuses: Bool? = nil,
        silenced: Int? = nil,
        restarts: Bool? = nil,
        nulls: Set<Null> = []
    ) {
        self.v = v
        self.peer = peer
        self.seat = seat
        self.player = player
        self.service = service
        self.group = group
        self.groupInfo = groupInfo
        self.routerRtpCapabilities = routerRtpCapabilities
        self.peers = peers
        self.statuses = statuses
        self.silenced = silenced
        self.restarts = restarts
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case v
        case peer
        case seat
        case player
        case service
        case group
        case groupInfo
        case routerRtpCapabilities
        case peers
        case statuses
        case silenced
        case restarts
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = try container.decode(Int.self, forKey: .v)
        peer = try container.decode(String.self, forKey: .peer)
        seat = try container.decode(Int.self, forKey: .seat)
        player = try container.decode(String.self, forKey: .player)
        service = try container.decode(Base64.self, forKey: .service)
        group = try container.decode(Base64.self, forKey: .group)
        groupInfo = try container.decodeIfPresent(Base64.self, forKey: .groupInfo)
        routerRtpCapabilities = try container.decode(JSONValue.self, forKey: .routerRtpCapabilities)
        peers = try container.decode([VoicePeerInfo].self, forKey: .peers)
        statuses = try container.decodeIfPresent(Bool.self, forKey: .statuses)
        silenced = try container.decodeIfPresent(Int.self, forKey: .silenced)
        restarts = try container.decodeIfPresent(Bool.self, forKey: .restarts)
        if container.contains(.silenced), try container.decodeNil(forKey: .silenced) { nulls.insert(.silenced) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(peer, forKey: .peer)
        try container.encode(seat, forKey: .seat)
        try container.encode(player, forKey: .player)
        try container.encode(service, forKey: .service)
        try container.encode(group, forKey: .group)
        if let groupInfo { try container.encode(groupInfo, forKey: .groupInfo) } else { try container.encodeNil(forKey: .groupInfo) }
        try container.encode(routerRtpCapabilities, forKey: .routerRtpCapabilities)
        try container.encode(peers, forKey: .peers)
        try container.encodeIfPresent(statuses, forKey: .statuses)
        if let silenced { try container.encode(silenced, forKey: .silenced) } else if nulls.contains(.silenced) { try container.encodeNil(forKey: .silenced) }
        try container.encodeIfPresent(restarts, forKey: .restarts)
    }
}

public struct VoiceGroupCreateRequest: Codable, Sendable, Hashable {
    public var groupInfo: Base64

    public init(
        groupInfo: Base64
    ) {
        self.groupInfo = groupInfo
    }

    enum CodingKeys: String, CodingKey {
        case groupInfo
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groupInfo = try container.decode(Base64.self, forKey: .groupInfo)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(groupInfo, forKey: .groupInfo)
    }
}

public struct VoiceGroupCreateResponse: Codable, Sendable, Hashable {
    public var epoch: Int
    public var leaf: Int

    public init(
        epoch: Int,
        leaf: Int
    ) {
        self.epoch = epoch
        self.leaf = leaf
    }

    enum CodingKeys: String, CodingKey {
        case epoch
        case leaf
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        epoch = try container.decode(Int.self, forKey: .epoch)
        leaf = try container.decode(Int.self, forKey: .leaf)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(epoch, forKey: .epoch)
        try container.encode(leaf, forKey: .leaf)
    }
}

public struct VoiceGroupCommitRequest: Codable, Sendable, Hashable {
    public var commit: Base64
    public var groupInfo: Base64

    public init(
        commit: Base64,
        groupInfo: Base64
    ) {
        self.commit = commit
        self.groupInfo = groupInfo
    }

    enum CodingKeys: String, CodingKey {
        case commit
        case groupInfo
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        commit = try container.decode(Base64.self, forKey: .commit)
        groupInfo = try container.decode(Base64.self, forKey: .groupInfo)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(commit, forKey: .commit)
        try container.encode(groupInfo, forKey: .groupInfo)
    }
}

public struct VoiceGroupCommitResponse: Codable, Sendable, Hashable {
    public var epoch: Int
    public var leaf: Int?

    public init(
        epoch: Int,
        leaf: Int? = nil
    ) {
        self.epoch = epoch
        self.leaf = leaf
    }

    enum CodingKeys: String, CodingKey {
        case epoch
        case leaf
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        epoch = try container.decode(Int.self, forKey: .epoch)
        leaf = try container.decodeIfPresent(Int.self, forKey: .leaf)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(epoch, forKey: .epoch)
        if let leaf { try container.encode(leaf, forKey: .leaf) } else { try container.encodeNil(forKey: .leaf) }
    }
}

/// A value this build does not know decodes as itself.
public struct VoiceTransportCreateRequestDirection: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let send = VoiceTransportCreateRequestDirection(rawValue: "send")
    public static let recv = VoiceTransportCreateRequestDirection(rawValue: "recv")

    /// The values this build knows, in the protocol's order.
    public static let known: [VoiceTransportCreateRequestDirection] = [
        .send,
        .recv,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

public struct VoiceTransportCreateRequest: Codable, Sendable, Hashable {
    public var direction: VoiceTransportCreateRequestDirection

    public init(
        direction: VoiceTransportCreateRequestDirection
    ) {
        self.direction = direction
    }

    enum CodingKeys: String, CodingKey {
        case direction
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        direction = try container.decode(VoiceTransportCreateRequestDirection.self, forKey: .direction)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(direction, forKey: .direction)
    }
}

public struct VoiceTransportConnectRequest: Codable, Sendable, Hashable {
    public var transport: String
    public var dtlsParameters: JSONValue

    public init(
        transport: String,
        dtlsParameters: JSONValue
    ) {
        self.transport = transport
        self.dtlsParameters = dtlsParameters
    }

    enum CodingKeys: String, CodingKey {
        case transport
        case dtlsParameters
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transport = try container.decode(String.self, forKey: .transport)
        dtlsParameters = try container.decode(JSONValue.self, forKey: .dtlsParameters)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(transport, forKey: .transport)
        try container.encode(dtlsParameters, forKey: .dtlsParameters)
    }
}

public struct VoiceTransportRestartRequest: Codable, Sendable, Hashable {
    public var transport: String

    public init(
        transport: String
    ) {
        self.transport = transport
    }

    enum CodingKeys: String, CodingKey {
        case transport
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transport = try container.decode(String.self, forKey: .transport)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(transport, forKey: .transport)
    }
}

public struct VoiceTransportRestartResponse: Codable, Sendable, Hashable {
    public var iceParameters: JSONValue

    public init(
        iceParameters: JSONValue
    ) {
        self.iceParameters = iceParameters
    }

    enum CodingKeys: String, CodingKey {
        case iceParameters
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        iceParameters = try container.decode(JSONValue.self, forKey: .iceParameters)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(iceParameters, forKey: .iceParameters)
    }
}

public struct VoiceProduceRequest: Codable, Sendable, Hashable {
    public var transport: String
    public var rtpParameters: JSONValue

    public init(
        transport: String,
        rtpParameters: JSONValue
    ) {
        self.transport = transport
        self.rtpParameters = rtpParameters
    }

    enum CodingKeys: String, CodingKey {
        case transport
        case rtpParameters
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transport = try container.decode(String.self, forKey: .transport)
        rtpParameters = try container.decode(JSONValue.self, forKey: .rtpParameters)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(transport, forKey: .transport)
        try container.encode(rtpParameters, forKey: .rtpParameters)
    }
}

public struct VoiceProduceResponse: Codable, Sendable, Hashable {
    public var producer: String

    public init(
        producer: String
    ) {
        self.producer = producer
    }

    enum CodingKeys: String, CodingKey {
        case producer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        producer = try container.decode(String.self, forKey: .producer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(producer, forKey: .producer)
    }
}

public struct VoiceConsumeRequest: Codable, Sendable, Hashable {
    public var transport: String
    public var producer: String
    public var rtpCapabilities: JSONValue

    public init(
        transport: String,
        producer: String,
        rtpCapabilities: JSONValue
    ) {
        self.transport = transport
        self.producer = producer
        self.rtpCapabilities = rtpCapabilities
    }

    enum CodingKeys: String, CodingKey {
        case transport
        case producer
        case rtpCapabilities
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        transport = try container.decode(String.self, forKey: .transport)
        producer = try container.decode(String.self, forKey: .producer)
        rtpCapabilities = try container.decode(JSONValue.self, forKey: .rtpCapabilities)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(transport, forKey: .transport)
        try container.encode(producer, forKey: .producer)
        try container.encode(rtpCapabilities, forKey: .rtpCapabilities)
    }
}

public struct VoiceConsumeResponse: Codable, Sendable, Hashable {
    public var consumer: String
    public var producer: String
    public var rtpParameters: JSONValue

    public init(
        consumer: String,
        producer: String,
        rtpParameters: JSONValue
    ) {
        self.consumer = consumer
        self.producer = producer
        self.rtpParameters = rtpParameters
    }

    enum CodingKeys: String, CodingKey {
        case consumer
        case producer
        case rtpParameters
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        consumer = try container.decode(String.self, forKey: .consumer)
        producer = try container.decode(String.self, forKey: .producer)
        rtpParameters = try container.decode(JSONValue.self, forKey: .rtpParameters)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(consumer, forKey: .consumer)
        try container.encode(producer, forKey: .producer)
        try container.encode(rtpParameters, forKey: .rtpParameters)
    }
}

public struct VoiceConsumerPauseRequest: Codable, Sendable, Hashable {
    public var consumer: String

    public init(
        consumer: String
    ) {
        self.consumer = consumer
    }

    enum CodingKeys: String, CodingKey {
        case consumer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        consumer = try container.decode(String.self, forKey: .consumer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(consumer, forKey: .consumer)
    }
}

public struct VoiceConsumerResumeRequest: Codable, Sendable, Hashable {
    public var consumer: String

    public init(
        consumer: String
    ) {
        self.consumer = consumer
    }

    enum CodingKeys: String, CodingKey {
        case consumer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        consumer = try container.decode(String.self, forKey: .consumer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(consumer, forKey: .consumer)
    }
}

/// Why a request was refused. The MLS ones are delivery.ts's refusals.
///
/// A value this build does not know decodes as itself.
public struct VoiceError: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let badRequest = VoiceError(rawValue: "bad-request")
    public static let unsupportedVersion = VoiceError(rawValue: "unsupported-version")
    public static let badToken = VoiceError(rawValue: "bad-token")
    public static let notSeated = VoiceError(rawValue: "not-seated")
    public static let unknown = VoiceError(rawValue: "unknown")
    public static let tooMany = VoiceError(rawValue: "too-many")
    public static let notAllowed = VoiceError(rawValue: "not-allowed")
    public static let full = VoiceError(rawValue: "full")
    public static let failed = VoiceError(rawValue: "failed")
    public static let malformed = VoiceError(rawValue: "malformed")
    public static let noGroup = VoiceError(rawValue: "no-group")
    public static let groupExists = VoiceError(rawValue: "group-exists")
    public static let epochTaken = VoiceError(rawValue: "epoch-taken")
    public static let badGroupInfo = VoiceError(rawValue: "bad-group-info")

    /// The values this build knows, in the protocol's order.
    public static let known: [VoiceError] = [
        .badRequest,
        .unsupportedVersion,
        .badToken,
        .notSeated,
        .unknown,
        .tooMany,
        .notAllowed,
        .full,
        .failed,
        .malformed,
        .noGroup,
        .groupExists,
        .epochTaken,
        .badGroupInfo,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// A commit the service accepted, or a removal it proposes: apply it (Member.receive).
public struct VoiceMlsNotice: Codable, Sendable, Hashable {
    public static let notice = "mls"

    public var message: Base64

    public init(
        message: Base64
    ) {
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case notice
        case message
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        message = try container.decode(Base64.self, forKey: .message)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
        try container.encode(message, forKey: .message)
    }
}

/// Someone in the room sends audio now.
public struct VoiceProducerNotice: Codable, Sendable, Hashable {
    public static let notice = "producer"

    public var peer: VoicePeerInfo

    public init(
        peer: VoicePeerInfo
    ) {
        self.peer = peer
    }

    enum CodingKeys: String, CodingKey {
        case notice
        case peer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        peer = try container.decode(VoicePeerInfo.self, forKey: .peer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
        try container.encode(peer, forKey: .peer)
    }
}

/// A consumer of this page's ended, because its producer did.
public struct VoiceConsumerClosedNotice: Codable, Sendable, Hashable {
    public static let notice = "consumer.closed"

    public var consumer: String

    public init(
        consumer: String
    ) {
        self.consumer = consumer
    }

    enum CodingKeys: String, CodingKey {
        case notice
        case consumer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        consumer = try container.decode(String.self, forKey: .consumer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
        try container.encode(consumer, forKey: .consumer)
    }
}

/// Someone's socket closed. Their leaf, if they had one, is proposed for removal.
public struct VoiceLeftNotice: Codable, Sendable, Hashable {
    public static let notice = "left"

    public var peer: String

    public init(
        peer: String
    ) {
        self.peer = peer
    }

    enum CodingKeys: String, CodingKey {
        case notice
        case peer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        peer = try container.decode(String.self, forKey: .peer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
        try container.encode(peer, forKey: .peer)
    }
}

/// Someone said they muted themself or deafened, or no longer (`status`).
public struct VoicePeerNotice: Codable, Sendable, Hashable {
    public static let notice = "peer"

    public var peer: VoicePeerInfo

    public init(
        peer: VoicePeerInfo
    ) {
        self.peer = peer
    }

    enum CodingKeys: String, CodingKey {
        case notice
        case peer
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        peer = try container.decode(VoicePeerInfo.self, forKey: .peer)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
        try container.encode(peer, forKey: .peer)
    }
}

/// The media server's listener started again (its public address changed):
/// every transport is gone. The group stands; make the transports again.
public struct VoiceMediaResetNotice: Codable, Sendable, Hashable {
    public static let notice = "media.reset"

    public init() {}

    enum CodingKeys: String, CodingKey {
        case notice
    }

    public init(from decoder: any Decoder) throws {
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
    }
}

/// This person's speaking is suspended until then, in milliseconds since the
/// epoch, and their producer is closed; or, with null, they may speak again
/// (P4C.8). A page from before ignores it, and nobody hears it anyway.
public struct VoiceSilencedNotice: Codable, Sendable, Hashable {
    public static let notice = "silenced"

    public var until: Int?

    public init(
        until: Int? = nil
    ) {
        self.until = until
    }

    enum CodingKeys: String, CodingKey {
        case notice
        case until
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        until = try container.decodeIfPresent(Int.self, forKey: .until)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.notice, forKey: .notice)
        if let until { try container.encode(until, forKey: .until) } else { try container.encodeNil(forKey: .until) }
    }
}

public enum VoiceNotice: Codable, Sendable, Hashable {
    case mls(VoiceMlsNotice)
    case producer(VoiceProducerNotice)
    case consumerClosed(VoiceConsumerClosedNotice)
    case left(VoiceLeftNotice)
    case peer(VoicePeerNotice)
    case mediaReset(VoiceMediaResetNotice)
    case silenced(VoiceSilencedNotice)
    /// A message this build does not know, kept whole.
    case unknown(String, JSONValue)

    /// The `notice` that names the message.
    public var notice: String {
        switch self {
        case .mls: "mls"
        case .producer: "producer"
        case .consumerClosed: "consumer.closed"
        case .left: "left"
        case .peer: "peer"
        case .mediaReset: "media.reset"
        case .silenced: "silenced"
        case let .unknown(tag, _): tag
        }
    }

    private enum TagKey: String, CodingKey {
        case tag = "notice"
    }

    public init(from decoder: any Decoder) throws {
        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .tag)
        switch tag {
        case "mls": self = .mls(try VoiceMlsNotice(from: decoder))
        case "producer": self = .producer(try VoiceProducerNotice(from: decoder))
        case "consumer.closed": self = .consumerClosed(try VoiceConsumerClosedNotice(from: decoder))
        case "left": self = .left(try VoiceLeftNotice(from: decoder))
        case "peer": self = .peer(try VoicePeerNotice(from: decoder))
        case "media.reset": self = .mediaReset(try VoiceMediaResetNotice(from: decoder))
        case "silenced": self = .silenced(try VoiceSilencedNotice(from: decoder))
        default: self = .unknown(tag, try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .mls(message): try message.encode(to: encoder)
        case let .producer(message): try message.encode(to: encoder)
        case let .consumerClosed(message): try message.encode(to: encoder)
        case let .left(message): try message.encode(to: encoder)
        case let .peer(message): try message.encode(to: encoder)
        case let .mediaReset(message): try message.encode(to: encoder)
        case let .silenced(message): try message.encode(to: encoder)
        case let .unknown(_, value): try value.encode(to: encoder)
        }
    }
}

/// A request to the voice service, with what its answer holds.
public protocol VoiceRequest: Encodable, Sendable {
    associatedtype Response: Decodable & Sendable
    /// The request's `type`.
    static var type: String { get }
}

extension VoiceHelloRequest: VoiceRequest {
    public typealias Response = VoiceHelloResponse
    public static let type = "hello"
}

extension VoiceGroupCreateRequest: VoiceRequest {
    public typealias Response = VoiceGroupCreateResponse
    public static let type = "group.create"
}

extension VoiceGroupCommitRequest: VoiceRequest {
    public typealias Response = VoiceGroupCommitResponse
    public static let type = "group.commit"
}

extension VoiceTransportCreateRequest: VoiceRequest {
    public typealias Response = VoiceTransportInfo
    public static let type = "transport.create"
}

extension VoiceTransportConnectRequest: VoiceRequest {
    public typealias Response = Empty
    public static let type = "transport.connect"
}

/// A transport lost its path (the person's network changed): ICE starts
/// again under new credentials, and the transport, its streams and the
/// group all stand (P4C.7).
extension VoiceTransportRestartRequest: VoiceRequest {
    public typealias Response = VoiceTransportRestartResponse
    public static let type = "transport.restart"
}

extension VoiceProduceRequest: VoiceRequest {
    public typealias Response = VoiceProduceResponse
    public static let type = "produce"
}

public struct VoiceProducerPauseRequest: Codable, Sendable, Hashable {
    public init() {}
}

extension VoiceProducerPauseRequest: VoiceRequest {
    public typealias Response = Empty
    public static let type = "producer.pause"
}

public struct VoiceProducerResumeRequest: Codable, Sendable, Hashable {
    public init() {}
}

extension VoiceProducerResumeRequest: VoiceRequest {
    public typealias Response = Empty
    public static let type = "producer.resume"
}

extension VoiceConsumeRequest: VoiceRequest {
    public typealias Response = VoiceConsumeResponse
    public static let type = "consume"
}

extension VoiceConsumerPauseRequest: VoiceRequest {
    public typealias Response = Empty
    public static let type = "consumer.pause"
}

extension VoiceConsumerResumeRequest: VoiceRequest {
    public typealias Response = Empty
    public static let type = "consumer.resume"
}

extension VoicePeerStatus: VoiceRequest {
    public typealias Response = Empty
    public static let type = "status"
}
