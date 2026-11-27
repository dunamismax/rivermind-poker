// Writes the iPhone app's protocol types (P5D.2): Swift `Codable` types for
// protocol v2 from `src/lib/protocol-v2.ts` and for voice signalling v1 from
// `src/lib/voice/signalling.ts`, into RiverMindKit. The TypeScript files are
// the source; never edit the Swift by hand. `protocol-swift.spec.ts` fails
// while the committed Swift is stale.
//
//   pnpm protocol:swift            write the files
//   pnpm protocol:swift -- --check exit 1 if a written file would change
//
// The rules (docs/ios.md):
// - An interface or object type becomes a struct with a memberwise init and
//   explicit coding, so that a required `x: T | null` is written as null and
//   an optional `x?: T` is left out when it is nil, as the server writes them.
// - A union of string literals becomes an open type: a value this build does
//   not know decodes as itself (`Reaction` is the pattern), so a newer server
//   never breaks an older app.
// - A union of messages tagged by a literal field (`type`, `notice`) becomes
//   an enum. One the app reads has an `unknown` case for a tag it does not know.
// - A required literal field (`type: 'act'`, `protocol: 2`) is a constant,
//   written when encoding and not stored.
// - A number is an `Int` unless it is listed in FRACTIONAL: times and rates.
// - mediasoup's types are left as `JSONValue`, which the app hands to
//   libmediasoupclient as they came.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(web, '..');
const out = 'ios/RiverMindKit/Sources/RiverMindKit/Protocol';

/** Numbers that are not whole: seconds since the epoch, durations and rates. */
const FRACTIONAL = new Set([
	'BotChampion.stack_bb',
	'BotResult.bb_per_100',
	'BotResult.ci95',
	'HandSummary.at',
	'LedgerItem.at',
	'SeatHold.until',
	'TableSettings.action_seconds',
	'TableSettings.time_bank_seconds',
	'TableView.server_time',
	'Turn.started',
	'Turn.deadline',
	'Turn.final',
	'You.time_bank'
]);

/** Unions of messages that the app reads, which get an `unknown` case. */
const READ = new Set(['ServerMessage', 'VoiceNotice']);

/** Swift names for fields whose JSON name would read badly or is a keyword. */
const RENAMED: Record<string, string> = { protocol: 'protocolVersion', private: 'isPrivate' };

/** Words written in capitals inside a name, as Swift's guidelines ask. */
const CAPITALS = new Set(['id', 'bb', 'url', 'ip']);

const KEYWORDS = new Set(
	(
		'associatedtype class deinit enum extension fileprivate func import init inout internal let open ' +
		'operator private precedencegroup protocol public rethrows static struct subscript typealias var ' +
		'break case catch continue default defer do else fallthrough for guard if in repeat return throw ' +
		'switch where while Any as await false is nil self Self super throws true try'
	).split(' ')
);

// Swift names ---------------------------------------------------------------

function words(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

function camel(text: string): string {
	const name = words(text)
		.map((w, i) =>
			i === 0 ? w : CAPITALS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)
		)
		.join('');
	return /^[0-9]/.test(name) ? `_${name}` : name;
}

function pascal(text: string): string {
	const name = camel(text);
	return name[0].toUpperCase() + name.slice(1);
}

function member(name: string): string {
	return KEYWORDS.has(name) ? `\`${name}\`` : name;
}

function fieldName(json: string): string {
	return member(RENAMED[json] ?? camel(json));
}

function quote(text: string): string {
	return JSON.stringify(text);
}

// The model ------------------------------------------------------------------

type Shape =
	| { kind: 'string' | 'bool' | 'int' | 'double' | 'json' | 'empty' }
	| { kind: 'named'; name: string }
	| { kind: 'array'; of: Shape }
	| { kind: 'nullable'; of: Shape };

