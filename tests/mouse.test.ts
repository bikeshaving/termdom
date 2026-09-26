import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {transportFromProcess} from "../src/internal/exchange.ts";
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
	const written =
		captureRawOutput(proc, {onChunk: (chunk) => seen.push(chunk)});
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

test("a tall document keeps the wheel: its top is a stop", async () => {
	const {proc, chunks, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);
	const disables = () =>
		chunks().filter((chunk) => chunk.includes(DISABLE)).length;

	await send(proc, "\x1b[<65;5;3M");
	expect(termdom.window.scrollY).toBe(3);
	await send(proc, "\x1b[<64;5;3M");
	expect(termdom.window.scrollY).toBe(0);
	await send(proc, "\x1b[<64;5;3M");
	await send(proc, "\x1b[<64;5;3M");
	expect(termdom.window.scrollY).toBe(0);
	expect(disables()).toBe(0);
	expect(termdom.document.visibilityState).toBe("visible");
	termdom.dispose();
});

test("a document that fits hands the wheel to the terminal until a keystroke", async () => {
	const {proc, chunks, termdom, document} = makeDocumentModeApp(3);
	await nextFrame(termdom);

	const disables = () =>
		chunks().filter((chunk) => chunk.includes(DISABLE)).length;
	const enables = () =>
		chunks().filter((chunk) => chunk.includes(ENABLE)).length;
	const states: string[] = [];
	document.addEventListener("visibilitychange", () => {
		states.push(document.visibilityState);
	});
	expect(enables()).toBe(1);

	// The first wheel up escapes to the terminal's scrollback, so the
	// mouse is handed back and the document is hidden meanwhile.
	await send(proc, "\x1b[<64;5;3M");
	expect(disables()).toBe(1);
	expect(document.visibilityState).toBe("hidden");
	expect(states).toEqual(["hidden"]);

	// No timer takes it back: nothing says when the user scrolled down.
	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(enables()).toBe(1);

	// A keystroke does, before the key reaches the page.
	const order: string[] = [];
	document.addEventListener("keydown", () =>
		order.push(`keydown while ${document.visibilityState}`),
	);
	await send(proc, "j");
	expect(enables()).toBe(2);
	expect(order).toEqual(["keydown while visible"]);
	expect(states).toEqual(["hidden", "visible"]);
	termdom.dispose();
});

