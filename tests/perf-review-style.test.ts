import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {inputDispatched, MockProcess, nextFrame} from "./test-utils.js";

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

function send(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return inputDispatched();
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

const RED = "rgb(255, 0, 0)";
const GREEN = "rgb(0, 128, 0)";
const BLUE = "rgb(0, 0, 255)";

test("a descendant rule follows classes and ids changed from a MutationObserver", async () => {
	const {terminal, dom} = await open(
		"<style>.on b { color: rgb(255, 0, 0) } #lit i { color: rgb(0, 0, 255) }" +
		"</style><div id='outer'><div id='inner'><b>b</b><i>i</i></div></div>",
	);
	const {document, window} = dom;
	const outer = document.getElementById("outer")!;
	const inner = document.getElementById("inner")!;
	const b = document.querySelector("b")!;
	const i = document.querySelector("i")!;
	const observer = new window.MutationObserver(() => {
		if (outer.getAttribute("data-step") === "1") {
			outer.className = "on";
			inner.id = "lit";
		} else if (outer.getAttribute("data-step") === "2") {
			outer.className = "";
			inner.id = "dim";
		}
	});
	observer.observe(outer, {attributes: true, attributeFilter: ["data-step"]});
	expect(window.getComputedStyle(b).color).not.toBe(RED);
	outer.setAttribute("data-step", "1");
	await nextFrame(dom);
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).toBe(RED);
	expect(window.getComputedStyle(i).color).toBe(BLUE);
	expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
	outer.setAttribute("data-step", "2");
	await nextFrame(dom);
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).not.toBe(RED);
	expect(window.getComputedStyle(i).color).not.toBe(BLUE);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	dom.dispose();
});

test("a class changed in a listener reaches a descendant read in the same listener", async () => {
	const {dom} = await open(
		"<style>.a .x { color: rgb(255, 0, 0) } .b .x { color: rgb(0, 0, 255) }" +
		"</style><section><div><p class='x'>p</p></div></section>",
	);
	const {document, window} = dom;
	const section = document.querySelector("section")!;
	const p = document.querySelector("p")!;
	const seen: string[] = [];
	p.addEventListener("ping", () => {
		section.className = "a";
		seen.push(window.getComputedStyle(p).color);
		section.className = "b";
		seen.push(window.getComputedStyle(p).color);
		section.removeAttribute("class");
		seen.push(window.getComputedStyle(p).color);
		section.className = "a";
	});
	p.dispatchEvent(new window.Event("ping", {bubbles: true}));
	await nextFrame(dom);
	seen.push(window.getComputedStyle(p).color);
	expect(seen.slice(0, 2)).toEqual([RED, BLUE]);
	expect(seen[2]).not.toBe(RED);
	expect(seen[2]).not.toBe(BLUE);
	expect(seen[3]).toBe(RED);
	dom.dispose();
});

test("class values with odd whitespace and repeats match as their tokens", async () => {
	const {terminal, dom} = await open(
		"<style>.a.b span { color: rgb(255, 0, 0) } .c span " +
		"{ color: rgb(0, 0, 255) }</style><div><span>s</span></div>",
	);
	const {document, window} = dom;
	const div = document.querySelector("div")!;
	const span = document.querySelector("span")!;
	const color = (): string => window.getComputedStyle(span).color;
	const values = [
		["\t a \n\n a \f b\r", RED],
		["a b", RED],
		["b a", ""],
		["  ", ""],
		["c c c", BLUE],
		["a\tb\tc", RED],
		["c\ta", BLUE],
		["", ""],
		["b a b a", RED],
	] as const;
	for (const [value, expected] of values) {
		div.setAttribute("class", value);
		await nextFrame(dom);
		if (expected === "") {
			expect(color()).not.toBe(RED);
			expect(color()).not.toBe(BLUE);
			expect(cell(terminal, 0, 0).fg).toBe(-1);
		} else {
			expect(color()).toBe(expected);
			expect(cell(terminal, 0, 0).fg).toBe(
				expected === RED ? 0xff0000 : 0x0000ff,
			);
		}
	}
	expect([...div.classList]).toEqual(["b", "a"]);
	dom.dispose();
});

