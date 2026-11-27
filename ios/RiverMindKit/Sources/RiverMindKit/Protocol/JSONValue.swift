import Foundation

/// Any JSON value, kept as it came: what the app passes along without reading, such as
/// mediasoup's parameters, and a message this build does not know.
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    /// The value of a key, when this is an object that has it.
    public subscript(key: String) -> JSONValue? {
        if case let .object(fields) = self { fields[key] } else { nil }
    }

    /// The string, when this is one.
    public var string: String? {
        if case let .string(value) = self { value } else { nil }
    }

    /// Decodes this value as another type, as if it had come from the wire.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}

/// An empty object, `{}`: what a request with nothing to say sends or gets back.
public struct Empty: Codable, Sendable, Hashable {
    public init() {}
}
