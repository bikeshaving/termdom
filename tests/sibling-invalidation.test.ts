/**
 * A child added or removed restyles the children whose sibling tests it
 * changes, with their subtrees when a rule reaches below them, and leaves
 * the rest. Each screen after a mutation must match a document drawn
 * fresh from the same markup.
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

// The elements under `root` whose style key changed across `change`.
async function restyled(
	termdom: TermDOM,
	root: Element,
	change: () => void,
): Promise<Element[]> {
	const elements = [...root.querySelectorAll("*")];
	const keys = elements.map((element) => getStyleKey(element));
	change();
	await nextFrame(termdom);
	return elements.filter((element, index) =>
		element.isConnected && getStyleKey(element) !== keys[index]);
}

test("a :not(:last-child) under a keyed compound restyles the keyed child that stops being last", async () => {
	const {termdom, terminal, document} = await mount(
		".day:not(:last-child) { color: rgb(255, 0, 0); }",
		"<div id=grid><span class=day id=a>a</span><span class=day id=b>b</span></div>",
	);
	const {window} = termdom;
	const b = document.getElementById("b")!;
	expect(window.getComputedStyle(b).color).not.toBe(RED);
	const c = document.createElement("span");
	c.className = "day";
	c.textContent = "c";
	document.getElementById("grid")!.append(c);
	await nextFrame(termdom);
	expect(window.getComputedStyle(b).color).toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	c.remove();
	await nextFrame(termdom);
	expect(window.getComputedStyle(b).color).not.toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a keyless child test after > restyles the children of a parent with the key", async () => {
	const {termdom, terminal, document} = await mount(
		".stack > :not(:last-child) { color: rgb(255, 0, 0); }" +
			" .list > :last-child b { color: rgb(0, 0, 255); }",
		"<div class=stack id=stack><p id=one>1</p><p id=two>2</p></div>" +
			"<div class=list id=list><p id=x><b id=xb>x</b></p></div>",
	);
	const {window} = termdom;
	const two = document.getElementById("two")!;
	const xb = document.getElementById("xb")!;
	expect(window.getComputedStyle(two).color).not.toBe(RED);
	expect(window.getComputedStyle(xb).color).toBe(BLUE);
	document.getElementById("stack")!.append(document.createElement("p"));
	document.getElementById("list")!.append(document.createElement("p"));
	await nextFrame(termdom);
	expect(window.getComputedStyle(two).color).toBe(RED);
	expect(window.getComputedStyle(xb).color).not.toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	document.getElementById("stack")!.lastElementChild!.remove();
	document.getElementById("list")!.lastElementChild!.remove();
	await nextFrame(termdom);
	expect(window.getComputedStyle(two).color).not.toBe(RED);
	expect(window.getComputedStyle(xb).color).toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a keyless child test whose parent has no key restyles any child", async () => {
	const {termdom, terminal, document} = await mount(
		"div > :not(:last-child) { color: rgb(255, 0, 0); }" +
			" * > :first-child { background-color: rgb(0, 0, 255); }",
		"<section id=s><p id=one>1</p></section>",
	);
	const {window} = termdom;
	const one = document.getElementById("one")!;
	const s = document.getElementById("s")!;
	s.append(document.createElement("p"));
	s.prepend(document.createElement("p"));
	await nextFrame(termdom);
	expect(window.getComputedStyle(one).backgroundColor).not.toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a sibling-tested subject restyles below it only when its rule sets an inherited property", async () => {
	const {termdom, terminal, document} = await mount(
		".a:first-child { color: rgb(255, 0, 0); }" +
			" .b + .b { margin-left: 1px; }" +
			" .c:first-child .inner { color: rgb(0, 0, 255); }",
		"<div id=as><p class=a id=a><i id=ai>a</i></p></div>" +
			"<div id=bs><p class=b><i>1</i></p><p class=b><i>2</i></p></div>" +
			"<div id=cs><p class=c id=c><span><i class=inner id=inner>c</i></span></p></div>",
	);
	const {window} = termdom;
	const ai = document.getElementById("ai")!;
	const inner = document.getElementById("inner")!;
	expect(window.getComputedStyle(ai).color).toBe(RED);
	expect(window.getComputedStyle(inner).color).toBe(BLUE);
	document.getElementById("as")!.prepend(document.createElement("p"));
	document.getElementById("cs")!.prepend(document.createElement("p"));
	await nextFrame(termdom);
	expect(window.getComputedStyle(ai).color).not.toBe(RED);
	expect(window.getComputedStyle(inner).color).not.toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));

	const bs = document.getElementById("bs")!;
	const changed = await restyled(termdom, bs, () => {
		const b = document.createElement("p");
		b.className = "b";
		bs.prepend(b);
	});
	expect(changed.map((element) => element.localName)).toEqual(["p", "p"]);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("the UA's summary:first-of-type rule restyles a summary that stops being first", async () => {
	const {termdom, document} = await mount(
		"",
		"<details id=d><summary id=old><b>a</b></summary></details>",
	);
	const {window} = termdom;
	const old = document.getElementById("old")!;
	expect(window.getComputedStyle(old).display).toBe("list-item");
	old.before(document.createElement("summary"));
	await nextFrame(termdom);
	expect(window.getComputedStyle(old).display).toBe("block");
	termdom.dispose();
});

test("a child added or removed leaves the subtrees no sibling test names", async () => {
	const {termdom, terminal, document} = await mount(
		".day:not(:last-child) { color: rgb(255, 0, 0); }" +
			" .stack > :not(:last-child) { color: rgb(255, 0, 0); }" +
			" .nav .item { color: rgb(0, 0, 255); }",
		"<nav class=nav id=nav>" +
			Array.from(
				{length: 20},
				(_, i) =>
					`<div class=item><a>${i}</a><ul><li>x</li><li>y</li></ul></div>`,
			).join("") +
			"</nav>",
	);
	const nav = document.getElementById("nav")!;
	const item = document.createElement("div");
	item.className = "item";
	item.textContent = "new";
	expect(await restyled(termdom, nav, () => nav.append(item))).toEqual([]);
	expect(await restyled(termdom, nav, () => item.remove())).toEqual([]);
	expect(await restyled(termdom, nav, () => nav.prepend(item))).toEqual([]);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a :has() that reads later siblings restyles its subject when one comes or goes after it", async () => {
	const {termdom, terminal, document} = await mount(
		".a:has(+ .b) { color: rgb(255, 0, 0); }" +
			" .c:has(~ .d) .inner { color: rgb(0, 0, 255); }",
		"<div id=ab><p class=a id=a>a</p></div>" +
			"<div id=cd><p class=c><i class=inner id=inner>c</i></p></div>",
	);
	const {window} = termdom;
	const a = document.getElementById("a")!;
	const inner = document.getElementById("inner")!;
	const b = document.createElement("p");
	b.className = "b";
	const d = document.createElement("p");
	d.className = "d";
	document.getElementById("ab")!.append(b);
	document.getElementById("cd")!.append(d);
	await nextFrame(termdom);
	expect(window.getComputedStyle(a).color).toBe(RED);
	expect(window.getComputedStyle(inner).color).toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	b.remove();
	d.remove();
	await nextFrame(termdom);
	expect(window.getComputedStyle(a).color).not.toBe(RED);
	expect(window.getComputedStyle(inner).color).not.toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a sibling test inside an argument restyles below the elements whose siblings it reads", async () => {
	const {termdom, terminal, document} = await mount(
		".g:has(.e:is(.p + .c .e)) { color: rgb(255, 0, 0); }",
		"<div id=outer><div id=c class=c><div class=g id=g><i class=e>e</i>" +
			"</div></div></div>",
	);
	const {window} = termdom;
	const g = document.getElementById("g")!;
	expect(window.getComputedStyle(g).color).not.toBe(RED);
	const p = document.createElement("div");
	p.className = "p";
	document.getElementById("c")!.before(p);
	await nextFrame(termdom);
	expect(window.getComputedStyle(g).color).toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	p.remove();
	await nextFrame(termdom);
	expect(window.getComputedStyle(g).color).not.toBe(RED);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a :has(+ x) subject keys the children a child insert or remove restyles", async () => {
	const {termdom, terminal, document} = await mount(
		".resizing .event:has(+ .copy) { visibility: hidden; }",
		"<div class=resizing><div id=day>" +
			"<div class=event id=e1><b>1</b></div>" +
			"<div class=other><b>x</b></div>" +
			"<div class=event id=e2><b>2</b></div>" +
			"</div></div>" +
			"<nav id=nav>" +
			Array.from({length: 10}, (_, i) => `<p><a>${i}</a></p>`).join("") +
			"</nav>",
	);
	const nav = document.getElementById("nav")!;
	const item = document.createElement("p");
	expect(await restyled(termdom, nav, () => nav.append(item))).toEqual([]);
	expect(await restyled(termdom, nav, () => item.remove())).toEqual([]);
	expect(await restyled(termdom, nav, () => nav.prepend(item))).toEqual([]);

	const day = document.getElementById("day")!;
	const copy = document.createElement("div");
	copy.className = "copy";
	const changed = await restyled(termdom, day, () =>
		document.getElementById("e1")!.after(copy));
	expect(changed.map((element) => element.id || element.localName)).toEqual([
		"e1",
		"b",
		"e2",
		"b",
	]);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a :has(+ x) match follows the child after its subject coming and going", async () => {
	const {termdom, terminal, document} = await mount(
		".resizing .event:has(+ .copy) { visibility: hidden; }",
		"<div class=resizing><div id=day>" +
			"<div class=event id=e1><b id=b1>one</b></div>" +
			"<div class=event id=e2><b id=b2>two</b></div>" +
			"</div></div>",
	);
	const {window} = termdom;
	const e1 = document.getElementById("e1")!;
	const e2 = document.getElementById("e2")!;
	const b1 = document.getElementById("b1")!;
	const copy = document.createElement("div");
	copy.className = "copy";
	copy.textContent = "copy";
	e1.after(copy);
	await nextFrame(termdom);
	expect(window.getComputedStyle(e1).visibility).toBe("hidden");
	expect(window.getComputedStyle(b1).visibility).toBe("hidden");
	expect(window.getComputedStyle(e2).visibility).toBe("visible");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	copy.remove();
	await nextFrame(termdom);
	expect(window.getComputedStyle(e1).visibility).toBe("visible");
	expect(window.getComputedStyle(b1).visibility).toBe("visible");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	e2.after(copy);
	await nextFrame(termdom);
	expect(window.getComputedStyle(e2).visibility).toBe("hidden");
	expect(window.getComputedStyle(e1).visibility).toBe("visible");
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	termdom.dispose();
});

test("a child added to a :has() anchor restyles the siblings a rule styles after it", async () => {
	const {termdom, terminal, document} = await mount(
		"#box:has(.item:only-of-type) ~ #after { color: rgb(255, 0, 0); } #box:has(.item:last-of-type) + #next { color: rgb(0, 0, 255); }",
		"<div id=box></div><p id=next>next</p><p id=after>after</p>",
	);
	const {window} = termdom;
	const box = document.getElementById("box")!;
	const after = document.getElementById("after")!;
	const next = document.getElementById("next")!;
	const item = document.createElement("div");
	item.className = "item";
	box.append(item);
	await nextFrame(termdom);
	expect(window.getComputedStyle(after).color).toBe(RED);
	expect(window.getComputedStyle(next).color).toBe(BLUE);
	expect(terminal.getScreenContents()).toBe(await freshScreen(document));
	const second = document.createElement("div");
	second.className = "item";
	box.append(second);
	await nextFrame(termdom);
	expect(window.getComputedStyle(after).color).not.toBe(RED);
	expect(window.getComputedStyle(next).color).toBe(BLUE);
	second.remove();
	await nextFrame(termdom);
	expect(window.getComputedStyle(after).color).toBe(RED);
	termdom.dispose();
});

test("a class removed from a child inserted after a :has(+ x) anchor restyles what the anchor styled", async () => {
	const {termdom, document} = await mount(
		"div:has(+ .test) #subject { color: rgb(0, 0, 255); }",
		"<main id=main><div id=anchor><p id=subject>s</p></div><div id=next></div></main>",
	);
	const {window} = termdom;
	const main = document.getElementById("main")!;
	const subject = document.getElementById("subject")!;
	const next = document.getElementById("next")!;
	next.className = "test";
	await nextFrame(termdom);
	next.className = "";
	await nextFrame(termdom);
	const inserted = document.createElement("div");
	inserted.className = "test";
	main.insertBefore(inserted, next);
	await nextFrame(termdom);
	expect(window.getComputedStyle(subject).color).toBe(BLUE);
	inserted.classList.remove("test");
	await nextFrame(termdom);
	expect(window.getComputedStyle(subject).color).not.toBe(BLUE);
	termdom.dispose();
});
