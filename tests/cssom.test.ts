/**
 * CSSOM: the object model an author reaches, and the cascade reading the same
 * objects.
 *
 * The load-bearing property here is that there is exactly ONE CSSOM. A rule
 * inserted through `styleEl.sheet.insertRule` -- the way emotion and
 * styled-components inject -- reaches the terminal, because the sheet the
 * author mutated IS the sheet the cascade walks.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function makeDOM(html = ""): {terminal: MockProcess; dom: TermDOM} {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	return {terminal, dom};
}

test("insertRule on a style element's sheet repaints", async () => {
	const {terminal, dom} = makeDOM("<div class=\"box\">Boxed</div>");
	const style = dom.document.createElement("style");
	dom.document.head.appendChild(style);
	await nextFrame(dom);
	expect(terminal.getScreenContents()).not.toContain("38;2;255;0;0");

	const sheet = style.sheet!;
	expect(sheet.insertRule(".box { color: red; }", 0)).toBe(0);
	expect(sheet.cssRules.length).toBe(1);
	await nextFrame(dom);

	const box = dom.document.querySelector(".box")!;
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).toBe(
		"rgb(255, 0, 0)",
	);
	expect(terminal.getScreenContents()).toContain("38;2;255;0;0");

	sheet.deleteRule(0);
	await nextFrame(dom);
	expect(sheet.cssRules.length).toBe(0);
	expect(terminal.getScreenContents()).not.toContain("38;2;255;0;0");

	dom.dispose();
});

test("adoptedStyleSheets with replaceSync repaints", async () => {
	const {terminal, dom} = makeDOM("<div class=\"box\">Boxed</div>");
	await nextFrame(dom);

	const sheet = new dom.window.CSSStyleSheet();
	sheet.replaceSync(".box { color: red; }");
	dom.document.adoptedStyleSheets = [sheet];
	await nextFrame(dom);

	const box = dom.document.querySelector(".box")!;
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).toBe(
		"rgb(255, 0, 0)",
	);
	expect(terminal.getScreenContents()).toContain("38;2;255;0;0");

	// A later replaceSync on the adopted sheet reaches the render too.
	sheet.replaceSync(".box { color: blue; }");
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).toBe(
		"rgb(0, 0, 255)",
	);

	dom.document.adoptedStyleSheets = [];
	await nextFrame(dom);
	expect(terminal.getScreenContents()).not.toContain("38;2;0;0;255");

	dom.dispose();
});

test("writing a rule's declaration block repaints", async () => {
	const {dom} = makeDOM("<div class=\"box\">Boxed</div>");
	const style = dom.document.createElement("style");
	style.textContent = ".box { color: red; }";
	dom.document.head.appendChild(style);
	await nextFrame(dom);

	const rule = style.sheet!.cssRules[0] as CSSStyleRule;
	rule.style.setProperty("color", "blue");
	await nextFrame(dom);

	const box = dom.document.querySelector(".box")!;
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).toBe(
		"rgb(0, 0, 255)",
	);

	rule.selectorText = ".nothing";
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).not.toBe(
		"rgb(0, 0, 255)",
	);

	dom.dispose();
});

test("text mutation rebuilds the sheet; sheet mutation leaves the text alone", async () => {
	const {dom} = makeDOM();
	const style = dom.document.createElement("style");
	style.textContent = "div { color: red; }";
	dom.document.head.appendChild(style);
	await nextFrame(dom);

	const sheet = style.sheet!;
	expect(sheet.cssRules.length).toBe(1);

	sheet.insertRule("span { color: blue; }", 1);
	expect(sheet.cssRules.length).toBe(2);
	expect(style.textContent).toBe("div { color: red; }");

	style.textContent = "p { color: green; }";
	expect(sheet.cssRules.length).toBe(1);
	expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe("p");

	dom.dispose();
});

test("the whole CSSOM an author can reach is this engine's", async () => {
	const {dom} = makeDOM("<div id=\"box\" style=\"color: red\">Boxed</div>");
	const {window, document} = dom;
	const style = document.createElement("style");
	style.textContent = "@media (min-width: 1px) { #box { color: red } } div { margin: 1px }";
	document.head.appendChild(style);
	const adopted = new window.CSSStyleSheet();
	adopted.replaceSync("#box { padding: 1px }");
	document.adoptedStyleSheets = [adopted];
	await nextFrame(dom);

	const box = document.getElementById("box")!;
	const isOurs = (value: unknown, name: string): boolean =>
		value instanceof (window as any)[name];

	// Every door from a document, a window or an element to a sheet, a rule
	// or a declaration block opens on this engine's objects.
	expect(isOurs(style.sheet, "CSSStyleSheet")).toBe(true);
	expect(isOurs(document.styleSheets, "StyleSheetList")).toBe(true);
	expect(isOurs(document.styleSheets[0], "CSSStyleSheet")).toBe(true);
	expect(document.styleSheets[0]).toBe(style.sheet);
	expect(isOurs(document.adoptedStyleSheets[0], "CSSStyleSheet")).toBe(true);
	expect(isOurs(box.style, "CSSStyleDeclaration")).toBe(true);
	expect(isOurs(window.getComputedStyle(box), "CSSStyleDeclaration")).toBe(
		true,
	);

	const sheet = style.sheet!;
	expect(isOurs(sheet.cssRules, "CSSRuleList")).toBe(true);
	const mediaRule = sheet.cssRules[0] as CSSMediaRule;
	expect(isOurs(mediaRule, "CSSMediaRule")).toBe(true);
	expect(isOurs(mediaRule, "CSSConditionRule")).toBe(true);
	expect(isOurs(mediaRule, "CSSGroupingRule")).toBe(true);
	expect(isOurs(mediaRule, "CSSRule")).toBe(true);
	expect(isOurs(mediaRule.media, "MediaList")).toBe(true);
	const styleRule = mediaRule.cssRules[0] as CSSStyleRule;
	expect(isOurs(styleRule, "CSSStyleRule")).toBe(true);
	expect(isOurs(styleRule.style, "CSSStyleDeclaration")).toBe(true);
	expect(styleRule.style.parentRule).toBe(styleRule);
	expect(styleRule.parentRule).toBe(mediaRule);
	expect(styleRule.parentStyleSheet).toBe(sheet);
	expect(sheet.ownerNode).toBe(style);
	expect(sheet.ownerRule).toBeNull();

	// A <link> resolves to no sheet -- there is no network behind a terminal
	// document -- so it is not a second CSSOM either.
	const link = document.createElement("link");
	link.setAttribute("rel", "stylesheet");
	document.head.appendChild(link);
	expect(link.sheet).toBeNull();

	// Walk every sheet, every rule and every block a document can reach: not
	// one of them may be an object the cascade does not read.
	const foreign: string[] = [];
	const walkRules = (rules: CSSRuleList, where: string): void => {
		for (const rule of Array.from(rules)) {
			if (!isOurs(rule, "CSSRule")) {
				foreign.push(`${where} rule`);
			}
			const block = (rule as CSSStyleRule).style;
			if (block && !isOurs(block, "CSSStyleDeclaration")) {
				foreign.push(`${where} rule.style`);
			}
			if (
				rule.parentStyleSheet &&
				!isOurs(rule.parentStyleSheet, "CSSStyleSheet")
			) {
				foreign.push(`${where} rule.parentStyleSheet`);
			}
			const nested = (rule as CSSMediaRule).cssRules;
			if (nested) {
				walkRules(nested, `${where} >`);
			}
		}
	};
	for (const [where, sheets] of [
		["styleSheets", Array.from(document.styleSheets)],
		["adoptedStyleSheets", document.adoptedStyleSheets],
	] as const) {
		for (const sheet of sheets) {
			if (!isOurs(sheet, "CSSStyleSheet")) {
				foreign.push(where);
			}
			walkRules(sheet.cssRules, where);
		}
	}
	for (const element of document.querySelectorAll("*")) {
		if (!isOurs((element as HTMLElement).style, "CSSStyleDeclaration")) {
			foreign.push(`${element.tagName}.style`);
		}
		if (!isOurs(window.getComputedStyle(element), "CSSStyleDeclaration")) {
			foreign.push(`getComputedStyle(${element.tagName})`);
		}
	}
	expect(foreign).toEqual([]);

	dom.dispose();
});

test("getComputedStyle is read-only and enumerates the property index", async () => {
	const {dom} = makeDOM("<div id=\"box\" style=\"margin: 1px\">Boxed</div>");
	await nextFrame(dom);
	const style = dom.window.getComputedStyle(
		dom.document.getElementById("box")!,
	);

	expect(style.length).toBeGreaterThan(400);
	// Lexicographic, with the vendor-prefixed properties after the rest.
	expect(style.item(0)).toBe("accent-color");
	expect([...style].length).toBe(style.length);
	expect(style.getPropertyPriority("margin-top")).toBe("");
	expect(style.parentRule).toBeNull();

	// A computed style is read-only: writing one throws rather than lying.
	expect(() => style.setProperty("color", "red")).toThrow();
	expect(() => style.removeProperty("margin-top")).toThrow();
	expect(() => {
		style.cssText = "color: red";
	}).toThrow();

	dom.dispose();
});

test("a declaration block stores longhands and serializes shorthands", () => {
	const {dom} = makeDOM("<div id=\"box\"></div>");
	const style = dom.document.getElementById("box")!.style;

	style.margin = "1px";
	expect(style.marginTop).toBe("1px");
	expect(style.length).toBe(4);
	expect(style.item(0)).toBe("margin-top");
	expect(style.cssText).toBe("margin: 1px;");

	style.marginLeft = "2px";
	expect(style.margin).toBe("1px 1px 1px 2px");
	expect(style.cssText).toBe("margin: 1px 1px 1px 2px;");

	style.setProperty("margin-right", "3px", "important");
	// One longhand of four carrying !important makes the shorthand
	// unserializable, so the block falls back to the longhands.
	expect(style.margin).toBe("");
	expect(style.cssText).toContain("margin-right: 3px !important;");

	style.cssText = "border-top: 1px solid; color: RED";
	expect(style.borderTopWidth).toBe("1px");
	expect(style.borderTopColor).toBe("currentcolor");
	expect(style.borderTop).toBe("1px solid");
	expect(style.getPropertyValue("color")).toBe("RED");

	// A property outside the CSS property index is not stored at all.
	style.setProperty("not-a-property", "1px");
	expect(style.getPropertyValue("not-a-property")).toBe("");
	// A custom property is, and keeps its case.
	style.setProperty("--Accent", "red");
	expect(style.getPropertyValue("--Accent")).toBe("red");

	dom.dispose();
});

test("border-radius stores its corners and serializes both axes", () => {
	const {dom} = makeDOM("<div id=\"box\"></div>");
	const style = dom.document.getElementById("box")!.style;

	style.borderRadius = "1px";
	expect(style.length).toBe(4);
	expect(style.item(0)).toBe("border-top-left-radius");
	expect(style.borderTopLeftRadius).toBe("1px");
	expect(style.cssText).toBe("border-radius: 1px;");

	// Four corners, running top-left, top-right, bottom-right, bottom-left.
	style.borderRadius = "1px 2px 3px 4px";
	expect(style.borderTopRightRadius).toBe("2px");
	expect(style.borderBottomRightRadius).toBe("3px");
	expect(style.borderBottomLeftRadius).toBe("4px");

	// Two corners named, the other two filled by the CSS 1-4 rule.
	style.borderRadius = "1px 2px";
	expect(style.borderBottomRightRadius).toBe("1px");
	expect(style.borderBottomLeftRadius).toBe("2px");
	expect(style.cssText).toBe("border-radius: 1px 2px;");

	// The slash separates the horizontal radii from the vertical ones, and a
	// corner holds the pair its two lists give it.
	style.borderRadius = "1px 2px / 3px";
	expect(style.borderTopLeftRadius).toBe("1px 3px");
	expect(style.borderTopRightRadius).toBe("2px 3px");
	expect(style.borderRadius).toBe("1px 2px / 3px");
	expect(style.cssText).toBe("border-radius: 1px 2px / 3px;");

	// A corner whose two radii agree writes one of them, and a box whose two
	// axes agree writes no slash.
	style.borderRadius = "2px / 2px";
	expect(style.borderTopLeftRadius).toBe("2px");
	expect(style.borderRadius).toBe("2px");

	// Percentages are radii like any other length.
	style.borderRadius = "50% 25%";
	expect(style.borderTopLeftRadius).toBe("50%");
	expect(style.borderRadius).toBe("50% 25%");

	// A longhand overriding one corner reconstructs the shorthand around it.
	style.borderRadius = "1px";
	style.borderBottomLeftRadius = "5px";
	expect(style.borderRadius).toBe("1px 1px 1px 5px");

	// `border-radius: 0` resets every corner it had set.
	style.borderRadius = "0";
	expect(style.borderBottomLeftRadius).toBe("0");
	expect(style.cssText).toBe("border-radius: 0;");

	// One corner alone cannot serialize as the shorthand.
	style.removeProperty("border-radius");
	style.borderTopLeftRadius = "1px";
	expect(style.borderRadius).toBe("");
	expect(style.cssText).toBe("border-top-left-radius: 1px;");

	dom.dispose();
});

test("the accessor surface follows the CSSOM attribute-mapping rules", () => {
	const {dom} = makeDOM("<div id=\"box\"></div>");
	const style = dom.document.getElementById("box")!.style;

	style.cssFloat = "left";
	expect(style.getPropertyValue("float")).toBe("left");
	expect(style.float).toBe("left");

	// A -webkit- property carries all three spellings.
	(style as any).WebkitTextFillColor = "red";
	expect(style.webkitTextFillColor).toBe("red");
	expect(style.getPropertyValue("-webkit-text-fill-color")).toBe("red");
	expect((style as any)["-webkit-text-fill-color"]).toBe("red");

	// Properties this engine does not lay out still store and round-trip.
	style.setProperty("grid-auto-flow", "column dense");
	expect(style.gridAutoFlow).toBe("column dense");
	style.transitionDuration = "2s";
	expect(style.getPropertyValue("transition-duration")).toBe("2s");

	dom.dispose();
});

test("rules serialize as CSSOM says, and @import parses inert", async () => {
	const {dom} = makeDOM();
	const style = dom.document.createElement("style");
	style.textContent = `
		@import url("other.css") screen;
		#box, .row > span { color: red !important; margin: 1px 2px }
		@media screen and (min-width: 1px) { p { color: blue } }
	`;
	dom.document.head.appendChild(style);
	await nextFrame(dom);
	const rules = style.sheet!.cssRules;

	const importRule = rules[0] as CSSImportRule;
	expect(importRule.type).toBe(3);
	expect(importRule.href).toBe("other.css");
	expect(importRule.media.mediaText).toBe("screen");
	expect(importRule.styleSheet).toBeNull();
	expect(importRule.cssText).toBe('@import url("other.css") screen;');

	const styleRule = rules[1] as CSSStyleRule;
	expect(styleRule.type).toBe(1);
	expect(styleRule.cssText).toBe(
		"#box, .row > span { color: red !important; margin: 1px 2px; }",
	);

	const mediaRule = rules[2] as CSSMediaRule;
	expect(mediaRule.type).toBe(4);
	expect(mediaRule.conditionText).toBe("screen and (min-width: 1px)");
	expect(mediaRule.cssText).toBe(
		"@media screen and (min-width: 1px) {\n  p { color: blue; }\n}",
	);

	// Assigning a rule's text does nothing, as in every engine.
	styleRule.cssText = "ignored";
	expect(styleRule.selectorText).toBe("#box, .row > span");

	dom.dispose();
});

test("stylesheet mutation errors follow the spec", async () => {
	const {dom} = makeDOM();
	const style = dom.document.createElement("style");
	style.textContent = "div { color: red }";
	dom.document.head.appendChild(style);
	await nextFrame(dom);
	const sheet = style.sheet!;

	expect(() => sheet.insertRule("div { color: red }", 5)).toThrow();
	expect(() => sheet.deleteRule(5)).toThrow();
	expect(() => sheet.insertRule("not a rule")).toThrow();
	// A parsed sheet is not constructed, so it cannot be replaced wholesale.
	expect(() => sheet.replaceSync("p { color: red }")).toThrow();

	const constructed = new dom.window.CSSStyleSheet({media: "screen"});
	expect(constructed.media.mediaText).toBe("screen");
	expect(constructed.ownerNode).toBeNull();
	await constructed.replace("p { color: red } @import url(x.css);");
	// A constructed sheet drops @import rather than fetching it.
	expect(constructed.cssRules.length).toBe(1);
	// Only a constructed sheet can be adopted.
	expect(() => {
		dom.document.adoptedStyleSheets = [sheet];
	}).toThrow();

	dom.dispose();
});

test("a disabled sheet contributes nothing to the cascade", async () => {
	const {dom} = makeDOM("<div class=\"box\">Boxed</div>");
	const style = dom.document.createElement("style");
	style.textContent = ".box { color: red }";
	dom.document.head.appendChild(style);
	await nextFrame(dom);
	const box = dom.document.querySelector(".box")!;
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).toBe(
		"rgb(255, 0, 0)",
	);

	style.sheet!.disabled = true;
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(box).getPropertyValue("color")).not.toBe(
		"rgb(255, 0, 0)",
	);

	dom.dispose();
});

test("a shadow root's stylesheets and adopted sheets are the same CSSOM", async () => {
	const {dom} = makeDOM("<div id=\"host\"></div>");
	const host = dom.document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<style>span { color: red }</style><span>Shadowed</span>";
	await nextFrame(dom);

	expect(root.styleSheets.length).toBe(1);
	expect(root.styleSheets[0]).toBe(root.querySelector("style")!.sheet);
	const span = root.querySelector("span")!;
	expect(dom.window.getComputedStyle(span).getPropertyValue("color")).toBe(
		"rgb(255, 0, 0)",
	);

	const sheet = new dom.window.CSSStyleSheet();
	sheet.replaceSync("span { color: blue }");
	root.adoptedStyleSheets = [sheet];
	await nextFrame(dom);
	expect(root.adoptedStyleSheets[0]).toBe(sheet);
	expect(dom.window.getComputedStyle(span).getPropertyValue("color")).toBe(
		"rgb(0, 0, 255)",
	);

	dom.dispose();
});

test("text the CSS parsers cannot judge passes through as authored", () => {
	const {dom} = makeDOM();
	const sheet = new dom.window.CSSStyleSheet();

	// A media list keeps queries this engine cannot judge, case-folded.
	const mediaText = (query: string): string => {
		sheet.replaceSync(`@media ${query} { a { color: red } }`);
		return (sheet.cssRules[0] as CSSMediaRule).media.mediaText;
	};
	expect(mediaText("GARBAGE!!")).toBe("garbage!!");
	expect(mediaText("screen and foo")).toBe("screen and foo");
	expect(mediaText("not(color)")).toBe("not(color)");
	expect(mediaText("not (a) and (b)")).toBe("not (a) and (b)");
	expect(mediaText("SCREEN and (Min-Width: 5PX)")).toBe(
		"screen and (min-width: 5px)",
	);
	// An or-group serializes as one condition, its first value canonicalized.
	expect(mediaText("((min-width: 05px) or (color))")).toBe(
		"((min-width: 5px) or (color))",
	);
	// Features that stand apart without `and` are opaque text, not a join.
	expect(mediaText("(min-width: 05px) (color)")).toBe(
		"(min-width: 5px) (color)",
	);

	// A value whose parentheses never close swallows the rest of the block.
	sheet.replaceSync("a { color: red(; width: 10px }");
	const styleRule = sheet.cssRules[0] as CSSStyleRule;
	expect(styleRule.style.length).toBe(0);
	expect(styleRule.cssText).toBe("a { }");

	// A keyframe selector is `from`, `to` or a percentage, and a percentage
	// is a number token: an exponent spells one as anywhere else in CSS. A
	// word standing where a selector belongs serializes empty.
	sheet.replaceSync("@keyframes k { from {} 50.0% {} 1e2% {} halfway {} }");
	const keyframes = sheet.cssRules[0] as CSSKeyframesRule;
	expect(Array.from(keyframes.cssRules, (rule) =>
		(rule as CSSKeyframeRule).keyText,
	)).toEqual(["0%", "50%", "100%", ""]);

	// `layer` names a layer only as a word of its own: `layered-thing` is a
	// media query, and a media type this engine cannot judge is kept as
	// authored. A constructed sheet drops @import, so these parse through a
	// style element's sheet.
	const style = dom.document.createElement("style");
	dom.document.head.appendChild(style);
	const parsedSheet = style.sheet!;
	parsedSheet.insertRule("@import url(a.css) layered-thing;", 0);
	const imported = parsedSheet.cssRules[0] as CSSImportRule;
	expect(imported.layerName).toBe(null);
	expect(imported.media.mediaText).toBe("layered-thing");
	// An @import prelude off the grammar is a rule nothing can hold.
	expect(() => parsedSheet.insertRule("@import url(a.css) garbage!!;", 0))
		.toThrow();

	// `layer()` takes a layer name: one off the grammar drops the rule,
	// while the bare word asks for the anonymous layer.
	expect(() => parsedSheet.insertRule("@import url(a.css) layer(1a);", 0))
		.toThrow();
	parsedSheet.insertRule("@import url(a.css) layer;", 0);
	expect((parsedSheet.cssRules[0] as CSSImportRule).layerName).toBe("");

	// A supports() whose parenthesis never closes is recovered ending at the
	// text: the condition reaches its last character.
	parsedSheet.insertRule("@import url(a.css) supports(display:flex", 0);
	expect((parsedSheet.cssRules[0] as CSSImportRule).supportsText)
		.toBe("display:flex");

	dom.dispose();
});
