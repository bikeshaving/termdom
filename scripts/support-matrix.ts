/**
 * Generate SUPPORT.md by MEASURING what the engine does.
 *
 *   bun scripts/support-matrix.ts          # rewrite SUPPORT.md
 *   bun scripts/support-matrix.ts --check  # fail if it is out of date
 *
 * A hand-maintained support table is a promise that decays: the code moves and
 * the table does not, and nobody notices until a user does. So nothing here is
 * asserted. Each feature carries a probe, the probe runs against a real TermDOM
 * rendering to a real terminal buffer, and the answer in the table is whatever
 * came back this run.
 *
 * The CSS property list is mdn-data's, so "what is there to support" comes from
 * the platform rather than from our memory of it. The test values below are
 * fixtures -- inputs chosen so a property has an observable effect if it works
 * at all -- and they claim nothing on their own.
 *
 * A property counts as supported when setting it changes something a user could
 * see: the geometry of the box or its neighbour, or the cells painted. That is
 * deliberately behavioural. A property termdom parses and stores but never acts
 * on is not support, and this will say so.
 *
 * The package.json script runs this under BUN_JSC_useFTLJIT=false: at this
 * probe count, Bun's top JIT tier miscompiles a loop in cssstyle's value
 * parser into an infinite allocating spin (oven-sh/bun#36798). The flag costs
 * a few seconds; remove it when the upstream fix ships. The per-probe
 * watchdog below exists for the same reason in reverse -- if a probe ever
 * stalls again, fail loudly with its name instead of dying silently.
 */

import {writeFileSync, readFileSync} from "node:fs";
import {join} from "node:path";
import properties from "mdn-data/css/properties.json" with {type: "json"};
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "../tests/test-utils.js";

const ROOT = join(import.meta.dirname, "..");

/**
 * Test values, by property. A value has to be one whose effect is visible on a
 * character grid: `color: red` is observable, `color: #010101` is not, because
 * the terminal quantises it back to where it started.
 *
 * Absence from this table means "we have no way to observe this one", which is
 * reported as untested rather than unsupported -- the two are not the same
 * claim, and conflating them is how a support table starts lying.
 */
interface Feature {
	/** The declaration under test. */
	value: string;
	/** Which box it goes on. Container properties belong on the parent. */
	target?: "probe" | "parent";
	/**
	 * Context present in BOTH runs, so the diff isolates the property. Most
	 * properties do nothing without it: `top` needs `position`, every flex item
	 * property needs a flex container, and `white-space` needs text long enough
	 * to wrap. Probing without context reports the whole of flexbox as missing.
	 */
	setup?: string;
	/** Text to put inside #probe, when the property needs something to act on. */
	text?: string;
	/** Whole-document override, for properties that need real structure. */
	markup?: string;
}

const LONG = "the quick brown fox jumps over the lazy dog again and again";
const FLEX = "#parent { display: flex; }";
const NARROW = "#probe { width: 10ch; }";

