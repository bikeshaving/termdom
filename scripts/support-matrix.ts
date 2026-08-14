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
 * The per-probe watchdog below names the probe that stalls, so a run that
 * hangs says which feature did it rather than dying silently.
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
	/** Selector override for the declaration, for properties that only act
	 * on a pseudo-element (content on #probe::before, not #probe). */
	selector?: string;
}

const LONG = "the quick brown fox jumps over the lazy dog again and again";
/** A word no line of the probe document is wide enough to hold. */
const UNBREAKABLE = "supercalifragilisticexpialidocious";
const FLEX = "#parent { display: flex; }";
const GRID = "#parent { display: grid; grid-template-columns: 12ch 12ch; }";
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
	"border-radius": {value: "1ch", setup: "#probe { border: 1px solid; }"},
	"border-top-left-radius": {
		value: "1ch",
		setup: "#probe { border: 1px solid; }",
	},
	"border-top-right-radius": {
		value: "1ch",
		setup: "#probe { border: 1px solid; }",
	},
	"border-bottom-right-radius": {
		value: "1ch",
		setup: "#probe { border: 1px solid; }",
	},
	"border-bottom-left-radius": {
		value: "1ch",
		setup: "#probe { border: 1px solid; }",
	},
	"box-sizing": {
		value: "border-box",
		setup: "#probe { width: 12ch; padding: 0 2ch; border: 1px solid; }",
	},
	outline: {value: "1px solid red"},
	"outline-style": {value: "solid", setup: "#probe { outline-width: 1px; }"},
	// The painted outline is present or absent; a zero width is the only width
	// the grid can tell apart from the rest.
	"outline-width": {
		value: "1px",
		setup: "#probe { outline-style: solid; outline-width: 0; }",
	},
	"outline-color": {value: "red", setup: "#probe { outline: 1px solid; }"},
	"outline-offset": {value: "1px", setup: "#probe { outline: 1px solid red; }"},

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
	// #inner is above #sibling by z-index alone; `isolation` on #probe makes
	// #probe a stacking context, which confines #inner to #probe's own place in
	// the paint order and puts #sibling on top.
	isolation: {
		value: "isolate",
		setup:
			"#parent { display: block; position: relative; }" +
			" #inner { position: absolute; top: 0; left: 0; width: 8ch;" +
			" z-index: 5; background-color: red; }" +
			" #sibling { position: absolute; top: 0; left: 0; width: 8ch;" +
			" z-index: 2; background-color: blue; }",
		markup:
			'<div id="parent"><div id="probe"><div id="inner">inner</div></div>' +
			'<div id="sibling">sibling</div></div>',
	},
	float: {value: "right"},
	clear: {value: "both", setup: "#probe { float: left; }"},
	// Clipping only shows against content that overflows the box: an
	// unbreakable word wider than it for the x axis, wrapped lines taller
	// than it for the y axis.
	overflow: {
		value: "hidden",
		setup: NARROW,
		text: "an-unbreakable-overflowing-word",
	},
	"overflow-x": {
		value: "hidden",
		setup: NARROW,
		text: "an-unbreakable-overflowing-word",
	},
	"overflow-y": {
		value: "hidden",
		setup: "#probe { width: 6ch; height: 1px; }",
		text: "aaa bbb ccc",
	},
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

	// Grid. `subgrid` (css-grid-2 §9.5) and `masonry` (css-grid-3) are refused
	// values, not missing ones: the track-list parser rejects them by name,
	// and a property probed here reports on the rest of its grammar.
	"grid-template-columns": {
		value: "1fr 1fr",
		target: "parent",
		setup: "#parent { display: grid; }",
	},
	"grid-template-rows": {
		value: "3px 1px",
		target: "parent",
		setup: "#parent { display: grid; }",
	},
	"grid-column": {value: "2 / 3", setup: GRID},
	"grid-row": {value: "3", setup: "#parent { display: grid; }"},
	"grid-auto-flow": {
		value: "column",
		target: "parent",
		setup: "#parent { display: grid; }",
	},

	// Text and paint
	color: {value: "red"},
	"background-color": {value: "blue"},
	background: {value: "blue"},
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
	// Breaking inside a word takes a word too long for the line: every word of
	// LONG fits in ten columns, so LONG measures nothing here.
	"word-break": {value: "break-all", setup: NARROW, text: UNBREAKABLE},
	"overflow-wrap": {
		value: "break-word",
		setup: NARROW,
		text: UNBREAKABLE,
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
		// The engine collapses borders by default, so `collapse` matches the
		// baseline and shows no change; `separate` is what the property has
		// to move.
		value: "separate",
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
	content: {value: '"X"', selector: "#probe::before"},
	"counter-reset": {value: "c 3"},
	"counter-increment": {value: "c 2"},

	// Deliberately unsupported, probed so the claim stays honest
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
			// Padding on the END edge only moves cells inside a box whose
			// width is stated, exactly as `padding-right` needs it to.
			setup: physical === "right" ? NARROW : undefined,
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
		out[`padding-${axis}`] = {
			value: axis === "inline" ? "0 3ch" : "2px 0",
			setup: axis === "inline" ? NARROW : undefined,
		};
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
	// The inline-axis item alignments are grid's: a flex container's inline
	// axis belongs to justify-content, so probing them there measures nothing.
	out["justify-items"] = {value: "end", target: "parent", setup: GRID};
	out["justify-self"] = {value: "end", setup: GRID};

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
	out["word-wrap"] = {value: "break-word", setup: NARROW, text: UNBREAKABLE};
	out["line-clamp"] = {value: "1", setup: NARROW, text: LONG};
	out["counter-set"] = {value: "c 3"};
	out["font"] = {value: "bold 1px monospace"};
	out["list-style-image"] = {
		value: "none",
		markup:
			'<ul id="parent"><li id="probe">item</li><li id="sibling">two</li></ul>',
	};

	// The rest of the grid family, so the whole of it is measured.
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
			// Each value has to MOVE something: a track list that resolves to
			// the size the box already had measures as no support at all.
			value:
				name === "grid-template-areas"
					? '"a a" "b b"'
					: name === "grid-template" || name === "grid"
						? "3px 1px / 6ch 6ch"
						: name.endsWith("-start") || name.endsWith("-end")
							? "3"
							: name === "grid-area"
								? "2 / 2 / 3 / 3"
								: "3px",
			target:
				name.startsWith("grid-auto") ||
				name === "grid" ||
				name === "grid-template" ||
				name === "grid-template-areas"
					? "parent"
					: "probe",
			// grid-auto-columns sizes the implicit COLUMNS, which only exist
			// where the flow makes them: a row-flow grid never creates one.
			setup:
				name === "grid-auto-columns"
					? "#parent { display: grid; grid-auto-flow: column; }"
					: // An area map only moves a box that names one of its
						// areas, and only against columns it can span.
						name === "grid-template-areas"
						? `${GRID} #probe { grid-area: b; }`
						: "#parent { display: grid; }",
		};
	}

	// Logical overflow.
	out["overflow-block"] = {value: "hidden", setup: "#probe { height: 1px; }"};
	out["overflow-inline"] = {value: "hidden", setup: NARROW};

	return out;
}

