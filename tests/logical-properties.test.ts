/**
 * CSS logical properties (css-logical-1): the flow-relative spelling of the
 * box model.
 *
 * Two things are load-bearing here. A logical property and the physical
 * property it maps to are ONE cascade slot -- `margin-left` then
 * `margin-inline-start` is 2px in LTR, the same pair reversed is 1px -- and
 * the mapping is read off the element's `direction`, so the same declaration
 * paints the left edge of an LTR box and the right edge of an RTL one.
 */

import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function makeDOM(html = "", cols = 40, rows = 10): {
	terminal: MockProcess;
	dom: TermDOM;
} {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	return {terminal, dom};
}

/** One element's computed values, after a frame. */
async function computed(
	html: string,
	selector = "#t",
): Promise<{
	style: CSSStyleDeclaration;
	of: (property: string) => string;
	rect: ReturnType<Element["getBoundingClientRect"]>;
	text: string;
	dom: TermDOM;
}> {
	const {terminal, dom} = makeDOM(html);
	await nextFrame(dom);
	const element = dom.document.querySelector(selector)!;
	const style = dom.window.getComputedStyle(element);
	return {
		style,
		of: (property: string) => style.getPropertyValue(property),
		rect: element.getBoundingClientRect(),
		text: terminal.getVisibleText(),
		dom,
	};
}

/** A detached declaration block, for the CSSOM half. */
function block(): CSSStyleDeclaration {
	const {dom} = makeDOM();
	return dom.document.createElement("div").style;
}

// --- CSSOM: shorthands, longhands and serialization ------------------------

test("margin-inline expands to its longhands and serializes back", () => {
	const style = block();
	style.cssText = "margin-inline: 1px 2px";
	expect([...style]).toEqual(["margin-inline-start", "margin-inline-end"]);
	expect(style.getPropertyValue("margin-inline-start")).toBe("1px");
	expect(style.getPropertyValue("margin-inline-end")).toBe("2px");
	expect(style.getPropertyValue("margin-inline")).toBe("1px 2px");
	expect(style.cssText).toBe("margin-inline: 1px 2px;");
});

test("a flow-relative pair collapses when both ends agree", () => {
	const style = block();
	style.cssText = "padding-block: 3px";
	expect(style.getPropertyValue("padding-block-start")).toBe("3px");
	expect(style.getPropertyValue("padding-block-end")).toBe("3px");
	expect(style.cssText).toBe("padding-block: 3px;");
});

test("inset-inline and inset-block round-trip through their longhands", () => {
	const style = block();
	style.cssText = "inset-inline: 1px 2px; inset-block: 3px";
	expect(style.getPropertyValue("inset-inline-start")).toBe("1px");
	expect(style.getPropertyValue("inset-inline-end")).toBe("2px");
	expect(style.getPropertyValue("inset-block-start")).toBe("3px");
	expect(style.getPropertyValue("inset-block-end")).toBe("3px");
	expect(style.cssText).toBe("inset-inline: 1px 2px; inset-block: 3px;");
});

test("inset states all four physical offsets", () => {
	const style = block();
	style.cssText = "inset: 1px 2px";
	expect(style.getPropertyValue("top")).toBe("1px");
	expect(style.getPropertyValue("right")).toBe("2px");
	expect(style.getPropertyValue("bottom")).toBe("1px");
	expect(style.getPropertyValue("left")).toBe("2px");
	expect(style.cssText).toBe("inset: 1px 2px;");
});

test("border-inline-start expands to width, style and color", () => {
	const style = block();
	style.cssText = "border-inline-start: 1px solid red";
	expect(style.getPropertyValue("border-inline-start-width")).toBe("1px");
	expect(style.getPropertyValue("border-inline-start-style")).toBe("solid");
	expect(style.getPropertyValue("border-inline-start-color")).toBe("red");
	expect(style.cssText).toBe("border-inline-start: 1px solid red;");
});

test("border-inline draws both edges of the axis", () => {
	const style = block();
	style.cssText = "border-inline: 2px dashed";
	expect(style.getPropertyValue("border-inline-start-style")).toBe("dashed");
	expect(style.getPropertyValue("border-inline-end-width")).toBe("2px");
	expect(style.getPropertyValue("border-inline")).toBe("2px dashed");
	expect(style.cssText).toBe("border-inline: 2px dashed;");
});

test("border-block-width states one component across the axis", () => {
	const style = block();
	style.cssText = "border-block-width: 1px 2px";
	expect(style.getPropertyValue("border-block-start-width")).toBe("1px");
	expect(style.getPropertyValue("border-block-end-width")).toBe("2px");
	expect(style.cssText).toBe("border-block-width: 1px 2px;");
});