const FEATURES: Record<string, Feature> = {
	// Box model
	width: {value: "12ch"},
	height: {value: "4px"},
	"min-width": {value: "20ch", setup: NARROW},
	"min-height": {value: "5px"},
	"max-width": {value: "3ch", setup: NARROW},
	"max-height": {value: "1px", setup: "#probe { height: 5px; }"},
	padding: {value: "1px 2ch"},
	"padding-top": {value: "2px"},
	"padding-right": {value: "3ch", setup: NARROW},
	"padding-bottom": {value: "2px"},
	"padding-left": {value: "3ch"},
	margin: {value: "1px 2ch"},
	"margin-top": {value: "2px"},
	"margin-right": {value: "3ch", setup: `${FLEX} #probe { width: 10ch; }`},
	"margin-bottom": {value: "2px"},
	"margin-left": {value: "3ch"},
	border: {value: "1px solid red"},
	"border-width": {value: "1px", setup: "#probe { border-style: solid; }"},
	"border-style": {value: "solid", setup: "#probe { border-width: 1px; }"},
	"border-color": {value: "red", setup: "#probe { border: 1px solid; }"},
	"border-top": {value: "1px solid red"},
	"border-right": {value: "1px solid red"},
	"border-bottom": {value: "1px solid red"},
	"border-left": {value: "1px solid red"},
	"box-sizing": {
		value: "border-box",
		setup: "#probe { width: 12ch; padding: 0 2ch; border: 1px solid; }",
	},

	// Display and positioning
	display: {value: "none"},
	position: {value: "absolute"},
	top: {value: "3px", setup: "#probe { position: absolute; }"},
	right: {value: "2ch", setup: "#probe { position: absolute; }"},
	bottom: {value: "1px", setup: "#probe { position: absolute; }"},
	left: {value: "4ch", setup: "#probe { position: absolute; }"},
	"z-index": {
		value: "5",
		setup:
			"#probe, #sibling { position: absolute; top: 0; left: 0; width: 8ch; }" +
			" #probe { background-color: red; } #sibling { background-color: blue; }",
	},
	float: {value: "right"},
	clear: {value: "both", setup: "#probe { float: left; }"},
	overflow: {value: "hidden", setup: NARROW, markup: undefined},
	"overflow-x": {value: "hidden", setup: NARROW},
	"overflow-y": {value: "hidden", setup: "#probe { height: 1px; }"},
	visibility: {value: "hidden"},

	// Flexbox -- container properties on the parent, item properties on the item
	"flex-direction": {value: "column", target: "parent", setup: FLEX},
	"flex-wrap": {
		value: "wrap",
		target: "parent",
		setup: `${FLEX} #probe, #sibling { width: 30ch; }`,
	},
	"flex-grow": {value: "1", setup: FLEX},
	"flex-shrink": {
		value: "0",
		setup: `${FLEX} #probe, #sibling { width: 30ch; }`,
	},
	"flex-basis": {value: "8ch", setup: FLEX},
	flex: {value: "1 0 8ch", setup: FLEX},
	"justify-content": {value: "flex-end", target: "parent", setup: FLEX},
	"align-items": {
		value: "flex-end",
		target: "parent",
		setup: `${FLEX} #parent { height: 6px; }`,
	},
	"align-self": {
		value: "flex-end",
		setup: `${FLEX} #parent { height: 6px; }`,
	},
	"align-content": {
		value: "flex-end",
		target: "parent",
		setup: `${FLEX} #parent { height: 8px; flex-wrap: wrap; } #probe, #sibling { width: 30ch; }`,
	},
	order: {value: "2", setup: FLEX},
	gap: {value: "2px", target: "parent", setup: FLEX},
	"row-gap": {
		value: "2px",
		target: "parent",
		setup: `${FLEX} #parent { flex-direction: column; }`,
	},
	"column-gap": {value: "2ch", target: "parent", setup: FLEX},

	// Grid -- probed so its absence is measured rather than assumed
	"grid-template-columns": {
		value: "1fr 1fr",
		target: "parent",
		setup: "#parent { display: grid; }",
	},
	"grid-template-rows": {
		value: "1fr 1fr",
		target: "parent",
		setup: "#parent { display: grid; }",
	},
	"grid-column": {value: "1 / 3", setup: "#parent { display: grid; }"},
	"grid-row": {value: "1 / 3", setup: "#parent { display: grid; }"},
	"grid-auto-flow": {
		value: "column",
		target: "parent",
		setup: "#parent { display: grid; }",
	},

	// Text and paint
	color: {value: "red"},
	"background-color": {value: "blue"},
	"font-weight": {value: "bold"},
	"font-style": {value: "italic"},
	"text-decoration": {value: "underline"},
	"text-decoration-line": {value: "underline"},
	"text-decoration-style": {
		value: "double",
		setup: "#probe { text-decoration: underline; }",
	},
	"text-transform": {value: "uppercase"},
	"text-align": {value: "right"},
	"text-indent": {value: "4ch"},
	"white-space": {value: "pre", setup: NARROW, text: LONG},
	"word-break": {value: "break-all", setup: NARROW, text: LONG},
	"overflow-wrap": {
		value: "break-word",
		setup: NARROW,
		markup: "supercalifragilisticexpialidocious",
	},
	"line-height": {value: "2"},
	direction: {value: "rtl"},
	opacity: {value: "0"},
	"font-family": {value: "monospace"},
	"font-size": {value: "2px"},
	"letter-spacing": {value: "2px"},
	"word-spacing": {value: "3px"},

	// Lists, tables, counters
	"list-style-type": {
		value: "square",
		target: "probe",
		markup:
			'<ul id="parent"><li id="probe">item</li><li id="sibling">two</li></ul>',
	},
	"list-style-position": {
		value: "inside",
		target: "probe",
		markup:
			'<ul id="parent"><li id="probe">item</li><li id="sibling">two</li></ul>',
	},
	"list-style": {
		value: "square inside",
		target: "probe",
		markup:
			'<ul id="parent"><li id="probe">item</li><li id="sibling">two</li></ul>',
	},
	"border-collapse": {
		value: "collapse",
		target: "parent",
		setup: "#parent td { border: 1px solid; }",
		markup:
			'<table id="parent"><tr><td id="probe">a</td><td id="sibling">b</td></tr></table>',
	},
	"table-layout": {
		value: "fixed",
		target: "parent",
		setup: "#parent { width: 20ch; }",
		markup:
			'<table id="parent"><tr><td id="probe">a</td><td id="sibling">bbbbbbbbbbbb</td></tr></table>',
	},
	"vertical-align": {
		value: "bottom",
		setup:
			"#probe { display: inline-block; height: 1px; }" +
			" #sibling { display: inline-block; height: 4px; }",
	},
	content: {value: '"X"'},
	"counter-reset": {value: "c 3"},
	"counter-increment": {value: "c 2"},

	// Deliberately unsupported, probed so the claim stays honest
	transform: {value: "rotate(45deg)"},
	transition: {value: "color 1s"},
	animation: {value: "spin 1s"},
	"box-shadow": {value: "1px 1px red"},
	filter: {value: "blur(1px)"},
	"aspect-ratio": {value: "1 / 1", setup: NARROW},
	cursor: {value: "pointer"},
};

