/**
 * Regenerate src/generated/domidl.ts from webref.
 *
 * Every interface a TermDOM window exposes, as @webref/idl defines it
 * with its partials and mixins merged: what it inherits, whether script can construct it, and
 * its members. An operation lists how many arguments it needs and which
 * of them must be an object of an interface, or a function. webidl.ts
 * builds Web IDL's checks and the prototypes' layout from the table.
 *
 * Run: node --experimental-strip-types scripts/generate-dom-idl.ts
 */

import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {parse} from "webidl2";

import {getWindowClasses} from "../src/internal/window.ts";

const require = createRequire(import.meta.url);
const idlDir = dirname(require.resolve("@webref/idl/package.json"));

interface ExtAttr {
	name: string;
	rhs: {type: string; value: unknown} | null;
}

interface IdlType {
	idlType: string | IdlType[];
	nullable: boolean;
	union: boolean;
	generic: string;
}

interface Argument {
	name: string;
	idlType: IdlType;
	optional: boolean;
	variadic: boolean;
}

interface Member {
	type: string;
	name: string;
	special: string;
	readonly: boolean;
	idlType: IdlType | null;
	arguments: Argument[];
	extAttrs: ExtAttr[];
}

interface Definition {
	type: string;
	name: string;
	partial: boolean;
	inheritance: string | null;
	target: string;
	includes: string;
	members: Member[];
	extAttrs: ExtAttr[];
	idlType: IdlType;
}

const definitions: Definition[] = [];
for (const file of readdirSync(idlDir).sort()) {
	if (file.endsWith(".idl")) {
		definitions.push(
			...(parse(readFileSync(join(idlDir, file), "utf8")) as unknown as
			Definition[]),
		);
	}
}

const typedefs = new Map<string, IdlType>();
const callbackFunctions = new Set<string>();
const interfaceNames = new Set<string>();
for (const definition of definitions) {
	if (definition.type === "typedef") {
		typedefs.set(definition.name, definition.idlType);
	} else if (definition.type === "callback") {
		callbackFunctions.add(definition.name);
	} else if (definition.type === "interface") {
		interfaceNames.add(definition.name);
	}
}

function hasExtAttr(owner: {extAttrs: ExtAttr[]}, name: string): boolean {
	return owner.extAttrs.some((e) => e.name === name);
}

function isExposedToWindow(definition: Definition): boolean {
	const exposed = definition.extAttrs.find((e) => e.name === "Exposed");
	if (!exposed?.rhs) {
		return false;
	}
	if (exposed.rhs.type === "*") {
		return true;
	}
	const value = exposed.rhs.value;
	const names = Array.isArray(value)
		? value.map((v) => (v as {value: string}).value)
		: [value as string];
	return names.includes("Window") || names.includes("*");
}

const STRING_TYPES = new Set([
	"DOMString",
	"USVString",
	"ByteString",
	"TrustedHTML",
	"TrustedScript",
	"TrustedScriptURL",
]);

// The types a union flattens to, typedefs resolved.
function flatten(type: IdlType): IdlType[] {
	if (type.union) {
		return (type.idlType as IdlType[]).flatMap(flatten);
	}
	if (typeof type.idlType === "string" && typedefs.has(type.idlType)) {
		const resolved = typedefs.get(type.idlType)!;
		return flatten({...resolved, nullable: resolved.nullable || type.nullable});
	}
	return [type];
}

/**
 * What an argument or attribute of this type checks, in the table's
 * notation: an interface's name, "Function" for a callback function, a
 * leading "~" when anything else is converted to a string, as a union of
 * nodes and strings does, and a trailing "?" when null is allowed. Empty
 * when the engine converts the value itself.
 */
function getCheck(type: IdlType): string {
	const parts = flatten(type);
	const nullable = type.nullable || parts.some((p) => p.nullable);
	const suffix = nullable ? "?" : "";
	if (parts.some((p) => p.generic !== "" || typeof p.idlType !== "string")) {
		return "";
	}
	const names = parts.map((p) => p.idlType as string);
	if (names.length === 1) {
		if (interfaceNames.has(names[0])) {
			return names[0] + suffix;
		}
		if (callbackFunctions.has(names[0])) {
			return "Function" + suffix;
		}
		return "";
	}
	const interfaces = names.filter((n) => interfaceNames.has(n));
	const strings = names.filter((n) => STRING_TYPES.has(n));
	if (
		interfaces.length > 0 &&
		strings.length > 0 &&
		interfaces.length + strings.length === names.length
	) {
		return "~" + interfaces.join("|") + suffix;
	}
	return "";
}