/**
 * Properties with no probe, and why. A property is here because a probe would
 * be measuring nothing: either the effect needs geometry, imagery or hardware
 * a character grid does not have, or the effect is expressible in cells and
 * nobody has built it. Anything absent from both lists falls through to the
 * unclassified section; a name here that mdn-data does not list is a typo and
 * stops the run.
 */
const NOT_APPLICABLE: Array<[string, string[]]> = [
	// `transform` is here rather than probed: a rotation or a scale has no
	// reading on a grid of whole cells, and the one transform that would --
	// translating a box by whole cells -- is refused, because supporting the
	// property for the values that happen to land on the grid would report as
	// support for the property.
	[
		"Transforms, 3D and motion paths, which need sub-cell geometry",
		[
			"backface-visibility",
			"offset",
			"offset-anchor",
			"offset-distance",
			"offset-path",
			"offset-position",
			"offset-rotate",
			"perspective",
			"perspective-origin",
			"rotate",
			"scale",
			"transform",
			"transform-box",
			"transform-origin",
			"transform-style",
			"translate",
			"zoom",
		],
	],
	[
		"Raster imagery and compositing, which need pixels",
		[
			"backdrop-filter",
			"background-attachment",
			"background-blend-mode",
			"background-image",
			"background-origin",
			"background-position",
			"background-position-x",
			"background-position-y",
			"background-repeat",
			"background-size",
			"border-image",
			"border-image-outset",
			"border-image-repeat",
			"border-image-slice",
			"border-image-source",
			"border-image-width",
			"clip-path",
			"dynamic-range-limit",
			"image-orientation",
			"image-rendering",
			"mask",
			"mask-border",
			"mask-border-mode",
			"mask-border-outset",
			"mask-border-repeat",
			"mask-border-slice",
			"mask-border-source",
			"mask-border-width",
			"mask-clip",
			"mask-composite",
			"mask-image",
			"mask-mode",
			"mask-origin",
			"mask-position",
			"mask-repeat",
			"mask-size",
			"mix-blend-mode",
			"object-fit",
			"object-position",
			"shape-image-threshold",
			"shape-margin",
			"shape-outside",
		],
	],
	[
		"SVG presentation attributes, for a rendering model with no cells",
		[
			"alignment-baseline",
			"baseline-shift",
			"baseline-source",
			"clip-rule",
			"color-interpolation-filters",
			"cx",
			"cy",
			"d",
			"dominant-baseline",
			"fill",
			"fill-opacity",
			"fill-rule",
			"flood-color",
			"flood-opacity",
			"lighting-color",
			"marker",
			"marker-end",
			"marker-mid",
			"marker-start",
			"mask-type",
			"paint-order",
			"r",
			"rx",
			"ry",
			"shape-rendering",
			"stop-color",
			"stop-opacity",
			"stroke",
			"stroke-dasharray",
			"stroke-dashoffset",
			"stroke-linecap",
			"stroke-linejoin",
			"stroke-miterlimit",
			"stroke-opacity",
			"stroke-width",
			"text-anchor",
			"vector-effect",
			"x",
			"y",
		],
	],
	[
		"Glyph rendering, which the terminal emulator owns",
		[
			"font-feature-settings",
			"font-kerning",
			"font-language-override",
			"font-optical-sizing",
			"font-palette",
			"font-size-adjust",
			"font-synthesis",
			"font-synthesis-small-caps",
			"font-synthesis-style",
			"font-synthesis-weight",
			"font-variant",
			"font-variant-alternates",
			"font-variant-caps",
			"font-variant-east-asian",
			"font-variant-emoji",
			"font-variant-ligatures",
			"font-variant-numeric",
			"font-variant-position",
			"font-variation-settings",
			"math-depth",
			"math-style",
			"text-autospace",
			"text-combine-upright",
			"text-rendering",
			"text-shadow",
		],
	],
	[
		"Decoration finer than one cell",
		[
			"border-shape",
			"corner-block-end-shape",
			"corner-block-start-shape",
			"corner-bottom-left-shape",
			"corner-bottom-right-shape",
			"corner-bottom-shape",
			"corner-end-end-shape",
			"corner-end-start-shape",
			"corner-inline-end-shape",
			"corner-inline-start-shape",
			"corner-left-shape",
			"corner-right-shape",
			"corner-shape",
			"corner-start-end-shape",
			"corner-start-start-shape",
			"corner-top-left-shape",
			"corner-top-right-shape",
			"corner-top-shape",
			"frame-sizing",
			"initial-letter",
			"text-box",
			"text-box-edge",
			"text-box-trim",
			"text-decoration-inset",
			"text-decoration-skip-ink",
			"text-decoration-thickness",
			"text-emphasis",
			"text-emphasis-color",
			"text-emphasis-position",
			"text-emphasis-style",
			"text-underline-offset",
		],
	],
	["Print output", ["page", "print-color-adjust"]],
	["Pointer hardware a terminal does not report", ["touch-action"]],
];

