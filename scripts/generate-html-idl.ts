/**
 * Regenerate src/generated/htmlidl.ts from webref.
 *
 * @webref/idl carries the HTML Standard's IDL, whose Reflect extended
 * attributes say which IDL attributes reflect a content attribute and how:
 * the attribute's name where it differs, a URL, a default, a range. Those
 * become ReflectSpecs. @webref/elements maps each tag to its interface. The
 * event handler and ARIA mixins are read from the same IDL.
 *
 * Run: node --experimental-strip-types scripts/generate-html-idl.ts
 */

import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {parse} from "webidl2";

const require = createRequire(import.meta.url);
const idlDir = dirname(require.resolve("@webref/idl/package.json"));
const elements = require("@webref/elements/html.json") as {
	elements: Array<{name: string; interface: string}>;
};

interface Attribute {
	name: string;
	type: string;
	nullable: boolean;
	readonly: boolean;
	extended: Record<string, string | true>;
}

interface Definition {
	spec: string;
	type: string;
	name: string;
	partial: boolean;
	target?: string;
	includes?: string;
	attributes: Attribute[];
}

// The specs whose partials this DOM has a notion of. A handler from a
// spec outside the list would be a property that nothing ever fires.
const HANDLER_SPECS = new Set([
	"html",
	"pointerevents",
	"css-animations",
	"css-transitions",
	"selection-api",
	"fullscreen",
]);

function typeName(type: unknown): string {
	const t = type as {idlType: unknown; generic?: string};
	if (typeof t.idlType === "string") {
		return t.idlType;
	}
	if (Array.isArray(t.idlType)) {
		const inner = t.idlType.map(typeName).join(", ");
		return t.generic ? `${t.generic}<${inner}>` : inner;
	}
	return typeName(t.idlType);
}

const definitions: Definition[] = [];
for (const file of readdirSync(idlDir)) {
	if (!file.endsWith(".idl")) {
		continue;
	}
	const spec = file.slice(0, -".idl".length);
	for (const definition of parse(readFileSync(join(idlDir, file), "utf8"))) {
		const d = definition as unknown as {
			type: string;
			name?: string;
			partial?: boolean;
			target?: string;
			includes?: string;
			members?: unknown[];
		};
		definitions.push({
			spec,
			type: d.type,
			name: d.name ?? "",
			partial: d.partial ?? false,
			target: d.target,
			includes: d.includes,
			attributes: (d.members ?? [])
				.filter((m) => (m as {type: string}).type === "attribute")
				.map((m) => {
					const a = m as {
						name: string;
						idlType: {nullable: boolean};
						readonly: boolean;
						extAttrs: Array<{name: string; rhs: {value: unknown} | null}>;
					};
					return {
						name: a.name,
						type: typeName(a.idlType),
						nullable: a.idlType.nullable,
						readonly: a.readonly,
						extended: Object.fromEntries(
							a.extAttrs.map((e) => [
								e.name,
								e.rhs && typeof e.rhs.value === "string"
									? e.rhs.value.replace(/^"|"$/g, "")
									: e.rhs && Array.isArray(e.rhs.value)
										? e.rhs.value
											.map((v) => (v as {value: string}).value)
											.join(",")
										: true,
							]),
						),
					};
				}),
		});
	}
}

// An interface's attributes with its partials' and its mixins', all from
// the specs named.
function attributesOf(
	name: string,
	specs: ReadonlySet<string>,
	withMixins = true,
): Attribute[] {
	const own = definitions.filter(
		(d) =>
			specs.has(d.spec) &&
			(d.type === "interface" || d.type === "interface mixin") &&
			d.name === name,
	);
	const mixins = withMixins
		? definitions
			.filter(
				(d) => specs.has(d.spec) && d.type === "includes" && d.target === name,
			)
			.map((d) => d.includes!)
		: [];
	return [
		...own.flatMap((d) => d.attributes),
		...mixins.flatMap((mixin) => attributesOf(mixin, specs)),
	];
}

const HTML = new Set(["html"]);

type Reflection = Record<string, string | number | boolean>;

// What a Reflect annotation says, as a ReflectSpec. Null for an attribute
// whose reflection this DOM writes out by hand: a ReflectSetter has its own
// setter algorithm, and an element or a double reflects through prose.
function reflectionOf(attribute: Attribute): Reflection | null {
	const e = attribute.extended;
	const reflects = Object.keys(e).some(
		(key) => key.startsWith("Reflect") && key !== "ReflectSetter",
	);
	if (!reflects || e.ReflectSetter) {
		return null;
	}
	const spec: Reflection = {
		property: attribute.name,
		attribute:
			typeof e.Reflect === "string" ? e.Reflect : attribute.name.toLowerCase(),
	};
	const fallback = e.ReflectDefault === undefined
		? null
		: Number(e.ReflectDefault);
	switch (attribute.type) {
		case "DOMString":
		case "USVString":
			spec.kind = e.ReflectURL ? "url" : "string";
			break;
		case "boolean":
			spec.kind = "boolean";
			break;
		case "long":
			spec.kind = "long";
			// A non-negative long reports -1 when the attribute is missing.
			spec.fallback = fallback ?? (e.ReflectNonNegative ? -1 : 0);
			spec.nonNegative = e.ReflectNonNegative === true;
			break;
		case "unsigned long": {
			spec.kind = "unsigned-long";
			const positive =
				e.ReflectPositive === true || e.ReflectPositiveWithFallback === true;
			spec.fallback = fallback ?? (positive ? 1 : 0);
			if (positive) {
				spec.greaterThanZero = true;
			}
			if (typeof e.ReflectRange === "string") {
				const [min, max] = e.ReflectRange.split(",").map(Number);
				spec.clampMin = min;
				spec.clampMax = max;
			}
			break;
		}
		case "DOMTokenList":
			spec.kind = "tokenlist";
			break;
		default:
			return null;
	}
	return spec;
}

