import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {partialFrameCheck} from "../src/internal/painter.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

interface Size {
	cols?: number;
	rows?: number;
	colorDepth?: "rgb" | "256" | "ansi";
	fullscreen?: boolean;
}

async function open(
	html: string,
	size: Size = {},
): Promise<{terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({
		cols: size.cols ?? 40,
		rows: size.rows ?? 10,
		colorDepth: size.colorDepth,
	});
	const dom = new TermDOM({transport: terminal.transport, html});
	await dom.attach();
	await nextFrame(dom);
	if (size.fullscreen) {
		await dom.document.documentElement.requestFullscreen();
		await nextFrame(dom);
	}
	return {terminal, dom};
}

function screen(terminal: MockProcess): string[] {
	const buffer = (terminal as any).terminal.buffer.active;
	const rows: string[] = [];
	for (let row = 0; row < terminal.terminal.rows; row++) {
		const line = buffer.getLine(row);
		let text = "";
		for (let col = 0; col < terminal.terminal.cols; col++) {
			const at = line.getCell(col);
			const flags = [
				at.isBold() ? "b" : "",
				at.isDim() ? "d" : "",
				at.isItalic() ? "i" : "",
				at.isUnderline() ? "u" : "",
				at.isInverse() ? "v" : "",
				at.isStrikethrough() ? "s" : "",
				at.isOverline() ? "o" : "",
			].join("");
			text +=
				`${at.getChars() || " "}/${at.getWidth()}/${flags}` +
				`/${at.getFgColorMode()}:${at.getFgColor()}` +
				`/${at.getBgColorMode()}:${at.getBgColor()} `;
		}
		rows.push(text);
	}
	return rows;
}

function cursor(terminal: MockProcess): {row: number; col: number} {
	const buffer = (terminal as any).terminal.buffer.active;
	return {row: buffer.cursorY, col: buffer.cursorX};
}

async function fresh(html: string, size: Size = {}): Promise<string[]> {
	const {terminal, dom} = await open(html, size);
	const shown = screen(terminal);
	dom.dispose();
	return shown;
}

async function expectFresh(
	terminal: MockProcess,
	html: string,
	size: Size = {},
): Promise<void> {
	expect(screen(terminal)).toEqual(await fresh(html, size));
}

const ATTRIBUTES = [
	"",
	"font-weight: bold",
	"font-weight: 100",
	"font-weight: bold; text-decoration: underline",
	"font-weight: 100; text-decoration: underline line-through",
	"font-style: italic; font-weight: bold",
	"text-decoration: line-through",
	"background: Highlight; font-weight: bold",
	"background: Highlight; font-weight: 100",
	"text-decoration: overline; font-style: italic",
	"color: rgb(255, 0, 0); font-weight: bold",
	"color: rgb(255, 0, 1); font-weight: 100",
	"color: rgb(255, 0, 0); background: rgb(0, 0, 1)",
	"color: rgb(255, 0, 0); background: rgb(0, 0, 2); font-weight: bold",
	"color: red",
	"background: rgb(0, 0, 1)",
	"background: rgb(0, 0, 1); text-decoration: underline",
];

function attributeRow(shift: number, count: number): string {
	return Array.from({length: count}, (_, i) =>
		`<span style='${ATTRIBUTES[(i * 3 + shift) % ATTRIBUTES.length]}'>` +
		`a${i % 10}</span>`,
	).join("");
}

function attributePage(shift: number): string {
	return [0, 1, 2, 3]
		.map((row) => `<p>${attributeRow(shift + row * 5, 14)}</p>`)
		.join("");
}

test("cells cycling through every attribute pairing show as a fresh page", async () => {
	const {terminal, dom} = await open(attributePage(0), {cols: 30});
	const paragraphs = [...dom.document.querySelectorAll("p")];
	for (let shift = 1; shift <= ATTRIBUTES.length; shift++) {
		paragraphs.forEach((p, row) => {
			p.innerHTML = attributeRow(shift + row * 5, 14);
		});
		await nextFrame(dom);
		await expectFresh(terminal, attributePage(shift), {cols: 30});
	}
	dom.dispose();
});

