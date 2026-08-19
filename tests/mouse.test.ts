import {test, expect} from "@b9g/libuild/test";
import {TermDOM, transportFromProcess} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";
import {EventEmitter} from "events";

// A TTY-shaped process that records everything written to stdout, so tests
// can assert on the escape sequences that enable and disable mouse capture.
class MockTTYStream extends EventEmitter {
	isTTY = true;

	setRawMode(_mode: boolean) {
		return this;
	}

	resume() {
		return this;
	}

	pause() {
		return this;
	}

	send(data: string): Promise<void> {
		this.emit("data", Buffer.from(data));
		// Input rides the transport's readable: delivery is a microtask away.
		return new Promise((resolve) => setTimeout(resolve, 0));
	}
}

class MockMouseProcess extends EventEmitter {
	output: string[] = [];

	stdout = {
		isTTY: true,
		columns: 80,
		rows: 24,
		write: (chunk: any, encoding?: any, callback?: any): boolean => {
			this.output.push(String(chunk));
			if (typeof encoding === "function") {
				encoding();
			} else if (callback) {
				callback();
			}
			return true;
		},
	};

	stdin = new MockTTYStream();

	env = {
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};

	exit(_code?: number): never {
		throw new Error("Process exit");
	}

	get written(): string {
		return this.output.join("");
	}
}

const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1002l";

function makeDocumentModeApp(lines = 30) {
	const proc = new MockMouseProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;
	for (let i = 0; i < lines; i++) {
		const div = document.createElement("div");
		div.textContent = `line ${i}`;
		document.body.appendChild(div);
	}
	return {proc, termdom, document};
}

test("an interactive app captures the mouse; dispose releases it", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);
	expect(proc.written).toContain(ENABLE);

	termdom.dispose();
	// Dispose's mode restores ride the transport's stream; let them flush.
	await new Promise((r) => setTimeout(r, 0));
	expect(proc.written).toContain(DISABLE);
});

test("wheel scrolls the document camera", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);

	await proc.stdin.send("\x1b[<65;5;3M"); // wheel down at col 5, row 3
	expect(termdom.window.scrollY).toBe(3);

	await proc.stdin.send("\x1b[<64;5;3M"); // wheel up
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

	await proc.stdin.send("\x1b[<65;5;3M");
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
	await proc.stdin.send("j\x1b[<65;4;7Mj");
	expect(keys).toEqual(["j", "j"]);
	expect(termdom.window.scrollY).toBe(3);

	// Clicks and drag motion are swallowed too.
	await proc.stdin.send("\x1b[<0;2;2M\x1b[<32;3;2M\x1b[<0;3;2m");
	expect(keys).toEqual(["j", "j"]);
	termdom.dispose();
});

test("wheel at the document top chains to the terminal; a keystroke reclaims", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);

	const disables = () =>
		proc.output.filter((chunk) => chunk.includes(DISABLE)).length;
	const enables = () =>
		proc.output.filter((chunk) => chunk.includes(ENABLE)).length;
	expect(enables()).toBe(1);

	// Scrolled down, wheel up consumes normally -- no chaining mid-document.
	await proc.stdin.send("\x1b[<65;5;3M");
	expect(termdom.window.scrollY).toBe(3);
	await proc.stdin.send("\x1b[<64;5;3M");
	expect(termdom.window.scrollY).toBe(0);
	expect(disables()).toBe(0);

	// Wheel up AT the top: the scroll escapes to the terminal's scrollback,
	// so the mouse is handed back.
	await proc.stdin.send("\x1b[<64;5;3M");
	expect(disables()).toBe(1);

	// A keystroke reclaims it.
	await proc.stdin.send("j");
	expect(enables()).toBe(2);
	termdom.dispose();
});

