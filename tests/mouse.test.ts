import {test, expect} from "bun:test";
import {TermDOM} from "../src/internal/termdom.js";
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

	send(data: string) {
		this.emit("data", Buffer.from(data));
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
	const termdom = new TermDOM({process: proc as any, detectCursor: false});
	termdom.setViewportMode("document");
	const {document} = termdom;
	for (let i = 0; i < lines; i++) {
		const div = document.createElement("div");
		div.textContent = `line ${i}`;
		document.body.appendChild(div);
	}
	return {proc, termdom, document};
}

test("document mode captures the mouse; flow mode leaves it native", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await termdom.render();
	expect(proc.written).toContain(ENABLE);

	termdom.dispose();
	expect(proc.written).toContain(DISABLE);

	const flowProc = new MockMouseProcess();
	const flow = new TermDOM({process: flowProc as any, detectCursor: false});
	const div = flow.document.createElement("div");
	div.textContent = "flow content";
	flow.document.body.appendChild(div);
	await flow.render();
	expect(flowProc.written).not.toContain(ENABLE);
	flow.dispose();
});

test("switching viewport mode toggles capture", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await termdom.render();
	expect(proc.written).toContain(ENABLE);
	expect(proc.written).not.toContain(DISABLE);

	termdom.setViewportMode("flow");
	expect(proc.written).toContain(DISABLE);
	termdom.dispose();
});

test("wheel scrolls the document camera", async () => {
	const {proc, termdom} = makeDocumentModeApp();
	await termdom.render();

	proc.stdin.send("\x1b[<65;5;3M"); // wheel down at col 5, row 3
	expect((termdom as any).documentScrollTop).toBe(3);

	proc.stdin.send("\x1b[<64;5;3M"); // wheel up
	expect((termdom as any).documentScrollTop).toBe(0);
	termdom.dispose();
});

test("wheel dispatches a cancelable WheelEvent; preventDefault stops the camera", async () => {
	const {proc, termdom, document} = makeDocumentModeApp();
	await termdom.render();

	const seen: Array<{deltaY: number; deltaMode: number}> = [];
	document.body.addEventListener("wheel", (event: any) => {
		seen.push({deltaY: event.deltaY, deltaMode: event.deltaMode});
		event.preventDefault();
	});

	proc.stdin.send("\x1b[<65;5;3M");
	expect(seen).toEqual([{deltaY: 3, deltaMode: 1}]);
	expect((termdom as any).documentScrollTop).toBe(0); // canceled
	termdom.dispose();
});

test("mouse reports never leak into keyboard events", async () => {
	const {proc, termdom, document} = makeDocumentModeApp();
	await termdom.render();

	const keys: string[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		keys.push(event.key);
	});

	// A report glued to fast keystrokes: both keys arrive, the report does not.
	proc.stdin.send("j\x1b[<65;4;7Mj");
	expect(keys).toEqual(["j", "j"]);
	expect((termdom as any).documentScrollTop).toBe(3);

	// Clicks and drag motion are swallowed too.
	proc.stdin.send("\x1b[<0;2;2M\x1b[<32;3;2M\x1b[<0;3;2m");
	expect(keys).toEqual(["j", "j"]);
	termdom.dispose();
});

test("click dispatches at the element under the cell and focuses inputs", async () => {
	const proc = new MockMouseProcess();
	const termdom = new TermDOM({process: proc as any, detectCursor: false});
	termdom.setViewportMode("document");
	const {document} = termdom;

	const input = document.createElement("input");
	input.style.width = "20ch";
	document.body.appendChild(input);
	const below = document.createElement("div");
	below.textContent = "not focusable";
	document.body.appendChild(below);
	await termdom.render();

	const events: Array<{type: string; target: string}> = [];
	for (const type of ["mousedown", "mouseup", "click"]) {
		document.addEventListener(type, (event: any) => {
			events.push({type, target: event.target.tagName});
		});
	}

	// Press and release on the input's first row.
	proc.stdin.send("\x1b[<0;2;1M");
	proc.stdin.send("\x1b[<0;2;1m");

	expect(events.map((e) => e.type)).toEqual(["mousedown", "mouseup", "click"]);
	expect(events.every((e) => e.target === "INPUT")).toBe(true);
	expect(document.activeElement).toBe(input);

	// Mousedown on nothing focusable blurs, as in a browser.
	proc.stdin.send("\x1b[<0;2;6M");
	proc.stdin.send("\x1b[<0;2;6m");
	expect(document.activeElement).not.toBe(input);
	termdom.dispose();
});
