/**
 * Regenerate src/internal/cssproperties.ts from mdn-data.
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
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const properties = require("mdn-data/css/properties.json") as Record<
	string,
	{
		computed: string | string[];
		initial: string | string[];
		inherited: boolean;
		status: string;
	}
>;

/**
 * A property is supported when it is standard or experimental, or when it
 * carries the `-webkit-` prefix browsers ship regardless of standing. Vendor
 * prefixes no engine implements (`-ms-`, `-moz-`) and the custom-property
 * placeholder are not properties an author can name.
 */
function isSupported(name: string, status: string): boolean {
	if (name === "--*") return false;
	if (name.startsWith("-webkit-")) return true;
	if (name.startsWith("-")) return false;
	return status === "standard" || status === "experimental";
}

const supported = Object.keys(properties)
	.filter((name) => isSupported(name, properties[name].status))
	.sort();

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
	if (!direct || seen.has(name)) return [name];
	seen.add(name);
	const out: string[] = [];
	for (const part of direct) {
		if (!supported.includes(part)) continue;
		for (const leaf of flatten(part, seen)) {
			if (!out.includes(leaf)) out.push(leaf);
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

const longhands = supported.filter((name) => !(name in shorthands));

// `all` is the shorthand of every longhand that is not a custom property. Its
// mdn-data entry describes the behaviour in prose rather than a longhand list.
shorthands["all"] = longhands.slice();

const inherited = longhands.filter((name) => properties[name].inherited);

/**
 * Initial values, for the longhands whose mdn-data initial is a value rather
 * than a prose description ("see individual properties").
 */
const initials: Record<string, string> = {};
for (const name of longhands) {
	const initial = properties[name].initial;
	if (typeof initial !== "string") continue;
	if (/[A-Z]/.test(initial) && !initial.includes(" ")) continue;
	if (
		initial.includes(" ") &&
		/^[a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]/.test(initial)
	)
		continue;
	initials[name] = initial;
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

/** Every supported property, shorthands included, in lexicographic order. */
export const CSS_PROPERTIES: readonly string[] = [
${list(supported)}
];

/** Supported properties that are not shorthands, in lexicographic order. */
export const CSS_LONGHANDS: readonly string[] = [
${list(longhands)}
];

/** Each shorthand's longhands, in the order the shorthand's grammar names them. */
export const CSS_SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
${record(shorthands)}
};

/** Longhands whose value inherits from the parent element. */
export const CSS_INHERITED_PROPERTIES: readonly string[] = [
${list(inherited)}
];

/** Each longhand's initial value, where the property index states one. */
export const CSS_INITIAL_VALUES: Readonly<Record<string, string>> = {
${record(initials)}
};
`;

const out = fileURLToPath(
	new URL("../src/internal/cssproperties.ts", import.meta.url),
);
const prettier = require("prettier") as {
	format(source: string, options: object): Promise<string>;
	resolveConfig(path: string): Promise<object | null>;
};
writeFileSync(
	out,
	await prettier.format(source, {
		...((await prettier.resolveConfig(out)) ?? {}),
		parser: "typescript",
		useTabs: true,
		bracketSpacing: false,
	}),
);
process.stdout.write(
	`${supported.length} properties, ${longhands.length} longhands, ${
		Object.keys(shorthands).length
	} shorthands -> ${out}\n`,
);