test("a yielded wheel self-heals after the chain timeout, with no keystroke", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await nextFrame(termdom);

	const disables = () =>
		proc.output.filter((chunk) => chunk.includes(DISABLE)).length;
	const enables = () =>
		proc.output.filter((chunk) => chunk.includes(ENABLE)).length;
	expect(enables()).toBe(1);

	// Wheel up at the top yields the mouse -- same as the keystroke-reclaim
	// test, but here nothing ever types a key. Real timeout, not a shortened
	// test-only one: wheel activity produces no signal while yielded (that's
	// the entire mechanism), so there's nothing to fake-clock advance against;
	// this exercises the actual production constant.
	await proc.stdin.send("\x1b[<64;5;3M");
	expect(disables()).toBe(1);
	expect(enables()).toBe(1); // still yielded

	await new Promise((resolve) => setTimeout(resolve, 3200));
	expect(enables()).toBe(2); // self-healed without any keystroke

	// And scrolling actually works again -- not just the escape sequence.
	await proc.stdin.send("\x1b[<65;5;3M"); // wheel down
	expect(termdom.window.scrollY).toBe(3);
	termdom.dispose();
});

test("preventDefault on wheel opts out of scroll chaining", async () => {
	const {proc, termdom, document} = makeDocumentModeApp();
	await nextFrame(termdom);

	document.body.addEventListener(
		"wheel",
		(event: any) => {
			event.preventDefault();
		},
		{passive: false},
	);

	await proc.stdin.send("\x1b[<64;5;3M"); // wheel up at the top
	expect(proc.output.filter((c) => c.includes(DISABLE)).length).toBe(0);
	termdom.dispose();
});

test("click dispatches at the element under the cell and focuses inputs", async () => {
	const proc = new MockMouseProcess();
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
	await proc.stdin.send("\x1b[<0;2;1M");
	await proc.stdin.send("\x1b[<0;2;1m");

	expect(events.map((e) => e.type)).toEqual(["mousedown", "mouseup", "click"]);
	expect(events.every((e) => e.target === "INPUT")).toBe(true);
	expect(document.activeElement).toBe(input);

	// Mousedown on nothing focusable blurs, as in a browser.
	await proc.stdin.send("\x1b[<0;2;6M");
	await proc.stdin.send("\x1b[<0;2;6m");
	expect(document.activeElement).not.toBe(input);
	termdom.dispose();
});

test("clicking a checkbox toggles it and fires change, and preventDefault blocks it", async () => {
	const proc = new MockMouseProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document} = termdom;

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	document.body.appendChild(checkbox);
	await nextFrame(termdom);

	const changes: boolean[] = [];
	checkbox.addEventListener("change", () => changes.push(checkbox.checked));

	const click = async () => {
		await proc.stdin.send("\x1b[<0;1;1M");
		await proc.stdin.send("\x1b[<0;1;1m");
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
	const proc = new MockMouseProcess();
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
	await proc.stdin.send("\x1b[<0;5;1M");
	await proc.stdin.send("\x1b[<0;5;1m");

	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);
	expect(document.activeElement).toBe(checkbox);

	termdom.dispose();
});

test("two quick clicks on the same target fire dblclick in addition to two clicks", async () => {
	const proc = new MockMouseProcess();
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
		await proc.stdin.send("\x1b[<0;1;1M");
		await proc.stdin.send("\x1b[<0;1;1m");
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
	const proc = new MockMouseProcess();
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
		await proc.stdin.send("\x1b[<0;1;1M");
		await proc.stdin.send("\x1b[<0;1;1m");
	};

	await click();
	await new Promise((resolve) => setTimeout(resolve, 600)); // past the 500ms interval
	await click();
	expect(events).toEqual(["click", "click"]);

	termdom.dispose();
});