interface Field {
	json: string;
	doc: string[];
	shape: Shape;
	/** `x?:` in TypeScript: left out when nil. */
	optional: boolean;
	/** A required literal: written as this value and not stored. */
	constant?: string | number | boolean;
}

interface Struct {
	kind: 'struct';
	name: string;
	doc: string[];
	fields: Field[];
}

interface Open {
	kind: 'open';
	name: string;
	doc: string[];
	values: string[];
}

interface Tagged {
	kind: 'tagged';
	name: string;
	doc: string[];
	tag: string;
	members: { value: string; type: string }[];
	open: boolean;
}

interface Alias {
	kind: 'alias';
	name: string;
	doc: string[];
	of: string;
}

type Declaration = Struct | Open | Tagged | Alias;

class Source {
	readonly file: ts.SourceFile;
	readonly text: string;

	constructor(path: string) {
		this.text = readFileSync(resolve(web, path), 'utf8');
		this.file = ts.createSourceFile(path, this.text, ts.ScriptTarget.Latest, true);
	}

	/**
	 * The comments directly above a node, as lines: a JSDoc block or `//` lines. A union's
	 * member gives `from`, since its comment is the trivia of the `|` before it.
	 */
	doc(node: ts.Node, from = node.getFullStart()): string[] {
		const ranges = ts.getLeadingCommentRanges(this.text, from) ?? [];
		const kept: ts.CommentRange[] = [];
		let end = node.getStart(this.file);
		for (const range of [...ranges].reverse()) {
			const between = this.text.slice(range.end, end);
			if ((between.match(/\n/g) ?? []).length > 1) break;
			kept.unshift(range);
			end = range.pos;
		}
		const lines: string[] = [];
		for (const range of kept) {
			const raw = this.text.slice(range.pos, range.end);
			if (raw.startsWith('/*')) {
				for (const line of raw
					.replace(/^\/\*\*?/, '')
					.replace(/\*\/$/, '')
					.split('\n')) {
					lines.push(line.replace(/^\s*(\* ?)?/, '').trimEnd());
				}
			} else {
				lines.push(raw.replace(/^\/\/ ?/, '').trimEnd());
			}
		}
		while (lines.length && lines[0] === '') lines.shift();
		while (lines.length && lines.at(-1) === '') lines.pop();
		return lines;
	}
}

function literalOf(node: ts.TypeNode): string | number | boolean | undefined {
	if (!ts.isLiteralTypeNode(node)) return undefined;
	const literal = node.literal;
	if (ts.isStringLiteral(literal)) return literal.text;
	if (ts.isNumericLiteral(literal)) return Number(literal.text);
	if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
	return undefined;
}

function stringUnion(node: ts.TypeNode): string[] | null {
	if (!ts.isUnionTypeNode(node)) return null;
	const values = node.types.map(literalOf);
	return values.every((v) => typeof v === 'string') ? (values as string[]) : null;
}

class Model {
	readonly declarations: Declaration[] = [];
	private readonly names = new Map<string, string>();
	readonly source: Source;