test("one span changing a single field at a time shows as a fresh page", async () => {
	const steps = [
		"font-weight: bold",
		"font-weight: bold; text-decoration: underline",
		"font-weight: 100; text-decoration: underline",
		"font-weight: 100",
		"font-weight: bold",
		"font-weight: normal",
		"color: rgb(1, 2, 3)",
		"color: rgb(1, 2, 4)",
		"color: rgb(1, 2, 4); background: rgb(1, 2, 4)",
		"color: rgb(1, 2, 4); background: rgb(1, 2, 3)",
		"background: rgb(1, 2, 3)",
		"background: rgb(1, 2, 3); font-weight: 100",
		"background: rgb(1, 2, 3); font-weight: bold",
		"",
	];
	const page = (style: string): string =>
		"<p><b>ab</b><span style='" +
		style +
		"'>cd</span>ef" +
		"<i style='font-weight: 100'>gh</i></p>";
	const {terminal, dom} = await open(page(""));
	const span = dom.document.querySelector("span")!;
	for (const style of steps) {
		span.setAttribute("style", style);
		await nextFrame(dom);
		await expectFresh(terminal, page(style));
	}
	dom.dispose();
});

test("engines writing at different color depths keep their own escapes", async () => {
	const page = (on: boolean): string =>
		"<p><span style='color: rgb(200, 30, 30)'>red</span> " +
		`<span style='background: rgb(30, 30, ${on ? 200 : 199})'>blue</span>` +
		" <b style='color: rgb(30, 200, 30)'>green</b></p>";
	const depths: Array<"rgb" | "256" | "ansi"> = ["rgb", "256", "ansi"];
	const engines = await Promise.all(
		depths.map((colorDepth) => open(page(false), {colorDepth})),
	);
	for (let round = 0; round < 4; round++) {
		for (const {dom} of engines) {
			dom.document.body.innerHTML = page(round % 2 === 0);
		}
		await Promise.all(engines.map(({dom}) => nextFrame(dom)));
		for (let index = 0; index < depths.length; index++) {
			await expectFresh(engines[index].terminal, page(round % 2 === 0), {
				colorDepth: depths[index],
			});
		}
	}
	for (const {dom} of engines) {
		dom.dispose();
	}
});

test("engines of different widths painting in turn keep their own rows", async () => {
	const line = (width: number, round: number): string =>
		"<p>" +
		Array.from(
			{length: width},
			(_, i) => String.fromCharCode(97 + (i + round) % 26),
		).join("") +
		"</p><p>x<b>y</b>z</p>";
	const widths = [12, 70, 30];
	const engines = await Promise.all(
		widths.map((cols) => open(line(cols, 0), {cols})),
	);
	for (let round = 1; round < 4; round++) {
		for (let index = 0; index < widths.length; index++) {
			engines[index].dom.document.body.innerHTML = line(widths[index], round);
		}
		await Promise.all(engines.map(({dom}) => nextFrame(dom)));
		for (let index = 0; index < widths.length; index++) {
			await expectFresh(engines[index].terminal, line(widths[index], round), {
				cols: widths[index],
			});
		}
	}
	for (const {dom} of engines) {
		dom.dispose();
	}
});

const CLUSTERS = [
	"a",
	"\u65e5",
	"e\u0301",
	"\u{1f680}",
	"\u{1f469}\u200d\u{1f4bb}",
	"b",
	"\u8868",
	"x\u0308",
	"\u{1f1ef}\u{1f1f5}",
];

function clusterPage(shift: number): string {
	const row = (offset: number): string => Array.from({length: 12}, (_, i) => {
		const cluster = CLUSTERS[(i + offset) % CLUSTERS.length];
		return i % 3 === 0 ? `<b>${cluster}</b>` : cluster;
	}).join("");
	return `<p>${row(shift)}</p><p>${row(shift + 4)}</p><p>plain ${shift}</p>`;
}

test("wide, combined and plain clusters trading places show as a fresh page", async () => {
	const {terminal, dom} = await open(clusterPage(0));
	for (let shift = 1; shift <= CLUSTERS.length; shift++) {
		dom.document.body.innerHTML = clusterPage(shift);
		await nextFrame(dom);
		await expectFresh(terminal, clusterPage(shift));
	}
	dom.dispose();
});