const interfaces = definitions
	.filter(
		(d) =>
			d.spec === "html" &&
			d.type === "interface" &&
			!d.partial &&
			/^HTML\w*Element$/.test(d.name),
	)
	.map((d) => d.name)
	.sort();

const reflections: Record<string, Reflection[]> = {};
for (const name of interfaces) {
	const specs = attributesOf(name, HTML)
		.map(reflectionOf)
		.filter((spec): spec is Reflection => spec !== null);
	if (specs.length > 0) {
		reflections[name] = specs;
	}
}

const tagInterfaces: Record<string, string> = {};
for (const element of elements.elements) {
	tagInterfaces[element.name] = element.interface;
}

const aria = attributesOf("ARIAMixin", new Set(["wai-aria"]));
const ariaAttribute = (attribute: Attribute): string =>
	typeof attribute.extended.Reflect === "string"
		? attribute.extended.Reflect
		: attribute.name.toLowerCase();
const ariaStrings = aria
	.filter((a) => a.type === "DOMString")
	.map((a) => [a.name, ariaAttribute(a)] as const);
const ariaElements = aria
	.filter((a) => a.type !== "DOMString")
	.map(
		(
			a,
		) => [a.name, ariaAttribute(a), a.type.startsWith("FrozenArray")] as const,
	);

function handlers(
	name: string,
	specs: ReadonlySet<string>,
	withMixins = true,
): string[] {
	return attributesOf(name, specs, withMixins)
		.map((a) => a.name)
		.filter((n) => n.startsWith("on"))
		.sort();
}

const globalHandlers = handlers("GlobalEventHandlers", HANDLER_SPECS);
const windowHandlers = handlers("WindowEventHandlers", HTML);
const documentHandlers = handlers("Document", HANDLER_SPECS, false);

function list(values: readonly string[]): string {
	return values.map((value) => `\t${JSON.stringify(value)},`).join("\n");
}

function record(values: Record<string, unknown>): string {
	return Object.keys(values)
		.sort()
		.map((key) => `\t${JSON.stringify(key)}: ${JSON.stringify(values[key])},`)
		.join("\n");
}

const source = `/**
 * The HTML element tables, generated from webref by
 * scripts/generate-html-idl.ts. Do not edit by hand.
 */

import type {ReflectSpec} from "../internal/reflection.ts";

/** Each tag's interface, per the HTML Standard's element index. */
export const HTML_TAG_INTERFACES: Readonly<Record<string, string>> = {
${record(tagInterfaces)}
};

/**
 * Each interface's reflected attributes, from the IDL's Reflect
 * annotations. An attribute with its own setter algorithm, an enumerated
 * attribute, and one reflecting an element or a number with a unit are
 * not here: their rules are prose, and reflection.ts writes them out.
 */
export const HTML_REFLECTIONS: Readonly<
	Record<string, readonly ReflectSpec[]>
> = {
${record(reflections)}
};

/** Every aria-* attribute reflected as a nullable string. */
export const ARIA_STRING_REFLECTIONS: ReadonlyArray<readonly [string, string]> =
	${JSON.stringify(ariaStrings)};

/** The aria-* attributes reflected as an element or a list of them. */
export const ARIA_ELEMENT_REFLECTIONS: ReadonlyArray<
	readonly [string, string, boolean]
> = ${JSON.stringify(ariaElements)};

/** GlobalEventHandlers, with the partials of the specs this DOM implements. */
export const GLOBAL_EVENT_HANDLERS: readonly string[] = [
${list(globalHandlers)}
];

/** WindowEventHandlers. A body or frameset forwards these to its window. */
export const WINDOW_EVENT_HANDLERS: readonly string[] = [
${list(windowHandlers)}
];

/** The handlers on Document alone. */
export const DOCUMENT_EVENT_HANDLERS: readonly string[] = [
${list(documentHandlers)}
];
`;

const out = fileURLToPath(
	new URL("../src/generated/htmlidl.ts", import.meta.url),
);
writeFileSync(out, source);
execFileSync("npx", ["eslint", "--fix", out], {stdio: "inherit"});
process.stdout.write(
	`${Object.keys(tagInterfaces).length} tags, ${
		Object.values(reflections).flat().length
	} reflections on ${Object.keys(reflections).length} interfaces, ${
		globalHandlers.length
	} global handlers\n`,
);