	/** `rename` gives the Swift name of a TypeScript one. */
	constructor(source: Source, rename: (name: string) => string) {
		this.source = source;
		for (const statement of source.file.statements) {
			if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
				this.names.set(statement.name.text, rename(statement.name.text));
			}
		}
	}

	swiftName(name: string): string {
		const swift = this.names.get(name);
		if (!swift) throw new Error(`${name} is not declared in ${this.source.file.fileName}`);
		return swift;
	}

	/** A type the generator names itself, such as an inline union of strings. */
	/** Inline unions of strings that the generator names itself, by their node. */
	private readonly inline = new Map<ts.TypeNode, string>();

	/** Names an inline union of strings, such as a request's `direction`. */
	declare(node: ts.TypeNode, name: string): void {
		this.inline.set(node, name);
	}

	find<T extends Declaration>(name: string): T {
		const found = this.declarations.find((d) => d.name === name);
		if (!found) throw new Error(`no declaration ${name}`);
		return found as T;
	}

	shape(node: ts.TypeNode, where: string): Shape {
		const named = this.inline.get(node);
		if (named) return { kind: 'named', name: named };
		if (ts.isParenthesizedTypeNode(node)) return this.shape(node.type, where);
		if (ts.isUnionTypeNode(node)) {
			const rest = node.types.filter(
				(t) => !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
			);
			if (rest.length === node.types.length - 1 && rest.length === 1) {
				return { kind: 'nullable', of: this.shape(rest[0], where) };
			}
			throw new Error(`${where}: unions other than T | null are named types`);
		}
		if (ts.isArrayTypeNode(node)) return { kind: 'array', of: this.shape(node.elementType, where) };
		switch (node.kind) {
			case ts.SyntaxKind.StringKeyword:
				return { kind: 'string' };
			case ts.SyntaxKind.BooleanKeyword:
				return { kind: 'bool' };
			case ts.SyntaxKind.NumberKeyword:
				return { kind: FRACTIONAL.has(where) ? 'double' : 'int' };
		}
		if (ts.isLiteralTypeNode(node)) {
			const value = literalOf(node);
			if (typeof value === 'boolean') return { kind: 'bool' };
			if (typeof value === 'number') return { kind: 'int' };
			if (typeof value === 'string') return { kind: 'string' };
		}
		if (ts.isTypeQueryNode(node)) return { kind: 'int' };
		if (ts.isTypeReferenceNode(node)) {
			const name = node.typeName.getText(this.source.file);
			if (name.startsWith('msc.')) return { kind: 'json' };
			if (name === 'Record') return { kind: 'empty' };
			return { kind: 'named', name: this.swiftName(name) };
		}
		throw new Error(`${where}: cannot write ${ts.SyntaxKind[node.kind]} in Swift`);
	}

	fields(members: ts.NodeArray<ts.TypeElement>, owner: string): Field[] {
		const fields: Field[] = [];
		for (const element of members) {
			if (!ts.isPropertySignature(element) || !element.type) {
				throw new Error(`${owner}: only properties are written`);
			}
			const json = element.name.getText(this.source.file).replace(/^['"]|['"]$/g, '');
			const optional = element.questionToken !== undefined;
			const literal = literalOf(element.type);
			const field: Field = {
				json,
				doc: this.source.doc(element),
				shape: this.shape(element.type, `${owner}.${json}`),
				optional
			};
			if (literal !== undefined && !optional) field.constant = literal;
			fields.push(field);
		}
		return fields;
	}

	struct(name: string, doc: string[], members: ts.NodeArray<ts.TypeElement>, owner = name): Struct {
		const struct: Struct = { kind: 'struct', name, doc, fields: this.fields(members, owner) };
		this.declarations.push(struct);
		return struct;
	}

	open(name: string, doc: string[], values: string[]): Open {
		const open: Open = { kind: 'open', name, doc, values };
		this.declarations.push(open);
		return open;
	}

	/** A union of named message types, each with one required string literal field in common. */
	tagged(name: string, doc: string[], node: ts.UnionTypeNode, open: boolean): Tagged {
		const types = node.types.map((t) => {
			if (!ts.isTypeReferenceNode(t)) throw new Error(`${name}: members must be named`);
			return this.swiftName(t.typeName.getText(this.source.file));
		});
		const structs = types.map((t) => this.find<Struct>(t));
		const tag = structs[0].fields.find((f) => typeof f.constant === 'string')?.json;
		if (!tag) throw new Error(`${name}: no tag`);
		const members = structs.map((s) => {
			const value = s.fields.find((f) => f.json === tag)?.constant;
			if (typeof value !== 'string') throw new Error(`${name}: ${s.name} has no ${tag}`);
			return { value, type: s.name };
		});
		const tagged: Tagged = { kind: 'tagged', name, doc, tag, members, open };
		this.declarations.push(tagged);
		return tagged;
	}
}

// Writing Swift -------------------------------------------------------------

function typeOf(shape: Shape): string {
	switch (shape.kind) {
		case 'string':
			return 'String';
		case 'bool':
			return 'Bool';
		case 'int':
			return 'Int';
		case 'double':
			return 'Double';
		case 'json':
			return 'JSONValue';
		case 'empty':
			return 'Empty';
		case 'named':
			return shape.name;
		case 'array':
			return `[${typeOf(shape.of)}]`;
		case 'nullable':
			return `${typeOf(shape.of)}?`;
	}
}

/** The stored type of a field: optional when it may be missing or null. */
function storedType(field: Field): string {
	const type = typeOf(field.shape);
	return field.optional && field.shape.kind !== 'nullable' ? `${type}?` : type;
}

function isOptional(field: Field): boolean {
	return field.optional || field.shape.kind === 'nullable';
}

function baseType(field: Field): string {
	return typeOf(field.shape.kind === 'nullable' ? field.shape.of : field.shape);
}

function docLines(doc: string[], indent: string): string[] {
	return doc.map((line) => (line ? `${indent}/// ${line}` : `${indent}///`));
}

function writeConstant(value: string | number | boolean): string {
	return typeof value === 'string' ? quote(value) : String(value);
}

function writeStruct(struct: Struct): string[] {
	const stored = struct.fields.filter((f) => f.constant === undefined);
	const constants = struct.fields.filter((f) => f.constant !== undefined);
	const lines = [...docLines(struct.doc, '')];
	lines.push(`public struct ${struct.name}: Codable, Sendable, Hashable {`);
	for (const field of constants) {
		lines.push(...docLines(field.doc, '    '));
		lines.push(
			`    public static let ${fieldName(field.json)} = ${writeConstant(field.constant!)}`
		);
	}
	if (constants.length) lines.push('');
	for (const field of stored) {
		lines.push(...docLines(field.doc, '    '));
		lines.push(`    public var ${fieldName(field.json)}: ${storedType(field)}`);
	}
	// An optional field that may also be null: the server leaves it out in some messages
	// and writes null in others, so the struct remembers which, to write it back the same.
	const either = stored.filter((f) => f.optional && f.shape.kind === 'nullable');
	if (either.length) {
		lines.push(
			'    /// The optional fields written as an explicit null when they are nil, rather than'
		);
		lines.push('    /// left out: those that came as null, and those a request means as null.');
		lines.push('    public var nulls: Set<Null> = []', '');
		lines.push('    /// An optional field that may be written as null.');
		lines.push('    public enum Null: Sendable, Hashable {');
		for (const f of either) lines.push(`        case ${fieldName(f.json)}`);
		lines.push('    }');
	}
	if (stored.length) lines.push('');
	const params = stored.map(
		(f) => `${fieldName(f.json)}: ${storedType(f)}${isOptional(f) ? ' = nil' : ''}`
	);
	if (either.length) params.push('nulls: Set<Null> = []');
	if (params.length === 0) {
		lines.push('    public init() {}');
	} else {
		lines.push(`    public init(`);
		params.forEach((p, i) => lines.push(`        ${p}${i < params.length - 1 ? ',' : ''}`));
		lines.push('    ) {');
		for (const f of stored) lines.push(`        self.${fieldName(f.json)} = ${fieldName(f.json)}`);
		if (either.length) lines.push('        self.nulls = nulls');
		lines.push('    }');
	}
	lines.push('');
	if (struct.fields.length) {
		lines.push('    enum CodingKeys: String, CodingKey {');
		for (const f of struct.fields) {
			const name = fieldName(f.json);
			lines.push(`        case ${name}${name === f.json ? '' : ` = ${quote(f.json)}`}`);
		}
		lines.push('    }', '');
	}
	lines.push('    public init(from decoder: any Decoder) throws {');
	if (stored.length) {
		lines.push('        let container = try decoder.container(keyedBy: CodingKeys.self)');
		for (const f of stored) {
			const name = fieldName(f.json);
			const decode = isOptional(f) ? 'decodeIfPresent' : 'decode';
			lines.push(
				`        ${name} = try container.${decode}(${baseType(f)}.self, forKey: .${name.replace(/`/g, '')})`
			);
		}
		for (const f of either) {
			const key = `.${fieldName(f.json).replace(/`/g, '')}`;
			lines.push(
				`        if container.contains(${key}), try container.decodeNil(forKey: ${key}) { nulls.insert(${key}) }`
			);
		}
	}
	lines.push('    }', '');
	lines.push('    public func encode(to encoder: any Encoder) throws {');
	if (struct.fields.length) {
		lines.push('        var container = encoder.container(keyedBy: CodingKeys.self)');
		for (const f of struct.fields) {
			const name = fieldName(f.json);
			const key = `.${name.replace(/`/g, '')}`;
			if (f.constant !== undefined) {
				lines.push(`        try container.encode(Self.${name}, forKey: ${key})`);
			} else if (f.optional && f.shape.kind === 'nullable') {
				const bare = name.replace(/`/g, '');
				lines.push(
					`        if let ${bare} { try container.encode(${bare}, forKey: ${key}) } else if nulls.contains(${key}) { try container.encodeNil(forKey: ${key}) }`
				);
			} else if (f.optional) {
				lines.push(`        try container.encodeIfPresent(${name}, forKey: ${key})`);
			} else if (f.shape.kind === 'nullable') {
				lines.push(
					`        if let ${name.replace(/`/g, '')} { try container.encode(${name.replace(/`/g, '')}, forKey: ${key}) } else { try container.encodeNil(forKey: ${key}) }`
				);
			} else {
				lines.push(`        try container.encode(${name}, forKey: ${key})`);
			}
		}
	}
	lines.push('    }', '}');
	return lines;
}