const NOT_IMPLEMENTED: string[] = [
	"accent-color",
	"all",
	"animation-composition",
	"animation-delay",
	"animation-direction",
	"animation-duration",
	"animation-fill-mode",
	"animation-iteration-count",
	"animation-name",
	"animation-play-state",
	"animation-timing-function",
	"animation-trigger",
	"appearance",
	"background-clip",
	"box-decoration-break",
	"break-after",
	"break-before",
	"break-inside",
	"caret",
	"caret-animation",
	"caret-color",
	"caret-shape",
	"color-scheme",
	"column-count",
	"column-fill",
	"column-height",
	"column-rule",
	"column-rule-color",
	"column-rule-style",
	"column-rule-width",
	"column-span",
	"column-width",
	"column-wrap",
	"columns",
	"contain",
	"contain-intrinsic-block-size",
	"contain-intrinsic-height",
	"contain-intrinsic-inline-size",
	"contain-intrinsic-size",
	"contain-intrinsic-width",
	"container",
	"container-name",
	"container-type",
	"content-visibility",
	"forced-color-adjust",
	"hanging-punctuation",
	"hyphenate-character",
	"hyphenate-limit-chars",
	"hyphens",
	"interactivity",
	"interest-delay",
	"interest-delay-end",
	"interest-delay-start",
	"line-break",
	"orphans",
	"overflow-anchor",
	"overflow-clip-margin",
	"overscroll-behavior",
	"overscroll-behavior-block",
	"overscroll-behavior-inline",
	"overscroll-behavior-x",
	"overscroll-behavior-y",
	"pointer-events",
	"quotes",
	"reading-flow",
	"reading-order",
	"resize",
	"ruby-align",
	"ruby-overhang",
	"ruby-position",
	"scroll-behavior",
	"scroll-margin",
	"scroll-margin-block",
	"scroll-margin-block-end",
	"scroll-margin-block-start",
	"scroll-margin-bottom",
	"scroll-margin-inline",
	"scroll-margin-inline-end",
	"scroll-margin-inline-start",
	"scroll-margin-left",
	"scroll-margin-right",
	"scroll-margin-top",
	"scroll-marker-group",
	"scroll-padding",
	"scroll-padding-block",
	"scroll-padding-block-end",
	"scroll-padding-block-start",
	"scroll-padding-bottom",
	"scroll-padding-inline",
	"scroll-padding-inline-end",
	"scroll-padding-inline-start",
	"scroll-padding-left",
	"scroll-padding-right",
	"scroll-padding-top",
	"scroll-snap-align",
	"scroll-snap-stop",
	"scroll-snap-type",
	"scroll-target-group",
	"scrollbar-color",
	"scrollbar-gutter",
	"scrollbar-width",
	"tab-size",
	"text-justify",
	"text-orientation",
	"text-underline-position",
	"text-wrap-style",
	"timeline-trigger",
	"timeline-trigger-activation-range",
	"timeline-trigger-activation-range-end",
	"timeline-trigger-activation-range-start",
	"timeline-trigger-active-range",
	"timeline-trigger-active-range-end",
	"timeline-trigger-active-range-start",
	"timeline-trigger-name",
	"timeline-trigger-source",
	"transition-behavior",
	"transition-delay",
	"transition-duration",
	"transition-property",
	"transition-timing-function",
	"trigger-scope",
	"unicode-bidi",
	"user-select",
	"view-transition-class",
	"view-transition-name",
	"view-transition-scope",
	"widows",
	"will-change",
	"writing-mode",
];

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
	const target =
		feature.selector ?? (feature.target === "parent" ? "#parent" : "#probe");
	// BASE_CSS blocks out the default #parent; a probe that brings its own
	// markup (a real <table>, say) brings its own context and must not have
	// display: block forced onto its root.
	const context = feature.markup
		? (feature.setup ?? "")
		: `${BASE_CSS} ${feature.setup ?? ""}`;
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
			"border-radius",
			"border-top-left-radius",
			"border-top-right-radius",
			"border-bottom-right-radius",
			"border-bottom-left-radius",
			"box-sizing",
			"outline",
			"outline-style",
			"outline-width",
			"outline-color",
			"outline-offset",
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
			"isolation",
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
			"background",
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
			"@layer",
			`@layer base, theme; @layer theme { ${paints("#probe")} }`,
			"At-rules",
		),
		cssBlockProbe(
			"@scope",
			`@scope (#parent) { ${paints("#probe")} }`,
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

	// A classification names a property that exists; anything else is a typo,
	// and a typo would quietly leave a real property unclassified.
	const known = new Set(standard);
	const classified = new Set<string>();
	for (const name of [
		...NOT_APPLICABLE.flatMap(([, names]) => names),
		...NOT_IMPLEMENTED,
	]) {
		if (!known.has(name)) {
			throw new Error(
				`classified property is not a standard property: ${name}`,
			);
		}
		if (classified.has(name)) {
			throw new Error(`property classified twice: ${name}`);
		}
		classified.add(name);
	}
	const notApplicable = NOT_APPLICABLE.map(
		([reason, names]) =>
			[reason, names.filter((n) => !probed.has(n))] as [string, string[]],
	).filter(([, names]) => names.length > 0);
	const notImplemented = NOT_IMPLEMENTED.filter((n) => !probed.has(n));
	const notApplicableCount = notApplicable.reduce(
		(total, [, names]) => total + names.length,
		0,
	);
	const unclassified = unprobed.filter((p) => !classified.has(p));

	const supported = results.filter((r) => r.supported).length;
	const list = (names: string[]) => names.map((p) => `\`${p}\``).join(", ");

	const lines: string[] = [
		"<!-- Generated by `bun run support`. Do not edit. -->",
		"",
		"# Compatibility",
		"",
		"What TermDOM supports: DOM APIs, selectors, at-rules, and CSS",
		"properties. Every row is a probe -- the feature applied to a real",
		"document and rendered, with the row recording whether the output",
		"changed.",
		"",
		`${supported} features supported, ${results.length - supported} probed and unsupported,`,
		`${notApplicableCount} CSS properties not applicable to a character grid,`,
		`${notImplemented.length} applicable and not implemented,`,
		`${unclassified.length} not yet probed.`,
		"",
	];

	for (const [category] of [
		["DOM APIs"],
		["Selectors"],
		["At-rules"],
		...CATEGORIES,
		["Logical properties"],
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

	if (notApplicable.length > 0) {
		lines.push(
			"## Not applicable to a character grid",
			"",
			"These properties have no rendering a grid of characters can carry.",
			"",
		);
		for (const [reason, names] of notApplicable) {
			lines.push(`**${reason}.** ${list(names)}`, "");
		}
	}

	if (notImplemented.length > 0) {
		lines.push(
			"## Applicable, not implemented",
			"",
			"These properties have a meaning on a character grid and TermDOM does",
			"not act on them.",
			"",
			list(notImplemented),
			"",
		);
	}

	if (unclassified.length > 0) {
		lines.push(
			"## Not yet probed",
			"",
			"No probe covers these and they are unclassified.",
			"",
			list(unclassified),
			"",
		);
	}

	const output = lines.join("\n");
	const target = join(ROOT, "COMPATIBILITY.md");

	if (process.argv.includes("--check")) {
		const existing = readFileSync(target, "utf8");
		if (existing !== output) {
			console.error(
				"SUPPORT.md is out of date. Run: bun scripts/support-matrix.ts",
			);
			process.exit(1);
		}
		process.stdout.write("COMPATIBILITY.md is current.\n");
		return;
	}

	writeFileSync(target, output);
	process.stdout.write(
		`Wrote COMPATIBILITY.md: ${supported}/${results.length} probed supported, ` +
			`${unclassified.length} not yet probed.\n`,
	);
}

await main();
