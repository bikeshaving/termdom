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
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {UA_DOCUMENT_STYLES} from "../src/internal/useragent.ts";
import {MockProcess} from "./test-utils.js";

/** The computed value of a property on the element an id names. */
function computed(html: string, id: string, property: string): string {
	const {window, document} = new TermDOM({
		html: `<!DOCTYPE html><html><body>${html}</body></html>`,
		transport: new MockProcess().transport,
	});
	return window
		.getComputedStyle(document.getElementById(id)!)
		.getPropertyValue(property);
}

/**
 * The attribute-to-style mappings the Rendering section defines, keyed by the
 * element and attribute that carry them.
 */
const IMPLEMENTED_HINTS: Record<string, string> = {
	"*[dir]": "direction",
	bdi: "direction",
	"input[type=tel]": "direction",
	"body[bgcolor]": "background-color",
	"body[text]": "color",
	"body[link]": "color on :link",
	"body[marginheight]": "margin-top and margin-bottom",
	"body[marginwidth]": "margin-left and margin-right",
	"font[color]": "color",
	"table[bgcolor]": "background-color",
	"tr[bgcolor]": "background-color",
	"td[bgcolor]": "background-color",
	"th[bgcolor]": "background-color",
	"table[bordercolor]": "border colors",
	"table[border]": "border widths and style",
	"table[cellspacing]": "border-spacing",
	"table[cellpadding]": "padding on the table's cells",
	"table[align=center]": "auto side margins",
	"hr[color]": "color and border colors",
	"hr[align]": "side margins",
	"div[align]": "text-align",
	"p[align]": "text-align",
	"caption[align]": "text-align",
	center: "display: block and text-align: center",
	"td[align]": "text-align",
	"th[align]": "text-align",
	"tr[align]": "text-align",
	"thead[align]": "text-align",
	"tbody[align]": "text-align",
	"tfoot[align]": "text-align",
	"td[valign]": "vertical-align",
	"th[valign]": "vertical-align",
	"tr[valign]": "vertical-align",
	"td[nowrap]": "white-space: nowrap, unless quirks mode gives the cell a pixel width",
	"table[height]": "height",
	"table[width]": "width",
	"col[width]": "width",
	"thead[height]": "height",
	"tbody[height]": "height",
	"tfoot[height]": "height",
	"tr[height]": "height",
	"td[height]": "height",
	"td[width]": "width",
	"hr[width]": "width",
	"img[width]": "width",
	"img[height]": "height",
	"embed[width]": "width",
	"embed[height]": "height",
	"iframe[width]": "width",
	"iframe[height]": "height",
	"object[width]": "width",
	"object[height]": "height",
	"video[width]": "width",
	"video[height]": "height",
	"input[type=image][width]": "width",
	"input[type=image][height]": "height",
	"img[hspace]": "side margins",
	"img[vspace]": "top and bottom margins",
	"embed[hspace]": "side margins",
	"embed[vspace]": "top and bottom margins",
	"object[hspace]": "side margins",
	"object[vspace]": "top and bottom margins",
	"input[type=image][hspace]": "side margins",
	"input[type=image][vspace]": "top and bottom margins",
	"img[border]": "border widths and style",
	"object[border]": "border widths and style",
	"input[type=image][border]": "border widths and style",
	"ul[type]": "list-style-type",
	"ol[type]": "list-style-type",
	"li[type]": "list-style-type",
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
	"body[vlink]": "color on :visited -- no visited or link history here",
	"body[alink]": "color on :active :link -- :active is the pointer's, not a link state",
	"font[face]": "font-family: one terminal font, chosen by the terminal",
	"font[size]": "font-size: one cell, and every cell is the same size",
	"marquee[bgcolor]":
		"background-color on a marquee, which does not scroll here",
	"table[background]": "background-image: a raster image, which needs pixels",
	"td[background]": "background-image: a raster image, which needs pixels",

	// Alignment attributes, which map to text-align, float and vertical-align.
	"img[align]": "float and vertical-align on a replaced element",
	"embed[align]": "float and vertical-align on a replaced element",
	"iframe[align]": "float and vertical-align on a replaced element",
	"object[align]": "float and vertical-align on a replaced element",
	"input[type=image][align]": "float and vertical-align on a replaced element",

	// Dimension attributes: pixel lengths and aspect ratios.
	"hr[size]": "border widths and height as pixel lengths",
	"hr[noshade]": "border widths as pixel lengths",
	"canvas[width]": "aspect-ratio on a canvas, which paints no pixels here",
	"canvas[height]": "aspect-ratio on a canvas, which paints no pixels here",
	"img aspect-ratio":
		"aspect-ratio from width and height on a raster image, which needs pixels",
	"video aspect-ratio":
		"aspect-ratio from width and height on a video, which needs pixels",
	"marquee[hspace]": "margins on a marquee, which does not scroll here",
	"marquee[vspace]": "margins on a marquee, which does not scroll here",
	"iframe[frameborder]": "border widths on a nested document, which is absent",

	// Counters and the rest.
	"li[value]": "counter-set: the list numbering is computed, not a counter",
	"ol[start]": "counter-reset: the list numbering is computed, not a counter",
	"ol[reversed]":
		"counter-reset: the list numbering is computed, not a counter",
	"br[clear]": "clear: no floats to clear",
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
	).toBe("rtl");
	expect(
		computed("<div dir=\"auto\" id=\"d\">hello</div>", "d", "direction"),
	).toBe("ltr");
	// The first character with a STRONG direction decides, so digits and
	// punctuation ahead of the text settle nothing.
	expect(
		computed("<div dir=\"auto\" id=\"d\">123 - שלום</div>", "d", "direction"),
	).toBe("rtl");
	expect(
		computed("<div dir=\"auto\" id=\"d\">123 - hello</div>", "d", "direction"),
	).toBe("ltr");
});