/**
 * Longhands and logical properties, generated rather than typed out: they are
 * regular in both name and behaviour, so writing 60 near-identical fixtures by
 * hand would only add places to make a typo.
 */
function generatedFeatures(): Record<string, Feature> {
	const out: Record<string, Feature> = {};

	// border-<side>-<part>. Width needs a style to be visible and vice versa.
	for (const side of ["top", "right", "bottom", "left"]) {
		out[`border-${side}-width`] = {
			value: "1px",
			setup: `#probe { border-${side}-style: solid; }`,
		};
		out[`border-${side}-style`] = {
			value: "solid",
			setup: `#probe { border-${side}-width: 1px; }`,
		};
		out[`border-${side}-color`] = {
			value: "red",
			setup: `#probe { border-${side}: 1px solid; }`,
		};
	}

	// Logical box-model properties. block maps to the vertical axis and inline
	// to the horizontal one in the writing mode a terminal has.
	for (const [group, physical] of [
		["block-start", "top"],
		["block-end", "bottom"],
		["inline-start", "left"],
		["inline-end", "right"],
	]) {
		out[`margin-${group}`] = {
			value: physical === "left" || physical === "right" ? "3ch" : "2px",
		};
		out[`padding-${group}`] = {
			value: physical === "left" || physical === "right" ? "3ch" : "2px",
		};
		out[`border-${group}-width`] = {
			value: "1px",
			setup: `#probe { border-${group}-style: solid; }`,
		};
		out[`inset-${group}`] = {
			value: "2px",
			setup: "#probe { position: absolute; }",
		};
	}
	for (const axis of ["block", "inline"]) {
		out[`margin-${axis}`] = {value: axis === "inline" ? "0 3ch" : "2px 0"};
		out[`padding-${axis}`] = {value: axis === "inline" ? "0 3ch" : "2px 0"};
		out[`inset-${axis}`] = {
			value: "2px",
			setup: "#probe { position: absolute; }",
		};
	}
	out["inset"] = {value: "2px", setup: "#probe { position: absolute; }"};

	// Logical border longhands, the rest of the family.
	for (const axis of ["block", "inline"]) {
		out[`border-${axis}-width`] = {
			value: "1px",
			setup: `#probe { border-${axis}-style: solid; }`,
		};
		out[`border-${axis}-style`] = {
			value: "solid",
			setup: `#probe { border-${axis}-width: 1px; }`,
		};
		out[`border-${axis}-color`] = {
			value: "red",
			setup: `#probe { border-${axis}: 1px solid; }`,
		};
		out[`border-${axis}`] = {value: "1px solid red"};
		for (const side of ["start", "end"]) {
			out[`border-${axis}-${side}`] = {value: "1px solid red"};
			out[`border-${axis}-${side}-style`] = {
				value: "solid",
				setup: `#probe { border-${axis}-${side}-width: 1px; }`,
			};
			out[`border-${axis}-${side}-color`] = {
				value: "red",
				setup: `#probe { border-${axis}-${side}: 1px solid; }`,
			};
		}
	}

	// Logical sizing.
	out["inline-size"] = {value: "12ch"};
	out["block-size"] = {value: "4px"};
	out["min-inline-size"] = {value: "20ch", setup: NARROW};
	out["max-inline-size"] = {value: "5ch", setup: "#probe { width: 30ch; }"};
	out["min-block-size"] = {value: "5px"};
	out["max-block-size"] = {value: "1px", setup: "#probe { height: 5px; }"};

	// Shorthands and alignment that have straightforward terminal meaning.
	out["flex-flow"] = {value: "column wrap", target: "parent", setup: FLEX};
	out["place-content"] = {
		value: "flex-end",
		target: "parent",
		setup: `${FLEX} #parent { height: 6px; }`,
	};
	out["place-items"] = {
		value: "flex-end",
		target: "parent",
		setup: `${FLEX} #parent { height: 6px; }`,
	};
	out["place-self"] = {
		value: "flex-end",
		setup: `${FLEX} #parent { height: 6px; }`,
	};
	out["justify-items"] = {
		value: "flex-end",
		target: "parent",
		setup: FLEX,
	};
	out["justify-self"] = {value: "flex-end", setup: FLEX};

	// Table properties.
	out["border-spacing"] = {
		value: "2ch",
		target: "parent",
		markup:
			'<table id="parent"><tr><td id="probe">a</td><td id="sibling">b</td></tr></table>',
	};
	out["caption-side"] = {
		value: "bottom",
		target: "parent",
		markup:
			'<table id="parent"><caption id="probe">cap</caption><tr><td id="sibling">a</td></tr></table>',
	};
	out["empty-cells"] = {
		value: "hide",
		target: "parent",
		setup: "#parent td { border: 1px solid; }",
		markup:
			'<table id="parent"><tr><td id="probe"></td><td id="sibling">b</td></tr></table>',
	};

	// Text.
	out["text-align-last"] = {value: "right", setup: NARROW, text: LONG};
	out["text-decoration-color"] = {
		value: "red",
		setup: "#probe { text-decoration: underline; }",
	};
	out["text-overflow"] = {
		value: "ellipsis",
		setup: "#probe { width: 6ch; overflow: hidden; white-space: nowrap; }",
		text: LONG,
	};
	out["text-wrap"] = {value: "nowrap", setup: NARROW, text: LONG};
	out["text-wrap-mode"] = {value: "nowrap", setup: NARROW, text: LONG};
	out["white-space-collapse"] = {value: "preserve", setup: NARROW, text: LONG};
	out["word-wrap"] = {
		value: "break-word",
		setup: NARROW,
		text: "supercalifragilisticexpialidocious",
	};
	out["line-clamp"] = {value: "1", setup: NARROW, text: LONG};
	out["counter-set"] = {value: "c 3"};
	out["font"] = {value: "bold 1px monospace"};
	out["list-style-image"] = {
		value: "none",
		markup:
			'<ul id="parent"><li id="probe">item</li><li id="sibling">two</li></ul>',
	};

	// Grid, so its absence stays measured across the whole family.
	for (const name of [
		"grid",
		"grid-area",
		"grid-auto-columns",
		"grid-auto-rows",
		"grid-column-end",
		"grid-column-start",
		"grid-row-end",
		"grid-row-start",
		"grid-template",
		"grid-template-areas",
	]) {
		out[name] = {
			value:
				name === "grid-template-areas"
					? '"a" "b"'
					: name === "grid-template" || name === "grid"
						? "1fr / 1fr"
						: name.endsWith("-start") || name.endsWith("-end")
							? "1"
							: name === "grid-area"
								? "1 / 1 / 2 / 2"
								: "1fr",
			target:
				name.startsWith("grid-auto") ||
				name === "grid" ||
				name === "grid-template" ||
				name === "grid-template-areas"
					? "parent"
					: "probe",
			setup: "#parent { display: grid; }",
		};
	}

	// Logical overflow.
	out["overflow-block"] = {value: "hidden", setup: "#probe { height: 1px; }"};
	out["overflow-inline"] = {value: "hidden", setup: NARROW};

	return out;
}