function writeOpen(open: Open): string[] {
	const lines = [...docLines(open.doc, '')];
	if (open.doc.length) lines.push('///');
	lines.push(`/// A value this build does not know decodes as itself.`);
	lines.push(
		`public struct ${open.name}: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {`
	);
	lines.push('    public let rawValue: String', '');
	lines.push('    public init(rawValue: String) { self.rawValue = rawValue }', '');
	lines.push('    public init(from decoder: any Decoder) throws {');
	lines.push('        rawValue = try decoder.singleValueContainer().decode(String.self)');
	lines.push('    }', '');
	lines.push('    public func encode(to encoder: any Encoder) throws {');
	lines.push('        var container = encoder.singleValueContainer()');
	lines.push('        try container.encode(rawValue)');
	lines.push('    }', '');
	lines.push('    public var description: String { rawValue }', '');
	for (const value of open.values) {
		lines.push(
			`    public static let ${member(camel(value))} = ${open.name}(rawValue: ${quote(value)})`
		);
	}
	lines.push('', `    /// The values this build knows, in the protocol's order.`);
	lines.push(`    public static let known: [${open.name}] = [`);
	for (const value of open.values) lines.push(`        .${member(camel(value))},`);
	lines.push('    ]', '');
	lines.push('    /// Whether this build knows the value.');
	lines.push('    public var isKnown: Bool { Self.known.contains(self) }');
	lines.push('}');
	return lines;
}

