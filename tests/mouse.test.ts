import {expect, test} from "@b9g/libuild/test";

import {transportFromProcess} from "../src/internal/exchange.js";
import {TermDOM} from "../src/internal/termdom.js";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1002l";

/** Feed bytes as the terminal would, and wait for the read side to see them. */
function send(proc: MockProcess, data: string): Promise<void> {
	(proc.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeDocumentModeApp(lines = 30): {
	proc: MockProcess;
	written: () => string;
	chunks: () => string[];
	termdom: TermDOM;
	document: Document;
} {
	const proc = new MockProcess();
	const seen: string[] = [];
	const written = captureRawOutput(proc, {
		onChunk: (chunk) => seen.push(chunk),
	});
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	for (let i = 0; i < lines; i++) {
		const div = document.createElement("div");
		div.textContent = `line ${i}`;
		document.body.appendChild(div);
	}
	return {proc, written, chunks: () => seen, termdom, document};
}

test("an interactive app captures the mouse; dispose releases it", async () => {
	const {written, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);
	expect(written()).toContain(ENABLE);

	termdom.dispose();
	// Dispose's mode restores ride the transport's stream; let them flush.
	await new Promise((r) => setTimeout(r, 0));
	expect(written()).toContain(DISABLE);
});

test("wheel scrolls the document camera", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);

	await send(proc, "\x1b[<65;5;3M"); // wheel down at col 5, row 3
	expect(termdom.window.scrollY).toBe(3);

	await send(proc, "\x1b[<64;5;3M"); // wheel up
	expect(termdom.window.scrollY).toBe(0);
	termdom.dispose();
});

test("wheel dispatches a cancelable WheelEvent; preventDefault stops the camera", async () => {
	const {proc, termdom, document} = makeDocumentModeApp();
	await nextFrame(termdom);

	const seen: Array<{deltaY: number; deltaMode: number}> = [];
	// A wheel listener on the body is passive by default, as in a browser:
	// canceling the scroll takes the explicit opt-out.
	document.body.addEventListener(
		"wheel",
		(event: any) => {
			seen.push({deltaY: event.deltaY, deltaMode: event.deltaMode});
			event.preventDefault();
		},
		{passive: false},
	);

	await send(proc, "\x1b[<65;5;3M");
	expect(seen).toEqual([{deltaY: 3, deltaMode: 1}]);
	expect(termdom.window.scrollY).toBe(0); // canceled
	termdom.dispose();
});

test("mouse reports never leak into keyboard events", async () => {
	const {proc, termdom, document} = makeDocumentModeApp();
	await nextFrame(termdom);

	const keys: string[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		keys.push(event.key);
	});

	// A report glued to fast keystrokes: both keys arrive, the report does not.
	await send(proc, "j\x1b[<65;4;7Mj");
	expect(keys).toEqual(["j", "j"]);
	expect(termdom.window.scrollY).toBe(3);

	// Clicks and drag motion are swallowed too.
	await send(proc, "\x1b[<0;2;2M\x1b[<32;3;2M\x1b[<0;3;2m");
	expect(keys).toEqual(["j", "j"]);
	termdom.dispose();
});

test("wheel at the document top chains to the terminal; a keystroke reclaims", async () => {
	const {proc, chunks, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);

	const disables = () =>
		chunks().filter((chunk) => chunk.includes(DISABLE)).length;
	const enables = () =>
		chunks().filter((chunk) => chunk.includes(ENABLE)).length;
	expect(enables()).toBe(1);

	// Scrolled down, wheel up consumes normally -- no chaining mid-document.
	await send(proc, "\x1b[<65;5;3M");
	expect(termdom.window.scrollY).toBe(3);
	await send(proc, "\x1b[<64;5;3M");
	expect(termdom.window.scrollY).toBe(0);
	expect(disables()).toBe(0);

	// Wheel up AT the top: the scroll escapes to the terminal's scrollback,
	// so the mouse is handed back.
	await send(proc, "\x1b[<64;5;3M");
	expect(disables()).toBe(1);

	// A keystroke reclaims it.
	await send(proc, "j");
	expect(enables()).toBe(2);
	termdom.dispose();
});