interface Operation {
	required: number;
	args: string[];
	variadic: boolean;
}

interface Entry {
	parent: string | null;
	constructible: 0 | 1 | 2;
	constructors: Operation[];
	global: boolean;
	indexed: boolean;
	iterable: "" | "value" | "pair" | "maplike" | "setlike";
	unforgeable: Set<string>;
	lenient: Set<string>;
	constants: Set<string>;
	attributes: Map<string, {check: string; readonly: boolean}>;
	operations: Map<string, Operation[]>;
	statics: Set<string>;
}

function emptyEntry(): Entry {
	return {
		parent: null,
		constructible: 0,
		constructors: [],
		global: false,
		indexed: false,
		iterable: "",
		unforgeable: new Set(),
		lenient: new Set(),
		constants: new Set(),
		attributes: new Map(),
		operations: new Map(),
		statics: new Set(),
	};
}

function addMembers(
	entry: Entry,
	members: Member[],
	unforgeableInterface: boolean,
): void {
	for (const member of members) {
		if (
			hasExtAttr(member, "Exposed") &&
			!isExposedToWindow(member as unknown as Definition)
		) {
			continue;
		}
		const isStatic = member.special === "static";
		if (member.type === "constructor") {
			entry.constructible = hasExtAttr(member, "HTMLConstructor") ? 2 : 1;
			entry.constructors.push({
				required: member.arguments.filter((a) => !a.optional && !a.variadic)
					.length,
				args: member.arguments.map((a) => getCheck(a.idlType)),
				variadic: member.arguments.at(-1)?.variadic ?? false,
			});
			continue;
		}
		if (member.type === "const") {
			entry.constants.add(member.name);
			continue;
		}
		if (member.type === "iterable") {
			entry.iterable = (member.idlType as unknown as IdlType[]).length === 2
				? "pair"
				: "value";
			continue;
		}
		if (member.type === "maplike" || member.type === "setlike") {
			entry.iterable = member.type;
			continue;
		}
		if (member.type === "attribute") {
			if (isStatic) {
				entry.statics.add(member.name);
				continue;
			}
			entry.attributes.set(member.name, {
				check: getCheck(member.idlType!),
				readonly: member.readonly,
			});
			if (member.special === "stringifier") {
				entry.operations.set("toString", [
					{required: 0, args: [], variadic: false},
				]);
				if (unforgeableInterface) {
					entry.unforgeable.add("toString");
				}
			}
			if (unforgeableInterface || hasExtAttr(member, "LegacyUnforgeable")) {
				entry.unforgeable.add(member.name);
			}
			if (hasExtAttr(member, "LegacyLenientThis")) {
				entry.lenient.add(member.name);
			}
			continue;
		}
		if (member.type !== "operation") {
			continue;
		}
		if (
			member.special === "getter" &&
			member.arguments[0]?.idlType.idlType === "unsigned long"
		) {
			entry.indexed = true;
		}
		const name = member.special === "stringifier" && !member.name
			? "toString"
			: member.name;
		if (!name) {
			continue;
		}
		if (isStatic) {
			entry.statics.add(name);
			continue;
		}
		const args = member.arguments;
		const overload: Operation = {
			required: args.filter((a) => !a.optional && !a.variadic).length,
			args: args.map((a) => getCheck(a.idlType)),
			variadic: args.at(-1)?.variadic ?? false,
		};
		entry.operations.set(name, [
			...(entry.operations.get(name) ?? []),
			overload,
		]);
		if (unforgeableInterface || hasExtAttr(member, "LegacyUnforgeable")) {
			entry.unforgeable.add(name);
		}
	}
}

const mixins = new Map<string, Member[]>();
for (const definition of definitions) {
	if (definition.type === "interface mixin") {
		mixins.set(definition.name, [
			...(mixins.get(definition.name) ?? []),
			...definition.members.filter(
				(m) => !hasExtAttr(m, "Exposed") ||
					isExposedToWindow(m as unknown as Definition),
			),
		]);
	}
}

const windowInterfaces = new Set(Object.keys(getWindowClasses()));
const exposed = new Set(
	definitions
		.filter(
			(d) =>
				d.type === "interface" &&
			!d.partial &&
			isExposedToWindow(d) &&
			windowInterfaces.has(d.name),
		)
		.map((d) => d.name),
);

