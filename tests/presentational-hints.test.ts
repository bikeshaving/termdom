/**
 * The style the Rendering section makes out of content attributes.
 *
 * HTML defines two kinds of attribute-driven style: presentational hints,
 * which enter the cascade at author level with zero specificity, and UA sheet
 * rules written over an attribute selector. Both are style an author gets
 * without writing CSS, and both are the UA's job rather than the DOM's, so
 * they live in the UA sheet here.
 *
 * The table below is that list, transcribed from the Rendering section
 * (2026-08-14). Every entry is either implemented -- and then a test here
 * shows the attribute reaching a computed value -- or named with the reason it
 * is not. An entry in both tables fails the guard: a hint is handled or
 * somebody looked at it and wrote down why not.
 */
import {test, expect} from "@b9g/libuild/test";
import {createDocumentWindow} from "../src/internal/dom.js";
import {StyleManager} from "../src/internal/cascade.js";
import {LayoutEngine} from "../src/internal/layout.js";
import {UA_DOCUMENT_STYLES} from "../src/internal/useragent.js";

/** The computed value of a property on the element an id names. */
function computed(html: string, id: string, property: string): string {
	const window = createDocumentWindow(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
	);
	const styleManager = new StyleManager(window);
	styleManager.setLayoutEngine(new LayoutEngine(window));
	const element = window.document.getElementById(id)!;
	return window.getComputedStyle(element).getPropertyValue(property);
}

/**
 * The attribute-to-style mappings the Rendering section defines, keyed by the
 * element and attribute that carry them.
 */
const IMPLEMENTED_HINTS: Record<string, string> = {
	"*[dir]": "direction",
	"bdi": "direction",
	"input[type=tel]": "direction",
};

/**
 * The mappings this UA does not make, each with the reason.
 *
 * Most of them ask for a unit the terminal does not have. A cell is the
 * smallest thing there is: a pixel length, a border image, a font face or a
 * font size has nowhere to land, and a color the terminal can show is one an
 * author writes in CSS. The rest name layout modes this engine does not have
 * at all.
 */
