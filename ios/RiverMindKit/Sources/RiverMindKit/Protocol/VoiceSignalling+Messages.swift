import Foundation

// The envelopes of voice signalling v1 (web/src/lib/voice/signalling.ts): a request
// carries an `id` and its `type` beside its fields, and the service answers each with
// the same `id`, `ok` and either the request's response or an error. The types inside
// them are written by `pnpm protocol:swift`; these envelopes are written by hand
// because each answer's shape depends on the request it answers.

/// A request as it goes on the wire: `{"id": 1, "type": "hello", ...the request}`.
public struct VoiceEnvelope<Request: VoiceRequest>: Encodable, Sendable {
    public var id: Int
    public var request: Request

    public init(id: Int, request: Request) {
        self.id = id
        self.request = request
    }

    private enum CodingKeys: String, CodingKey { case id, type }

    public func encode(to encoder: any Encoder) throws {
        try request.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(Request.type, forKey: .type)
    }
}

/// The service's answer to a request: its `id`, and the response or the refusal.
public struct VoiceAnswer: Decodable, Sendable, Equatable {
    public var id: Int
    public var ok: Bool
    /// Why the request was refused, when it was.
    public var error: VoiceError?
    /// A refused `group.create` or `group.commit`: the GroupInfo to start again from,
    /// null to create the group. Missing from other refusals.
    public var groupInfo: Base64??
    /// The whole answer, from which `response(to:)` reads the response.
    public var body: JSONValue

    private enum CodingKeys: String, CodingKey { case id, ok, error, groupInfo }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        ok = try container.decode(Bool.self, forKey: .ok)
        error = try container.decodeIfPresent(VoiceError.self, forKey: .error)
        if container.contains(.groupInfo) {
            groupInfo = .some(try container.decodeIfPresent(Base64.self, forKey: .groupInfo))
        } else {
            groupInfo = .none
        }
        body = try JSONValue(from: decoder)
    }

    /// The response to a request of this type, or the refusal as an error.
    public func response<Request: VoiceRequest>(to _: Request.Type) throws -> Request.Response {
        guard ok else { throw VoiceRefusal(error: error ?? VoiceError(rawValue: "unknown"), groupInfo: groupInfo) }
        return try body.decode(Request.Response.self)
    }
}

/// A request the voice service refused.
public struct VoiceRefusal: Error, Sendable, Equatable {
    public var error: VoiceError
    public var groupInfo: Base64??
}

/// Anything the voice service sends: an answer, which has an `id`, or a notice.
public enum VoiceServerMessage: Decodable, Sendable, Equatable {
    case answer(VoiceAnswer)
    case notice(VoiceNotice)

    private enum CodingKeys: String, CodingKey { case id }

    public init(from decoder: any Decoder) throws {
        if try decoder.container(keyedBy: CodingKeys.self).contains(.id) {
            self = .answer(try VoiceAnswer(from: decoder))
        } else {
            self = .notice(try VoiceNotice(from: decoder))
        }
    }
}
