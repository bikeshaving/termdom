/**
 * What the engine shares between elements, events and frames, or keeps
 * from one to the next: class token sets, style attribute blocks, ancestor
 * filters, marker styles, style escapes, paint records, event paths and
 * the classes a DOM member last accepted. Each test changes one sharer
 * and checks the others, or skips work and checks it was not needed, so a
 * shortcut that goes stale fails here.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {CellContext, CellGrid, drawRect} from "../src/internal/framebuffer.ts";
import {inputDispatched, MockProcess, nextFrame} from "./test-utils.js";

interface Cell {
	char: string;
	fg: number;
	bg: number;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	dim: boolean;
	inverse: boolean;
}

function cell(terminal: MockProcess, col: number, row: number): Cell {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	const at = line.getCell(col);
	return {
		char: at.getChars() || " ",
		fg: at.isFgRGB() ? at.getFgColor() : -1,
		bg: at.isBgRGB() ? at.getBgColor() : -1,
		bold: Boolean(at.isBold()),
		italic: Boolean(at.isItalic()),
		underline: Boolean(at.isUnderline()),
		dim: Boolean(at.isDim()),
		inverse: Boolean(at.isInverse()),
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

test("elements sharing a class value restyle alone when one's class changes", async () => {
	const {dom} = await open(
		"<style>.a { color: rgb(255, 0, 0) } .c { color: rgb(0, 0, 255) }</style>" +
		"<p class='a b'>one</p><p class='a b'>two</p><p class='a b'>three</p>",
	);
	const {window} = dom;
	const [one, two, three] = [...dom.document.querySelectorAll("p")];
	one.classList.add("c");
	await nextFrame(dom);
	expect(window.getComputedStyle(one).color).toBe("rgb(0, 0, 255)");
	expect(window.getComputedStyle(two).color).toBe("rgb(255, 0, 0)");
	expect([...two.classList]).toEqual(["a", "b"]);
	two.className = "b";
	await nextFrame(dom);
	expect(window.getComputedStyle(two).color).toBe("rgb(0, 0, 0)");
	expect(window.getComputedStyle(three).color).toBe("rgb(255, 0, 0)");
	expect([...one.classList]).toEqual(["a", "b", "c"]);
	dom.dispose();
});

test("a no-break space inside a class value does not split it, before or after a change", async () => {
	const {dom} = await open(
		"<style>.a { color: rgb(255, 0, 0) } .a + p { color: rgb(0, 0, 255) }" +
		"</style><p class='a b'>one</p><p>two</p>",
	);
	const {window} = dom;
	const [one, two] = [...dom.document.querySelectorAll("p")];
	expect(window.getComputedStyle(one).color).toBe("rgb(0, 0, 0)");
	one.className = "a";
	await nextFrame(dom);
	expect(window.getComputedStyle(one).color).toBe("rgb(255, 0, 0)");
	expect(window.getComputedStyle(two).color).toBe("rgb(0, 0, 255)");
	one.className = "a b";
	await nextFrame(dom);
	expect(window.getComputedStyle(one).color).toBe("rgb(0, 0, 0)");
	expect(window.getComputedStyle(two).color).toBe("rgb(0, 0, 0)");
	dom.dispose();
});

test("a descendant rule follows an element moved under another ancestor", async () => {
	const {dom} = await open(
		"<style>.on p { color: rgb(255, 0, 0) } .other span { font-style: italic }" +
		" #top span { font-weight: bold }</style>" +
		"<section class='on'><p>text <span>x</span></p></section>" +
		"<section class='other'></section>",
	);
	const {window, document} = dom;
	const p = document.querySelector("p")!;
	const span = document.querySelector("span")!;
	expect(window.getComputedStyle(p).color).toBe("rgb(255, 0, 0)");
	expect(window.getComputedStyle(span).fontStyle).toBe("normal");
	document.querySelectorAll("section")[1].append(p);
	await nextFrame(dom);
	expect(window.getComputedStyle(p).color).toBe("rgb(0, 0, 0)");
	expect(window.getComputedStyle(span).fontStyle).toBe("italic");
	document.querySelectorAll("section")[1].id = "top";
	await nextFrame(dom);
	expect(window.getComputedStyle(span).fontWeight).toBe("700");
	dom.dispose();
});

test("a style attribute's text shared by many resets on the one it is removed from", async () => {
	const {dom} = await open(
		Array.from({length: 5}, () => "<p style='color: rgb(255, 0, 0)'>x</p>")
			.join(""),
	);
	const {window} = dom;
	const items = [...dom.document.querySelectorAll("p")];
	items[2].removeAttribute("style");
	await nextFrame(dom);
	expect(items.map((p) => window.getComputedStyle(p).color)).toEqual([
		"rgb(255, 0, 0)",
		"rgb(255, 0, 0)",
		"rgb(0, 0, 0)",
		"rgb(255, 0, 0)",
		"rgb(255, 0, 0)",
	]);
	dom.dispose();
});

test("more distinct style texts than are kept still read as written", async () => {
	const count = 1500;
	const {dom} = await open(
		Array.from(
			{length: count},
			(_, i) => `<i style='width: ${i}px; color: rgb(${i % 256}, 0, 0)'></i>`,
		).join(""),
	);
	const {window} = dom;
	const items = [...dom.document.querySelectorAll("i")];
	for (const i of [0, 1, 700, 1023, 1024, 1499]) {
		expect(window.getComputedStyle(items[i]).color)
			.toBe(`rgb(${i % 256}, 0, 0)`);
	}
	items[0].setAttribute("style", "color: rgb(0, 0, 255)");
	await nextFrame(dom);
	expect(window.getComputedStyle(items[0]).color).toBe("rgb(0, 0, 255)");
	expect(window.getComputedStyle(items[1]).color).toBe("rgb(1, 0, 0)");
	dom.dispose();
});

test("a class whose rules set a color in one and a width in another lays out", async () => {
	const {dom} = await open(
		"<style>div { width: 4ch } .x { width: 9ch } .x { color: rgb(255, 0, 0) }" +
		"</style><div>box</div>",
	);
	const div = dom.document.querySelector("div")!;
	expect(div.getBoundingClientRect().width).toBe(4);
	div.classList.add("x");
	await nextFrame(dom);
	expect(div.getBoundingClientRect().width).toBe(9);
	div.classList.remove("x");
	await nextFrame(dom);
	expect(div.getBoundingClientRect().width).toBe(4);
	dom.dispose();
});

test("a list marker takes its item's color through restyles", async () => {
	const {terminal, dom} = await open(
		"<style>ul { margin: 0 } li.on { color: rgb(255, 0, 0) }" +
		" li.off { color: rgb(0, 0, 255) }</style>" +
		"<ul><li>one</li><li>two</li></ul>",
	);
	const markerCol = rowText(terminal, 0).indexOf("•");
	expect(markerCol).toBeGreaterThanOrEqual(0);
	const [one, two] = [...dom.document.querySelectorAll("li")];
	for (let round = 0; round < 3; round++) {
		one.className = "on";
		two.className = "off";
		await nextFrame(dom);
		expect(cell(terminal, markerCol, 0).fg).toBe(0xff0000);
		expect(cell(terminal, markerCol, 1).fg).toBe(0x0000ff);
		one.className = "off";
		two.className = "on";
		await nextFrame(dom);
		expect(cell(terminal, markerCol, 0).fg).toBe(0x0000ff);
		expect(cell(terminal, markerCol, 1).fg).toBe(0xff0000);
	}
	dom.dispose();
});

test("a ::marker rule added later styles the markers already shown", async () => {
	const {terminal, dom} = await open(
		"<style>ul { margin: 0 } li { color: rgb(255, 0, 0) }</style>" +
		"<ul><li>one</li><li>two</li></ul>",
	);
	const markerCol = rowText(terminal, 0).indexOf("•");
	expect(cell(terminal, markerCol, 0).fg).toBe(0xff0000);
	const style = dom.document.createElement("style");
	style.textContent = "li::marker { color: rgb(0, 255, 0) }";
	dom.document.head.append(style);
	await nextFrame(dom);
	expect(cell(terminal, markerCol, 0).fg).toBe(0x00ff00);
	expect(cell(terminal, markerCol, 1).fg).toBe(0x00ff00);
	expect(cell(terminal, markerCol + 2, 0).fg).toBe(0xff0000);
	style.remove();
	await nextFrame(dom);
	expect(cell(terminal, markerCol, 1).fg).toBe(0xff0000);
	dom.dispose();
});

test("cells keep their own attributes as styles trade places between rows", async () => {
	const styles = [
		"font-weight: bold",
		"font-style: italic",
		"text-decoration: underline",
		"font-weight: 100",
		"color: rgb(255, 0, 0); background: rgb(0, 0, 255)",
	];
	const {terminal, dom} = await open(
		styles.map((_, i) => `<p id='p${i}'>row${i}</p>`).join(""),
	);
	const rows = styles.map((_, i) => dom.document.getElementById(`p${i}`)!);
	for (let shift = 0; shift < styles.length * 2; shift++) {
		rows.forEach((row, i) => {
			row.setAttribute("style", styles[(i + shift) % styles.length]);
		});
		await nextFrame(dom);
		rows.forEach((_, i) => {
			const style = styles[(i + shift) % styles.length];
			const at = cell(terminal, 1, i);
			expect(at.char).toBe("o");
			expect(at.bold).toBe(style === "font-weight: bold");
			expect(at.italic).toBe(style === "font-style: italic");
			expect(at.underline).toBe(style === "text-decoration: underline");
			expect(at.dim).toBe(style === "font-weight: 100");
			expect(at.fg).toBe(style.startsWith("color") ? 0xff0000 : -1);
			expect(at.bg).toBe(style.startsWith("color") ? 0x0000ff : -1);
		});
	}
	dom.dispose();
});

test("a style reached from different styles turns off what each had on", async () => {
	const red = "color: rgb(255, 0, 0); background: rgb(0, 0, 255)";
	const {terminal, dom} = await open(
		`<p><b style='${red}'>a</b></p>` +
		`<p><span style='${red}; font-weight: 100'>b</span>` +
		`<b style='${red}'>c</b></p>` +
		"<p><i>d</i><b>e</b><span style='font-weight: 100'>f</span>g</p>",
	);
	const at = (col: number, row: number): Partial<Cell> => {
		const {char, bold, dim, italic} = cell(terminal, col, row);
		return {char, bold, dim, italic};
	};
	expect(at(0, 0)).toEqual({char: "a", bold: true, dim: false, italic: false});
	expect(at(0, 1)).toEqual({char: "b", bold: false, dim: true, italic: false});
	expect(at(1, 1)).toEqual({char: "c", bold: true, dim: false, italic: false});
	expect(at(1, 2)).toEqual({char: "e", bold: true, dim: false, italic: false});
	expect(at(2, 2)).toEqual({char: "f", bold: false, dim: true, italic: false});
	expect(at(3, 2)).toEqual({char: "g", bold: false, dim: false, italic: false});
	dom.dispose();
});

test("a row mixing plain, wide and styled text reaches the screen as painted", async () => {
	const {terminal, dom} = await open(
		"<p>ab<b>cd</b>日本<i>e</i> f<span style='color: rgb(255, 0, 0)'>gh</span>" +
		"🚀z</p>",
	);
	expect(rowText(terminal, 0)).toBe("abcd日本e fgh🚀z");
	expect(cell(terminal, 2, 0).bold).toBe(true);
	expect(cell(terminal, 4, 0).char).toBe("日");
	expect(cell(terminal, 8, 0).italic).toBe(true);
	expect(cell(terminal, 11, 0).fg).toBe(0xff0000);
	expect(cell(terminal, 13, 0).fg).toBe(-1);
	const p = dom.document.querySelector("p")!;
	p.style.background = "rgb(0, 0, 255)";
	await nextFrame(dom);
	expect(rowText(terminal, 0).trimEnd()).toBe("abcd日本e fgh🚀z");
	expect(cell(terminal, 0, 0).bg).toBe(0x0000ff);
	expect(cell(terminal, 15, 0).char).toBe("z");
	dom.dispose();
});

test("text around and inside an inline-block keeps its place across frames", async () => {
	const {terminal, dom} = await open(
		"<style>.on { color: rgb(255, 0, 0) }</style>" +
		"<p>ab <span style='display: inline-block'>cd <b>ef</b></span> gh " +
		"<span style='display: inline-block'>o<b>p</b>s</span> qr</p>" +
		"<p>ij <span style='display: inline-block'>kl</span> mn</p>",
	);
	const [first, second] = [...dom.document.querySelectorAll("p")];
	for (let round = 0; round < 6; round++) {
		first.classList.toggle("on");
		if (round % 2 === 0) {
			second.classList.toggle("on");
		}
		await nextFrame(dom);
		expect(rowText(terminal, 0)).toBe("ab cd ef gh ops qr");
		expect(rowText(terminal, 1)).toBe("ij kl mn");
		expect(cell(terminal, 6, 0).fg)
			.toBe(first.classList.contains("on") ? 0xff0000 : -1);
		expect(cell(terminal, 3, 1).fg)
			.toBe(second.classList.contains("on") ? 0xff0000 : -1);
	}
	dom.dispose();
});

test("a fill under a clip with fractional edges covers the cells whose left edges it holds", () => {
	const grid = new CellGrid(3, 10);
	const context = new CellContext(grid, 3, 10, 0);
	context.clipRect = {left: 2.5, top: 0.5, right: 6.5, bottom: 2.5} as any;
	const blue = 0x10000ff;
	drawRect(context, 0, 0, 10, 3, blue);
	const filled = (row: number): number[] =>
		Array.from({length: 10}, (_, col) => col)
			.filter((col) => grid.bg[row * 10 + col] === blue);
	expect(filled(0)).toEqual([]);
	expect(filled(1)).toEqual([3, 4, 5, 6]);
	expect(filled(2)).toEqual([3, 4, 5, 6]);
});

test("a key that only moves a text field's caret moves the terminal's cursor", async () => {
	const {terminal, dom} = await open("<input value='hello'>");
	const input = dom.document.querySelector("input")!;
	input.focus();
	input.setSelectionRange(5, 5);
	await nextFrame(dom);
	const buffer = (terminal as any).terminal.buffer.active;
	const start = buffer.cursorX;
	await send(terminal, "\x1b[D");
	await nextFrame(dom);
	expect(input.selectionStart).toBe(4);
	expect(buffer.cursorX).toBe(start - 1);
	await send(terminal, "\x1b[D\x1b[D");
	await nextFrame(dom);
	expect(buffer.cursorX).toBe(start - 3);
	dom.dispose();
});

test("a :hover color reaches the screen after keys that changed nothing", async () => {
	const {terminal, dom} = await open(
		"<style>div:hover { color: rgb(255, 0, 0) }</style>" +
		"<div>first</div><div>second</div>",
	);
	for (let i = 0; i < 3; i++) {
		await send(terminal, "x");
		await nextFrame(dom);
	}
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	await send(terminal, "\x1b[<35;2;1M");
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).fg).toBe(0xff0000);
	expect(cell(terminal, 0, 1).fg).toBe(-1);
	await send(terminal, "x");
	await nextFrame(dom);
	await send(terminal, "\x1b[<35;2;2M");
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).fg).toBe(-1);
	expect(cell(terminal, 0, 1).fg).toBe(0xff0000);
	dom.dispose();
});

test("a scrolled box's offset is clamped when its content shrinks", async () => {
	const {dom} = await open(
		"<style>ul { height: 5em; overflow: auto; margin: 0 }</style><ul>" +
		Array.from({length: 40}, (_, i) => `<li>item ${i}</li>`).join("") +
		"</ul>",
	);
	const ul = dom.document.querySelector("ul")!;
	ul.scrollTop = ul.scrollHeight;
	await nextFrame(dom);
	await nextFrame(dom);
	const before = ul.scrollTop;
	expect(before).toBe(ul.scrollHeight - ul.clientHeight);
	for (const li of [...ul.querySelectorAll("li")].slice(10)) {
		li.remove();
	}
	await nextFrame(dom);
	expect(ul.scrollTop).toBeLessThan(before);
	expect(ul.scrollTop).toBe(ul.scrollHeight - ul.clientHeight);
	dom.dispose();
});

test("an event dispatched from a listener leaves the outer event's path whole", async () => {
	const {dom} = await open(
		"<div id='a'><span id='b'></span></div><div id='c'><span id='d'></span>" +
		"</div>",
	);
	const {document, window} = dom;
	const name = (target: EventTarget): string =>
		(target as Element).id || (target as Node).nodeName || "window";
	const seen: string[] = [];
	const get = (id: string): Element => document.getElementById(id)!;
	get("c").addEventListener("pong", (event) => {
		seen.push(`pong at c: ${event.composedPath().map(name).join(" ")}`);
	});
	get("a").addEventListener("ping", (event) => {
		get("d").dispatchEvent(new window.Event("pong", {bubbles: true}));
		seen.push(`ping at a: ${event.composedPath().map(name).join(" ")}`);
	});
	document.body.addEventListener("ping", (event) => {
		seen.push(`ping at body: ${(event.currentTarget as Element).nodeName}`);
	});
	const ping = new window.Event("ping", {bubbles: true});
	get("b").dispatchEvent(ping);
	expect(ping.composedPath()).toEqual([]);
	get("b").dispatchEvent(ping);
	const path = "b a BODY HTML #document window";
	expect(seen).toEqual([
		"pong at c: d c BODY HTML #document window",
		`ping at a: ${path}`,
		"ping at body: BODY",
		"pong at c: d c BODY HTML #document window",
		`ping at a: ${path}`,
		"ping at body: BODY",
	]);
	dom.dispose();
});

test("keyboard events with different modifiers report their own", async () => {
	const {dom} = await open("");
	const {KeyboardEvent} = dom.window;
	const control = new KeyboardEvent("keydown", {ctrlKey: true});
	const shiftAlt = new KeyboardEvent("keydown", {shiftKey: true, altKey: true});
	const none = new KeyboardEvent("keydown");
	const controlAgain = new KeyboardEvent("keydown", {ctrlKey: true});
	const lock = new KeyboardEvent("keydown", {modifierCapsLock: true} as any);
	const held = (event: KeyboardEvent): string[] =>
		["Control", "Shift", "Alt", "Meta", "CapsLock"]
			.filter((key) => event.getModifierState(key));
	expect(held(control)).toEqual(["Control"]);
	expect(held(shiftAlt)).toEqual(["Shift", "Alt"]);
	expect(held(none)).toEqual([]);
	expect(held(controlAgain)).toEqual(["Control"]);
	expect(held(lock)).toEqual(["CapsLock"]);
	expect([control.ctrlKey, control.shiftKey, shiftAlt.altKey, none.metaKey])
		.toEqual([true, false, true, false]);
	dom.dispose();
});

test("a DOM member still refuses another interface's object after accepting its own", async () => {
	const {dom} =
		await open("<p id='x'>text</p><input><a href='h'>a</a><iframe></iframe>");
	const {document, window} = dom;
	const getAttribute = window.Element.prototype.getAttribute;
	const idGetter = Object.getOwnPropertyDescriptor(
		window.Element.prototype,
		"id",
	)!.get!;
	const hrefGetter = Object.getOwnPropertyDescriptor(
		window.HTMLAnchorElement.prototype,
		"href",
	)!.get!;
	const closest = window.Element.prototype.closest;
	const text = document.querySelector("p")!.firstChild!;
	const check = (): void => {
		expect(getAttribute.call(document.querySelector("p"), "id")).toBe("x");
		expect(getAttribute.call(document.querySelector("input"), "id")).toBe(null);
		expect(getAttribute.call(document.body, "id")).toBe(null);
		expect(() => getAttribute.call(text, "id")).toThrow(TypeError);
		expect(() => getAttribute.call(document, "id")).toThrow(TypeError);
		expect(idGetter.call(document.querySelector("p"))).toBe("x");
		expect(() => idGetter.call(text)).toThrow(TypeError);
		expect(hrefGetter.call(document.querySelector("a"))).toContain("h");
		expect(() => hrefGetter.call(document.querySelector("p"))).toThrow(
			TypeError,
		);
		expect(closest.call(document.querySelector("p"), "p")).not.toBe(null);
		expect(() => closest.call(text, "p")).toThrow(TypeError);
	};
	check();
	document.querySelector("iframe")!.remove();
	await nextFrame(dom);
	check();
	dom.dispose();
});

test("a selection made in a frame callback is painted in that frame", async () => {
	const {terminal, dom} = await open("<p>hello</p><p>world</p>");
	const plain = cell(terminal, 0, 0);
	const second = dom.document.querySelectorAll("p")[1];
	dom.window.requestAnimationFrame(() => {
		dom.window.getSelection()!.selectAllChildren(second);
	});
	await nextFrame(dom);
	const selected = cell(terminal, 0, 1);
	expect(selected.inverse || selected.bg !== plain.bg).toBe(true);
	expect(cell(terminal, 0, 0)).toEqual(plain);
	dom.window.getSelection()!.removeAllRanges();
	await nextFrame(dom);
	expect(cell(terminal, 0, 1)).toEqual({...plain, char: "w"});
	dom.dispose();
});