/**
 * The document every probe renders. #probe is block-level on purpose: `width`
 * on an inline box correctly does nothing, so probing with a <span> reported
 * the entire box model as unsupported. #sibling is there to catch properties
 * whose effect lands on the NEXT box rather than their own -- float, margin,
 * order -- and #parent to catch the ones that change the container.
 */
const BASE_CSS = "#parent { display: block; }";

const PROBE_MARKUP =
	`<div id="parent"><div id="probe">probe text</div>` +
	`<div id="sibling">sibling</div></div>`;

interface Probe {
	name: string;
	category: string;
	/** Returns whether the feature demonstrably works, plus an optional note. */
	run(): Promise<{supported: boolean; note?: string}>;
}

/**
 * Renders are the whole cost of this script, and most probes share a baseline
 * with their neighbours -- the same context CSS and the same markup. Caching by
 * exactly that pair turns two renders per probe into a little over one.
 */
const renderCache = new Map<string, {frame: string; geometry: string}>();

/** One render: returns the painted frame plus the geometry of two boxes. */
async function snapshot(
	css: string,
	markup: string,
): Promise<{frame: string; geometry: string}> {
	const key = `${css}\u0000${markup}`;
	const cached = renderCache.get(key);
	if (cached) return cached;

	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	try {
		dom.document.head.innerHTML = `<style>${css}</style>`;
		dom.document.body.innerHTML = markup;
		await nextFrame(dom);
		await nextFrame(dom);

		const rect = (selector: string): string => {
			const element = dom.document.querySelector(selector);
			if (!element) return "-";
			const r = element.getBoundingClientRect();
			return `${r.x},${r.y},${r.width},${r.height}`;
		};
		const result = {
			frame: terminal.getStaticANSI(),
			geometry: `${rect("#probe")}|${rect("#sibling")}|${rect("#parent")}`,
		};
		renderCache.set(key, result);
		return result;
	} finally {
		dom.dispose();
	}
}

