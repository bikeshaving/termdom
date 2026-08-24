/**
 * Regenerate src/generated/cssproperties.ts from mdn-data.
 *
 * mdn-data's css/properties.json is the CSS property index: every property, its
 * initial value, whether it inherits, and -- for a shorthand -- the longhands it
 * maps to (the `computed` array). CSSOM's supported-property surface is
 * generated from it rather than typed out, so the accessor set, the shorthand
 * table and the initial values all come from one source.
 *
 * Run: node --experimental-strip-types scripts/generate-css-properties.ts
 */

import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const properties = require("mdn-data/css/properties.json") as Record<
	string,
	{
		computed: string | string[];
		initial: string | string[];
		inherited: boolean;
	}
>;
const atRules = require("mdn-data/css/at-rules.json") as Record<
	string,
	{descriptors?: Record<string, unknown>}
>;

/**
 * A property is supported when it is unprefixed -- including the ones the
 * index marks obsolete, since `clip` and `page-break-after` are properties
 * every engine still answers to -- or when it carries the `-webkit-` prefix
 * browsers ship. Vendor prefixes no engine implements (`-ms-`, `-moz-`) and
 * the custom-property placeholder are not properties an author can name.
 */
function isSupported(name: string): boolean {
	if (name === "--*") {
		return false;
	}
	if (name.startsWith("-webkit-")) {
		return true;
	}
	return !name.startsWith("-");
}

const supported = Object.keys(properties).filter(isSupported).sort();

const directLonghands = new Map<string, string[]>();
for (const name of supported) {
	const computed = properties[name].computed;
	if (Array.isArray(computed)) {
		directLonghands.set(name, computed);
	}
}

/** A shorthand's longhands, with nested shorthands (`border`) flattened out. */
function flatten(name: string, seen = new Set<string>()): string[] {
	const direct = directLonghands.get(name);
	if (!direct || seen.has(name)) {
		return [name];
	}
	seen.add(name);
	const out: string[] = [];
	for (const part of direct) {
		if (!supported.includes(part)) {
			continue;
		}
		for (const leaf of flatten(part, seen)) {
			if (!out.includes(leaf)) {
				out.push(leaf);
			}
		}
	}
	return out.length > 0 ? out : [name];
}

const shorthands: Record<string, string[]> = {};
for (const name of directLonghands.keys()) {
	const longhands = flatten(name);
	if (longhands.length > 1 || longhands[0] !== name) {
		shorthands[name] = longhands;
	}
}

/**
 * Shorthands whose longhand order the property index states from an older
 * level of the spec. CSS UI 4 writes `outline` as `<'outline-color'> ||
 * <'outline-style'> || <'outline-width'>`, and a shorthand serializes in the
 * order its grammar names its components.
 */
const grammarOrder: Record<string, string[]> = {
	outline: ["outline-color", "outline-style", "outline-width"],
};
for (const [shorthand, order] of Object.entries(grammarOrder)) {
	shorthands[shorthand] = order;
}

/**
 * The longhands a shorthand resets without being able to state them: `border`
 * resets the border-image longhands, so a block serializes as `border` only
 * when all five stand at their initial values. The property index says so in
 * prose rather than in the `computed` array, so it is named here.
 */
const resetOnly: Record<string, string[]> = {
	border: shorthands["border-image"],
};
for (const [shorthand, reset] of Object.entries(resetOnly)) {
	shorthands[shorthand] = [...shorthands[shorthand], ...reset];
}

/**
 * A computed style enumerates its properties in lexicographic order, with the
 * vendor-prefixed ones after the rest: a name beginning with `-` sorts after
 * every name that does not.
 */
function propertyOrder(a: string, b: string): number {
	if (a.startsWith("-") !== b.startsWith("-")) {
		return a.startsWith("-") ? 1 : -1;
	}
	return a < b ? -1 : 1;
}

const longhands = supported
	.filter((name) => name !== "all" && !(name in shorthands))
	.sort(propertyOrder);

// `all` resets every longhand except the two that carry a document's writing
// direction, which it is defined to leave alone. Its mdn-data entry describes
// the behaviour in prose rather than as a longhand list.
shorthands["all"] = longhands.filter(
	(name) => name !== "direction" && name !== "unicode-bidi",
);