test("a class list's tokens stay its own after another element changes", async () => {
	const {dom} =
		await open("<p class='x y'>1</p><p class='x y'>2</p><p class='x y'>3</p>");
	const [first, second, third] = [...dom.document.querySelectorAll("p")];
	second.classList.add("z");
	third.classList.remove("x");
	first.classList.toggle("y");
	expect(first.className).toBe("x");
	expect(second.className).toBe("x y z");
	expect(third.className).toBe("y");
	expect(dom.document.querySelectorAll(".x").length).toBe(2);
	expect(dom.document.querySelectorAll(".y").length).toBe(2);
	expect(dom.document.getElementsByClassName("x y").length).toBe(1);
	const fresh = dom.document.createElement("p");
	fresh.className = "x y";
	expect([...fresh.classList]).toEqual(["x", "y"]);
	fresh.classList.replace("x", "q");
	expect([...fresh.classList]).toEqual(["q", "y"]);
	expect(second.matches(".x.y.z")).toBe(true);
	dom.dispose();
});

test("an id or class changed inside a shadow tree reaches the tree's rules", async () => {
	const {terminal, dom} = await open("<div id='host'></div>");
	const {document, window} = dom;
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML =
		"<style>#on b { color: rgb(255, 0, 0) } .on > div i " +
		"{ color: rgb(0, 0, 255) } :host(.lit) u { color: rgb(0, 128, 0) }" +
		"</style><div id='wrap'><div><b>b</b><i>i</i><u>u</u></div></div>";
	await nextFrame(dom);
	const wrap = root.getElementById("wrap")!;
	const b = root.querySelector("b")!;
	const i = root.querySelector("i")!;
	const u = root.querySelector("u")!;
	wrap.id = "on";
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).toBe(RED);
	expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
	wrap.className = "on";
	await nextFrame(dom);
	expect(window.getComputedStyle(i).color).toBe(BLUE);
	host.className = "lit";
	await nextFrame(dom);
	expect(window.getComputedStyle(u).color).toBe(GREEN);
	wrap.id = "";
	wrap.className = "";
	host.className = "";
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).not.toBe(RED);
	expect(window.getComputedStyle(i).color).not.toBe(BLUE);
	expect(window.getComputedStyle(u).color).not.toBe(GREEN);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	dom.dispose();
});

test("a slotted child follows its light parent's class through the host", async () => {
	const {dom} = await open(
		"<style>.lit span { color: rgb(255, 0, 0) }</style>" +
		"<div id='outer'><div id='host'><span>s</span></div></div>",
	);
	const {document, window} = dom;
	const host = document.getElementById("host")!;
	const outer = document.getElementById("outer")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<p><slot></slot></p>";
	await nextFrame(dom);
	const span = document.querySelector("span")!;
	outer.className = "lit";
	await nextFrame(dom);
	expect(window.getComputedStyle(span).color).toBe(RED);
	outer.className = "";
	host.className = "lit";
	await nextFrame(dom);
	expect(window.getComputedStyle(span).color).toBe(RED);
	host.className = "";
	await nextFrame(dom);
	expect(window.getComputedStyle(span).color).not.toBe(RED);
	dom.dispose();
});

test("an nth-child of a class list follows classes changed in a listener", async () => {
	const {terminal, dom} = await open(
		"<style>p:nth-child(2 of .x) { color: rgb(255, 0, 0) }" +
		"p { margin: 0 }</style>" +
		"<div><p class='x'>a</p><p>b</p><p class='x'>c</p><p class='x'>d</p>" +
		"</div>",
	);
	const {document, window} = dom;
	const ps = [...document.querySelectorAll("p")];
	const red = (): number[] => ps.flatMap((p, index) =>
		window.getComputedStyle(p).color === RED ? [index] : []);
	expect(red()).toEqual([2]);
	ps[0].addEventListener("ping", () => {
		ps[1].classList.add("x");
		ps[0].id = "first";
	});
	ps[0].dispatchEvent(new window.Event("ping"));
	await nextFrame(dom);
	expect(red()).toEqual([1]);
	expect(cell(terminal, 0, 1).fg).toBe(0xff0000);
	expect(cell(terminal, 0, 2).fg).toBe(-1);
	ps[0].className = "";
	await nextFrame(dom);
	expect(red()).toEqual([2]);
	expect(cell(terminal, 0, 1).fg).toBe(-1);
	expect(cell(terminal, 0, 2).fg).toBe(0xff0000);
	ps[1].remove();
	await nextFrame(dom);
	expect(red()).toEqual([3]);
	dom.dispose();
});