const entries = new Map<string, Entry>();
for (const name of exposed) {
	entries.set(name, emptyEntry());
}
for (const definition of definitions) {
	const entry = entries.get(definition.name);
	if (definition.type !== "interface" || entry === undefined) {
		continue;
	}
	if (!definition.partial) {
		entry.parent = definition.inheritance;
		entry.global = hasExtAttr(definition, "Global");
	}
	addMembers(
		entry,
		definition.members,
		hasExtAttr(definition, "LegacyUnforgeable"),
	);
}
for (const definition of definitions) {
	if (definition.type === "includes" && entries.has(definition.target)) {
		addMembers(
			entries.get(definition.target)!,
			mixins.get(definition.includes) ?? [],
			false,
		);
	}
}

// Overloads merge into what every one of them requires: the fewest
// arguments, and a check at a position only where they all agree.
function mergeOverloads(overloads: Operation[]): Operation {
	const required = Math.min(...overloads.map((o) => o.required));
	const length = Math.max(...overloads.map((o) => o.args.length));
	const args: string[] = [];
	for (let i = 0; i < length; i++) {
		const checks = new Set(
			overloads.filter((o) => i < o.args.length).map((o) => o.args[i]),
		);
		args.push(checks.size === 1 ? [...checks][0] : "");
	}
	while (args.length > 0 && args.at(-1) === "") {
		args.pop();
	}
	const variadic =
		overloads.length === 1 &&
		overloads[0].variadic &&
		args.length === overloads[0].args.length;
	return {required, args, variadic};
}

// An operation in the table's notation, after its flags.
function formatOperation(flags: string, {
	required,
	args,
	variadic,
}: Operation): string {
	const parts = [`${flags}${required}`, ...args];
	if (variadic) {
		parts[parts.length - 1] = "..." + parts[parts.length - 1];
	}
	return parts.join(":");
}

function quote(value: string): string {
	return JSON.stringify(value);
}

const lines: string[] = [];
for (const [
	name,
	entry,
] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
	const members: string[] = [];
	for (const constant of [...entry.constants].sort()) {
		members.push(`[${quote(constant)}, "c"]`);
	}
	for (const [attribute, {check, readonly}] of [...entry.attributes].sort()) {
		let flags = readonly ? "r" : "a";
		if (entry.unforgeable.has(attribute)) {
			flags += "u";
		}
		if (entry.lenient.has(attribute)) {
			flags += "l";
		}
		members.push(
			`[${quote(attribute)}, ${quote(check ? `${flags}:${check}` : flags)}]`,
		);
	}
	for (const [operation, overloads] of [...entry.operations].sort()) {
		const flags = entry.unforgeable.has(operation) ? "ou" : "o";
		const text = formatOperation(flags, mergeOverloads(overloads));
		members.push(`[${quote(operation)}, ${quote(text)}]`);
	}
	const fields = [
		entry.parent ? `parent: ${quote(entry.parent)}` : "",
		entry.constructible ? `constructible: ${entry.constructible}` : "",
		entry.constructors.length > 0
			? `constructorArguments: ${quote(formatOperation("o", mergeOverloads(entry.constructors)))}`
			: "",
		entry.global ? "global: true" : "",
		entry.indexed ? "indexed: true" : "",
		entry.iterable ? `iterable: ${quote(entry.iterable)}` : "",
		entry.statics.size > 0
			? `statics: [${[...entry.statics].sort().map(quote).join(", ")}]`
			: "",
		`members: [${members.join(", ")}]`,
	].filter(Boolean);
	lines.push(`\t${quote(name)}: {${fields.join(", ")}},`);
}

const output = `/**
 * Every interface a window exposes, as webref defines it, generated by
 * scripts/generate-dom-idl.ts. Do not edit by hand.
 *
 * Each member is its name and what it is. A member is "c" for a constant; "a" or "r" (read-only) for an
 * attribute, then "u" when it is unforgeable and "l" when its getter is
 * lenient about this; "o" and the count of required arguments for an
 * operation. After a colon come what the value or each argument must be:
 * an interface's name, or "Function", "?" after it when null is allowed,
 * "~" before it when anything else becomes a string, "..." before the
 * last when it repeats, and nothing when the engine converts it.
 */

import type {IdlInterface} from "../internal/webidl.ts";

export const DOM_INTERFACES: Readonly<Record<string, IdlInterface>> = {
${lines.join("\n")}
};
`;

const outPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../src/generated/domidl.ts",
);
writeFileSync(outPath, output);
execFileSync("npx", ["eslint", "--fix", outPath], {stdio: "inherit"});
console.log(`wrote ${entries.size} interfaces to ${outPath}`);