test("a yielded wheel self-heals after the chain timeout, with no keystroke", async () => {
	const {proc, chunks, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);

	const disables = () =>
		chunks().filter((chunk) => chunk.includes(DISABLE)).length;
	const enables = () =>
		chunks().filter((chunk) => chunk.includes(ENABLE)).length;
	expect(enables()).toBe(1);

	// Wheel up at the top yields the mouse -- same as the keystroke-reclaim
	// test, but here nothing ever types a key. Real timeout, not a shortened
	// test-only one: wheel activity produces no signal while yielded (that's
	// the entire mechanism), so there's nothing to fake-clock advance against;
	// this exercises the actual production constant.
	await send(proc, "\x1b[<64;5;3M");
	expect(disables()).toBe(1);
	expect(enables()).toBe(1); // still yielded

	await new Promise((resolve) => setTimeout(resolve, 3200));
	expect(enables()).toBe(2); // self-healed without any keystroke

	// And scrolling actually works again -- not just the escape sequence.
	await send(proc, "\x1b[<65;5;3M"); // wheel down
	expect(termdom.window.scrollY).toBe(3);
	termdom.dispose();
});

test("preventDefault on wheel opts out of scroll chaining", async () => {
	const {proc, chunks, termdom, document} = makeDocumentModeApp();
	await nextFrame(termdom);

	document.body.addEventListener(
		"wheel",
		(event: any) => {
			event.preventDefault();
		},
		{passive: false},
	);

	await send(proc, "\x1b[<64;5;3M"); // wheel up at the top
	expect(chunks().filter((c) => c.includes(DISABLE)).length).toBe(0);
	termdom.dispose();
});

test("click dispatches at the element under the cell and focuses inputs", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;

	const input = document.createElement("input");
	input.style.width = "20ch";
	document.body.appendChild(input);
	const below = document.createElement("div");
	below.textContent = "not focusable";
	document.body.appendChild(below);
	await nextFrame(termdom);

	const events: Array<{type: string; target: string}> = [];
	for (const type of ["mousedown", "mouseup", "click"]) {
		document.addEventListener(type, (event: any) => {
			events.push({type, target: event.target.tagName});
		});
	}

	// Press and release on the input's first row.
	await send(proc, "\x1b[<0;2;1M");
	await send(proc, "\x1b[<0;2;1m");

	expect(events.map((e) => e.type)).toEqual(["mousedown", "mouseup", "click"]);
	expect(events.every((e) => e.target === "INPUT")).toBe(true);
	expect(document.activeElement).toBe(input);

	// Mousedown on nothing focusable blurs, as in a browser.
	await send(proc, "\x1b[<0;2;6M");
	await send(proc, "\x1b[<0;2;6m");
	expect(document.activeElement).not.toBe(input);
	termdom.dispose();
});

test("clicking a checkbox toggles it and fires change, and preventDefault blocks it", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	document.body.appendChild(checkbox);
	await nextFrame(termdom);

	const changes: boolean[] = [];
	checkbox.addEventListener("change", () => changes.push(checkbox.checked));

	const click = async () => {
		await send(proc, "\x1b[<0;1;1M");
		await send(proc, "\x1b[<0;1;1m");
	};

	await click();
	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);

	await click();
	expect(checkbox.checked).toBe(false);
	expect(changes).toEqual([true, false]);

	checkbox.addEventListener("click", (e: any) => e.preventDefault());
	await click();
	expect(checkbox.checked).toBe(false); // blocked, matching a real browser
	expect(changes).toEqual([true, false]);

	termdom.dispose();
});

test("clicking a label toggles its associated checkbox and moves focus to it", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.id = "cb";
	document.body.appendChild(checkbox);
	const label = document.createElement("label");
	label.setAttribute("for", "cb");
	label.textContent = "Mark all as complete";
	document.body.appendChild(label);
	await nextFrame(termdom);

	const changes: boolean[] = [];
	checkbox.addEventListener("change", () => changes.push(checkbox.checked));

	// The checkbox ([ ], an inline-block) and the label share row 1 as one
	// inline run: "[ ]Mark all as complete". Click inside the label's text,
	// past the checkbox's 3 cells.
	await send(proc, "\x1b[<0;5;1M");
	await send(proc, "\x1b[<0;5;1m");

	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);
	expect(document.activeElement).toBe(checkbox);

	termdom.dispose();
});

test("two quick clicks on the same target fire dblclick in addition to two clicks", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;

	const div = document.createElement("div");
	div.textContent = "clickable";
	document.body.appendChild(div);
	await nextFrame(termdom);

	const events: string[] = [];
	div.addEventListener("click", () => events.push("click"));
	div.addEventListener("dblclick", () => events.push("dblclick"));

	const click = async () => {
		await send(proc, "\x1b[<0;1;1M");
		await send(proc, "\x1b[<0;1;1m");
	};

	await click();
	await click();
	expect(events).toEqual(["click", "click", "dblclick"]);

	// The pair is consumed -- a third click starts a fresh one, not an
	// immediate second dblclick.
	await click();
	expect(events).toEqual(["click", "click", "dblclick", "click"]);
	await click();
	expect(events).toEqual([
		"click",
		"click",
		"dblclick",
		"click",
		"click",
		"dblclick",
	]);

	termdom.dispose();
});