test("an nth-child of an attribute list follows the attribute in place", async () => {
	const {dom} = await open(
		"<style>li:nth-child(odd of [data-on]) { color: rgb(255, 0, 0) }" +
		"li:nth-last-child(1 of .k) { background: rgb(0, 0, 255) }</style>" +
		"<ul><li data-on>a</li><li>b</li><li data-on class='k'>c</li>" +
		"<li data-on>d</li><li class='k'>e</li></ul>",
	);
	const {document, window} = dom;
	const lis = [...document.querySelectorAll("li")];
	const state = (): string => lis.map((li) => {
		const style = window.getComputedStyle(li);
		return (style.color === RED ? "r" : "-") +
			(style.backgroundColor === BLUE ? "b" : "-");
	}).join(" ");
	expect(state()).toBe("r- -- -- r- -b");
	for (let round = 0; round < 3; round++) {
		lis[1].toggleAttribute("data-on");
		lis[4].classList.toggle("k");
		await nextFrame(dom);
		expect(state()).toBe(round % 2 === 0 ? "r- -- rb -- --" : "r- -- -- r- -b");
	}
	dom.dispose();
});

test("a sibling rule follows a class changed while the sibling's event runs", async () => {
	const {terminal, dom} = await open(
		"<style>.a + p { color: rgb(255, 0, 0) } .a ~ i { color: " +
		"rgb(0, 0, 255) } p, div { margin: 0 }</style>" +
		"<div>x</div><p>y</p><i>z</i>",
	);
	const {document, window} = dom;
	const div = document.querySelector("div")!;
	const p = document.querySelector("p")!;
	const i = document.querySelector("i")!;
	p.addEventListener("ping", () => {
		div.classList.add("a");
		expect(window.getComputedStyle(p).color).toBe(RED);
	});
	p.dispatchEvent(new window.Event("ping"));
	await nextFrame(dom);
	expect(window.getComputedStyle(i).color).toBe(BLUE);
	expect(cell(terminal, 0, 1).fg).toBe(0xff0000);
	expect(cell(terminal, 0, 2).fg).toBe(0x0000ff);
	div.classList.remove("a");
	await nextFrame(dom);
	expect(cell(terminal, 0, 1).fg).toBe(-1);
	expect(cell(terminal, 0, 2).fg).toBe(-1);
	dom.dispose();
});

test("a :has() anchor follows a class and an id its descendants take and lose", async () => {
	const {terminal, dom} = await open(
		"<style>div:has(.hot) > b { color: rgb(255, 0, 0) }" +
		"div:has(> #cold) > b { background: rgb(0, 0, 255) }</style>" +
		"<div><b>b</b><span><em>e</em></span><span>s</span></div>",
	);
	const {document, window} = dom;
	const b = document.querySelector("b")!;
	const em = document.querySelector("em")!;
	const span = document.querySelectorAll("span")[1];
	const observer = new window.MutationObserver(() => {
		if (em.className === "hot" && span.id === "") {
			span.id = "cold";
		}
	});
	observer.observe(em, {attributes: true});
	em.className = "hot";
	await nextFrame(dom);
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).toBe(RED);
	expect(window.getComputedStyle(b).backgroundColor).toBe(BLUE);
	expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(terminal, 0, 0).bg).toBe(0x0000ff);
	em.className = "hot cold";
	span.id = "";
	await nextFrame(dom);
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).toBe(RED);
	em.className = "";
	span.id = "x";
	await nextFrame(dom);
	await nextFrame(dom);
	expect(window.getComputedStyle(b).color).not.toBe(RED);
	expect(window.getComputedStyle(b).backgroundColor).not.toBe(BLUE);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	dom.dispose();
});