function writeTagged(tagged: Tagged): string[] {
	const lines = [...docLines(tagged.doc, '')];
	lines.push(`public enum ${tagged.name}: Codable, Sendable, Hashable {`);
	for (const m of tagged.members) lines.push(`    case ${member(camel(m.value))}(${m.type})`);
	if (tagged.open) {
		lines.push(`    /// A message this build does not know, kept whole.`);
		lines.push('    case unknown(String, JSONValue)');
	}
	lines.push('');
	lines.push(`    /// The \`${tagged.tag}\` that names the message.`);
	lines.push(`    public var ${member(camel(tagged.tag))}: String {`);
	lines.push('        switch self {');
	for (const m of tagged.members)
		lines.push(`        case .${member(camel(m.value))}: ${quote(m.value)}`);
	if (tagged.open) lines.push('        case let .unknown(tag, _): tag');
	lines.push('        }', '    }', '');
	lines.push(
		'    private enum TagKey: String, CodingKey {',
		`        case tag = ${quote(tagged.tag)}`,
		'    }',
		''
	);
	lines.push('    public init(from decoder: any Decoder) throws {');
	lines.push(
		'        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .tag)'
	);
	lines.push('        switch tag {');
	for (const m of tagged.members) {
		lines.push(
			`        case ${quote(m.value)}: self = .${member(camel(m.value))}(try ${m.type}(from: decoder))`
		);
	}
	if (tagged.open) {
		lines.push('        default: self = .unknown(tag, try JSONValue(from: decoder))');
	} else {
		lines.push('        default:');
		lines.push('            throw DecodingError.dataCorruptedError(');
		lines.push(`                forKey: .tag, in: try decoder.container(keyedBy: TagKey.self),`);
		lines.push(`                debugDescription: "not a ${tagged.name}: \\(tag)")`);
	}
	lines.push('        }', '    }', '');
	lines.push('    public func encode(to encoder: any Encoder) throws {');
	lines.push('        switch self {');
	for (const m of tagged.members) {
		lines.push(
			`        case let .${member(camel(m.value))}(message): try message.encode(to: encoder)`
		);
	}
	if (tagged.open) lines.push('        case let .unknown(_, value): try value.encode(to: encoder)');
	lines.push('        }', '    }', '}');
	return lines;
}