/**
 * A CSS property is supported when applying it changes what the user sees.
 * Both halves matter: geometry catches layout properties, and the painted cells
 * catch the ones that only change colour or attributes.
 */
function cssProbe(property: string, feature: Feature, category: string): Probe {
	const markup =
		feature.markup ??
		(feature.text
			? PROBE_MARKUP.replace("probe text", feature.text)
			: PROBE_MARKUP);
	const target = feature.target === "parent" ? "#parent" : "#probe";
	const context = `${BASE_CSS} ${feature.setup ?? ""}`;
	return {
		name: property,
		category,
		async run() {
			const base = await snapshot(context, markup);
			const applied = await snapshot(
				`${context} ${target} { ${property}: ${feature.value}; }`,
				markup,
			);
			const changed =
				base.frame !== applied.frame || base.geometry !== applied.geometry;
			return {supported: changed, note: changed ? undefined : "no effect"};
		},
	};
}

/** Some features are not properties. These probe behaviour directly. */
function apiProbe(
	name: string,
	category: string,
	run: (dom: TermDOM) => boolean | Promise<boolean>,
	note?: string,
): Probe {
	return {
		name,
		category,
		async run() {
			const terminal = new MockProcess({cols: 40, rows: 12});
			const dom = new TermDOM({transport: terminal.transport});
			try {
				return {supported: await run(dom), note};
			} catch {
				return {supported: false, note: "throws"};
			} finally {
				dom.dispose();
			}
		},
	};
}