test("a ::part rule follows the part attribute and the host's class", async () => {
	const {terminal, dom} = await open(
		"<style>#host::part(label) { color: rgb(255, 0, 0) }" +
		"#host.big::part(label  extra) { background: rgb(0, 0, 255) }</style>" +
		"<div id='host'></div>",
	);
	const {document, window} = dom;
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span>p</span>";
	await nextFrame(dom);
	const span = root.querySelector("span")!;
	expect(window.getComputedStyle(span).color).not.toBe(RED);
	span.setAttribute("part", " label ");
	await nextFrame(dom);
	expect(window.getComputedStyle(span).color).toBe(RED);
	expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
	host.className = "big";
	await nextFrame(dom);
	expect(window.getComputedStyle(span).backgroundColor).not.toBe(BLUE);
	span.setAttribute("part", "label\textra");
	await nextFrame(dom);
	expect(window.getComputedStyle(span).backgroundColor).toBe(BLUE);
	expect(cell(terminal, 0, 0).bg).toBe(0x0000ff);
	span.setAttribute("part", "extra extra");
	await nextFrame(dom);
	expect(window.getComputedStyle(span).color).not.toBe(RED);
	expect(window.getComputedStyle(span).backgroundColor).not.toBe(BLUE);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	dom.dispose();
});

test("elements sharing a style text part ways through style and setAttribute", async () => {
	const {terminal, dom} = await open(
		"<style>p { margin: 0 }</style>" +
		"<p style='color: rgb(255, 0, 0)'>a</p>" +
		"<p style='color: rgb(255, 0, 0)'>b</p>" +
		"<p style='color: rgb(255, 0, 0)'>c</p>",
	);
	const {document, window} = dom;
	const [a, b, c] = [...document.querySelectorAll("p")];
	const colors = (): string[] =>
		[a, b, c].map((p) => window.getComputedStyle(p).color);
	a.style.color = "rgb(0, 0, 255)";
	await nextFrame(dom);
	expect(colors()).toEqual([BLUE, RED, RED]);
	b.setAttribute("style", "color: rgb(0, 128, 0)");
	await nextFrame(dom);
	expect(colors()).toEqual([BLUE, GREEN, RED]);
	expect(c.style.color).toBe(RED);
	c.style.setProperty("background-color", "rgb(0, 0, 255)");
	a.setAttribute("style", "color: rgb(255, 0, 0)");
	await nextFrame(dom);
	expect(colors()).toEqual([RED, GREEN, RED]);
	expect(a.style.color).toBe(RED);
	expect(c.getAttribute("style")).toBe(
		"color: rgb(255, 0, 0); background-color: rgb(0, 0, 255);",
	);
	expect([0, 1, 2].map((row) => cell(terminal, 0, row).fg)).toEqual([
		0xff0000,
		0x008000,
		0xff0000,
	]);
	expect(cell(terminal, 0, 2).bg).toBe(0x0000ff);
	b.setAttribute("style", "color: rgb(255, 0, 0)");
	c.removeAttribute("style");
	await nextFrame(dom);
	expect(colors().slice(0, 2)).toEqual([RED, RED]);
	expect(colors()[2]).not.toBe(RED);
	expect(cell(terminal, 0, 2).bg).toBe(-1);
	dom.dispose();
});