test("a click long after the previous one does not fire dblclick", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;

	const div = document.createElement("div");
	div.textContent = "clickable";
	document.body.appendChild(div);
	await nextFrame(termdom);

	const events: string[] = [];
	div.addEventListener("click", () => events.push("click"));
	div.addEventListener("dblclick", () => events.push("dblclick"));

	const click = async () => {
		await send(proc, "\x1b[<0;1;1M");
		await send(proc, "\x1b[<0;1;1m");
	};

	await click();
	await new Promise((resolve) => setTimeout(resolve, 600)); // past the 500ms interval
	await click();
	expect(events).toEqual(["click", "click"]);

	termdom.dispose();
});

test("dragging across text builds a real Selection and paints inverse, without touching the clipboard", async () => {
	const proc = new MockProcess();
	const written = captureRawOutput(proc);
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document, window} = termdom;

	const line1 = document.createElement("div");
	line1.textContent = "hello world";
	const line2 = document.createElement("div");
	line2.textContent = "second line";
	document.body.append(line1, line2);
	await nextFrame(termdom);

	// Press at col 1 row 1 (before "h"), drag to col 6 (before "o" -- wait,
	// before index 5), release: selects "hello".
	await send(proc, "\x1b[<0;1;1M");
	await send(proc, "\x1b[<32;6;1M"); // motion with left button held
	await nextFrame(termdom);

	const selection = window.getSelection()!;
	expect(selection.isCollapsed).toBe(false);
	expect(selection.toString()).toBe("hello");
	// The highlight paints as inverse video (SGR 7).
	expect(written()).toMatch(/\x1b\[[\d;]*7m/);

	// Releasing a drag is only a selection: the clipboard is written by
	// navigator.clipboard.writeText() from the app's own release handler --
	// which is inside the release's dispatch, where the clipboard is
	// reachable -- and never as a side effect of the drag.
	expect(written()).not.toContain("\x1b]52;");
	let copied: Promise<void> | null = null;
	document.addEventListener("mouseup", () => {
		copied = window.navigator.clipboard.writeText(selection.toString());
	});
	await send(proc, "\x1b[<0;6;1m");
	await copied;
	const payload = Buffer.from("hello", "utf8").toString("base64");
	expect(written()).toContain(`\x1b]52;c;${payload}\x07`);

	termdom.dispose();
});

test("a backward drag selects, and spans nodes, with the anchor/focus handled by Selection", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document, window} = termdom;

	const line1 = document.createElement("div");
	line1.textContent = "hello world";
	const line2 = document.createElement("div");
	line2.textContent = "second line";
	document.body.append(line1, line2);
	await nextFrame(termdom);

	// Press mid-way through line 2, drag UP to mid line 1.
	await send(proc, "\x1b[<0;7;2M"); // before "d" of "second" (offset 6)
	await send(proc, "\x1b[<32;3;1M"); // up to before "l" of "hello" (offset 2)
	await nextFrame(termdom);

	const text = window.getSelection()!.toString();
	expect(text).toContain("llo world");
	expect(text).toContain("second");
	await send(proc, "\x1b[<0;3;1m");

	termdom.dispose();
});

test("a click collapses an existing selection", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document, window} = termdom;

	const div = document.createElement("div");
	div.textContent = "some isSelectable text";
	document.body.appendChild(div);
	await nextFrame(termdom);

	await send(proc, "\x1b[<0;1;1M");
	await send(proc, "\x1b[<32;10;1M");
	await send(proc, "\x1b[<0;10;1m");
	expect(window.getSelection()!.isCollapsed).toBe(false);

	// A fresh click elsewhere collapses it, as in a browser.
	await send(proc, "\x1b[<0;3;1M");
	await send(proc, "\x1b[<0;3;1m");
	expect(window.getSelection()!.isCollapsed).toBe(true);

	termdom.dispose();
});

