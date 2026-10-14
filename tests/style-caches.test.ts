import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {getBoxModel, getDeclaredDisplay} from "../src/internal/cssom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function mount(html: string): Promise<{dom: TermDOM; document: any}> {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {dom, document: dom.document};
}

test("the box model is the same object until the element's style changes", async () => {
	const {dom, document} =
		await mount("<div id=a style=\"padding: 0 2px\">a</div><div id=b>b</div>");
	const a = document.getElementById("a");
	const first = getBoxModel(a);
	expect(getBoxModel(a)).toBe(first);
	document.getElementById("b").style.color = "red";
	await nextFrame(dom);
	expect(getBoxModel(a)).toBe(first);
	dom.dispose();
});

test("the box model follows an inline style change", async () => {
	const {dom, document} =
		await mount("<div id=a style=\"padding-left: 2px\">a</div>");
	const a = document.getElementById("a");
	expect(getBoxModel(a).paddingLeft).toBe(2);
	a.style.paddingLeft = "5px";
	await nextFrame(dom);
	expect(getBoxModel(a).paddingLeft).toBe(5);
	a.removeAttribute("style");
	await nextFrame(dom);
	expect(getBoxModel(a).paddingLeft === 0).toBe(true);
	dom.dispose();
});

test("the box model follows a class that changes which rule matches", async () => {
	const {dom, document} = await mount(
		"<style>.wide { margin-left: 4px; border: 1px solid }</style><div id=a>a</div>",
	);
	const a = document.getElementById("a");
	expect([getBoxModel(a).marginLeft, getBoxModel(a).borderLeftWidth])
		.toEqual([0, 0]);
	a.classList.add("wide");
	await nextFrame(dom);
	expect([getBoxModel(a).marginLeft, getBoxModel(a).borderLeftWidth])
		.toEqual([4, 1]);
	a.classList.remove("wide");
	await nextFrame(dom);
	expect([getBoxModel(a).marginLeft, getBoxModel(a).borderLeftWidth])
		.toEqual([0, 0]);
	dom.dispose();
});

test("the box model follows a stylesheet edited in place", async () => {
	const {dom, document} = await mount(
		"<style id=s>div { padding-left: 1px }</style><div id=a>a</div>",
	);
	const a = document.getElementById("a");
	expect(getBoxModel(a).paddingLeft).toBe(1);
	document.getElementById("s").textContent = "div { padding-left: 3px }";
	await nextFrame(dom);
	expect(getBoxModel(a).paddingLeft).toBe(3);
	const sheet = document.getElementById("s").sheet;
	sheet.cssRules[0].style.paddingLeft = "6px";
	await nextFrame(dom);
	expect(getBoxModel(a).paddingLeft).toBe(6);
	dom.dispose();
});

test("the box model follows an inherited font size its lengths are in", async () => {
	const {dom, document} = await mount(
		"<div id=p style=\"font-size: 2px\"><div id=a style=\"padding-left: 1em\">a</div></div>",
	);
	const a = document.getElementById("a");
	expect(getBoxModel(a).paddingLeft).toBe(2);
	document.getElementById("p").style.fontSize = "3px";
	await nextFrame(dom);
	expect(getBoxModel(a).paddingLeft).toBe(3);
	dom.dispose();
});

test("the declared display follows a class and an edited stylesheet", async () => {
	const {dom, document} = await mount(
		"<style id=s>.row { display: flex }</style><span id=a>a</span>",
	);
	const a = document.getElementById("a");
	expect(getDeclaredDisplay(a)).toBe("inline");
	a.className = "row";
	await nextFrame(dom);
	expect(getDeclaredDisplay(a)).toBe("flex");
	document.getElementById("s").textContent = ".row { display: grid }";
	await nextFrame(dom);
	expect(getDeclaredDisplay(a)).toBe("grid");
	a.removeAttribute("class");
	await nextFrame(dom);
	expect(getDeclaredDisplay(a)).toBe("inline");
	dom.dispose();
});

test("a list marker's color follows its ::marker rule", async () => {
	const {dom, document} = await mount(
		"<style id=s>li::marker { color: rgb(0, 128, 0) }</style><ul><li>item</li></ul>",
	);
	const bulletColor = (): string => {
		const output = dom.renderANSI();
		const bullet = output.indexOf("•");
		return output.slice(0, bullet);
	};
	expect(bulletColor()).toContain("38;2;0;128;0");
	document.getElementById("s").textContent =
		"li::marker { color: rgb(255, 0, 0) }";
	await nextFrame(dom);
	expect(bulletColor()).toContain("38;2;255;0;0");
	document.querySelector("li").style.fontWeight = "bold";
	document.getElementById("s").textContent =
		"li::marker { color: rgb(0, 0, 255) }";
	await nextFrame(dom);
	expect(bulletColor()).toContain("38;2;0;0;255");
	dom.dispose();
});

test("a list marker's text follows a ::marker rule added after the first frame", async () => {
	const {dom, document} =
		await mount("<style id=s></style><ul><li>item</li></ul>");
	expect(dom.renderANSI()).toContain("•");
	document.getElementById("s").textContent = "li::marker { content: '> ' }";
	await nextFrame(dom);
	expect(dom.renderANSI()).toContain("> item");
	document.getElementById("s").textContent =
		"ul li::marker { content: '- ' } li::marker { content: '* ' } " +
		"@layer a { ul li::marker { content: '+ ' } }";
	await nextFrame(dom);
	expect(dom.renderANSI()).toContain("- item");
	dom.dispose();
});

test("appending a child leaves its earlier siblings' styles alone", async () => {
	const {dom, document} =
		await mount("<div id=log><div id=first><span>a</span></div></div>");
	const first = document.getElementById("first");
	const span = first.firstElementChild;
	const boxes = [getBoxModel(first), getBoxModel(span)];
	const next = document.createElement("div");
	next.textContent = "b";
	document.getElementById("log").append(next);
	await nextFrame(dom);
	expect([getBoxModel(first), getBoxModel(span)]).toEqual(boxes);
	expect(getBoxModel(first)).toBe(boxes[0]);
	expect(getBoxModel(span)).toBe(boxes[1]);
	dom.dispose();
});

test("a sibling rule that reaches descendants follows a child placed first", async () => {
	const {dom, document} = await mount(
		"<style>li:first-child span { padding-left: 2px }</style>" +
			"<ul><li id=a><span id=sa>a</span></li></ul>",
	);
	expect(getBoxModel(document.getElementById("sa")).paddingLeft).toBe(2);
	const b = document.createElement("li");
	b.innerHTML = "<span id=sb>b</span>";
	document.querySelector("ul").prepend(b);
	await nextFrame(dom);
	expect(getBoxModel(document.getElementById("sb")).paddingLeft).toBe(2);
	expect(getBoxModel(document.getElementById("sa")).paddingLeft === 0)
		.toBe(true);
	dom.dispose();
});

test("only a details element's first summary is its marker", async () => {
	const {dom, document} =
		await mount("<details><summary id=old>old</summary>body</details>");
	const view = dom.window;
	const display = (id: string): string =>
		view.getComputedStyle(document.getElementById(id)).display;
	expect(display("old")).toBe("list-item");
	const summary = document.createElement("summary");
	summary.id = "new";
	summary.textContent = "new";
	document.querySelector("details").prepend(summary);
	await nextFrame(dom);
	expect([display("new"), display("old")]).toEqual(["list-item", "block"]);
	dom.dispose();
});