test("two documents sharing a style text keep their own styles", async () => {
	const first = await open("<p style='color: rgb(255, 0, 0)'>one</p>");
	const second = await open("<p style='color: rgb(255, 0, 0)'>two</p>");
	const p = second.dom.document.querySelector("p")!;
	p.style.color = "rgb(0, 0, 255)";
	await nextFrame(second.dom);
	await nextFrame(first.dom);
	const other = first.dom.document.querySelector("p")!;
	expect(first.dom.window.getComputedStyle(other).color).toBe(RED);
	expect(second.dom.window.getComputedStyle(p).color).toBe(BLUE);
	expect(cell(first.terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(second.terminal, 0, 0).fg).toBe(0x0000ff);
	const third = await open(
		"<p style='color: rgb(255, 0, 0)'>three</p>" +
		"<p style='color: rgb(0, 0, 255)'>four</p>",
	);
	expect(cell(third.terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(third.terminal, 0, 1).fg).toBe(0x0000ff);
	first.dom.dispose();
	second.dom.dispose();
	third.dom.dispose();
});

test("a style attribute written from a listener a property at a time serializes whole", async () => {
	const {dom} = await open("<p>x</p>");
	const {document, window} = dom;
	const p = document.querySelector("p")!;
	const texts: string[] = [];
	p.addEventListener("ping", () => {
		const style = p.style;
		style.setProperty("COLOR", "RED");
		texts.push(p.getAttribute("style")!);
		style.setProperty("--Mixed", "  spaced  value ");
		texts.push(p.getAttribute("style")!);
		style.setProperty("margin-inline-start", "1px");
		texts.push(p.getAttribute("style")!);
		style.setProperty("z-index", "2", "IMPORTANT");
		texts.push(p.getAttribute("style")!);
		style.setProperty("color", "blue");
		style.setProperty("opacity", "0.5");
		texts.push(p.getAttribute("style")!);
		style.removeProperty("--Mixed");
		style.setProperty("--n", "var(--m)");
		texts.push(p.getAttribute("style")!);
		style.setProperty("border-top-color", "red");
		texts.push(p.getAttribute("style")!);
	});
	p.dispatchEvent(new window.Event("ping"));
	for (const text of texts) {
		const fresh = document.createElement("p");
		fresh.setAttribute("style", text);
		expect(fresh.style.cssText).toBe(text);
	}
	expect(texts.at(-1)).toBe(p.style.cssText);
	expect(p.style.getPropertyValue("--n")).toBe("var(--m)");
	expect(p.style.getPropertyPriority("z-index")).toBe("important");
	dom.dispose();
});

test("an event path a script kept reads the same after later dispatches", async () => {
	const {dom} = await open(
		"<div id='a'><span id='b'></span></div><div id='c'><i id='d'></i></div>",
	);
	const {document, window} = dom;
	const name = (target: EventTarget): string =>
		(target as Element).id || (target as Node).nodeName || "window";
	const kept: EventTarget[][] = [];
	const events: Event[] = [];
	const b = document.getElementById("b")!;
	const d = document.getElementById("d")!;
	document.addEventListener("ping", (event) => {
		kept.push(event.composedPath());
		events.push(event);
	});
	b.dispatchEvent(new window.Event("ping", {bubbles: true}));
	d.dispatchEvent(new window.Event("ping", {bubbles: true}));
	for (let i = 0; i < 20; i++) {
		(i % 2 === 0 ? b : d).dispatchEvent(
			new window.Event("other", {bubbles: true}),
		);
	}
	expect(kept[0].map(name)).toEqual([
		"b",
		"a",
		"BODY",
		"HTML",
		"#document",
		"window",
	]);
	expect(kept[1].map(name)[0]).toBe("d");
	expect(events.map((event) => name(event.target!))).toEqual(["b", "d"]);
	expect(events.map((event) => event.composedPath().length)).toEqual([0, 0]);
	expect(events[0].currentTarget).toBe(null);
	expect(events[0].eventPhase).toBe(0);
	dom.dispose();
});

test("listeners added and removed during a dispatch run as the spec orders", async () => {
	const {dom} = await open("<div id='a'><p id='b'><i id='c'></i></p></div>");
	const {document, window} = dom;
	const a = document.getElementById("a")!;
	const b = document.getElementById("b")!;
	const c = document.getElementById("c")!;
	const seen: string[] = [];
	const late = (): void => {
		seen.push("late on a");
	};
	const removed = (): void => {
		seen.push("removed on b");
	};
	b.addEventListener("ping", removed);
	c.addEventListener("ping", () => {
		seen.push("c");
		c.addEventListener("ping", () => seen.push("added on c"));
		a.addEventListener("ping", late);
		b.removeEventListener("ping", removed);
		document.body.addEventListener(
			"ping",
			() => seen.push("body"),
			{once: true},
		);
	});
	c.dispatchEvent(new window.Event("ping", {bubbles: true}));
	expect(seen).toEqual(["c", "late on a", "body"]);
	seen.length = 0;
	a.removeEventListener("ping", late);
	c.dispatchEvent(new window.Event("ping", {bubbles: true}));
	expect(seen).toEqual(["c", "added on c", "late on a", "body"]);
	dom.dispose();
});

test("events dispatched from a MutationObserver and a listener nest whole", async () => {
	const {dom} = await open("<div id='a'><b id='b'></b></div><p id='p'></p>");
	const {document, window} = dom;
	const name = (target: EventTarget): string =>
		(target as Element).id || (target as Node).nodeName || "window";
	const a = document.getElementById("a")!;
	const b = document.getElementById("b")!;
	const p = document.getElementById("p")!;
	const seen: string[] = [];
	p.addEventListener("inner", (event) => {
		seen.push(`inner ${event.composedPath().map(name).join(" ")}`);
	});
	b.addEventListener("outer", (event) => {
		a.setAttribute("data-x", String(seen.length));
		p.dispatchEvent(new window.Event("inner", {bubbles: true}));
		seen.push(`outer ${event.composedPath().map(name).join(" ")}`);
	});
	const observer = new window.MutationObserver(() => {
		b.dispatchEvent(new window.Event("outer", {bubbles: true}));
		seen.push("observed");
		observer.disconnect();
	});
	observer.observe(a, {attributes: true});
	a.setAttribute("data-x", "start");
	await nextFrame(dom);
	expect(seen).toEqual([
		"inner p BODY HTML #document window",
		"outer b a BODY HTML #document window",
		"observed",
	]);
	dom.dispose();
});

test("a key event's modifier state and code match what was pressed", async () => {
	const {terminal, dom} = await open("<input>");
	const {document, window} = dom;
	const input = document.querySelector("input")!;
	input.focus();
	await nextFrame(dom);
	const seen: string[] = [];
	const events: KeyboardEvent[] = [];
	document.addEventListener("keydown", (event) => {
		events.push(event);
		seen.push(
			`${event.key} ${event.code} ${event.getModifierState("Control")}` +
			` ${event.getModifierState("Alt")}`,
		);
	});
	await send(terminal, "a");
	await send(terminal, "A");
	await send(terminal, "7");
	await send(terminal, "\x01");
	await send(terminal, "\x1bz");
	await send(terminal, "!");
	await send(terminal, "é");
	await nextFrame(dom);
	expect(seen).toEqual([
		"a KeyA false false",
		"A KeyA false false",
		"7 Digit7 false false",
		"a KeyA true false",
		"z KeyZ false true",
		"! Digit1 false false",
		"é  false false",
	]);
	expect(events[3].getModifierState("Control")).toBe(true);
	expect(events[0].getModifierState("Control")).toBe(false);
	const made = new window.KeyboardEvent("keydown", {
		ctrlKey: true,
		modifierFn: true,
		modifierSymbolLock: true,
	});
	const all = [
		"Control",
		"Shift",
		"Alt",
		"Meta",
		"AltGraph",
		"CapsLock",
		"Fn",
		"FnLock",
		"Hyper",
		"NumLock",
		"ScrollLock",
		"Super",
		"Symbol",
		"SymbolLock",
	];
	expect(all.filter((key) => made.getModifierState(key))).toEqual([
		"Control",
		"Fn",
		"SymbolLock",
	]);
	const mouse = new window.MouseEvent("click", {ctrlKey: true, metaKey: true});
	expect(all.filter((key) => mouse.getModifierState(key))).toEqual([
		"Control",
		"Meta",
	]);
	expect(events[3].getModifierState("Control")).toBe(true);
	dom.dispose();
});

test("a transition event's listener that changes the style restyles from it", async () => {
	const {terminal, dom} = await open(
		"<style>p { transition: color 10ms; color: rgb(255, 0, 0) }" +
		".go { color: rgb(0, 0, 255) } .back { color: rgb(0, 128, 0) }</style>" +
		"<p>text</p>",
	);
	const {document, window} = dom;
	const p = document.querySelector("p")!;
	const seen: string[] = [];
	p.addEventListener("transitionrun", () => {
		seen.push(`run ${window.getComputedStyle(p).color}`);
	});
	p.addEventListener("transitionend", () => {
		seen.push("end");
		if (p.className === "go") {
			p.className = "back";
			p.style.transition = "none";
		}
	});
	p.className = "go";
	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 60));
	await nextFrame(dom);
	await nextFrame(dom);
	await nextFrame(dom);
	expect(seen[0]).toMatch(/^run /);
	expect(seen).toContain("end");
	expect(window.getComputedStyle(p).color).toBe(GREEN);
	expect(cell(terminal, 0, 0).fg).toBe(0x008000);
	dom.dispose();
});

