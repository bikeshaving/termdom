/**
 * What the performance work assumes stays true, pushed at its edges: a
 * style attribute written after its text, sibling orders and ancestor
 * filters kept through attribute changes, a pseudo-element's inherited
 * values read from its element, an inline's lines kept through a restyle,
 * transitions that start from a dropped style, event paths returned to a
 * pool, paint records kept between frames, presentational hints gathered
 * in one record, and a box's scroll carried by the terminal. The engine's
 * own checks hold every style, layout and partial frame to one made from
 * scratch, so each test drives the sequence a shortcut could get wrong and
 * reads what reaches the screen. A test.todo marks a bug found here.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {partialFrameCheck} from "../src/internal/painter.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

interface Cell {
	char: string;
	fg: number;
	bg: number;
}

function cell(terminal: MockProcess, col: number, row: number): Cell {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	const at = line.getCell(col);
	return {
		char: at.getChars() || " ",
		fg: at.isFgRGB() ? at.getFgColor() : -1,
		bg: at.isBgRGB() ? at.getBgColor() : -1,
	};
}

function rowText(terminal: MockProcess, row: number): string {
	return (terminal as any)
		.terminal.buffer.active.getLine(row)
		.translateToString(true);
}

async function open(
	html: string,
	size: {cols?: number; rows?: number} = {},
): Promise<{terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({
		cols: size.cols ?? 40,
		rows: size.rows ?? 10,
	});
	const dom = new TermDOM({transport: terminal.transport, html});
	await dom.attach();
	await nextFrame(dom);
	return {terminal, dom};
}

test("a style attribute written a declaration at a time reads as its block serializes", async () => {
	const {dom} = await open("<p>x</p>");
	const p = dom.document.querySelector("p")!;
	const style = p.style;
	const steps: Array<() => void> = [
		() => style.setProperty("--a", "1"),
		() => style.setProperty("--b", "two words"),
		() => style.setProperty("color", "red"),
		() => style.setProperty("--a", "3"),
		() => style.removeProperty("--b"),
		() => style.setProperty("--c", "4", "important"),
		() => style.setProperty("margin-top", "1px"),
		() => style.setProperty("margin-right", "1px"),
		() => style.setProperty("margin-bottom", "1px"),
		() => style.setProperty("margin-left", "1px"),
		() => style.setProperty("--d", "5"),
		() => style.setProperty("padding", "var(--a)"),
		() => style.setProperty("--e", "6"),
		() => p.setAttribute("style", "--f: 7"),
		() => style.setProperty("--g", "8"),
		() => style.removeProperty("--f"),
		() => style.removeProperty("--g"),
		() => style.setProperty("--h", "9"),
		() => {
			style.cssText = "color: blue; --i: 10";
		},
		() => style.setProperty("--j", "11"),
		() => style.setProperty("--a.b", "12"),
		() => style.setProperty("--k", "13"),
		() => style.setProperty("--c", "14"),
		() => style.setProperty("--l", "15"),
	];
	for (const step of steps) {
		step();
		const written = p.getAttribute("style")!;
		if (written !== "--f: 7" && written !== "color: blue; --i: 10") {
			expect(written).toBe(style.cssText);
		}
		const copy = dom.document.createElement("p");
		copy.setAttribute("style", p.getAttribute("style")!);
		expect(copy.style.cssText).toBe(style.cssText);
		expect([...copy.style]).toEqual([...style]);
	}
	expect(p.getAttribute("style")).toContain("--a\\.b: 12;");
	dom.dispose();
});

test("a stylesheet that brings a transition transitions from the old style", async () => {
	const {dom} = await open(
		"<style>#other { transition: width 1s }</style>" +
		"<style id='sheet'>#box { color: rgb(0, 0, 0) }</style>" +
		"<div id='other'></div><div id='box'>x</div>",
	);
	const {document, window} = dom;
	const box = document.getElementById("box")!;
	expect(window.getComputedStyle(box).color).toBe("rgb(0, 0, 0)");
	document.getElementById("sheet")!.textContent =
		"#box { color: rgb(255, 255, 255); " +
		"transition: color 100s steps(1, jump-both) }";
	await nextFrame(dom);
	expect(window.getComputedStyle(box).color).toBe("rgb(128, 128, 128)");
	dom.dispose();
});

test("an inherited value a transition starts from is the one shown before", async () => {
	const {dom} = await open(
		"<style>#other { transition: width 1s } " +
		"section { color: rgb(0, 0, 0) } section.on { color: rgb(255, 255, 255) } " +
		"section.on p { transition: color 100s steps(1, jump-both) }</style>" +
		"<div id='other'></div><section><p>x</p></section>",
	);
	const {document, window} = dom;
	const p = document.querySelector("p")!;
	document.querySelector("section")!.className = "on";
	await nextFrame(dom);
	expect(window.getComputedStyle(p).color).toBe("rgb(128, 128, 128)");
	dom.dispose();
});

test("a descendant rule follows a class set through every way an attribute is written", async () => {
	const {dom} = await open(
		"<style>.on span { color: rgb(255, 0, 0) } #top span { font-style: italic }" +
		" [data-x] span { font-weight: bold }</style>" +
		"<section><div><p><span>x</span></p></div></section>",
	);
	const {document, window} = dom;
	const section = document.querySelector("section")!;
	const div = document.querySelector("div")!;
	const span = document.querySelector("span")!;
	const color = (): string => window.getComputedStyle(span).color;
	div.setAttribute("data-x", "");
	await nextFrame(dom);
	expect(window.getComputedStyle(span).fontWeight).toBe("700");
	expect(color()).toBe("rgb(0, 0, 0)");
	section.setAttributeNS(null, "class", "on");
	expect(color()).toBe("rgb(255, 0, 0)");
	await nextFrame(dom);
	expect(color()).toBe("rgb(255, 0, 0)");
	section.getAttributeNode("class")!.value = "off";
	await nextFrame(dom);
	expect(color()).toBe("rgb(0, 0, 0)");
	div.toggleAttribute("class");
	div.classList.add("on");
	div.setAttribute("title", "t");
	await nextFrame(dom);
	expect(color()).toBe("rgb(255, 0, 0)");
	div.removeAttribute("class");
	section.id = "top";
	await nextFrame(dom);
	expect(color()).toBe("rgb(0, 0, 0)");
	expect(window.getComputedStyle(span).fontStyle).toBe("italic");
	const attr = document.createAttribute("class");
	attr.value = "on";
	div.setAttributeNode(attr);
	section.removeAttribute("id");
	await nextFrame(dom);
	expect(color()).toBe("rgb(255, 0, 0)");
	expect(window.getComputedStyle(span).fontStyle).toBe("normal");
	dom.dispose();
});

test("a shadow host's class reaches the rules its tree and its slotted children match", async () => {
	const {dom} = await open(
		"<style>.on span { color: rgb(255, 0, 0) }</style>" +
		"<div id='host'><span id='light'>light</span></div>",
	);
	const {document, window} = dom;
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML =
		"<style>:host(.on) b { color: rgb(0, 0, 255) } .in b { font-style: italic }" +
		"</style><div><b>inner</b><slot></slot></div>";
	await nextFrame(dom);
	const b = root.querySelector("b")!;
	const light = document.getElementById("light")!;
	for (let round = 0; round < 3; round++) {
		host.classList.add("on");
		root.querySelector("div")!.className = "in";
		await nextFrame(dom);
		expect(window.getComputedStyle(b).color).toBe("rgb(0, 0, 255)");
		expect(window.getComputedStyle(b).fontStyle).toBe("italic");
		expect(window.getComputedStyle(light).color).toBe("rgb(255, 0, 0)");
		host.classList.remove("on");
		root.querySelector("div")!.className = "";
		await nextFrame(dom);
		expect(window.getComputedStyle(b).color).toBe("rgb(0, 0, 0)");
		expect(window.getComputedStyle(b).fontStyle).toBe("normal");
		expect(window.getComputedStyle(light).color).toBe("rgb(0, 0, 0)");
	}
	dom.dispose();
});

test("sibling positions follow children added in a shadow tree and beside attribute changes", async () => {
	const {dom} = await open("<div id='host'></div><ul id='list'></ul>");
	const {document, window} = dom;
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML =
		"<style>li:nth-child(odd) { color: rgb(255, 0, 0) }" +
		" li:nth-last-child(1) { font-style: italic }</style>" +
		"<ul><li>a</li><li>b</li><li>c</li></ul>";
	const list = document.getElementById("list")!;
	const style = document.createElement("style");
	style.textContent =
		"li:nth-child(even) { color: rgb(0, 0, 255) }" +
		" li:nth-child(odd of .x) { font-weight: bold }";
	document.head.append(style);
	list.innerHTML = "<li>1</li><li class='x'>2</li><li class='x'>3</li>";
	await nextFrame(dom);
	const shadowList = root.querySelector("ul")!;
	const colors = (parent: Element): string[] =>
		[...parent.children].map((li) => window.getComputedStyle(li).color);
	expect(colors(shadowList)).toEqual([
		"rgb(255, 0, 0)",
		"rgb(0, 0, 0)",
		"rgb(255, 0, 0)",
	]);
	shadowList.prepend(document.createElement("li"));
	shadowList.children[2].setAttribute("title", "t");
	expect(window.getComputedStyle(shadowList.children[0]).color)
		.toBe("rgb(255, 0, 0)");
	await nextFrame(dom);
	expect(colors(shadowList)).toEqual([
		"rgb(255, 0, 0)",
		"rgb(0, 0, 0)",
		"rgb(255, 0, 0)",
		"rgb(0, 0, 0)",
	]);
	expect(window.getComputedStyle(shadowList.children[3]).fontStyle)
		.toBe("italic");
	expect(window.getComputedStyle(shadowList.children[2]).fontStyle)
		.toBe("normal");
	const bold = (): string[] =>
		[...list.children].map((li) => window.getComputedStyle(li).fontWeight);
	expect(bold()).toEqual(["400", "700", "400"]);
	list.children[0].className = "x";
	await nextFrame(dom);
	expect(bold()).toEqual(["700", "400", "700"]);
	list.children[1].remove();
	list.children[0].className = "";
	await nextFrame(dom);
	expect(bold()).toEqual(["400", "700"]);
	expect(colors(list)).toEqual(["rgb(0, 0, 0)", "rgb(0, 0, 255)"]);
	list.append(list.children[0]);
	list.children[0].setAttribute("title", "t");
	await nextFrame(dom);
	expect(colors(list)).toEqual(["rgb(0, 0, 0)", "rgb(0, 0, 255)"]);
	expect(bold()).toEqual(["700", "400"]);
	list.innerHTML = "<li>solo</li>";
	await nextFrame(dom);
	for (let round = 0; round < 2; round++) {
		list.children[0].classList.add("x");
		await nextFrame(dom);
		expect(bold()).toEqual(["700"]);
		list.children[0].classList.remove("x");
		await nextFrame(dom);
		expect(bold()).toEqual(["400"]);
	}
	dom.dispose();
});

test("a pseudo-element's inherited values follow its element and the element's parent", async () => {
	const {terminal, dom} = await open(
		"<style>p::before { content: 'Z' } li::marker { font-weight: bold }" +
		" ul { margin: 0 } .red { color: rgb(255, 0, 0) }" +
		" .blue { color: rgb(0, 0, 255) } .up { text-transform: uppercase }</style>" +
		"<section><p>x</p></section><ul><li>one</li></ul>",
	);
	const {document, window} = dom;
	const section = document.querySelector("section")!;
	const p = document.querySelector("p")!;
	const li = document.querySelector("li")!;
	const before = (): CSSStyleDeclaration =>
		window.getComputedStyle(p, "::before");
	const markerCol = rowText(terminal, 1).indexOf("•");
	expect(markerCol).toBeGreaterThanOrEqual(0);
	for (let round = 0; round < 2; round++) {
		section.className = "red";
		li.className = "blue";
		await nextFrame(dom);
		expect(before().color).toBe("rgb(255, 0, 0)");
		expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
		expect(cell(terminal, markerCol, 1).fg).toBe(0x0000ff);
		p.className = "blue up";
		li.className = "";
		await nextFrame(dom);
		expect(before().color).toBe("rgb(0, 0, 255)");
		expect(before().textTransform).toBe("uppercase");
		expect(cell(terminal, 0, 0).fg).toBe(0x0000ff);
		expect(cell(terminal, markerCol, 1).fg).toBe(-1);
		section.className = "";
		p.className = "";
		li.className = "red";
		await nextFrame(dom);
		expect(before().textTransform).toBe("none");
		expect(cell(terminal, 0, 0).fg).toBe(-1);
		expect(cell(terminal, markerCol, 1).fg).toBe(0xff0000);
	}
	dom.dispose();
});

test("an inline restyled once for paint lays out as a fresh page does when layout's properties change", async () => {
	const changes: Array<[string, string]> = [
		["padding-left", "2ch"],
		["margin-left", "1ch"],
		["text-transform", "uppercase"],
		["display", "none"],
		["display", "inline-block"],
		["border-left", "1px solid"],
		["visibility", "hidden"],
		["position", "relative"],
	];
	for (const [property, value] of changes) {
		const fresh =
			await open(`<p>ab <span style='${property}: ${value}'>cd</span> ef</p>`);
		const shown = rowText(fresh.terminal, 0).trimEnd();
		fresh.dom.dispose();
		const {terminal, dom} = await open("<p>ab <span>cd</span> ef</p>");
		const span = dom.document.querySelector("span")!;
		span.style.color = "rgb(255, 0, 0)";
		await nextFrame(dom);
		span.style.color = "rgb(0, 0, 255)";
		await nextFrame(dom);
		span.style.setProperty(property, value);
		await nextFrame(dom);
		expect([property, rowText(terminal, 0).trimEnd()]).toEqual([
			property,
			shown,
		]);
		span.style.removeProperty(property);
		await nextFrame(dom);
		expect([property, rowText(terminal, 0).trimEnd()])
			.toEqual([property, "ab cd ef"]);
		dom.dispose();
	}
});

test("an inline given a ::before by a class change shows it, and loses it", async () => {
	const {terminal, dom} = await open(
		"<style>.x::before { content: '>' } .y { color: rgb(255, 0, 0) }</style>" +
		"<p>ab <span>cd</span> ef</p>",
	);
	const span = dom.document.querySelector("span")!;
	const row = (): string => rowText(terminal, 0).trimEnd();
	for (let round = 0; round < 3; round++) {
		span.className = "y";
		await nextFrame(dom);
		expect(row()).toBe("ab cd ef");
		expect(cell(terminal, 3, 0).fg).toBe(0xff0000);
		span.className = "y x";
		await nextFrame(dom);
		expect(row()).toBe("ab >cd ef");
		span.className = "x";
		await nextFrame(dom);
		expect(row()).toBe("ab >cd ef");
		expect(cell(terminal, 4, 0).fg).toBe(-1);
	}
	dom.dispose();
});

test("an event dispatched inside a shadow tree from a listener keeps the outer event's targets", async () => {
	const {dom} = await open("<div id='host'></div><p id='out'>out</p>");
	const {document, window} = dom;
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "closed"});
	root.innerHTML = "<span id='inner'>in</span><b id='other'>b</b>";
	const inner = root.getElementById("inner")!;
	const other = root.getElementById("other")!;
	const out = document.getElementById("out")!;
	const name = (target: EventTarget | null): string =>
		target === null
			? "null"
			: (target as Element).id || (target as Node).nodeName || "window";
	const seen: string[] = [];
	const errors: string[] = [];
	window.addEventListener("error", (event) => {
		errors.push((event as ErrorEvent).message);
		event.preventDefault();
	});
	inner.addEventListener("mouseover", (event) => {
		seen.push(
			`inner ${name(event.target)} ${name((event as MouseEvent).relatedTarget)}`,
		);
		other.dispatchEvent(
			new window.MouseEvent("mouseover", {
				bubbles: true,
				composed: true,
				relatedTarget: inner,
			}),
		);
		throw new Error("from inner");
	});
	other.addEventListener("mouseover", (event) => {
		seen.push(
			`other ${name(event.target)} ${name((event as MouseEvent).relatedTarget)}`,
		);
	});
	host.addEventListener("mouseover", (event) => {
		seen.push(
			`host ${name(event.target)} ${name((event as MouseEvent).relatedTarget)} ` +
			event.composedPath().map(name).join(","),
		);
	});
	document.body.addEventListener("mouseover", (event) => {
		seen.push(
			`body ${name(event.target)} ${name((event as MouseEvent).relatedTarget)}`,
		);
	});
	for (let round = 0; round < 2; round++) {
		seen.length = 0;
		inner.dispatchEvent(
			new window.MouseEvent("mouseover", {
				bubbles: true,
				composed: true,
				relatedTarget: out,
			}),
		);
		expect(seen).toEqual([
			"inner inner out",
			"other other inner",
			"host host out host,BODY,HTML,#document,window",
			"body host out",
		]);
	}
	expect(errors).toEqual(["from inner", "from inner"]);
	dom.dispose();
});

test("a document printed whole between frames leaves the frames painting as before", async () => {
	const {terminal, dom} = await open(
		"<style>b { color: rgb(255, 0, 0) }</style>" +
		"<p>ab<b>cd</b>ef <span>gh</span></p>",
	);
	const words = Array.from({length: 6000}, (_, i) => `<b>w${i}</b>`);
	const printed = dom
		.renderANSI(`<p>${words.join(" ")}</p>`)
		.replace(/\x1b\[[0-9;]*m/g, "")
		.split(/\s+/)
		.filter(Boolean);
	expect(printed).toHaveLength(6000);
	expect(printed[0]).toBe("w0");
	expect(printed[5999]).toBe("w5999");
	const p = dom.document.querySelector("p")!;
	for (let round = 0; round < 3; round++) {
		p.append(` ${round}`);
		await nextFrame(dom);
		expect(rowText(terminal, 0)).toBe(
			"abcdef gh" + Array.from({length: round + 1}, (_, i) => ` ${i}`).join(""),
		);
		expect(cell(terminal, 2, 0).fg).toBe(0xff0000);
		expect(cell(terminal, 4, 0).fg).toBe(-1);
	}
	dom.dispose();
});

const SCROLLED_LIST =
	"<style>body { margin: 0; height: 100vh; display: flex; " +
	"flex-direction: column } ul { flex: 1; overflow: auto; margin: 0; " +
	"padding: 0; list-style: none } li.on { background: navy; color: white }" +
	" footer { background: maroon }</style><header>Inbox</header><ul>" +
	Array.from({length: 40}, (_, i) => `<li>item ${i}</li>`).join("") +
	"</ul>";

// The rows on screen once a list scrolled a row at a time, the row the
// footer is laid out on, and how many frames painted only some rows.
async function walkList(
	footer: string,
): Promise<{rows: string[]; footerRow: number; partial: number}> {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = SCROLLED_LIST + footer;
	await dom.attach();
	await nextFrame(dom);
	const items = [...dom.document.querySelectorAll("li")];
	const checked = partialFrameCheck.checked;
	try {
		for (let at = 1; at <= 12; at++) {
			items[at - 1].classList.remove("on");
			items[at].classList.add("on");
			items[at].scrollIntoView({block: "nearest"});
			await nextFrame(dom);
		}
		return {
			rows: terminal.getVisibleText().split("\n").map((row) => row.trimEnd()),
			footerRow: Math.round(
				dom.document.querySelector("footer")!.getBoundingClientRect().top,
			),
			partial: partialFrameCheck.checked - checked,
		};
	} finally {
		dom.dispose();
	}
}

test("a box scrolled under a sibling it lies beneath keeps the sibling still", async () => {
	expect((await walkList("<footer>FOOTER</footer>")).partial)
		.toBeGreaterThanOrEqual(12);
	const {rows, footerRow} = await walkList(
		"<footer style='position: relative; top: -3em'>FOOTER</footer>",
	);
	expect(rows.filter((row) => row.includes("FOOTER"))).toHaveLength(1);
	expect(rows[footerRow]).toBe("FOOTER");
});

test("a box scrolled under a sibling a negative margin pulls over it keeps the sibling still", async () => {
	const {rows, footerRow} =
		await walkList("<footer style='margin-top: -3em'>FOOTER</footer>");
	expect(rows.filter((row) => row.includes("FOOTER"))).toHaveLength(1);
	expect(rows[footerRow]).toBe("FOOTER");
});

test("a box scrolled under a sibling a transform moves over it keeps the sibling still", async () => {
	const {rows, footerRow} = await walkList(
		"<footer style='transform: translateY(-3em)'>FOOTER</footer>",
	);
	expect(rows.filter((row) => row.includes("FOOTER"))).toHaveLength(1);
	expect(rows[footerRow]).toBe("FOOTER");
});

test("presentational hints survive a style read made while they are gathered", async () => {
	const {dom} = await open(
		"<table id='t' bgcolor='red' align='center'><tr><td>x</td></tr></table>" +
		"<font color='blue'>f</font>",
	);
	const {window, document} = dom;
	const prototype = window.Element.prototype;
	const getAttribute = prototype.getAttribute;
	const font = document.querySelector("font")!;
	prototype.getAttribute = function (this: Element, name: string) {
		if (name === "align" && this.localName === "table") {
			void window.getComputedStyle(font).color;
		}
		return getAttribute.call(this, name);
	};
	try {
		const table = document.getElementById("t")!;
		table.setAttribute("width", "12");
		await nextFrame(dom);
		expect(window.getComputedStyle(table).backgroundColor)
			.toBe("rgb(255, 0, 0)");
	} finally {
		prototype.getAttribute = getAttribute;
		dom.dispose();
	}
});

test.todo("a light child shows again once a slot takes its new slot name", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({
		transport: terminal.transport,
		html: "<div id='b'><p slot='one'>light</p></div><p>after</p>",
	});
	const host = dom.document.getElementById("b")!;
	host.attachShadow({mode: "open"}).innerHTML =
		"<slot name='one'></slot><p>shadow</p>";
	await dom.attach();
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("light");
	host.querySelector("p")!.setAttribute("slot", "two");
	await nextFrame(dom);
	expect(terminal.getVisibleText()).not.toContain("light");
	host.shadowRoot!.querySelector("slot")!.name = "two";
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("light");
	dom.dispose();
});

test.todo("a shadow root attached after a frame replaces the light children drawn", async () => {
	const {terminal, dom} = await open("<div id='a'><p>light</p></div>");
	dom.document.getElementById("a")!.attachShadow({mode: "open"}).innerHTML =
		"<p>shadow</p>";
	await nextFrame(dom);
	expect(terminal.getVisibleText()).not.toContain("light");
	expect(terminal.getVisibleText()).toContain("shadow");
	dom.dispose();
});