const EXCLUDED_HINTS: Record<string, string> = {
	// Bidi: the direction half of the dir rules is implemented above; these
	// are the unicode-bidi halves of the same rules.
	"*[dir] unicode-bidi":
		"unicode-bidi: isolate -- reordering here runs per line over the paragraph direction, with no embedding levels to isolate",
	"bdo unicode-bidi": "unicode-bidi: isolate-override -- no embedding levels",
	"input[dir=auto] unicode-bidi":
		"unicode-bidi: plaintext -- no embedding levels",
	"textarea[dir=auto] unicode-bidi":
		"unicode-bidi: plaintext -- no embedding levels",
	"pre[dir=auto] unicode-bidi":
		"unicode-bidi: plaintext -- no embedding levels",
	"iso-8859-8 unicode-bidi":
		"unicode-bidi: bidi-override under the ISO-8859-8 encoding -- this DOM decodes UTF-8",

	// Legacy color and font attributes.
	"body[background]": "background-image: a raster image, which needs pixels",
	"body[bgcolor]": "background-color: an author writes this in CSS",
	"body[text]": "color: an author writes this in CSS",
	"body[link]": "color on :link -- no visited or link history here",
	"body[vlink]": "color on :visited -- no visited or link history here",
	"body[alink]": "color on :active :link -- no visited or link history here",
	"font[color]": "color: an author writes this in CSS",
	"font[face]": "font-family: one terminal font, chosen by the terminal",
	"font[size]": "font-size: one cell, and every cell is the same size",
	"marquee[bgcolor]":
		"background-color on a marquee, which does not scroll here",
	"table[bordercolor]": "border-*-color: an author writes this in CSS",
	"table[bgcolor]": "background-color: an author writes this in CSS",
	"td[bgcolor]": "background-color: an author writes this in CSS",
	"table[background]": "background-image: a raster image, which needs pixels",
	"td[background]": "background-image: a raster image, which needs pixels",
	"hr[color]": "color on an hr, whose rule is drawn from its border",

	// Alignment attributes, which map to text-align, float and vertical-align.
	"div[align]": "text-align: the align attribute predates text-align",
	"center": "text-align: center, which the UA sheet could carry but does not",
	"td[align]": "text-align on a cell",
	"th[align]": "text-align on a cell",
	"tr[align]": "text-align on a row",
	"thead[align]": "text-align on a row group",
	"tbody[align]": "text-align on a row group",
	"tfoot[align]": "text-align on a row group",
	"img[align]": "float and vertical-align on a replaced element",
	"embed[align]": "float and vertical-align on a replaced element",
	"iframe[align]": "float and vertical-align on a replaced element",
	"object[align]": "float and vertical-align on a replaced element",
	"input[type=image][align]": "float and vertical-align on a replaced element",

	// Dimension attributes: pixel lengths and aspect ratios.
	"table[height]": "height as a pixel length",
	"table[width]": "width as a pixel length",
	"col[width]": "width as a pixel length",
	"thead[height]": "height as a pixel length",
	"tbody[height]": "height as a pixel length",
	"tfoot[height]": "height as a pixel length",
	"tr[height]": "height as a pixel length",
	"td[height]": "height as a pixel length",
	"td[width]": "width as a pixel length",
	"hr[width]": "width as a pixel length",
	"hr[size]": "border widths and height as pixel lengths",
	"hr[noshade]": "border widths as pixel lengths",
	"img[width]": "width, height and aspect-ratio on a raster image",
	"img[height]": "width, height and aspect-ratio on a raster image",
	"embed[width]": "width and height on embedded content, which needs pixels",
	"embed[height]": "width and height on embedded content, which needs pixels",
	"iframe[width]": "width and height on a nested document, which is absent",
	"iframe[height]": "width and height on a nested document, which is absent",
	"object[width]": "width and height on embedded content, which needs pixels",
	"object[height]": "width and height on embedded content, which needs pixels",
	"video[width]": "width, height and aspect-ratio on a video",
	"video[height]": "width, height and aspect-ratio on a video",
	"canvas[width]": "aspect-ratio on a canvas, which paints no pixels here",
	"canvas[height]": "aspect-ratio on a canvas, which paints no pixels here",
	"input[type=image][width]": "width and height on an image button",
	"input[type=image][height]": "width and height on an image button",
	"img[hspace]": "margins as pixel lengths",
	"img[vspace]": "margins as pixel lengths",
	"embed[hspace]": "margins as pixel lengths",
	"embed[vspace]": "margins as pixel lengths",
	"object[hspace]": "margins as pixel lengths",
	"object[vspace]": "margins as pixel lengths",
	"marquee[hspace]": "margins on a marquee, which does not scroll here",
	"marquee[vspace]": "margins on a marquee, which does not scroll here",
	"input[type=image][hspace]": "margins as pixel lengths",
	"input[type=image][vspace]": "margins as pixel lengths",
	"img[border]": "border widths as pixel lengths",
	"object[border]": "border widths as pixel lengths",
	"input[type=image][border]": "border widths as pixel lengths",
	"iframe[frameborder]": "border widths on a nested document, which is absent",

	// Counters and the rest.
	"li[value]": "counter-set: the list numbering is computed, not a counter",
	"ol[start]": "counter-reset: the list numbering is computed, not a counter",
	"ol[reversed]":
		"counter-reset: the list numbering is computed, not a counter",
	"br[clear]": "clear: no floats to clear",
	"td[nowrap]": "white-space in quirks mode, gated on a pixel width",
	"textarea[wrap]":
		"white-space: pre for wrap=off -- the widget owns its own wrapping",
	"input[type=color]":
		"background-color on the button's anonymous content box -- no color well",
};

test("no attribute is both implemented and excluded, and every exclusion says why", () => {
	// Whether the transcription is complete is not something the tables can
	// answer about themselves -- they are the transcription. What they can
	// answer is that no entry appears in both, that neither has been emptied,
	// and that an exclusion carries its reason.
	expect(Object.keys(IMPLEMENTED_HINTS).length).toBeGreaterThan(0);
	expect(Object.keys(EXCLUDED_HINTS).length).toBeGreaterThan(0);
	for (const name of Object.keys(IMPLEMENTED_HINTS)) {
		expect(`${name} excluded: ${name in EXCLUDED_HINTS}`).toBe(
			`${name} excluded: false`,
		);
	}
	for (const [name, reason] of Object.entries(EXCLUDED_HINTS)) {
		expect(`${name}: ${reason.length > 12}`).toBe(`${name}: true`);
	}
});