test("a transition on a flex item starts from the value it showed", async () => {
	const {dom} = await open(
		"<style>div { display: flex } span { transition: color 1s linear;" +
		" color: rgb(255, 0, 0); display: inline }" +
		".go { color: rgb(0, 0, 255) }</style><div><span>s</span></div>",
	);
	const {document, window} = dom;
	const span = document.querySelector("span")!;
	expect(window.getComputedStyle(span).display).toBe("block");
	span.className = "go";
	await nextFrame(dom);
	const color = window.getComputedStyle(span).color;
	expect(color).not.toBe(BLUE);
	expect(window.getComputedStyle(span).display).toBe("block");
	dom.dispose();
});

test("a ::before inherits what its element changes to from a listener", async () => {
	const {terminal, dom} = await open(
		"<style>p::before { content: '>' } .a { color: rgb(255, 0, 0) }" +
		".b { color: rgb(0, 0, 255); font-weight: bold }</style><p>x</p>",
	);
	const {document, window} = dom;
	const p = document.querySelector("p")!;
	const reads: string[] = [];
	p.addEventListener("ping", () => {
		p.className = "a";
		reads.push(window.getComputedStyle(p, "::before").color);
		p.className = "b";
		reads.push(window.getComputedStyle(p, "::before").color);
		reads.push(window.getComputedStyle(p, "::before").fontWeight);
	});
	p.dispatchEvent(new window.Event("ping"));
	expect(reads).toEqual([RED, BLUE, "700"]);
	await nextFrame(dom);
	expect(rowText(terminal, 0).trimEnd()).toBe(">x");
	expect(cell(terminal, 0, 0).fg).toBe(0x0000ff);
	p.className = "";
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	expect(window.getComputedStyle(p, "::before").fontWeight).toBe("400");
	dom.dispose();
});