test("dragging across text builds a real Selection and paints inverse, without touching the clipboard", async () => {
	const proc = new MockMouseProcess();
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
	await proc.stdin.send("\x1b[<0;1;1M");
	await proc.stdin.send("\x1b[<32;6;1M"); // motion with left button held
	await nextFrame(termdom);

	const selection = window.getSelection()!;
	expect(selection.isCollapsed).toBe(false);
	expect(selection.toString()).toBe("hello");
	// The highlight paints as inverse video (SGR 7).
	expect(proc.written).toMatch(/\x1b\[[\d;]*7m/);

	// Releasing a drag is only a selection: the clipboard is written by
	// navigator.clipboard.writeText(), never as a side effect.
	await proc.stdin.send("\x1b[<0;6;1m");
	expect(proc.written).not.toContain("\x1b]52;");

	const payload = Buffer.from("hello", "utf8").toString("base64");
	await window.navigator.clipboard.writeText(selection.toString());
	expect(proc.written).toContain(`\x1b]52;c;${payload}\x07`);

	termdom.dispose();
});

test("a backward drag selects, and spans nodes, with the anchor/focus handled by Selection", async () => {
	const proc = new MockMouseProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document, window} = termdom;

	const line1 = document.createElement("div");
	line1.textContent = "hello world";
	const line2 = document.createElement("div");
	line2.textContent = "second line";
	document.body.append(line1, line2);
	await nextFrame(termdom);

	// Press mid-way through line 2, drag UP to mid line 1.
	await proc.stdin.send("\x1b[<0;7;2M"); // before "d" of "second" (offset 6)
	await proc.stdin.send("\x1b[<32;3;1M"); // up to before "l" of "hello" (offset 2)
	await nextFrame(termdom);

	const text = window.getSelection()!.toString();
	expect(text).toContain("llo world");
	expect(text).toContain("second");
	await proc.stdin.send("\x1b[<0;3;1m");

	termdom.dispose();
});

test("a click collapses an existing selection", async () => {
	const proc = new MockMouseProcess();
	const termdom = new TermDOM({transport: transportFromProcess(proc as any)});
	const {document, window} = termdom;

	const div = document.createElement("div");
	div.textContent = "some selectable text";
	document.body.appendChild(div);
	await nextFrame(termdom);

	await proc.stdin.send("\x1b[<0;1;1M");
	await proc.stdin.send("\x1b[<32;10;1M");
	await proc.stdin.send("\x1b[<0;10;1m");
	expect(window.getSelection()!.isCollapsed).toBe(false);

	// A fresh click elsewhere collapses it, as in a browser.
	await proc.stdin.send("\x1b[<0;3;1M");
	await proc.stdin.send("\x1b[<0;3;1m");
	expect(window.getSelection()!.isCollapsed).toBe(true);

	termdom.dispose();
});

test("a selecting drag released over a label does not activate it", async () => {
	// Activation after a selecting gesture would toggle the label's checkbox
	// -- and in a framework app the resulting re-render replaces the very
	// nodes the fresh selection points into, destroying it on the spot.
	// Browsers suppress the click; so do we.
	const proc = new MockMouseProcess();
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
	await proc.stdin.send("\x1b[<0;5;1M");
	await proc.stdin.send("\x1b[<32;12;1M");
	await proc.stdin.send("\x1b[<0;12;1m");

	expect(window.getSelection()!.toString()).toBe("ark all");
	expect(checkbox.checked).toBe(false); // NOT activated
	expect(clicks).toEqual([]); // no click synthesized from a selecting drag

	// A plain click on the label still activates as before.
	await proc.stdin.send("\x1b[<0;5;1M");
	await proc.stdin.send("\x1b[<0;5;1m");
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
	await proc.stdin.send("\x1b[<0;3;2M\x1b[<0;3;2m"); // click at col 3, row 2
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

	let emitted = "";
	const write = terminal.stdout.write.bind(terminal.stdout);
	(terminal.stdout as unknown as {write: unknown}).write = (
		chunk: unknown,
		enc?: unknown,
		cb?: unknown,
	) => {
		emitted += String(chunk);
		return (write as (...a: unknown[]) => unknown)(chunk, enc, cb);
	};

	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<65;10;5M"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	// The region's margins are set, which only the transform path does.
	expect(emitted).toMatch(/\x1b\[\d+;\d+r/);
	// And the document actually moved.
	expect(dom.window.scrollY).toBeGreaterThan(0);

	dom.dispose();
});