test("the flow-relative sizes are longhands of their own", () => {
	const style = block();
	style.cssText =
		"inline-size: 10px; block-size: 4px; min-inline-size: 2px; max-block-size: 8px";
	expect(style.getPropertyValue("inline-size")).toBe("10px");
	expect(style.getPropertyValue("block-size")).toBe("4px");
	expect(style.getPropertyValue("min-inline-size")).toBe("2px");
	expect(style.getPropertyValue("max-block-size")).toBe("8px");
	expect(style.cssText).toBe(
		"inline-size: 10px; block-size: 4px; min-inline-size: 2px; max-block-size: 8px;",
	);
});

test("the IDL attribute reflects a flow-relative longhand", () => {
	const style = block();
	style.marginInlineStart = "4px";
	expect(style.getPropertyValue("margin-inline-start")).toBe("4px");
	expect(style.cssText).toBe("margin-inline-start: 4px;");
	style.setProperty("inline-size", "6px");
	expect(style.inlineSize).toBe("6px");
});

// --- Computed values: one slot, two names ---------------------------------

test("a logical property computes to the same value as its physical name", async () => {
	const {of} = await computed(
		"<div id=\"t\" style=\"margin-inline-start: 2px; margin-block-end: 3px; padding-inline-end: 1px; inline-size: 9px; block-size: 4px\"></div>",
	);
	expect(of("margin-left")).toBe("2px");
	expect(of("margin-inline-start")).toBe("2px");
	expect(of("margin-bottom")).toBe("3px");
	expect(of("margin-block-end")).toBe("3px");
	expect(of("padding-right")).toBe("1px");
	expect(of("padding-inline-end")).toBe("1px");
	expect(of("width")).toBe("9px");
	expect(of("inline-size")).toBe("9px");
	expect(of("height")).toBe("4px");
	expect(of("block-size")).toBe("4px");
});

test("a physical declaration answers under the logical name too", async () => {
	const {of} = await computed(
		"<div id=\"t\" style=\"margin-left: 5px; border-top: 1px solid red\"></div>",
	);
	expect(of("margin-inline-start")).toBe("5px");
	expect(of("border-block-start-width")).toBe("1px");
	expect(of("border-block-start-style")).toBe("solid");
	expect(of("border-block-start-color")).toBe("rgb(255, 0, 0)");
});

test("the later declaration wins the slot: physical then logical", async () => {
	const {of} = await computed(
		"<style>#t { margin-left: 1px; margin-inline-start: 2px }</style><div id=\"t\"></div>",
	);
	expect(of("margin-left")).toBe("2px");
	expect(of("margin-inline-start")).toBe("2px");
});

test("the later declaration wins the slot: logical then physical", async () => {
	const {of} = await computed(
		"<style>#t { margin-inline-start: 2px; margin-left: 1px }</style><div id=\"t\"></div>",
	);
	expect(of("margin-left")).toBe("1px");
	expect(of("margin-inline-start")).toBe("1px");
});

test("a property written through the IDL takes the slot from an earlier one", async () => {
	const {dom} = makeDOM("<div id=\"t\"></div>");
	await nextFrame(dom);
	const element = dom.document.getElementById("t")!;
	element.style.marginInlineStart = "2px";
	element.style.marginLeft = "1px";
	expect(dom.window.getComputedStyle(element).marginInlineStart).toBe("1px");
	element.style.marginInlineStart = "3px";
	expect(dom.window.getComputedStyle(element).marginLeft).toBe("3px");
	dom.dispose();
});

test("a computed style reports both names of the slot", async () => {
	const {style} = await computed(
		"<div id=\"t\" style=\"margin-inline-start: 2px\"></div>",
	);
	const names = [...style];
	expect(names).toContain("margin-inline-start");
	expect(names).toContain("margin-left");
	expect(style.marginInlineStart).toBe(style.marginLeft);
});

test("cascade order decides the slot across rules, not property kind", async () => {
	const {of} = await computed(
		"<style>.a { margin-inline-start: 2px } .a { margin-left: 1px }</style><div id=\"t\" class=\"a\"></div>",
	);
	expect(of("margin-left")).toBe("1px");
});

test("an !important physical declaration beats a later logical one", async () => {
	const {of} = await computed(
		"<style>#t { margin-left: 1px !important; margin-inline-start: 2px }</style><div id=\"t\"></div>",
	);
	expect(of("margin-left")).toBe("1px");
	expect(of("margin-inline-start")).toBe("1px");
});

test("specificity outranks source order for the shared slot", async () => {
	const {of} = await computed(
		"<style>#t { margin-inline-start: 2px } div { margin-left: 1px }</style><div id=\"t\"></div>",
	);
	expect(of("margin-left")).toBe("2px");
});

test("under direction:rtl the inline slot is the right edge", async () => {
	const {of} = await computed(
		"<style>#t { direction: rtl; margin-left: 1px; margin-inline-start: 2px }</style><div id=\"t\"></div>",
	);
	// margin-inline-start names margin-right here, so the two declarations are
	// different slots and neither overrides the other.
	expect(of("margin-right")).toBe("2px");
	expect(of("margin-left")).toBe("1px");
	expect(of("margin-inline-start")).toBe("2px");
	expect(of("margin-inline-end")).toBe("1px");
});