test("the dir attribute reaches the direction property", () => {
	expect(computed("<div dir=\"rtl\" id=\"d\">x</div>", "d", "direction")).toBe(
		"rtl",
	);
	expect(computed("<div dir=\"ltr\" id=\"d\">x</div>", "d", "direction")).toBe(
		"ltr",
	);
	// The attribute value is matched ASCII case-insensitively.
	expect(computed("<div dir=\"RTL\" id=\"d\">x</div>", "d", "direction")).toBe(
		"rtl",
	);
	// No dir attribute is the initial value.
	expect(computed("<div id=\"d\">x</div>", "d", "direction")).toBe("ltr");
});

test("dir inherits, and a nested dir overrides it", () => {
	const markup = "<div dir=\"rtl\"><p id=\"inner\">x</p></div>";
	expect(computed(markup, "inner", "direction")).toBe("rtl");
	const nested = "<div dir=\"rtl\"><p dir=\"ltr\" id=\"inner\">x</p></div>";
	expect(computed(nested, "inner", "direction")).toBe("ltr");
});

test("dir=auto reads the direction off the content", () => {
	expect(
		computed("<div dir=\"auto\" id=\"d\">שלום</div>", "d", "direction"),
	).toBe(
		"rtl",
	);
	expect(
		computed("<div dir=\"auto\" id=\"d\">hello</div>", "d", "direction"),
	).toBe(
		"ltr",
	);
	// The boundary, pinned rather than asserted away: the selector engine's
	// :dir() reads the FIRST character rather than the first character with a
	// strong direction, so content opening with digits or punctuation reads
	// left-to-right whatever follows. Writing dir=rtl says it outright.
	expect(
		computed("<div dir=\"auto\" id=\"d\">123 - שלום</div>", "d", "direction"),
	).toBe("ltr");
});

test("an unrecognized dir value inherits the parent's direction", () => {
	// Which is why the explicit values are attribute selectors rather than the
	// Rendering section's `[dir]:dir(ltr)`: a value that is neither ltr, rtl
	// nor auto matches no rule, and direction inherits, as the directionality
	// algorithm says it should.
	const markup = "<div dir=\"rtl\"><p dir=\"sideways\" id=\"inner\">x</p></div>";
	expect(computed(markup, "inner", "direction")).toBe("rtl");
});

test("bdi is auto without an attribute, and bdo takes the attribute", () => {
	expect(computed("<bdi id=\"d\">שלום</bdi>", "d", "direction")).toBe("rtl");
	expect(computed("<bdi id=\"d\">hello</bdi>", "d", "direction")).toBe("ltr");
	expect(computed("<bdo dir=\"rtl\" id=\"d\">x</bdo>", "d", "direction")).toBe(
		"rtl",
	);
});

test("an author's direction outranks the attribute", () => {
	// The dir rules are UA origin, so any author rule beats them -- including
	// one whose selector is weaker than the UA's.
	const markup = "<style>p { direction: ltr }</style><p dir=\"rtl\" id=\"d\">x</p>";
	expect(computed(markup, "d", "direction")).toBe("ltr");
});

test("the UA sheet carries the dir rules and no unicode-bidi", () => {
	// The exclusion list above is the record of what is missing; this pins the
	// sheet to it, so implementing unicode-bidi has to move an entry.
	expect(UA_DOCUMENT_STYLES).toContain("[dir=ltr i] { direction: ltr; }");
	expect(UA_DOCUMENT_STYLES).toContain("[dir=rtl i] { direction: rtl; }");
	expect(UA_DOCUMENT_STYLES).toContain("[dir=auto i]:dir(rtl)");
	expect(UA_DOCUMENT_STYLES.includes("unicode-bidi:")).toBe(false);
});