test.todo("an element moved into another document takes that document's rules, also failing on main", async () => {
	const {terminal, dom} = await open(
		"<style>.k { color: rgb(255, 0, 0) } p { margin: 0 }</style>" +
		"<p>top</p><iframe srcdoc=\"<style>.k { color: rgb(0, 0, 255) }" +
		"</style><p class='k'>in</p>\"></iframe>",
		{rows: 20},
	);
	try {
		const {document, window} = dom;
		const iframe = document.querySelector("iframe")!;
		await nextFrame(dom);
		const inner = iframe.contentDocument!;
		const moved = inner.querySelector("p")!;
		const innerWindow = iframe.contentWindow!;
		expect(innerWindow.getComputedStyle(moved).color).toBe(BLUE);
		document.body.prepend(moved);
		await nextFrame(dom);
		expect(window.getComputedStyle(moved).color).toBe(RED);
		expect(rowText(terminal, 0).trimEnd()).toBe("in");
		expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
		moved.className = "k q";
		await nextFrame(dom);
		expect(window.getComputedStyle(moved).color).toBe(RED);
		inner.body.append(moved);
		moved.className = "k";
		await nextFrame(dom);
		expect(innerWindow.getComputedStyle(moved).color).toBe(BLUE);
		expect(rowText(terminal, 0).trimEnd()).toBe("top");
	} finally {
		dom.dispose();
	}
});

test("a custom element whose members are overridden styles by its attributes", async () => {
	const {terminal, dom} = await open(
		"<style>.on { color: rgb(255, 0, 0) } #me { background: " +
		"rgb(0, 0, 255) } x-a, p { display: block; margin: 0 }</style>" +
		"<x-a>a</x-a><p>p</p>",
	);
	const {document, window} = dom;

	class XA extends window.HTMLElement {
		override get className(): string {
			return "off";
		}

		override set className(_value: string) {}

		override get id(): string {
			return "nope";
		}

		override set id(_value: string) {}

		override get classList(): DOMTokenList {
			return document.querySelector("p")!.classList;
		}

		override getAttribute(): string {
			return "on";
		}
	}

	window.customElements.define("x-a", XA);
	const element = document.querySelector("x-a")!;
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	window.Element.prototype.setAttribute.call(element, "class", "on");
	window.Element.prototype.setAttribute.call(element, "id", "me");
	element.className = "ignored";
	await nextFrame(dom);
	expect(window.getComputedStyle(element).color).toBe(RED);
	expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(terminal, 0, 0).bg).toBe(0x0000ff);
	expect(element.matches(".on#me")).toBe(true);
	element.classList.add("on");
	await nextFrame(dom);
	expect(cell(terminal, 0, 1).fg).toBe(0xff0000);
	const getAttribute = window.Element.prototype.getAttribute;
	expect(getAttribute.call(element, "class")).toBe("on");
	expect(element.getAttribute("class")).toBe("on");
	dom.dispose();
});

