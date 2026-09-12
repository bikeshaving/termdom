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

import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const properties = require("mdn-data/css/properties.json") as Record<
	string,
	{
		computed: string | string[];
		initial: string | string[];
		inherited: boolean;
		syntax: string;
	}
>;
const syntaxes = require("mdn-data/css/syntaxes.json") as Record<
	string,
	{syntax: string}
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

// The property index describes font-variant's longhands in prose only.
// css-fonts-4 §6.1 names them in this order. Set here so that `font`,
// which contains font-variant, flattens through it.
directLonghands.set("font-variant", [
	"font-variant-ligatures",
	"font-variant-caps",
	"font-variant-alternates",
	"font-variant-numeric",
	"font-variant-east-asian",
	"font-variant-position",
	"font-variant-emoji",
]);

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
		initial.includes(" ") && /^[a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]/.test(initial)
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
	].filter((descriptor) => !descriptor.includes("(")).sort();
	if (names.length > 0) {
		descriptors[name] = names;
	}
}

/** The longhands the property index marks as inherited. */
const inherited = longhands.filter((name) => properties[name].inherited);

/**
 * A property's grammar with the `<'property'>` references it makes
 * replaced by those properties' own grammars.
 */
function expandSyntax(syntax: string, depth = 0): string {
	if (depth > 8) {
		return syntax;
	}
	return syntax.replace(/<'([^']+)'>/g, (reference, name: string) =>
		name in properties
			? `[ ${expandSyntax(properties[name].syntax, depth + 1)} ]`
			: reference,
	);
}

/**
 * The longhands whose value is a color: their grammar names `<color>` and
 * no other type.
 */
const colors = longhands.filter((name) => {
	const types = [
		...expandSyntax(properties[name].syntax).matchAll(/<([a-z-]+)>/g),
	]
		.map((match) => match[1]);
	return types.length > 0 && types.every((type) => type === "color");
});

/**
 * The keywords a grammar production accepts, following the productions it
 * names. Function names and types are not keywords.
 */