test("a selecting drag released over a label does not activate it", async () => {
	// Activation after a selecting gesture would toggle the label's checkbox
	// -- and in a framework app the resulting re-render replaces the very
	// nodes the fresh selection points into, destroying it on the spot.
	// Browsers suppress the click; so do we.
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document, window} = termdom;

	const row = document.createElement("div");
	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.id = "cb";
	const label = document.createElement("label");
	label.setAttribute("for", "cb");
	label.textContent = "Mark all as complete";
	row.append(checkbox, label);
	document.body.appendChild(row);
	await nextFrame(termdom);

	const clicks: string[] = [];
	document.addEventListener("click", (e: any) => clicks.push(e.target.tagName));

	// Drag across the label text ("[ ]Mark all..." -- label starts col 4).
	await send(proc, "\x1b[<0;5;1M");
	await send(proc, "\x1b[<32;12;1M");
	await send(proc, "\x1b[<0;12;1m");

	expect(window.getSelection()!.toString()).toBe("ark all");
	expect(checkbox.checked).toBe(false); // NOT activated
	expect(clicks).toEqual([]); // no click synthesized from a selecting drag

	// A plain click on the label still activates as before.
	await send(proc, "\x1b[<0;5;1M");
	await send(proc, "\x1b[<0;5;1m");
	expect(checkbox.checked).toBe(true);

	termdom.dispose();
});

test("a click inside a widget's UA shadow content focuses the widget", async () => {
	// Hit-testing descends into composed content, so a click over an
	// input's value lands on a UA-internal span -- which has no
	// parentElement chain for closest() to climb. Per spec, hits retarget
	// to the shadow HOST from outside the tree: the click is on the input.
	const {proc, termdom} = makeDocumentModeApp();
	const {document} = termdom;
	document.body.innerHTML = "<div>row0</div><div><input id=\"i\" value=\"hello\"></div>";
	await nextFrame(termdom);

	expect(document.elementFromPoint(2, 1)?.id).toBe("i");
	await send(proc, "\x1b[<0;3;2M\x1b[<0;3;2m"); // click at col 3, row 2
	await nextFrame(termdom);
	expect(document.activeElement?.id).toBe("i");
	termdom.dispose();
});

test("wheel scrolling moves the screen with a scroll region, not a redraw", async () => {
	// What a mouse report changes names its elements, so a wheel scroll is as
	// bounded as a keyboard one and keeps the scroll transform: the terminal
	// is told to move its own rows, and only the exposed band is drawn.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = Array.from(
		{length: 200},
		(_, i) => `<div>row ${i}</div>`,
	).join("");
	await nextFrame(dom);

	const emitted = captureRawOutput(terminal);

	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<65;10;5M"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	// The region's margins are set, which only the transform path does.
	expect(emitted()).toMatch(/\x1b\[\d+;\d+r/);
	// And the document actually moved.
	expect(dom.window.scrollY).toBeGreaterThan(0);

	dom.dispose();
});

test("a mouse event answers in the standard coordinate spaces", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	document.body.innerHTML =
		"<div style=\"padding-top: 2px\"><button id=\"b\">[go]</button></div>";
	await nextFrame(termdom);

	const seen: Array<Record<string, number>> = [];
	document.addEventListener("mousedown", (event) => {
		const mouse = event as MouseEvent;
		seen.push({
			clientX: mouse.clientX,
			clientY: mouse.clientY,
			x: mouse.x,
			y: mouse.y,
			pageX: mouse.pageX,
			pageY: mouse.pageY,
			offsetY: mouse.offsetY,
			movementX: mouse.movementX,
		});
	});
	document.addEventListener("mousemove", (event) => {
		const mouse = event as MouseEvent;
		seen.push({movementX: mouse.movementX, movementY: mouse.movementY});
	});

	// Press at col 2, row 3 (1-based reports; the event is 0-based).
	await send(proc, "\x1b[<0;2;3M");
	// Motion to col 6, row 4: movement is the delta from the press.
	await send(proc, "\x1b[<32;6;4M");
	await send(proc, "\x1b[<0;6;4m");

	expect(seen[0].clientX).toBe(1);
	expect(seen[0].clientY).toBe(2);
	expect(seen[0].x).toBe(1);
	expect(seen[0].y).toBe(2);
	// No scroll: page equals client.
	expect(seen[0].pageX).toBe(1);
	expect(seen[0].pageY).toBe(2);
	// The button sits below 2px of padding; offsetY is target-relative.
	expect(seen[0].offsetY).toBe(0);
	expect(seen[0].movementX).toBe(0);
	expect(seen[1].movementX).toBe(4);
	expect(seen[1].movementY).toBe(1);

	termdom.dispose();
});