const CATEGORIES: Array<[string, string[]]> = [
	[
		"Box model",
		[
			"width",
			"height",
			"min-width",
			"min-height",
			"max-width",
			"max-height",
			"padding",
			"padding-top",
			"padding-right",
			"padding-bottom",
			"padding-left",
			"margin",
			"margin-top",
			"margin-right",
			"margin-bottom",
			"margin-left",
			"border",
			"border-width",
			"border-style",
			"border-color",
			"border-top",
			"border-right",
			"border-bottom",
			"border-left",
			"box-sizing",
		],
	],
	[
		"Display and positioning",
		[
			"display",
			"position",
			"top",
			"right",
			"bottom",
			"left",
			"z-index",
			"float",
			"clear",
			"overflow",
			"overflow-x",
			"overflow-y",
			"visibility",
		],
	],
	[
		"Flexbox",
		[
			"flex-direction",
			"flex-wrap",
			"flex-grow",
			"flex-shrink",
			"flex-basis",
			"flex",
			"justify-content",
			"align-items",
			"align-self",
			"align-content",
			"order",
			"gap",
			"row-gap",
			"column-gap",
		],
	],
	[
		"Grid",
		[
			"grid-template-columns",
			"grid-template-rows",
			"grid-column",
			"grid-row",
			"grid-auto-flow",
		],
	],
	[
		"Text and paint",
		[
			"color",
			"background-color",
			"font-weight",
			"font-style",
			"text-decoration",
			"text-decoration-line",
			"text-decoration-style",
			"text-transform",
			"text-align",
			"text-indent",
			"white-space",
			"word-break",
			"overflow-wrap",
			"line-height",
			"direction",
			"opacity",
			"font-family",
			"font-size",
			"letter-spacing",
			"word-spacing",
		],
	],
	[
		"Lists, tables, counters",
		[
			"list-style-type",
			"list-style-position",
			"list-style",
			"border-collapse",
			"table-layout",
			"vertical-align",
			"content",
			"counter-reset",
			"counter-increment",
		],
	],
	[
		"Graphical effects",
		[
			"transform",
			"transition",
			"animation",
			"box-shadow",
			"filter",
			"aspect-ratio",
			"cursor",
		],
	],
];

