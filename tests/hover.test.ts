import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {
	captureRawOutput,
	inputDispatched,
	MockProcess,
	nextFrame,
} from "./test-utils.js";

const MOTION_ON = "\x1b[?1003h";
const MOTION_OFF = "\x1b[?1003l";

function makeApp(options: {html?: string} = {}): {
	proc: MockProcess;
	written: () => string;
	termdom: TermDOM;
	document: Document;
} {
	const proc = new MockProcess();
	const written = captureRawOutput(proc);
	const termdom = new TermDOM({transport: proc.transport, html: options.html});
	return {proc, written, termdom, document: termdom.document};
}

/** An SGR buttonless-motion report at a 1-based column and row. */
function motion(col: number, row: number): string {
	return `\x1b[<35;${col};${row}M`;
}

/** Feed bytes as the terminal would, and wait for the read side to see them. */
function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return inputDispatched();
}

/** Wait until the session's write queue has carried `marker` to the wire. */
async function flushed(written: () => string, marker: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!written().includes(marker) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("no motion reporting for an app that never observes hover", async () => {
	const {written, termdom, document} = makeApp();
	const div = document.createElement("div");
	div.textContent = "plain";
	document.body.appendChild(div);
	await nextFrame(termdom);

	expect(written()).toContain("\x1b[?1002h");
	expect(written()).not.toContain(MOTION_ON);
	termdom.dispose();
});

test("a :hover rule turns motion reporting on; removing it turns it off", async () => {
	const {written, termdom, document} = makeApp();
	const div = document.createElement("div");
	div.textContent = "target";
	document.body.appendChild(div);
	await nextFrame(termdom);
	expect(written()).not.toContain(MOTION_ON);

	const style = document.createElement("style");
	style.textContent = "div:hover { color: red; }";
	document.head.appendChild(style);
	await nextFrame(termdom);
	expect(written()).toContain(MOTION_ON);
	expect(written()).not.toContain(MOTION_OFF);

	style.remove();
	await nextFrame(termdom);
	await flushed(written, MOTION_OFF);
	expect(written()).toContain(MOTION_OFF);
	termdom.dispose();
});

test("a hover-family listener turns motion reporting on; removal turns it off", async () => {
	const {written, termdom, document} = makeApp();
	const div = document.createElement("div");
	div.textContent = "target";
	document.body.appendChild(div);
	await nextFrame(termdom);
	expect(written()).not.toContain(MOTION_ON);

	const listener = () => {};
	document.addEventListener("mousemove", listener);
	await nextFrame(termdom);
	expect(written()).toContain(MOTION_ON);

	document.removeEventListener("mousemove", listener);
	await nextFrame(termdom);
	await flushed(written, MOTION_OFF);
	expect(written()).toContain(MOTION_OFF);
	// tmux drops every mouse mode on a ?1003 reset, so the button mode is
	// asserted again right after it.
	expect(written()).toContain(MOTION_OFF + "\x1b[?1002h\x1b[?1006h");
	termdom.dispose();
});

test("a window mouseover listener counts as observing hover", async () => {
	const {written, termdom} = makeApp();
	await nextFrame(termdom);
	expect(written()).not.toContain(MOTION_ON);

	const listener = () => {};
	(termdom.window as any).addEventListener("mouseover", listener);
	await nextFrame(termdom);
	await flushed(written, MOTION_ON);
	expect(written()).toContain(MOTION_ON);
	(termdom.window as any).removeEventListener("mouseover", listener);
	await nextFrame(termdom);
	await flushed(written, MOTION_OFF);
	expect(written()).toContain(MOTION_OFF);
	termdom.dispose();
});

test(":hover styles the element under the pointer and its ancestors", async () => {
	const {proc, termdom, document} = makeApp({
		html:
			"<style>" +
			"div:hover { color: rgb(255, 0, 0); }" +
			"section:hover { background-color: rgb(0, 0, 255); }" +
			"</style>" +
			"<section><div>first</div><div>second</div></section>",
	});
	await nextFrame(termdom);
	const [first, second] = Array.from(document.querySelectorAll("div"));
	const section = document.querySelector("section")!;

	await send(proc, motion(2, 1));
	await nextFrame(termdom);
	expect(first.matches(":hover")).toBe(true);
	expect(section.matches(":hover")).toBe(true);
	expect(second.matches(":hover")).toBe(false);
	const styles = termdom.window.getComputedStyle(first);
	expect(styles.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
	expect(
		termdom.window
			.getComputedStyle(section)
			.getPropertyValue("background-color"),
	).toBe("rgb(0, 0, 255)");

	await send(proc, motion(2, 2));
	await nextFrame(termdom);
	expect(first.matches(":hover")).toBe(false);
	expect(second.matches(":hover")).toBe(true);
	expect(termdom.window.getComputedStyle(first).getPropertyValue("color"))
		.toBe("rgb(0, 0, 0)");
	termdom.dispose();
});

test("boundary events fire in UI Events order with relatedTarget", async () => {
	const {proc, termdom, document} = makeApp({
		html: "<div id=parent><span id=a>aaaa</span><span id=b>bbbb</span></div>",
	});
	await nextFrame(termdom);
	const parent = document.getElementById("parent")!;
	const a = document.getElementById("a")!;
	const b = document.getElementById("b")!;

	const log: string[] = [];
	const related: Record<string, unknown> = {};
	for (const [
		element,
		name,
	] of [[parent, "parent"], [a, "a"], [b, "b"]] as const) {
		for (const type of [
			"mouseover",
			"mouseout",
			"mouseenter",
			"mouseleave",
			"mousemove",
		]) {
			// Filtered to the element's own events: mouseover and mouseout
			// bubble, and a bubbled arrival would double-log.
			element.addEventListener(type, (event: any) => {
				if (event.target !== element) {
					return;
				}
				log.push(`${type}:${name}`);
				related[`${type}:${name}`] = event.relatedTarget;
			});
		}
	}

	await send(proc, motion(2, 1)); // over "a"
	await nextFrame(termdom);
	expect(log).toEqual([
		"mouseover:a",
		"mouseenter:parent",
		"mouseenter:a",
		"mousemove:a",
	]);
	expect(related["mouseover:a"]).toBe(null);

	log.length = 0;
	await send(proc, motion(6, 1)); // over "b"
	await nextFrame(termdom);
	expect(log).toEqual([
		"mouseout:a",
		"mouseleave:a",
		"mouseover:b",
		"mouseenter:b",
		"mousemove:b",
	]);
	expect(related["mouseout:a"]).toBe(b);
	expect(related["mouseover:b"]).toBe(a);
	termdom.dispose();
});

test("mouseenter does not bubble; mouseover does", async () => {
	const {proc, termdom, document} =
		makeApp({html: "<div id=parent><span id=a>aaaa</span></div>"});
	await nextFrame(termdom);
	const parent = document.getElementById("parent")!;
	const a = document.getElementById("a")!;

	let parentEnter = 0;
	let parentOver = 0;
	parent.addEventListener("mouseenter", () => parentEnter++);
	parent.addEventListener("mouseover", () => parentOver++);

	await send(proc, motion(2, 1)); // onto the span
	await nextFrame(termdom);
	expect(a.matches(":hover")).toBe(true);
	// The parent's own enter, once; the span's over, bubbled up to it.
	expect(parentEnter).toBe(1);
	expect(parentOver).toBe(1);
	termdom.dispose();
});

test("removing the hovered element hovers what is under the pointer", async () => {
	const {proc, termdom, document} =
		makeApp({html: "<div>pppp<div id=a>aaaa</div></div>"});
	await nextFrame(termdom);
	const a = document.getElementById("a")!;
	await send(proc, motion(2, 2));
	await nextFrame(termdom);
	expect(a.matches(":hover")).toBe(true);

	const over: Array<[EventTarget | null, EventTarget | null]> = [];
	document.addEventListener("mouseover", (event: any) => {
		over.push([event.target, event.relatedTarget]);
	});
	let moves = 0;
	document.addEventListener("mousemove", () => moves++);
	a.remove();
	await nextFrame(termdom);
	expect(over).toEqual([[document.body, a]]);
	expect(moves).toBe(0);
	termdom.dispose();
});

test("motion reports coalesce into at most one hit-test per frame", async () => {
	const {proc, termdom, document} = makeApp();
	for (let i = 0; i < 5; i++) {
		const div = document.createElement("div");
		div.textContent = `line ${i}`;
		document.body.appendChild(div);
	}
	await nextFrame(termdom);

	const moves: number[] = [];
	document.addEventListener("mousemove", (event: any) => {
		moves.push(event.clientY);
	});

	// A held pointer sweep delivers a report per cell in one chunk; the
	// frame handles the last position, not one per report.
	await send(proc, motion(2, 1) + motion(2, 2) + motion(2, 3));
	await nextFrame(termdom);
	expect(moves.length).toBeLessThan(3);
	expect(moves[moves.length - 1]).toBe(2);
	termdom.dispose();
});

test("@media (hover) answers hover, unconditionally", async () => {
	const {termdom} = makeApp();
	await nextFrame(termdom);
	expect(termdom.window.matchMedia("(hover: hover)").matches).toBe(true);
	expect(termdom.window.matchMedia("(hover: none)").matches).toBe(false);
	expect(termdom.window.matchMedia("(hover)").matches).toBe(true);
	termdom.dispose();
});

test("@media (hover: none) rules never apply", async () => {
	const html =
		"<style>@media (hover: none) { div { color: rgb(1, 2, 3); } }</style>" +
		"<div>target</div>";
	const {termdom, document} = makeApp({html});
	await nextFrame(termdom);
	const div = document.querySelector("div")!;
	expect(termdom.window.getComputedStyle(div).getPropertyValue("color")).toBe(
		"rgb(0, 0, 0)",
	);
	termdom.dispose();
});

test("dispose turns motion reporting off", async () => {
	const {written, termdom} = makeApp({
		html: "<style>div:hover { color: red; }</style><div>target</div>",
	});
	await nextFrame(termdom);
	expect(written()).toContain(MOTION_ON);

	termdom.dispose();
	await flushed(written, MOTION_OFF);
	expect(written()).toContain(MOTION_OFF);
});

// A message list as a webmail lays it out: in a grid column, rows of
// flex lines whose sender and subject columns shrink. Each hover rule
// changes what the hovered row, the row under it or the row over it
// measures, and every box must land where a fresh render with the
// hovered row's styles puts it.
const MESSAGE_LIST = `
html, body { margin: 0; height: 100% }
.shell { display: grid; height: 100%; grid-template-columns: 70px 1.2fr 1fr }
.messages { display: flex; flex-direction: column; overflow: hidden;
	min-width: 0; min-height: 0 }
.scroller { flex: 1; min-height: 0; overflow-y: auto }
.msg { overflow: hidden }
.row { display: flex; align-items: center; gap: 12px; padding: 0 12px }
.from { width: 30%; min-width: 140px; max-width: 280px; flex-shrink: 0;
	display: flex }
.subject { flex: 1; min-width: 0; display: flex; gap: 4px; overflow: hidden }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.meta { display: flex; gap: 6px; flex-shrink: 0 }
.act { display: none }
`;

const MESSAGE_LIST_HOVERS: Record<string, string> = {
	background: ".msg:is(:hover, .hovered) { background: rgb(0, 0, 80) }",
	reveal: ".msg:is(:hover, .hovered) .act { display: inline }",
	below: ".msg:is(:hover, .hovered) + .msg .from { min-width: 200px }",
	above:
		".msg:has(+ :is(.msg:hover, .msg.hovered)) .from " +
		"{ width: 10%; min-width: 0 }" +
		".msg:has(+ :is(.msg:hover, .msg.hovered)) .act { display: inline }",
};

function messageList(hover: string): string {
	let rows = "";
	for (let i = 0; i < 40; i++) {
		rows +=
			`<article class=msg id=m${i}><div class=row>` +
			"<button>[ ]</button>" +
			`<div class=from><span class=truncate>Sender ${i} Name</span></div>` +
			"<div class=subject>" +
			`<span class=truncate>Subject of message ${i}</span>` +
			`<span class=truncate>preview text ${i}</span></div>` +
			"<div class=meta><button class=act>archive</button>" +
			`<span>Nov ${i}</span></div></div></article>`;
	}
	return (
		`<style>${MESSAGE_LIST}${hover}</style><div class=shell>` +
		"<nav>Inbox</nav><section class=messages><div class=scroller>" +
		`${rows}</div></section><div>reader</div></div>`
	);
}

function mountWide(): {proc: MockProcess; termdom: TermDOM} {
	const proc = new MockProcess({cols: 120, rows: 30});
	const termdom = new TermDOM({
		transport: proc.transport,
		cellSize: {width: 7, height: 15},
	});
	return {proc, termdom};
}

function boxes(document: Document): string[] {
	return Array.from(document.querySelectorAll("*"), (element, index) => {
		const r = element.getBoundingClientRect();
		return `${index} ${element.localName} ${r.x},${r.y} ${r.width}x${r.height}`;
	});
}

for (const [name, hover] of Object.entries(MESSAGE_LIST_HOVERS)) {
	test(`a message list lays out as fresh while the pointer crosses its rows: ${name}`, async () => {
		const html = messageList(hover);
		const {proc, termdom} = mountWide();
		const {document} = termdom;
		document.body.innerHTML = html;
		await nextFrame(termdom);
		for (const index of [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 3, 1, 5, 2]) {
			const box = document.getElementById(`m${index}`)!
				.getBoundingClientRect();
			await send(proc, motion(box.x / 7 + 3, box.y / 15 + 1));
			await nextFrame(termdom);
			expect(document.querySelector(".msg:hover")?.id).toBe(`m${index}`);

			const fresh = mountWide();
			fresh.termdom.document.body.innerHTML = html;
			fresh.termdom.document.getElementById(`m${index}`)!
				.classList.add("hovered");
			await nextFrame(fresh.termdom);
			expect(boxes(document)).toEqual(boxes(fresh.termdom.document));
			fresh.termdom.dispose();
		}
		termdom.dispose();
	});
}
