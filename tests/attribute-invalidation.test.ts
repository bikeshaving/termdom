/**
 * An attribute selector reaches descendants only from an element its
 * compound could match. A class or attribute change on any other element
 * restyles that element alone, and one on an element the compound could
 * match restyles what the rule styles below it. Each screen after a
 * mutation must match a document drawn fresh from the same markup.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {getStyleKey} from "../src/internal/cssom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const RED = "rgb(255, 0, 0)";
const BLUE = "rgb(0, 0, 255)";

async function freshScreen(document: Document): Promise<string> {
	const terminal = new MockProcess({cols: 60, rows: 16});
	const termdom = new TermDOM({transport: terminal.transport});
	termdom.document.head.innerHTML = document.head.innerHTML;
	termdom.document.body.innerHTML = document.body.innerHTML;
	await nextFrame(termdom);
	const screen = terminal.getScreenContents();
	termdom.dispose();
	return screen;
}

async function mount(
	css: string,
	html: string,
): Promise<{termdom: TermDOM; terminal: MockProcess; document: Document}> {
	const terminal = new MockProcess({cols: 60, rows: 16});
	const termdom = new TermDOM({transport: terminal.transport});
	const document = termdom.document as unknown as Document;
	document.head.innerHTML = `<style>${css}</style>`;
	document.body.innerHTML = html;
	await nextFrame(termdom);
	return {termdom, terminal, document};
}

// The elements under `root`, itself included, whose style key changed
// across `change`.
async function restyled(
	termdom: TermDOM,
	root: Element,
	change: () => void,
): Promise<Element[]> {
	const elements = [root, ...root.querySelectorAll("*")];
	const keys = elements.map((element) => getStyleKey(element));
	change();
	await nextFrame(termdom);
	return elements.filter((element, index) =>
		getStyleKey(element) !== keys[index]);
}

const SHADCN =
	".\\[\\&_svg\\:not\\(\\[class\\*\\=\\'text-\\'\\]\\)\\]\\:text-muted-foreground" +
	" span:not([class*='text-']) { color: rgb(255, 0, 0); }";
const SHADCN_CLASS =
	"[&_svg:not([class*='text-'])]:text-muted-foreground";

test("a class attribute test on an inheriting subject restyles below an element it could match", async () => {
	const {termdom, terminal, document} = await mount(
		SHADCN,
		"<div id=wrap><span id=icon><b id=inner>x</b></span></div>",
	);
	const {window} = termdom;
	const wrap = document.getElementById("wrap")!;
	const icon = document.getElementById("icon")!;
	const inner = document.getElementById("inner")!;
	wrap.className = SHADCN_CLASS;
	await nextFrame(termdom);
	expect(window.getComputedStyle(inner).color).toBe(RED);
	icon.className = "text-blue";
	await nextFrame(termdom);
	expect(window.getComputedStyle(icon).color).not.toBe(RED);
	expect(window.getComputedStyle(inner).color).not.toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	icon.removeAttribute("class");
	await nextFrame(termdom);
	expect(window.getComputedStyle(inner).color).toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a class change on an element no attribute-testing compound could match restyles it alone", async () => {
	const {termdom, terminal, document} = await mount(
		SHADCN + " .selected { background-color: rgb(0, 0, 255); }",
		Array.from(
			{length: 20},
			(_, i) =>
				`<div class=row id=r${i}><p>${i}</p><p><b>x</b><i>y</i></p></div>`,
		).join(""),
	);
	const row = document.getElementById("r3")!;
	expect(await restyled(termdom, row, () => row.classList.add("selected")))
		.toEqual([row]);
	expect(await restyled(termdom, row, () => row.classList.remove("selected")))
		.toEqual([row]);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("an attribute test above the subject restyles the subjects under an element it could match", async () => {
	const {termdom, terminal, document} = await mount(
		".menu[data-state=open] .item { color: rgb(255, 0, 0); }",
		"<div class=menu id=menu><p class=item id=item>a</p><p id=other>b</p></div>" +
			"<div id=plain><p class=item id=plainItem>c</p></div>",
	);
	const {window} = termdom;
	const menu = document.getElementById("menu")!;
	const plain = document.getElementById("plain")!;
	const item = document.getElementById("item")!;
	menu.setAttribute("data-state", "open");
	await nextFrame(termdom);
	expect(window.getComputedStyle(item).color).toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	expect(
		await restyled(termdom, plain, () =>
			plain.setAttribute("data-state", "open")),
	).toEqual([plain]);
	menu.setAttribute("data-state", "shut");
	await nextFrame(termdom);
	expect(window.getComputedStyle(item).color).not.toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a batch that changes an attribute and the keys its compound needs restyles below", async () => {
	const {termdom, terminal, document} = await mount(
		".menu[data-open] .item { color: rgb(255, 0, 0); }" +
			" #x[class~=on] .item { background-color: rgb(0, 0, 255); }" +
			" [data-a][data-b] .item { font-weight: bold; }",
		"<div class=menu id=menu data-open><p class=item id=one>a</p></div>" +
			"<div id=x class=on><p class=item id=two>b</p></div>" +
			"<div id=ab data-a data-b><p class=item id=three>c</p></div>",
	);
	const {window} = termdom;
	const one = document.getElementById("one")!;
	const two = document.getElementById("two")!;
	const three = document.getElementById("three")!;
	expect(window.getComputedStyle(one).color).toBe(RED);
	expect(window.getComputedStyle(two).backgroundColor).toBe(BLUE);
	expect(window.getComputedStyle(three).fontWeight).toBe("700");
	const menu = document.getElementById("menu")!;
	menu.removeAttribute("data-open");
	menu.className = "";
	const x = document.getElementById("x")!;
	x.className = "";
	x.id = "y";
	const ab = document.getElementById("ab")!;
	ab.removeAttribute("data-a");
	ab.removeAttribute("data-b");
	await nextFrame(termdom);
	expect(window.getComputedStyle(one).color).not.toBe(RED);
	expect(window.getComputedStyle(two).backgroundColor).not.toBe(BLUE);
	expect(window.getComputedStyle(three).fontWeight).not.toBe("700");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("an attribute tested inside :has() or past a combinator in an argument restyles as before", async () => {
	const {termdom, terminal, document} = await mount(
		".card:has([class~=big]) .title { color: rgb(255, 0, 0); }" +
			" .t:is([class~=on] *) { color: rgb(0, 0, 255); }",
		"<div class=card><p class=title id=title>t</p><p id=img>i</p></div>" +
			"<div id=wrap><p><span class=t id=t>x</span></p></div>",
	);
	const {window} = termdom;
	const title = document.getElementById("title")!;
	const t = document.getElementById("t")!;
	document.getElementById("img")!.className = "big";
	document.getElementById("wrap")!.className = "on";
	await nextFrame(termdom);
	expect(window.getComputedStyle(title).color).toBe(RED);
	expect(window.getComputedStyle(t).color).toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	document.getElementById("img")!.className = "";
	document.getElementById("wrap")!.className = "";
	await nextFrame(termdom);
	expect(window.getComputedStyle(title).color).not.toBe(RED);
	expect(window.getComputedStyle(t).color).not.toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});