function buildProbes(): Probe[] {
	const probes: Probe[] = [];
	const generated = generatedFeatures();
	for (const [name, feature] of Object.entries(generated)) {
		const category = name.startsWith("border")
			? "Box model"
			: "Logical properties";
		probes.push(cssProbe(name, feature, category));
	}
	for (const [category, names] of CATEGORIES) {
		for (const name of names) {
			const feature = FEATURES[name];
			if (!feature) continue;
			probes.push(cssProbe(name, feature, category));
		}
	}

	// DOM and CSSOM surface, where "does it exist and do something" is the
	// question rather than "does this declaration change a box".
	probes.push(
		apiProbe("Shadow DOM", "DOM APIs", (dom) => {
			const host = dom.document.createElement("div");
			dom.document.body.appendChild(host);
			const root = host.attachShadow({mode: "open"});
			root.innerHTML = "<slot></slot>";
			return host.shadowRoot !== null;
		}),
		apiProbe(
			"MutationObserver",
			"DOM APIs",
			(dom) => typeof dom.window.MutationObserver === "function",
		),
		apiProbe(
			"ResizeObserver",
			"DOM APIs",
			(dom) =>
				typeof (dom.window as {ResizeObserver?: unknown}).ResizeObserver ===
				"function",
		),
		apiProbe(
			"IntersectionObserver",
			"DOM APIs",
			(dom) =>
				typeof (dom.window as {IntersectionObserver?: unknown})
					.IntersectionObserver === "function",
		),
		apiProbe(
			"matchMedia",
			"DOM APIs",
			(dom) =>
				typeof dom.window.matchMedia === "function" &&
				typeof dom.window.matchMedia("(min-width: 1ch)").matches === "boolean",
		),
		apiProbe(
			"requestAnimationFrame",
			"DOM APIs",
			(dom) =>
				typeof dom.window.requestAnimationFrame === "function" &&
				typeof dom.window.cancelAnimationFrame === "function",
		),
		apiProbe("getComputedStyle", "DOM APIs", (dom) => {
			const el = dom.document.createElement("div");
			el.style.color = "red";
			dom.document.body.appendChild(el);
			return dom.window.getComputedStyle(el).color !== "";
		}),
		apiProbe("getBoundingClientRect", "DOM APIs", (dom) => {
			const el = dom.document.createElement("div");
			dom.document.body.appendChild(el);
			return typeof el.getBoundingClientRect().width === "number";
		}),
		apiProbe(
			"Selection / getSelection",
			"DOM APIs",
			(dom) => typeof dom.window.getSelection === "function",
		),
		apiProbe(
			"Fullscreen API",
			"DOM APIs",
			(dom) =>
				typeof (dom.document.body as {requestFullscreen?: unknown})
					.requestFullscreen === "function",
		),
	);

	// At-rules and selectors: does the cascade honour them?
	const cssBlockProbe = (name: string, css: string, category: string) =>
		({
			name,
			category,
			async run() {
				const base = await snapshot(BASE_CSS, PROBE_MARKUP);
				const applied = await snapshot(`${BASE_CSS} ${css}`, PROBE_MARKUP);
				const changed = base.frame !== applied.frame;
				return {supported: changed, note: changed ? undefined : "no effect"};
			},
		}) satisfies Probe;
	const paints = (selector: string) =>
		`${selector} { background-color: blue; }`;

	probes.push(
		cssBlockProbe("Type / class / id", paints("#probe"), "Selectors"),
		cssBlockProbe("Descendant", paints("#parent div"), "Selectors"),
		cssBlockProbe("Child", paints("#parent > div"), "Selectors"),
		cssBlockProbe("Attribute", paints("div[id='probe']"), "Selectors"),
		cssBlockProbe(
			"Pseudo-class :first-child",
			paints("#parent div:first-child"),
			"Selectors",
		),
		cssBlockProbe(
			"Pseudo-class :nth-child",
			paints("#parent div:nth-child(1)"),
			"Selectors",
		),
		cssBlockProbe(
			"Pseudo-element ::before",
			'#probe::before { content: "X"; }',
			"Selectors",
		),
		cssBlockProbe("Adjacent sibling", paints("#probe + div"), "Selectors"),
		cssBlockProbe("Selector list", paints("#nothing, #probe"), "Selectors"),
		cssBlockProbe("Universal", paints("#parent > *"), "Selectors"),
		cssBlockProbe(
			"@media (width)",
			`@media (min-width: 1ch) { ${paints("#probe")} }`,
			"At-rules",
		),
		cssBlockProbe(
			"@media (height)",
			`@media (min-height: 1px) { ${paints("#probe")} }`,
			"At-rules",
		),
		cssBlockProbe(
			"@supports",
			`@supports (color: red) { ${paints("#probe")} }`,
			"At-rules",
		),
		cssBlockProbe(
			"Custom properties (var)",
			"#parent { --probe-bg: blue; } #probe { background-color: var(--probe-bg); }",
			"At-rules",
		),
		cssBlockProbe(
			"!important",
			"#probe { background-color: red; } div { background-color: blue !important; }",
			"At-rules",
		),
	);

	return probes;
}