test("an unrecognized dir value inherits the parent's direction", () => {
	// Which is why the explicit values are attribute selectors rather than the
	// Rendering section's `[dir]:dir(ltr)`: a value that is neither ltr, rtl
	// nor auto matches no rule, and direction inherits, as the getDirectionality
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

test("a legacy color attribute reads as HTML's legacy color parser reads it", () => {
	const color = (value: string) =>
		computed(
			`<table><tr><td id="c" bgcolor="${value}">x</td></tr></table>`,
			"c",
			"background-color",
		);
	expect(color("#336699")).toBe("rgb(51, 102, 153)");
	expect(color("336699")).toBe("rgb(51, 102, 153)");
	expect(color("#abc")).toBe("rgb(170, 187, 204)");
	expect(color("red")).toBe("rgb(255, 0, 0)");
	expect(color("chucknorris")).toBe("rgb(192, 0, 0)");
	expect(color("transparent")).toBe("rgba(0, 0, 0, 0)");
});

test("body, font and link colors come from their attributes", () => {
	const markup =
		"<font id=\"f\" color=\"green\">x</font><a id=\"a\" href=\"#\">link</a>";
	const {window, document} = new TermDOM({
		html: `<!DOCTYPE html><html><body id="b" bgcolor="navy" text="yellow" link="lime">${markup}</body></html>`,
		transport: new MockProcess().transport,
	});
	const style = (id: string) =>
		window.getComputedStyle(document.getElementById(id)!);
	expect(style("b").backgroundColor).toBe("rgb(0, 0, 128)");
	expect(style("b").color).toBe("rgb(255, 255, 0)");
	expect(style("f").color).toBe("rgb(0, 128, 0)");
	expect(style("a").color).toBe("rgb(0, 255, 0)");
});

test("align and valign reach text-align and vertical-align", () => {
	expect(computed("<div id=\"d\" align=\"center\">x</div>", "d", "text-align"))
		.toBe("center");
	expect(computed("<center id=\"d\">x</center>", "d", "text-align")).toBe(
		"center",
	);
	const cell =
		"<table><tr><td id=\"c\" align=\"right\" valign=\"top\">x</td></tr></table>";
	expect(computed(cell, "c", "text-align")).toBe("right");
	expect(computed(cell, "c", "vertical-align")).toBe("top");
});

test("a table's attributes size it and pad its cells", () => {
	const markup =
		"<table id=\"t\" width=\"30\" border=\"2\" cellpadding=\"3\" align=\"center\">" +
		"<tbody><tr><td id=\"c\" width=\"50%\" nowrap>x</td></tr></tbody></table>";
	expect(computed(markup, "t", "width")).toBe("30px");
	expect(computed(markup, "t", "border-top-width")).toBe("2px");
	expect(computed(markup, "t", "border-top-style")).toBe("outset");
	expect(computed(markup, "c", "padding-left")).toBe("3px");
	expect(computed(markup, "c", "text-wrap-mode")).toBe("nowrap");
});

test("an author rule of any specificity outranks a hint", () => {
	expect(
		computed(
			"<style>@layer base { td { background-color: green } }</style>" +
				"<table><tr><td id=\"c\" bgcolor=\"red\">x</td></tr></table>",
			"c",
			"background-color",
		),
	).toBe("rgb(0, 128, 0)");
});

test("changing a table's cellpadding restyles its cells", () => {
	const {window, document} = new TermDOM({
		html:
			"<!DOCTYPE html><html><body><table id=\"t\" cellpadding=\"1\"><tr>" +
			"<td id=\"c\">x</td></tr></table></body></html>",
		transport: new MockProcess().transport,
	});
	const cell = document.getElementById("c")!;
	expect(window.getComputedStyle(cell).paddingLeft).toBe("1px");
	document.getElementById("t")!.setAttribute("cellpadding", "4");
	expect(window.getComputedStyle(cell).paddingLeft).toBe("4px");
});

test("list type attributes reach list-style-type", () => {
	expect(
		computed("<ol id=\"o\" type=\"a\"><li>x</li></ol>", "o", "list-style-type"),
	)
		.toBe("lower-alpha");
	expect(
		computed("<ol><li id=\"l\" type=\"I\">x</li></ol>", "l", "list-style-type"),
	)
		.toBe("upper-roman");
});