function keywordsOf(name: string, seen = new Set<string>()): string[] {
	if (seen.has(name)) {
		return [];
	}
	seen.add(name);
	const syntax = syntaxes[name]?.syntax ?? properties[name]?.syntax;
	if (syntax === undefined) {
		return [];
	}
	const out: string[] = [];
	for (const token of syntax.split(/[\s|[\]&#!?*+,{}()]+/)) {
		const reference = /^<'?([a-z-]+)'?(?:\(\))?>$/.exec(token);
		if (reference) {
			out.push(...keywordsOf(reference[1], seen));
		} else if (/^[a-z][a-z-]*$/.test(token)) {
			out.push(token);
		}
	}
	return [...new Set(out)];
}

/**
 * The named-color table of CSS Color 4 §6.1, which the grammar index names
 * without giving the values. Written out here, since no index carries it,
 * and checked against the grammar's names on every run.
 */
const NAMED_COLOR_VALUES: Readonly<Record<string, number>> = {
	aliceblue: 0xf0f8ff,
	antiquewhite: 0xfaebd7,
	aqua: 0x00ffff,
	aquamarine: 0x7fffd4,
	azure: 0xf0ffff,
	beige: 0xf5f5dc,
	bisque: 0xffe4c4,
	black: 0x000000,
	blanchedalmond: 0xffebcd,
	blue: 0x0000ff,
	blueviolet: 0x8a2be2,
	brown: 0xa52a2a,
	burlywood: 0xdeb887,
	cadetblue: 0x5f9ea0,
	chartreuse: 0x7fff00,
	chocolate: 0xd2691e,
	coral: 0xff7f50,
	cornflowerblue: 0x6495ed,
	cornsilk: 0xfff8dc,
	crimson: 0xdc143c,
	cyan: 0x00ffff,
	darkblue: 0x00008b,
	darkcyan: 0x008b8b,
	darkgoldenrod: 0xb8860b,
	darkgray: 0xa9a9a9,
	darkgreen: 0x006400,
	darkgrey: 0xa9a9a9,
	darkkhaki: 0xbdb76b,
	darkmagenta: 0x8b008b,
	darkolivegreen: 0x556b2f,
	darkorange: 0xff8c00,
	darkorchid: 0x9932cc,
	darkred: 0x8b0000,
	darksalmon: 0xe9967a,
	darkseagreen: 0x8fbc8f,
	darkslateblue: 0x483d8b,
	darkslategray: 0x2f4f4f,
	darkslategrey: 0x2f4f4f,
	darkturquoise: 0x00ced1,
	darkviolet: 0x9400d3,
	deeppink: 0xff1493,
	deepskyblue: 0x00bfff,
	dimgray: 0x696969,
	dimgrey: 0x696969,
	dodgerblue: 0x1e90ff,
	firebrick: 0xb22222,
	floralwhite: 0xfffaf0,
	forestgreen: 0x228b22,
	fuchsia: 0xff00ff,
	gainsboro: 0xdcdcdc,
	ghostwhite: 0xf8f8ff,
	gold: 0xffd700,
	goldenrod: 0xdaa520,
	gray: 0x808080,
	green: 0x008000,
	greenyellow: 0xadff2f,
	grey: 0x808080,
	honeydew: 0xf0fff0,
	hotpink: 0xff69b4,
	indianred: 0xcd5c5c,
	indigo: 0x4b0082,
	ivory: 0xfffff0,
	khaki: 0xf0e68c,
	lavender: 0xe6e6fa,
	lavenderblush: 0xfff0f5,
	lawngreen: 0x7cfc00,
	lemonchiffon: 0xfffacd,
	lightblue: 0xadd8e6,
	lightcoral: 0xf08080,
	lightcyan: 0xe0ffff,
	lightgoldenrodyellow: 0xfafad2,
	lightgray: 0xd3d3d3,
	lightgreen: 0x90ee90,
	lightgrey: 0xd3d3d3,
	lightpink: 0xffb6c1,
	lightsalmon: 0xffa07a,
	lightseagreen: 0x20b2aa,
	lightskyblue: 0x87cefa,
	lightslategray: 0x778899,
	lightslategrey: 0x778899,
	lightsteelblue: 0xb0c4de,
	lightyellow: 0xffffe0,
	lime: 0x00ff00,
	limegreen: 0x32cd32,
	linen: 0xfaf0e6,
	magenta: 0xff00ff,
	maroon: 0x800000,
	mediumaquamarine: 0x66cdaa,
	mediumblue: 0x0000cd,
	mediumorchid: 0xba55d3,
	mediumpurple: 0x9370db,
	mediumseagreen: 0x3cb371,
	mediumslateblue: 0x7b68ee,
	mediumspringgreen: 0x00fa9a,
	mediumturquoise: 0x48d1cc,
	mediumvioletred: 0xc71585,
	midnightblue: 0x191970,
	mintcream: 0xf5fffa,
	mistyrose: 0xffe4e1,
	moccasin: 0xffe4b5,
	navajowhite: 0xffdead,
	navy: 0x000080,
	oldlace: 0xfdf5e6,
	olive: 0x808000,
	olivedrab: 0x6b8e23,
	orange: 0xffa500,
	orangered: 0xff4500,
	orchid: 0xda70d6,
	palegoldenrod: 0xeee8aa,
	palegreen: 0x98fb98,
	paleturquoise: 0xafeeee,
	palevioletred: 0xdb7093,
	papayawhip: 0xffefd5,
	peachpuff: 0xffdab9,
	peru: 0xcd853f,
	pink: 0xffc0cb,
	plum: 0xdda0dd,
	powderblue: 0xb0e0e6,
	purple: 0x800080,
	rebeccapurple: 0x663399,
	red: 0xff0000,
	rosybrown: 0xbc8f8f,
	royalblue: 0x4169e1,
	saddlebrown: 0x8b4513,
	salmon: 0xfa8072,
	sandybrown: 0xf4a460,
	seagreen: 0x2e8b57,
	seashell: 0xfff5ee,
	sienna: 0xa0522d,
	silver: 0xc0c0c0,
	skyblue: 0x87ceeb,
	slateblue: 0x6a5acd,
	slategray: 0x708090,
	slategrey: 0x708090,
	snow: 0xfffafa,
	springgreen: 0x00ff7f,
	steelblue: 0x4682b4,
	tan: 0xd2b48c,
	teal: 0x008080,
	thistle: 0xd8bfd8,
	tomato: 0xff6347,
	turquoise: 0x40e0d0,
	violet: 0xee82ee,
	wheat: 0xf5deb3,
	white: 0xffffff,
	whitesmoke: 0xf5f5f5,
	yellow: 0xffff00,
	yellowgreen: 0x9acd32,
};

const namedColors: Record<string, number> = {};
for (const name of keywordsOf("named-color")) {
	const color = NAMED_COLOR_VALUES[name];
	if (color === undefined) {
		throw new Error(`The grammar names a color the table lacks: ${name}`);
	}
	namedColors[name] = color;
}
for (const name of Object.keys(NAMED_COLOR_VALUES)) {
	if (!(name in namedColors)) {
		throw new Error(`The table has a color the grammar does not name: ${name}`);
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

function hexRecord(values: Record<string, number>): string {
	return Object.keys(values)
		.sort()
		.map((key) => `\t${key}: 0x${values[key].toString(16).padStart(6, "0")},`)
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

/** The longhands that inherit. */
export const CSS_INHERITED_PROPERTIES: readonly string[] = [
${list(inherited)}
];

/** The longhands whose value is a color. */
export const CSS_COLOR_PROPERTIES: readonly string[] = [
${list(colors)}
];

/** Each named color as packed RGB, per CSS Color 4. */
export const CSS_NAMED_COLORS: Readonly<Record<string, number>> = {
${hexRecord(namedColors)}
};

/** The \`<line-style>\` keywords. */
export const CSS_LINE_STYLES: readonly string[] = [
${list(keywordsOf("line-style"))}
];

/** The easing function keywords, which name a function without arguments. */
export const CSS_EASING_KEYWORDS: readonly string[] = [
${list(keywordsOf("easing-function"))}
];

/** The generic font family names. */
export const CSS_GENERIC_FAMILIES: readonly string[] = [
${list(keywordsOf("generic-family"))}
];
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