function writeDeclaration(d: Declaration): string[] {
	switch (d.kind) {
		case 'struct':
			return writeStruct(d);
		case 'open':
			return writeOpen(d);
		case 'tagged':
			return writeTagged(d);
		case 'alias':
			return [...docLines(d.doc, ''), `public typealias ${d.name} = ${d.of}`];
	}
}

function header(source: string, about: string): string[] {
	return [
		`// ${about}`,
		`// Written by \`pnpm protocol:swift\` (web/scripts/protocol-swift.ts) from`,
		`// web/${source}. Do not edit: change the TypeScript and run it again.`,
		'',
		'import Foundation',
		''
	];
}

// Protocol v2 ---------------------------------------------------------------

function protocolV2(): string {
	const source = new Source('src/lib/protocol-v2.ts');
	const model = new Model(source, (name) => name);
	const unions: ts.TypeAliasDeclaration[] = [];
	for (const statement of source.file.statements) {
		const doc = source.doc(statement);
		if (ts.isInterfaceDeclaration(statement)) {
			model.struct(statement.name.text, doc, statement.members);
		} else if (ts.isTypeAliasDeclaration(statement)) {
			const values = stringUnion(statement.type);
			if (values) model.open(statement.name.text, doc, values);
			else if (ts.isUnionTypeNode(statement.type)) unions.push(statement);
			else throw new Error(`cannot write ${statement.name.text}`);
		}
	}
	for (const union of unions) {
		const name = union.name.text;
		model.tagged(name, source.doc(union), union.type as ts.UnionTypeNode, READ.has(name));
	}
	const order = new Map(
		source.file.statements
			.filter((s) => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s))
			.map((s, i) => [(s as ts.InterfaceDeclaration).name.text, i])
	);
	model.declarations.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
	const lines = header(
		'src/lib/protocol-v2.ts',
		'Protocol v2: every HTTP body and table message (P5D.2).'
	);
	lines.push("/// The table protocol's version, which `hello` names.");
	lines.push('public let protocolVersion = 2', '');
	for (const d of model.declarations) lines.push(...writeDeclaration(d), '');
	return lines.join('\n').trimEnd() + '\n';
}