async function main(): Promise<void> {
	const probes = buildProbes();
	const results: Array<{
		probe: Probe;
		supported: boolean;
		note?: string;
	}> = [];

	for (const probe of probes) {
		const t0 = performance.now();
		// A probe whose render never produces a frame leaves main() suspended on
		// a promise nothing will resolve; the event loop drains and the process
		// exits 0 having written nothing. The watchdog keeps the loop alive and
		// turns that silence into a named failure.
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const {supported, note} = await Promise.race([
				probe.run(),
				new Promise<never>((_, reject) => {
					watchdog = setTimeout(
						() => reject(new Error(`probe hung: ${probe.name}`)),
						30_000,
					);
				}),
			]);
			results.push({probe, supported, note});
		} finally {
			clearTimeout(watchdog);
			process.stderr.write(
				`probe: ${probe.name} ${(performance.now() - t0).toFixed(0)}ms\n`,
			);
		}
	}

	// Every standard property is accounted for in one of three states, so the
	// difference between "we checked and it does not work" and "this could never
	// mean anything here" sits on the page rather than in someone's head.
	const probed = new Set(probes.map((p) => p.name));
	const standard = Object.keys(properties)
		.filter(
			(p) =>
				!p.startsWith("-") &&
				(properties as Record<string, {status: string}>)[p].status ===
					"standard",
		)
		.sort();

	const unprobed: string[] = [];
	for (const property of standard) {
		if (!probed.has(property)) unprobed.push(property);
	}

	const supported = results.filter((r) => r.supported).length;

	const lines: string[] = [
		"<!-- Generated by `bun run support`. Do not edit. -->",
		"",
		"# Support",
		"",
		"The generator applies each feature to a real document, renders it to a",
		"terminal buffer, and records whether the output changed. A property that",
		"is parsed and stored but never affects rendering is listed as unsupported.",
		"",
		`Of the ${standard.length} standard CSS properties in \`mdn-data\`:`,
		"",
		`- **${supported} supported**`,
		`- **${results.length - supported} unsupported**`,
		`- **${unprobed.length} not yet probed**`,
		"",
		"Non-property features (selectors, at-rules, DOM APIs) are probed the same",
		"way and counted in the first two figures.",
		"",
	];

	for (const [category] of [
		...CATEGORIES,
		["Logical properties"],
		["Selectors"],
		["At-rules"],
		["DOM APIs"],
	] as Array<[string]>) {
		const rows = results.filter((r) => r.probe.category === category);
		if (rows.length === 0) continue;
		lines.push(
			`## ${category}`,
			"",
			"| feature | supported |",
			"| --- | --- |",
		);
		for (const {probe, supported: ok, note} of rows) {
			const mark = ok ? "yes" : note ? `no (${note})` : "no";
			lines.push(`| \`${probe.name}\` | ${mark} |`);
		}
		lines.push("");
	}

	if (unprobed.length > 0) {
		lines.push(
			"## Not yet probed",
			"",
			"No probe exists for these; each is either a probe nobody has written",
			"or a property that cannot apply to a character grid. Sorting out",
			"which is which is open work.",
			"",
			"<details><summary>Show</summary>",
			"",
			unprobed.map((p) => `\`${p}\``).join(", "),
			"",
			"</details>",
			"",
		);
	}

	const output = lines.join("\n");
	const target = join(ROOT, "SUPPORT.md");

	if (process.argv.includes("--check")) {
		const existing = readFileSync(target, "utf8");
		if (existing !== output) {
			console.error(
				"SUPPORT.md is out of date. Run: bun scripts/support-matrix.ts",
			);
			process.exit(1);
		}
		process.stdout.write("SUPPORT.md is current.\n");
		return;
	}

	writeFileSync(target, output);
	process.stdout.write(
		`Wrote SUPPORT.md: ${supported}/${results.length} probed supported, ` +
			`${unprobed.length} not yet probed.\n`,
	);
}

await main();