test("two engines restyle the same class value on their own", async () => {
	const css =
		"<style>.a .b { color: rgb(255, 0, 0) } .c { color: rgb(0, 0, 255) }" +
		"</style><div class='a'><p class='b c'>x</p></div>";
	const first = await open(css);
	const second = await open(css);
	expect(cell(first.terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(second.terminal, 0, 0).fg).toBe(0xff0000);
	first.dom.document.querySelector("div")!.className = "z";
	second.dom.document.querySelector("p")!.className = "c b";
	await nextFrame(first.dom);
	await nextFrame(second.dom);
	expect(cell(first.terminal, 0, 0).fg).toBe(0x0000ff);
	expect(cell(second.terminal, 0, 0).fg).toBe(0xff0000);
	second.dom.document.querySelector("div")!.className = "z";
	first.dom.document.querySelector("div")!.className = "a";
	await nextFrame(first.dom);
	await nextFrame(second.dom);
	expect(cell(first.terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(second.terminal, 0, 0).fg).toBe(0x0000ff);
	first.dom.dispose();
	second.dom.dispose();
});

test("a class that paints only and one that lays out, swapped in place", async () => {
	const {terminal, dom} = await open(
		"<style>.paint { color: rgb(255, 0, 0) } .wide { padding-left: 2em }" +
		"#w { padding-left: 4em } #c { background-position-x: 1px;" +
		" color: rgb(0, 0, 255) }</style><p>text</p>",
	);
	const p = dom.document.querySelector("p")!;
	const steps: Array<[() => void, string, number]> = [
		[() => p.className = "paint", "text", 0xff0000],
		[() => p.className = "paint wide", "  text", 0xff0000],
		[() => p.className = "wide", "  text", -1],
		[() => p.className = "", "text", -1],
		[() => p.id = "w", "    text", -1],
		[() => p.id = "c", "text", 0x0000ff],
		[() => p.className = "wide", "  text", 0x0000ff],
		[() => p.id = "", "  text", -1],
	];
	for (const [step, text, fg] of steps) {
		step();
		await nextFrame(dom);
		expect(rowText(terminal, 0).trimEnd()).toBe(text);
		expect(cell(terminal, text.indexOf("t"), 0).fg).toBe(fg);
	}
	dom.dispose();
});

test("a fragment of custom elements whose connected callbacks move nodes", async () => {
	const {dom} = await open("<div id='a'></div><div id='b'></div>");
	const {document, window} = dom;
	const connected: string[] = [];

	class XM extends window.HTMLElement {
		connectedCallback(): void {
			connected.push(this.id);
			if (this.id === "one" && this.parentElement!.id !== "b") {
				document.getElementById("b")!.append(this);
			}
		}
	}

	window.customElements.define("x-m", XM);
	const fragment = document.createDocumentFragment();
	for (const id of ["one", "two", "three"]) {
		const element = document.createElement("x-m");
		element.id = id;
		element.append(document.createElement("x-m"));
		fragment.append(element);
	}
	document.getElementById("a")!.append(fragment);
	await nextFrame(dom);
	expect(connected.filter(Boolean)).toEqual(["one", "one", "two", "three"]);
	expect(document.getElementById("b")!.firstElementChild!.id).toBe("one");
	dom.dispose();
});

test.todo("a data attribute written through dataset is set, also failing on main", async () => {
	const {dom} = await open("<p>x</p>");
	const p = dom.document.querySelector("p")!;
	p.dataset.step = "1";
	expect(p.getAttribute("data-step")).toBe("1");
	p.dataset.twoWords = "2";
	expect(p.getAttribute("data-two-words")).toBe("2");
	dom.dispose();
});