// Voice signalling v1 -------------------------------------------------------

function evaluate(node: ts.Expression): number | string {
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (ts.isStringLiteral(node)) return node.text;
	if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
		return (evaluate(node.left) as number) * (evaluate(node.right) as number);
	}
	throw new Error(`cannot evaluate ${node.getText()}`);
}

function voiceSignalling(): string {
	const source = new Source('src/lib/voice/signalling.ts');
	const prefix = (name: string) =>
		name.startsWith('Voice') || name === 'Base64' ? name : `Voice${name}`;
	const model = new Model(source, prefix);
	const constants: string[] = [];
	const requests: {
		json: string;
		swift: string;
		request: string;
		response: string;
		doc: string[];
	}[] = [];
	// Written by hand in VoiceSignalling+Messages.swift: the envelopes of requests and answers.
	const byHand = new Set(['Requests', 'RequestType', 'ClientMessage', 'Answer', 'ServerMessage']);

	for (const statement of source.file.statements) {
		const doc = source.doc(statement);
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				const name = declaration.name.getText(source.file);
				let init = declaration.initializer!;
				if (ts.isAsExpression(init)) init = init.expression;
				if (name === 'REQUEST_TYPES') continue;
				if (ts.isObjectLiteralExpression(init)) {
					constants.push(...docLines(doc, '    '), `    public enum ${pascal(name)} {`);
					for (const property of init.properties) {
						if (!ts.isPropertyAssignment(property)) continue;
						constants.push(...docLines(source.doc(property), '        '));
						constants.push(
							`        public static let ${member(camel(property.name.getText(source.file)))} = ${writeConstant(evaluate(property.initializer))}`
						);
					}
					constants.push('    }', '');
				} else {
					const swift =
						{ VOICE_PROTOCOL: 'protocolVersion', VOICE_PATH: 'path' }[name] ?? camel(name);
					constants.push(...docLines(doc, '    '));
					constants.push(`    public static let ${swift} = ${writeConstant(evaluate(init))}`, '');
				}
			}
			continue;
		}
		if (!ts.isTypeAliasDeclaration(statement)) continue;
		const name = statement.name.text;
		const swift = model.swiftName(name);
		if (name === 'Requests') {
			const literal = statement.type as ts.TypeLiteralNode;
			for (const element of literal.members) {
				const property = element as ts.PropertySignature;
				const json = property.name.getText(source.file).replace(/^['"]|['"]$/g, '');
				const base = `Voice${pascal(json)}`;
				const parts = (property.type as ts.TypeLiteralNode)
					.members as ts.NodeArray<ts.PropertySignature>;
				const named: Record<string, string> = {};
				for (const part of parts) {
					const which = part.name.getText(source.file);
					const type = part.type!;
					const typeName = `${base}${pascal(which)}`;
					if (ts.isTypeLiteralNode(type)) {
						for (const field of type.members as ts.NodeArray<ts.PropertySignature>) {
							const values = field.type && stringUnion(field.type);
							if (values) {
								const openName = `${typeName}${pascal(field.name.getText(source.file))}`;
								model.open(openName, [], values);
								model.declare(field.type!, openName);
							}
						}
						model.struct(typeName, [], type.members, typeName);
						named[which] = typeName;
					} else if (
						ts.isTypeReferenceNode(type) &&
						type.typeName.getText(source.file) === 'Record'
					) {
						named[which] = 'Empty';
					} else if (ts.isTypeReferenceNode(type)) {
						named[which] = model.swiftName(type.typeName.getText(source.file));
					} else {
						throw new Error(`${json}.${which}: cannot write`);
					}
				}
				requests.push({
					json,
					swift: camel(json),
					request: named.request,
					response: named.response,
					doc: source.doc(property)
				});
			}
			continue;
		}
		if (byHand.has(name)) continue;
		const values = stringUnion(statement.type);
		if (values) {
			model.open(swift, doc, values);
		} else if (ts.isTypeLiteralNode(statement.type)) {
			model.struct(swift, doc, statement.type.members);
		} else if (statement.type.kind === ts.SyntaxKind.StringKeyword) {
			model.declarations.push({ kind: 'alias', name: swift, doc, of: 'String' });
		} else if (ts.isUnionTypeNode(statement.type)) {
			// A union of inline messages tagged by a literal field: each becomes a struct.
			const tagged: Tagged = {
				kind: 'tagged',
				name: swift,
				doc,
				tag: '',
				members: [],
				open: READ.has(swift)
			};
			for (const [index, member] of statement.type.types.entries()) {
				if (!ts.isTypeLiteralNode(member)) throw new Error(`${name}: members must be object types`);
				const from =
					index === 0 ? statement.type.getFullStart() : statement.type.types[index - 1].end;
				const tagField = member.members.find(
					(m) => ts.isPropertySignature(m) && m.type && typeof literalOf(m.type) === 'string'
				) as ts.PropertySignature;
				const tag = tagField.name.getText(source.file);
				const value = literalOf(tagField.type!) as string;
				const structName = `Voice${pascal(value)}${pascal(tag)}`;
				const memberDoc = source.doc(member, from);
				model.struct(structName, memberDoc, member.members, structName);
				tagged.tag = tag;
				tagged.members.push({ value, type: structName });
			}
			model.declarations.push(tagged);
		} else {
			throw new Error(`cannot write ${name}`);
		}
	}

	const lines = header('src/lib/voice/signalling.ts', 'Voice signalling v1 on `/voice` (P5D.2).');
	lines.push("/// Voice signalling's constants.");
	lines.push('public enum VoiceSignalling {');
	lines.push(...constants);
	lines.push('    /// Every request, in the order signalling.ts lists them.');
	lines.push('    public static let requestTypes: [String] = [');
	for (const r of requests) lines.push(`        ${quote(r.json)},`);
	lines.push('    ]', '}', '');
	for (const d of model.declarations) lines.push(...writeDeclaration(d), '');

	// The requests: what each sends and what its answer holds.
	lines.push('/// A request to the voice service, with what its answer holds.');
	lines.push('public protocol VoiceRequest: Encodable, Sendable {');
	lines.push('    associatedtype Response: Decodable & Sendable');
	lines.push("    /// The request's `type`.");
	lines.push('    static var type: String { get }');
	lines.push('}', '');
	for (const r of requests) {
		const requestType = r.request === 'Empty' ? `Voice${pascal(r.json)}Request` : r.request;
		if (r.request === 'Empty') {
			lines.push(`public struct ${requestType}: Codable, Sendable, Hashable {`);
			lines.push('    public init() {}');
			lines.push('}', '');
		}
		lines.push(...docLines(r.doc, ''));
		lines.push(`extension ${requestType}: VoiceRequest {`);
		lines.push(`    public typealias Response = ${r.response}`);
		lines.push(`    public static let type = ${quote(r.json)}`);
		lines.push('}', '');
	}
	return lines.join('\n').trimEnd() + '\n';
}

/** Every file the generator writes, by path from the repository's root. */
export function generate(): Record<string, string> {
	return {
		[`${out}/ProtocolV2.swift`]: protocolV2(),
		[`${out}/VoiceSignalling.swift`]: voiceSignalling()
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes('--check');
	let stale = false;
	for (const [path, text] of Object.entries(generate())) {
		const file = resolve(root, path);
		let current = '';
		try {
			current = readFileSync(file, 'utf8');
		} catch {
			// written below
		}
		if (current === text) continue;
		if (check) {
			console.error(`${path} is stale: run pnpm protocol:swift`);
			stale = true;
		} else {
			writeFileSync(file, text);
			console.log(`wrote ${path}`);
		}
	}
	if (stale) process.exit(1);
}