/**
 * Initial values, for the longhands whose mdn-data initial is a value rather
 * than a prose description ("see individual properties").
 */
const initials: Record<string, string> = {};
for (const name of longhands) {
	const initial = properties[name].initial;
	if (typeof initial !== "string") {
		continue;
	}
	if (/[A-Z]/.test(initial) && !initial.includes(" ")) {
		continue;
	}
	if (
		initial.includes(" ") &&
		/^[a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]/.test(initial)
	) {
		continue;
	}
	initials[name] = initial;
}

/**
 * The descriptors each at-rule's block may hold. A descriptor is not a
 * property -- it is named only inside its own at-rule -- so it gets its
 * accessors on that rule's own declaration block and nowhere else.
 */
const descriptors: Record<string, string[]> = {};
/**
 * Descriptors the property index leaves out. css-page-3 gives @page's block
 * the page margins alongside its own descriptors, so they are named on
 * CSSPageDescriptors and nowhere the index would put them.
 */
const extraDescriptors: Record<string, string[]> = {
	"@page": [
		"margin",
		"margin-top",
		"margin-right",
		"margin-bottom",
		"margin-left",
	],
};
for (const name of new Set([
	...Object.keys(atRules),
	...Object.keys(extraDescriptors),
])) {
	const names = [
		...Object.keys(atRules[name]?.descriptors ?? {}),
		...(extraDescriptors[name] ?? []),
	]
		.filter((descriptor) => !descriptor.includes("("))
		.sort();
	if (names.length > 0) {
		descriptors[name] = names;
	}
}

function list(values: readonly string[]): string {
	return values.map((value) => `\t${JSON.stringify(value)},`).join("\n");
}

function record(values: Record<string, string | string[]>): string {
	return Object.keys(values)
		.sort()
		.map((key) => `\t${JSON.stringify(key)}: ${JSON.stringify(values[key])},`)
		.join("\n");
}

const source = `/**
 * The CSS property index, generated from mdn-data by
 * scripts/generate-css-properties.ts. Do not edit by hand.
 *
 * CSSOM's supported CSS properties are exactly the names in CSS_PROPERTIES:
 * every one gets a camel-cased (and dashed, and webkit-cased) accessor on
 * CSSStyleDeclaration, and every longhand is enumerated by a computed style.
 */

/** Supported properties that are not shorthands, in lexicographic order. */
export const CSS_LONGHANDS: readonly string[] = [
${list(longhands)}
];

/** Each shorthand's longhands, in the order the shorthand's grammar names them. */
export const CSS_SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
${record(shorthands)}
};

/** Every supported property: the longhands and the shorthand names. */
export const CSS_PROPERTIES: readonly string[] = [
	...CSS_LONGHANDS,
	...Object.keys(CSS_SHORTHANDS),
].sort();

/** The longhands a shorthand resets but cannot state, per shorthand. */
export const CSS_RESET_ONLY_LONGHANDS: Readonly<
	Record<string, readonly string[]>
> = {
${record(resetOnly)}
};

/** Each at-rule's descriptors, which its own declaration block reflects. */
export const CSS_AT_RULE_DESCRIPTORS: Readonly<
	Record<string, readonly string[]>
> = {
${record(descriptors)}
};


/** Each longhand's initial value, where the property index states one. */
export const CSS_INITIAL_VALUES: Readonly<Record<string, string>> = {
${record(initials)}
};
`;

const out = fileURLToPath(
	new URL("../src/generated/cssproperties.ts", import.meta.url),
);
writeFileSync(out, source);
// The emitted file must be canonical -- CI diffs it against a fresh run,
// so formatting cannot be optional or the artifact forks from its
// generator. eslint is the project's one formatter; a failure here is a
// failure of the generation, not a shrug.
execFileSync("npx", ["eslint", "--fix", out], {stdio: "inherit"});
process.stdout.write(
	`${supported.length} properties, ${longhands.length} longhands, ${
		Object.keys(shorthands).length
	} shorthands -> ${out}\n`,
);