test("direction:rtl leaves the block axis where it was", async () => {
	const {of} = await computed(
		"<style>#t { direction: rtl; margin-block-start: 2px }</style><div id=\"t\"></div>",
	);
	expect(of("margin-top")).toBe("2px");
	expect(of("margin-bottom")).toBe("0px");
});

test("the flow-relative sizes ignore direction", async () => {
	const {of} = await computed(
		"<div id=\"t\" style=\"direction: rtl; inline-size: 9px; block-size: 4px\"></div>",
	);
	expect(of("width")).toBe("9px");
	expect(of("height")).toBe("4px");
});

// --- Layout: the edge a flow-relative declaration actually moves -----------

test("margin-inline-start indents from the left in ltr", async () => {
	const {rect, text} = await computed(
		"<div id=\"t\" style=\"margin-inline-start: 4px; width: 10px\">hi</div>",
	);
	expect(rect.left).toBe(4);
	expect(text.split("\n")[0]).toBe("    hi");
});

test("margin-inline-end indents from the left in rtl", async () => {
	const start = await computed(
		"<div style=\"direction: rtl; width: 20px\"><div id=\"t\" style=\"margin-inline-start: 4px; width: 10px\">hi</div></div>",
	);
	// The start edge is the right one here, so the margin holds the box off
	// the far side of the containing block and its left edge does not move.
	expect(start.of("margin-right")).toBe("4px");
	expect(start.rect.left).toBe(0);
	// The end edge is the left one, and a box indented from it does move.
	const end = await computed(
		"<div style=\"direction: rtl; width: 20px\"><div id=\"t\" style=\"margin-inline-end: 4px; width: 10px\">hi</div></div>",
	);
	expect(end.of("margin-left")).toBe("4px");
	expect(end.rect.left).toBe(4);
});

test("padding-inline-start pushes content off the correct edge", async () => {
	const ltr = await computed(
		"<div id=\"t\" style=\"padding-inline-start: 3px; width: 12px\">hi</div>",
	);
	expect(ltr.text.split("\n")[0]).toBe("   hi");
	const rtl = await computed(
		"<div id=\"t\" style=\"direction: rtl; padding-inline-start: 3px; width: 12px\">hi</div>",
	);
	// RTL puts the start edge on the right, and the line reads from it.
	expect(rtl.text.split("\n")[0]).toBe("       hi");
});

test("border-inline-start draws the left edge in ltr and the right in rtl", async () => {
	const ltr = await computed(
		"<div id=\"t\" style=\"border-inline-start: 1px solid; width: 6px\">x</div>",
	);
	expect(ltr.text.split("\n")[0]).toBe("│x");
	const rtl = await computed(
		"<div id=\"t\" style=\"direction: rtl; border-inline-start: 1px solid; width: 6px\">x</div>",
	);
	expect(rtl.text.split("\n")[0]).toBe("    x│");
});

test("inset-inline-start offsets a positioned box off the correct edge", async () => {
	const ltr = await computed(
		"<div style=\"position: relative; width: 20px; height: 3px\"><div id=\"t\" style=\"position: absolute; inset-inline-start: 5px; width: 4px\">x</div></div>",
	);
	expect(ltr.rect.left).toBe(5);
	const rtl = await computed(
		"<div style=\"direction: rtl; position: relative; width: 20px; height: 3px\"><div id=\"t\" style=\"position: absolute; inset-inline-start: 5px; width: 4px\">x</div></div>",
	);
	expect(rtl.rect.right).toBe(15);
});

test("inline-size and block-size size the box", async () => {
	const {rect} = await computed(
		"<div id=\"t\" style=\"inline-size: 7px; block-size: 3px\"></div>",
	);
	expect(rect.width).toBe(7);
	expect(rect.height).toBe(3);
});

// --- text-align: start and end --------------------------------------------

test("text-align:start is the left edge in ltr and the right in rtl", async () => {
	const ltr = await computed(
		"<div id=\"t\" style=\"text-align: start; width: 10px\">ab</div>",
	);
	expect(ltr.text.split("\n")[0]).toBe("ab");
	const rtl = await computed(
		"<div id=\"t\" style=\"direction: rtl; text-align: start; width: 10px\">ab</div>",
	);
	expect(rtl.text.split("\n")[0]).toBe("        ab");
});

test("text-align:end is the right edge in ltr and the left in rtl", async () => {
	const ltr = await computed(
		"<div id=\"t\" style=\"text-align: end; width: 10px\">ab</div>",
	);
	expect(ltr.text.split("\n")[0]).toBe("        ab");
	const rtl = await computed(
		"<div id=\"t\" style=\"direction: rtl; text-align: end; width: 10px\">ab</div>",
	);
	expect(rtl.text.split("\n")[0]).toBe("ab");
});