test("preventDefault on wheel opts out of the handoff", async () => {
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
	expect(document.visibilityState).toBe("visible");
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

test("mouse events carry the click count in detail", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	const div = document.createElement("div");
	div.textContent = "clickable";
	document.body.appendChild(div);
	await nextFrame(termdom);

	const seen: string[] = [];
	for (const type of [
		"mousedown",
		"mouseup",
		"click",
		"dblclick",
		"mousemove",
	]) {
		div.addEventListener(type, (e: any) => seen.push(`${type}:${e.detail}`));
	}
	const click = async () => {
		await send(proc, "\x1b[<0;1;1M");
		await send(proc, "\x1b[<0;1;1m");
	};

	await click();
	expect(seen).toEqual(["mousedown:1", "mouseup:1", "click:1"]);
	seen.length = 0;
	await click();
	expect(seen).toEqual(["mousedown:2", "mouseup:2", "click:2", "dblclick:2"]);
	seen.length = 0;
	await click();
	expect(seen).toEqual(["mousedown:3", "mouseup:3", "click:3"]);
	seen.length = 0;
	await send(proc, "\x1b[<35;2;1M");
	expect(seen).toEqual(["mousemove:0"]);
	seen.length = 0;

	await new Promise((resolve) => setTimeout(resolve, 600));
	await click();
	expect(seen).toEqual(["mousedown:1", "mouseup:1", "click:1"]);
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

test("a scrolled document reports the pointer in viewport coordinates", async () => {
	const {proc, termdom, document} = makeDocumentModeApp();
	await nextFrame(termdom);
	await send(proc, "\x1b[<65;5;3M");
	expect(termdom.window.scrollY).toBe(3);

	const seen: Array<{target: string; clientY: number; pageY: number}> = [];
	document.addEventListener("mousedown", (event) => {
		const mouse = event as MouseEvent;
		seen.push({
			target: (mouse.target as Element).textContent!,
			clientY: mouse.clientY,
			pageY: mouse.pageY,
		});
	});
	// Row 2 of the screen shows line 4 once three lines scroll away. Code
	// that finds the point in client rects, as CodeMirror does, has to see
	// the same row the box is drawn on.
	await send(proc, "\x1b[<0;2;2M");
	await send(proc, "\x1b[<0;2;2m");
	expect(seen).toEqual([{target: "line 4", clientY: 1, pageY: 4}]);
	const hit = document.elementFromPoint(1, seen[0].clientY)!;
	expect(hit.textContent).toBe("line 4");
	expect(hit.getBoundingClientRect().top).toBe(1);
	termdom.dispose();
});

test("fullscreen maps mouse rows from the screen's top, not the command's row", async () => {
	const terminal = new MockProcess({rows: 10, cols: 30});
	// Prior output puts the command's start, and so the document's anchor,
	// on row 4. The alternate screen starts at row 0 regardless.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("one\r\ntwo\r\nthree\r\nfour\r\n", () => resolve());
	});
	const termdom = new TermDOM({transport: terminal.sharedTransport});
	const {document} = termdom;
	document.body.innerHTML =
		"<div id=\"pane\" style=\"overflow-y:auto\">" +
		Array.from({length: 40}, (_, i) => `<div id="r${i}">row ${i}</div>`)
			.join("") +
		"</div>";
	await nextFrame(termdom);
	const pane = document.getElementById("pane")!;
	await pane.requestFullscreen();
	await nextFrame(termdom);

	const clicked: string[] = [];
	document.addEventListener("click", (event) => {
		clicked.push((event.target as Element).id);
	});
	// A click on the screen's second row lands on the second row's box.
	await send(terminal, "\x1b[<0;3;2M");
	await send(terminal, "\x1b[<0;3;2m");
	expect(clicked).toEqual(["r1"]);

	// A wheel tick on the first row scrolls the pane, and never the
	// document behind the alternate screen.
	await send(terminal, "\x1b[<65;3;1M");
	await nextFrame(termdom);
	expect(pane.scrollTop).toBe(3);
	expect(termdom.window.scrollY).toBe(0);
	// Past the pane's end the tick has nowhere to go.
	pane.scrollTop = 100;
	await nextFrame(termdom);
	const end = pane.scrollTop;
	await send(terminal, "\x1b[<65;3;5M");
	await nextFrame(termdom);
	expect(pane.scrollTop).toBe(end);
	expect(termdom.window.scrollY).toBe(0);
	termdom.dispose();
});

test("a click reaches a child that overflows its parent's box", async () => {
	// The parent is narrow and does not clip, so its child spills past it
	// to the right, as a fanned card does past its pile. The pointer
	// reaches the child there, as it does in a browser.
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	document.body.innerHTML =
		"<div id=\"pile\" style=\"width: 5ch\">" +
		"<div id=\"card\" style=\"width: 14ch; white-space: pre\">a fanned card</div>" +
		"</div>";
	await nextFrame(termdom);

	const targets: string[] = [];
	document.addEventListener("mousedown", (event: any) => {
		targets.push(event.target.id || event.target.tagName);
	});
	await send(proc, "\x1b[<0;12;1M");
	await send(proc, "\x1b[<0;12;1m");
	expect(targets).toEqual(["card"]);
	expect(document.elementFromPoint(11, 0)?.id).toBe("card");
	termdom.dispose();
});

test("a press and a release on different elements click their common ancestor", async () => {
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	document.body.innerHTML =
		"<div id=\"pile\"><div id=\"a\">aaaa</div><div id=\"b\">bbbb</div></div>";
	await nextFrame(termdom);

	const clicks: string[] = [];
	document.addEventListener("click", (event: any) =>
		clicks.push(event.target.id),
	);
	await send(proc, "\x1b[<0;1;1M");
	await send(proc, "\x1b[<0;1;2m");
	expect(clicks).toEqual(["pile"]);
	termdom.dispose();
});

test("a second press on the same cell is a double-click even if the element moved", async () => {
	// The first click moves the element down a row, as a focus step or a
	// layout change might. A browser counts the second press by where and
	// when it happened, and fires dblclick on what is under it then.
	const proc = new MockProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	document.body.innerHTML =
		// A flex column, so the margin that moves the child does not collapse
		// through the pile and move the pile with it.
		"<div id=\"pile\" style=\"display: flex; flex-direction: column; height: 4px\">" +
		"<div id=\"a\">aaaa</div><div id=\"b\">bbbb</div></div>";
	await nextFrame(termdom);
	const a = document.getElementById("a")!;
	const events: string[] = [];
	a.addEventListener("click", () => {
		events.push("click a");
		a.style.marginTop = "1px";
	});
	document.getElementById("pile")!.addEventListener(
		"dblclick",
		(event: any) => {
			events.push(`dblclick via ${event.target.id}`);
		},
	);
	await send(proc, "\x1b[<0;1;1M");
	await send(proc, "\x1b[<0;1;1m");
	await nextFrame(termdom);
	await send(proc, "\x1b[<0;1;1M");
	await send(proc, "\x1b[<0;1;1m");
	expect(events).toEqual(["click a", "dblclick via pile"]);
	termdom.dispose();
});