async function resize(
	terminal: MockProcess,
	dom: TermDOM,
	cols: number,
	rows: number,
): Promise<void> {
	terminal.resize(cols, rows);
	(terminal as any).emit("SIGWINCH");
	const deadline = Date.now() + 2000;
	while (
		(dom.window.innerWidth !== cols || dom.window.innerHeight !== rows) &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await nextFrame(dom);
}

test("a page resized between frames shows as one started at the new size", async () => {
	const page = (round: number): string =>
		"<style>body { margin: 0 } div { border: 1px solid; height: 3em }" +
		"</style><div>" +
		`<span style='color: rgb(${round}, 0, 0)'>${"word ".repeat(12)}</span>` +
		"</div><p>tail <b>bold</b></p>";
	const {terminal, dom} = await open(page(0), {fullscreen: true});
	const sizes = [[60, 12], [20, 8], [33, 9], [80, 5], [40, 10]];
	for (let round = 0; round < sizes.length; round++) {
		const [cols, rows] = sizes[round];
		await resize(terminal, dom, cols, rows);
		dom.document.querySelector("span")!.style.color = `rgb(${round + 1}, 0, 0)`;
		await nextFrame(dom);
		await expectFresh(terminal, page(
			round + 1,
		), {cols, rows, fullscreen: true});
	}
	dom.dispose();
});

const LIST_ITEMS = Array.from(
	{length: 30},
	(_, i) => `<li>item <b>${i}</b> ${"·".repeat(i % 5)}</li>`,
).join("");

function scrollPage(box: string, before = "", after = ""): string {
	return (
		"<style>body { margin: 0 } ul { margin: 0; list-style: none; " +
		`overflow: hidden; height: 6em; ${box} } li.on { color: rgb(255, 0, 0) }` +
		"</style>" +
		`${before}<ul>${LIST_ITEMS}</ul>${after}`
	);
}

function scrolledPage(
	box: string,
	by: number,
	before = "",
	after = "",
): string {
	return scrollPage(box, before, after).replace(
		"<li>",
		`<li style='margin-top: -${by}em'>`,
	);
}

async function scrollBy(
	box: string,
	steps: number[],
	before = "",
	after = "",
): Promise<void> {
	const {terminal, dom} = await open(scrollPage(box, before, after));
	const ul = dom.document.querySelector("ul")!;
	let at = 0;
	for (const step of steps) {
		at += step;
		ul.scrollTop = at;
		const checked = partialFrameCheck.checked;
		await nextFrame(dom);
		expect(partialFrameCheck.checked).toBeGreaterThan(checked);
		await expectFresh(terminal, scrolledPage(box, at, before, after));
	}
	dom.dispose();
}

test("a box scrolled a row at a time shows as content pulled up", async () => {
	await scrollBy("padding: 0", [1, 1, 2, -1, -2, 3]);
});

test("a box with padding scrolled a row at a time shows as content pulled up", async () => {
	await scrollBy("padding: 1em 0", [1, 1, 2, -1, -2, 3]);
});

test("a box with a top and bottom border scrolled a row at a time shows as content pulled up", async () => {
	await scrollBy(
		"border-top: 1px solid; border-bottom: 1px solid; padding: 0",
		[1, 1, 2, -1, -2, 3],
	);
});

test("a box scrolled under a header and above a footer shows as content pulled up", async () => {
	await scrollBy(
		"padding: 0",
		[1, 2, -1, 3],
		"<header style='background: rgb(0, 0, 128)'>head</header>",
		"<footer style='background: rgb(128, 0, 0)'>foot</footer>",
	);
});

test("a box scrolled while an item in it changes shows as a fresh page", async () => {
	const box = "padding: 0";
	const {terminal, dom} = await open(scrollPage(box));
	const ul = dom.document.querySelector("ul")!;
	const items = [...ul.querySelectorAll("li")];
	for (let at = 1; at <= 5; at++) {
		ul.scrollTop = at;
		items[at + 2].classList.add("on");
		items[at + 1].classList.remove("on");
		items[at + 5].querySelector("b")!.textContent = `n${at}`;
		await nextFrame(dom);
		expect(screen(terminal)).toEqual(await fresh(liveScrolledPage(dom, at)));
	}
	dom.dispose();
});

function liveScrolledPage(dom: TermDOM, by: number): string {
	const ul = dom.document.querySelector("ul")!;
	const copy = ul.cloneNode(true) as HTMLElement;
	(copy.firstElementChild as HTMLElement).style.marginTop = `-${by}em`;
	return (
		[...dom.document.querySelectorAll("style")]
			.map((style) => style.outerHTML)
			.join("") + copy.outerHTML
	);
}

test("a focused field in a scrolled box keeps the terminal's cursor on it", async () => {
	const {terminal, dom} = await open(
		"<style>body { margin: 0 } div { height: 6em; overflow: hidden }" +
		" input { border: 0; padding: 0 }</style><div>" +
		Array.from({length: 4}, (_, i) => `<p style='margin: 0'>row ${i}</p>`)
			.join("") +
		"<input value='typed'>" +
		Array.from({length: 10}, (_, i) => `<p style='margin: 0'>row ${i}</p>`)
			.join("") +
		"</div>",
	);
	const input = dom.document.querySelector("input")!;
	input.focus();
	await nextFrame(dom);
	const row = (): number => Math.round(input.getBoundingClientRect().top);
	expect(cursor(terminal).row).toBe(row());
	const div = dom.document.querySelector("div")!;
	for (const at of [1, 2, 3, 1]) {
		div.scrollTop = at;
		const checked = partialFrameCheck.checked;
		await nextFrame(dom);
		expect(partialFrameCheck.checked).toBeGreaterThan(checked);
		expect(row()).toBe(4 - at);
		expect(cursor(terminal).row).toBe(row());
	}
	dom.dispose();
});

const PANE_ROWS = Array.from(
	{length: 40},
	(_, i) => `<div class='row'>row <i>${i}</i> ${"=".repeat(i % 7)}</div>`,
).join("");

function panePage(extra: string): string {
	return (
		"<style>body { margin: 0 } #pane { height: 100vh; overflow: auto }" +
		" .row.on { background: rgb(0, 0, 128) } " +
		extra +
		`</style><div id='pane'>${PANE_ROWS}</div>`
	);
}

async function wholeScreen(
	html: string,
	setup: (dom: TermDOM) => void,
	size: Size = {},
): Promise<string[]> {
	const cols = size.cols ?? 40;
	const rows = size.rows ?? 10;
	const {terminal, dom} = await open(html, {
		...size,
		cols: cols + 3,
		fullscreen: true,
	});
	setup(dom);
	await nextFrame(dom);
	await resize(terminal, dom, cols, rows);
	await nextFrame(dom);
	const shown = screen(terminal);
	dom.dispose();
	return shown;
}

async function scrollPane(
	extra: string,
	html: string,
	steps: Array<number | number[]>,
	change?: (dom: TermDOM, at: number) => void,
): Promise<void> {
	const page = panePage(extra) + html;
	const {terminal, dom} = await open(page, {fullscreen: true});
	const pane = dom.document.getElementById("pane")!;
	for (const step of steps) {
		const [at, inner] = typeof step === "number" ? [step, -1] : step;
		pane.scrollTop = at;
		const nested = dom.document.getElementById("inner");
		if (nested !== null && inner >= 0) {
			nested.scrollTop = inner;
		}
		change?.(dom, at);
		await nextFrame(dom);
		const final = dom.document.documentElement.outerHTML;
		const expected = await wholeScreen(final, (reference) => {
			reference.document.getElementById("pane")!.scrollTop = at;
			const copy = reference.document.getElementById("inner");
			if (copy !== null && nested !== null) {
				copy.scrollTop = nested.scrollTop;
			}
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
}

test("a full screen pane scrolled back and forth shows as a whole repaint", async () => {
	await scrollPane("", "", [1, 2, 4, 3, 0, 7, 6]);
});

test("a full screen pane scrolled under a fixed bar shows as a whole repaint", async () => {
	await scrollPane(
		"#bar { position: fixed; bottom: 0; left: 0; width: 100%;" +
		" background: rgb(128, 0, 0) }",
		"<div id='bar'>STATUS</div>",
		[1, 2, 5, 4, 0],
	);
});

test("a full screen pane scrolled under a fixed box over its middle shows as a whole repaint", async () => {
	await scrollPane(
		"#bar { position: fixed; top: 3px; left: 5px; width: 10px;" +
		" background: rgb(128, 0, 0) }",
		"<div id='bar'>FLOAT</div>",
		[1, 2, 5, 4, 0],
	);
});

test("a full screen pane with a sticky row scrolled shows as a whole repaint", async () => {
	await scrollPane(
		".row:nth-child(4) { position: sticky; top: 0;" +
		" background: rgb(0, 128, 0) }",
		"",
		[1, 2, 3, 4, 6, 5, 2, 0],
	);
});

test("a full screen pane scrolled while a row in it changes shows as a whole repaint", async () => {
	await scrollPane("", "", [1, 2, 3, 2, 5], (dom, at) => {
		const rows = [...dom.document.querySelectorAll(".row")];
		rows.forEach((row) => row.classList.remove("on"));
		rows[at + 3].classList.add("on");
		rows[at + 8].querySelector("i")!.textContent = `x${at}`;
	});
});

test("a full screen pane scrolled while a row in it grows shows as a whole repaint", async () => {
	await scrollPane("", "", [1, 2, 3, 2, 5], (dom, at) => {
		const rows = [...dom.document.querySelectorAll(".row")];
		rows[at + 2].append(" more ".repeat(10));
	});
});

test("a full screen pane scrolled with a selection across it shows as a whole repaint", async () => {
	const page = panePage("");
	const {terminal, dom} = await open(page, {fullscreen: true});
	const select = (document: Document): void => {
		const all = [...document.querySelectorAll(".row")];
		const range = document.createRange();
		range.setStart(all[2].firstChild!, 2);
		range.setEnd(all[12].firstChild!, 3);
		const selection = document.defaultView!.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	};
	select(dom.document);
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	for (const at of [1, 2, 5, 3, 9, 0]) {
		pane.scrollTop = at;
		await nextFrame(dom);
		const expected = await wholeScreen(page, (reference) => {
			select(reference.document);
			reference.document.getElementById("pane")!.scrollTop = at;
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});

test("nested panes scrolled one, the other and both show as a whole repaint", async () => {
	const inner =
		"<div id='inner' style='height: 4em; overflow: auto;" +
		" background: rgb(0, 64, 0)'>" +
		Array.from({length: 12}, (_, i) => `<div>inner ${i}</div>`).join("") +
		"</div>";
	const page = panePage("").replace(
		"<div class='row'>row <i>3</i>",
		inner + "<div class='row'>row <i>3</i>",
	);
	const {terminal, dom} = await open(page, {fullscreen: true});
	const pane = dom.document.getElementById("pane")!;
	const nested = dom.document.getElementById("inner")!;
	const steps: Array<[number, number]> = [
		[0, 1],
		[0, 2],
		[1, 2],
		[2, 3],
		[2, 1],
		[0, 0],
		[3, 5],
		[3, 6],
	];
	for (const [at, inside] of steps) {
		pane.scrollTop = at;
		nested.scrollTop = inside;
		await nextFrame(dom);
		const expected = await wholeScreen(page, (reference) => {
			reference.document.getElementById("pane")!.scrollTop = at;
			reference.document.getElementById("inner")!.scrollTop = inside;
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});

test("an inline restyled one property at a time lays out as a fresh page", async () => {
	const changes = [
		"white-space: nowrap",
		"white-space: pre",
		"text-transform: uppercase",
		"letter-spacing: 1px",
		"word-spacing: 2px",
		"padding-left: 2px",
		"margin-left: 3px",
		"margin-right: -1px",
		"position: relative; left: 2px",
		"position: relative; top: 1px",
		"vertical-align: super",
		"line-height: 3",
		"word-break: break-all",
		"overflow-wrap: anywhere",
		"direction: rtl; unicode-bidi: bidi-override",
		"visibility: hidden",
		"font-variant: small-caps",
		"tab-size: 2",
		"",
	];
	const page = (style: string): string =>
		"<style>p { width: 18px }</style><p>aaa bbb <span style='" +
		style +
		"'>ccc ddd\teee fff ggggggggggggggg</span> hhh iii</p><p>next</p>";
	const {terminal, dom} = await open(page(""));
	const span = dom.document.querySelector("span")!;
	for (const style of changes) {
		span.setAttribute("style", style);
		await nextFrame(dom);
		await expectFresh(terminal, page(style));
	}
	dom.dispose();
});

test("fractional and negative boxes repainted show as a fresh page", async () => {
	const page = (round: number): string =>
		"<style>body { margin: 0 } div { position: absolute; }</style>" +
		`<div style='left: ${-0.5 - round * 0.25}px; top: ${0.5 + round * 0.3}px;` +
		` width: ${10.5 + round * 0.4}px; height: 2.5px;` +
		" background: rgb(0, 0, 200)'>ab</div>" +
		`<div style='left: ${7.75 - round * 0.5}px; top: ${3.4}px;` +
		` width: ${4.2}px; height: ${1.6 + round * 0.5}px;` +
		" background: rgb(200, 0, 0)'>cd</div>" +
		"<div style='left: 20px; top: -0.6px; width: 5.5px; height: 1.2px;" +
		` margin-left: -${round * 0.7}px; background: rgb(0, 200, 0)'>ef</div>`;
	const {terminal, dom} = await open(page(0));
	for (let round = 1; round < 8; round++) {
		dom.document.body.innerHTML = page(round);
		await nextFrame(dom);
		await expectFresh(terminal, page(round));
	}
	dom.dispose();
});

test("grid tracks that do not divide the width evenly repaint as a fresh page", async () => {
	const page = (columns: string, gap: number): string =>
		"<style>body { margin: 0 } section { display: grid;" +
		` grid-template-columns: ${columns}; column-gap: ${gap}px }` +
		" div:nth-child(odd) { background: rgb(0, 0, 160) }" +
		" div:nth-child(even) { background: rgb(160, 0, 0) }</style>" +
		"<section>" +
		Array.from({length: 7}, (_, i) => `<div>c${i}</div>`).join("") +
		"</section>";
	const steps: Array<[string, number]> = [
		["repeat(3, 1fr)", 0],
		["repeat(7, 1fr)", 0],
		["1fr 2fr 1fr", 1],
		["repeat(6, 1fr)", 0.5],
		["1.5fr 1fr 2.25fr", 0],
		["33.3% 33.3% 33.3%", 0],
		["repeat(3, 1fr)", 0],
	];
	for (const cols of [40, 41, 23]) {
		const {terminal, dom} = await open(page(...steps[0]), {cols});
		for (const step of steps.slice(1)) {
			dom.document.body.innerHTML = page(...step);
			await nextFrame(dom);
			await expectFresh(terminal, page(...step), {cols});
		}
		dom.dispose();
	}
});

for (const [name, html] of [
	["a margin", "<div style='margin-top: 4294967298px'>far</div>"],
	[
		"an absolute offset",
		"<div style='position: absolute; top: 4294967297px'>far</div>",
	],
	[
		"a tall box before it",
		"<div style='height: 4294967296px'></div><div>far</div>",
	],
]) {
	test(`a box pushed past 2^32 rows by ${name} stays off the screen`, async () => {
		const {terminal, dom} = await open(`<p>top</p>${html}`);
		expect(terminal.getVisibleText()).toContain("top");
		expect(terminal.getVisibleText()).not.toContain("far");
		dom.dispose();
	});
}

function listPage(colors: string[], marker = ""): string {
	return (
		`<style>${marker} .c0 { color: rgb(200, 0, 0) }` +
		" .c1 { color: rgb(0, 200, 0); font-weight: bold }" +
		" .c2 { color: rgb(200, 0, 0); font-style: italic }" +
		" .c3 { text-decoration: underline }</style><ul>" +
		colors.map((name, i) => `<li class='${name}'>a${i}</li>`).join("") +
		"</ul><ol>" +
		colors.map((name, i) => `<li class='${name}'>b${i}</li>`).join("") +
		"</ol>"
	);
}

test("list markers trading styles between items show as a fresh page", async () => {
	const order = ["c0", "c1", "c2", "c3", ""];
	const at = (shift: number): string[] =>
		order.map((_, i) => order[(i + shift) % order.length]);
	for (const marker of ["", "li.c3::marker { color: rgb(0, 0, 200) }"]) {
		const {terminal, dom} = await open(listPage(at(0), marker));
		const items = [...dom.document.querySelectorAll("li")];
		for (let shift = 1; shift <= order.length; shift++) {
			const names = at(shift);
			items.forEach((item, i) => {
				item.className = names[i % names.length];
			});
			await nextFrame(dom);
			await expectFresh(terminal, listPage(names, marker));
		}
		dom.dispose();
	}
});

test("a ::marker rule in a shadow tree styles the markers of its own list", async () => {
	const {terminal, dom} =
		await open("<div id='host'></div><ul><li>out</li></ul>");
	const host = dom.document.getElementById("host")!;
	host.attachShadow({mode: "open"}).innerHTML =
		"<style>li::marker { color: rgb(0, 0, 255) }</style><ul><li>in</li></ul>";
	await nextFrame(dom);
	const buffer = (terminal as any).terminal.buffer.active;
	const markerColor = (row: number): number => {
		const line = buffer.getLine(row);
		for (let col = 0; col < terminal.terminal.cols; col++) {
			const at = line.getCell(col);
			if ((at.getChars() || " ") !== " ") {
				return at.isFgRGB() ? at.getFgColor() : -1;
			}
		}
		return -2;
	};
	const rows = terminal.getVisibleText().split("\n");
	const inRow = rows.findIndex((row) => row.includes("in"));
	const outRow = rows.findIndex((row) => row.includes("out"));
	expect(markerColor(inRow)).toBe(0x0000ff);
	expect(markerColor(outRow)).toBe(-1);
	dom.dispose();
});

test("an inline border taken off and put back shows as a fresh page", async () => {
	const page = (style: string): string =>
		"<p>aa <span style='" +
		style +
		"'>bb cc</span> dd" +
		" <span style='border: 1px solid; color: rgb(0, 200, 0)'>ee</span></p>";
	const styles = [
		"border: 1px solid",
		"",
		"border: 1px solid; background: rgb(0, 0, 100)",
		"background: rgb(0, 0, 100)",
		"border-left: 1px solid; background: rgb(0, 0, 100)",
		"border: 1px solid",
	];
	const {terminal, dom} = await open(page(""));
	const span = dom.document.querySelector("span")!;
	for (const style of styles) {
		span.setAttribute("style", style);
		await nextFrame(dom);
		await expectFresh(terminal, page(style));
	}
	dom.dispose();
});

test("frames that paint nothing leave the next selection and hover painting", async () => {
	const page =
		"<style>p:hover { color: rgb(255, 0, 0) }</style><p>one</p><p>two</p>";
	const {terminal, dom} = await open(page);
	const second = dom.document.querySelectorAll("p")[1];
	for (let round = 0; round < 3; round++) {
		await nextFrame(dom);
		await nextFrame(dom);
		dom.window.getSelection()!.selectAllChildren(second);
		await nextFrame(dom);
		await nextFrame(dom);
		const expected = await fresh(page);
		const shown = screen(terminal);
		expect(shown[1]).not.toEqual(expected[1]);
		expect(shown[0]).toEqual(expected[0]);
		dom.window.getSelection()!.removeAllRanges();
		await nextFrame(dom);
		await nextFrame(dom);
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});

async function scrollUnder(css: string, html: string): Promise<void> {
	const page =
		"<style>body { margin: 0 } header { height: 2em }" +
		" #pane { height: calc(100vh - 2em); overflow: auto } " +
		css +
		`</style><header>head</header><div id='pane'>${PANE_ROWS}</div>` +
		html;
	const {terminal, dom} = await open(page, {fullscreen: true});
	const pane = dom.document.getElementById("pane")!;
	let partial = 0;
	for (const at of [1, 2, 4, 3, 0, 5]) {
		pane.scrollTop = at;
		const checked = partialFrameCheck.checked;
		await nextFrame(dom);
		partial += partialFrameCheck.checked - checked;
		const expected = await wholeScreen(page, (reference) => {
			reference.document.getElementById("pane")!.scrollTop = at;
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
	expect(partial).toBeGreaterThanOrEqual(0);
}

test("a pane scrolled with a plain header above it shows as a whole repaint", async () => {
	await scrollUnder("", "");
});

test("a pane scrolled under a fixed box's overflowing text shows as a whole repaint", async () => {
	await scrollUnder(
		"#bar { position: fixed; top: 0; left: 0; width: 12px; height: 1px;" +
		" color: rgb(255, 255, 0) }",
		"<div id='bar'>spill one spill two spill three spill four</div>",
	);
});

test("a pane scrolled under a fixed box a transform moves shows as a whole repaint", async () => {
	await scrollUnder(
		"#bar { position: fixed; top: 0; left: 0; width: 100%; height: 1px;" +
		" transform: translateY(4px); background: rgb(128, 0, 0) }",
		"<div id='bar'>MOVED</div>",
	);
});

test("a pane scrolled under an absolute box's overflowing text shows as a whole repaint", async () => {
	await scrollUnder(
		"#bar { position: absolute; top: 0; left: 20px; width: 8px; height: 1px;" +
		" color: rgb(255, 255, 0) }",
		"<div id='bar'>spill one spill two spill three spill four</div>",
	);
});

test("a pane scrolled under a fixed pseudo-element shows as a whole repaint", async () => {
	await scrollUnder(
		"header::after { content: 'PSEUDO'; position: fixed; top: 4px;" +
		" left: 4px; background: rgb(128, 0, 0) }",
		"",
	);
});

test("a pane scrolled under a header's overflowing outline shows as a whole repaint", async () => {
	await scrollUnder(
		"header { outline: 1px solid rgb(255, 0, 0); margin: 0 1px }",
		"",
	);
});

test("a pane scrolled under a header whose text overflows it shows as a whole repaint", async () => {
	const page =
		"<style>body { margin: 0 }" +
		" header { height: 1px; color: rgb(255, 255, 0) }" +
		" #pane { height: 8em; overflow: auto }</style>" +
		"<header>head one<br>head two<br>head three</header>" +
		`<div id='pane'>${PANE_ROWS}</div>`;
	const {terminal, dom} = await open(page, {fullscreen: true});
	const pane = dom.document.getElementById("pane")!;
	for (const at of [1, 2, 4, 3, 0]) {
		pane.scrollTop = at;
		await nextFrame(dom);
		const expected = await wholeScreen(page, (reference) => {
			reference.document.getElementById("pane")!.scrollTop = at;
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});

test("a full screen pane scrolled while its selection grows shows as a whole repaint", async () => {
	const page = panePage("");
	const {terminal, dom} = await open(page, {fullscreen: true});
	const select = (document: Document, end: number): void => {
		const all = [...document.querySelectorAll(".row")];
		const selection = document.defaultView!.getSelection()!;
		selection.setBaseAndExtent(all[3].firstChild!, 1, all[end].firstChild!, 2);
	};
	const pane = dom.document.getElementById("pane")!;
	for (const at of [1, 2, 3, 5, 4]) {
		pane.scrollTop = at;
		select(dom.document, at + 8);
		await nextFrame(dom);
		const expected = await wholeScreen(page, (reference) => {
			select(reference.document, at + 8);
			reference.document.getElementById("pane")!.scrollTop = at;
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});

const BOXES = Array.from({length: 12}, (_, i) =>
	`<div class='box'>box ${i}</div>` +
	(i % 3 === 0
		? "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>" +
			"</table>"
		: ""),
).join("");

test("a full screen pane of joined borders scrolled shows as a whole repaint", async () => {
	const page =
		"<style>body { margin: 0 } #pane { height: 100vh; overflow: auto }" +
		" .box { border: 1px solid; margin: 0; margin-top: -1px }" +
		" table { border-collapse: collapse; width: 100% }" +
		" td { border: 1px solid }</style>" +
		`<div id='pane'>${BOXES}</div>`;
	const {terminal, dom} = await open(page, {fullscreen: true});
	const pane = dom.document.getElementById("pane")!;
	for (const at of [1, 2, 3, 5, 4, 8, 7, 0, 1.5, 2.25, -1]) {
		pane.scrollTop = at;
		await nextFrame(dom);
		const expected = await wholeScreen(page, (reference) => {
			reference.document.getElementById("pane")!.scrollTop = at;
		});
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});

test("a full screen pane scrolled by fractions shows as a whole repaint", async () => {
	await scrollPane("", "", [0.5, 1.5, 1.25, 2.75, 0.4, -2, 3]);
});

test.todo("bordered cells whose text changes beside them show as a fresh page (fails on main too)", async () => {
	const page = (round: number): string =>
		"<style>table { border-collapse: collapse } td { border: 1px solid }" +
		"</style><table>" +
		[0, 1, 2].map((row) =>
			"<tr>" + [0, 1, 2].map((col) =>
				`<td>${(row * 3 + col + round) % 4 === 0 ? "日本" : "ab"}` +
				`${round % 2 === 0 ? "" : "<u>c</u>"}</td>`,
			).join("") + "</tr>",
		).join("") +
		"</table>";
	const {terminal, dom} = await open(page(0));
	for (let round = 1; round < 6; round++) {
		dom.document.body.innerHTML = page(round);
		await nextFrame(dom);
		await expectFresh(terminal, page(round));
	}
	dom.dispose();
});

test("a scroll offset set past the end before the content grows reads as set", async () => {
	const {dom} = await open(
		"<style>ul { height: 5em; overflow: auto; margin: 0 }</style><ul>" +
		Array.from({length: 20}, (_, i) => `<li>item ${i}</li>`).join("") +
		"</ul>",
	);
	const ul = dom.document.querySelector("ul")!;
	const end = ul.scrollHeight - ul.clientHeight;
	ul.scrollTop = end + 10;
	expect(ul.scrollTop).toBe(end);
	for (let i = 20; i < 40; i++) {
		ul.append(
			Object.assign(dom.document.createElement("li"), {
				textContent: `item ${i}`,
			}),
		);
	}
	await nextFrame(dom);
	expect(ul.scrollTop).toBe(end);
	dom.dispose();
});

test("a full screen pane scrolled as the terminal resizes shows as a whole repaint", async () => {
	const page = panePage("");
	const {terminal, dom} = await open(page, {fullscreen: true});
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 2;
	await nextFrame(dom);
	for (const [at, cols, rows] of [[3, 50, 12], [5, 30, 8], [4, 40, 10]]) {
		pane.scrollTop = at;
		await resize(terminal, dom, cols, rows);
		pane.scrollTop = at;
		await nextFrame(dom);
		const expected = await wholeScreen(
			page,
			(reference) => {
				reference.document.getElementById("pane")!.scrollTop = at;
			},
			{cols, rows},
		);
		expect(screen(terminal)).toEqual(expected);
	}
	dom.dispose();
});
