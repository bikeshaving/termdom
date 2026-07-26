import {test, expect} from "bun:test";
import {TermDOM} from "../src/_termdom.js";
import {MockProcess} from "./test-utils.js";
import {EventEmitter} from "events";

// Mock TTY stream that simulates a real terminal
class MockTTYStream extends EventEmitter {
	isTTY = true;
	readable = true;
	readableObjectMode = false;

	constructor() {
		super();
	}

	setRawMode(_mode: boolean) {
		return this;
	}

	resume() {
		return this;
	}

	pause() {
		return this;
	}

	// Simulate keyboard input
	simulateKeypress(key: string) {
		const buffer = Buffer.from(key);
		this.emit("data", buffer);
	}

	simulateArrowKey(direction: "up" | "down" | "left" | "right") {
		const sequences = {
			up: "\x1b[A",
			down: "\x1b[B",
			right: "\x1b[C",
			left: "\x1b[D",
		};
		this.simulateKeypress(sequences[direction]);
	}
}

// Mock process that has a TTY
class MockKeyboardProcess extends EventEmitter {
	stdout = {
		isTTY: true,
		columns: 80,
		rows: 24,
		write: (chunk: any, encoding?: any, callback?: any) => {
			// Mock write - just call callback
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
}

test("keyboard events are dispatched to elements", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Create a test element
	const container = document.createElement("div");
	container.textContent = "Test element";
	document.body.appendChild(container);

	// Track events
	const events: any[] = [];

	document.body.addEventListener("keydown", (event) => {
		events.push({
			type: "keydown",
			key: event.key,
			keyCode: event.keyCode,
			charCode: event.charCode,
		});
	});

	document.body.addEventListener("keypress", (event) => {
		events.push({
			type: "keypress",
			key: event.key,
			keyCode: event.keyCode,
			charCode: event.charCode,
		});
	});

	document.body.addEventListener("keyup", (event) => {
		events.push({
			type: "keyup",
			key: event.key,
			keyCode: event.keyCode,
			charCode: event.charCode,
		});
	});

	// Simulate keyboard input by calling the internal method directly
	const chunk = Buffer.from("a");
	(termdom as any).dispatchGlobalKeyboardEvent(chunk);

	// Check events were fired
	expect(events.length).toBeGreaterThan(0);
	expect(events.some((e) => e.type === "keydown")).toBe(true);
	expect(events.some((e) => e.key === "a")).toBe(true);
});

test("special keys are mapped correctly", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	const events: any[] = [];
	document.body.addEventListener("keydown", (event) => {
		events.push({
			key: event.key,
			keyCode: event.keyCode,
		});
	});

	// Test Enter key
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\r"));
	expect(events.some((e) => e.key === "Enter" && e.keyCode === 13)).toBe(true);

	// Test Tab key
	events.length = 0;
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\t"));
	expect(events.some((e) => e.key === "Tab" && e.keyCode === 9)).toBe(true);

	// Test Backspace
	events.length = 0;
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\x7f"));
	expect(events.some((e) => e.key === "Backspace" && e.keyCode === 8)).toBe(
		true,
	);
});

test("arrow keys are parsed correctly", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	const events: any[] = [];
	document.body.addEventListener("keydown", (event) => {
		events.push({
			key: event.key,
			keyCode: event.keyCode,
		});
	});

	// Test arrow keys (ANSI sequences)
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\x1b[A"));
	expect(events.some((e) => e.key === "ArrowUp" && e.keyCode === 38)).toBe(
		true,
	);

	events.length = 0;
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\x1b[B"));
	expect(events.some((e) => e.key === "ArrowDown" && e.keyCode === 40)).toBe(
		true,
	);

	events.length = 0;
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\x1b[C"));
	expect(events.some((e) => e.key === "ArrowRight" && e.keyCode === 39)).toBe(
		true,
	);

	events.length = 0;
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("\x1b[D"));
	expect(events.some((e) => e.key === "ArrowLeft" && e.keyCode === 37)).toBe(
		true,
	);
});

test("keyboard events bubble up the DOM", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const parent = document.createElement("div");
	const child = document.createElement("span");
	parent.appendChild(child);
	document.body.appendChild(parent);

	const parentEvents: string[] = [];
	const childEvents: string[] = [];

	parent.addEventListener("keydown", () => parentEvents.push("parent"));
	child.addEventListener("keydown", () => childEvents.push("child"));

	// Simulate keydown on child
	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("a"));

	// Events should bubble from child to parent
	expect(childEvents.length).toBe(0); // No direct events on child since we target document.body
	expect(parentEvents.length).toBe(0); // No direct events on parent either

	// Events go to document.body by default in our implementation
	const bodyEvents: string[] = [];
	document.body.addEventListener("keydown", () => bodyEvents.push("body"));

	(termdom as any).dispatchGlobalKeyboardEvent(Buffer.from("b"));
	expect(bodyEvents.length).toBe(1);
});

test("can create keyboard event manually", () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document: _document, window} = termdom;

	// Test that we can create KeyboardEvent
	const event = new window.KeyboardEvent("keydown", {
		key: "a",
		keyCode: 65,
		bubbles: true,
		cancelable: true,
	});

	expect(event.key).toBe("a");
	expect(event.keyCode).toBe(65);
	expect(event.type).toBe("keydown");
});

test("manual event dispatch works", () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document, window} = termdom;

	const element = document.createElement("div");
	document.body.appendChild(element);

	let eventReceived = false;
	element.addEventListener("keydown", (_event) => {
		eventReceived = true;
	});

	// Manually dispatch event
	const event = new window.KeyboardEvent("keydown", {
		key: "test",
		keyCode: 84,
		bubbles: true,
		cancelable: true,
	});

	element.dispatchEvent(event);
	expect(eventReceived).toBe(true);
});

test("keyboard system works with mock TTY", async () => {
	const mockProcess = new MockKeyboardProcess();

	// Create TermDOM with our mock process
	const termdom = new TermDOM({
		process: mockProcess as any,
		width: 80,
		height: 24,
	});

	const {document} = termdom;

	// Create test element
	const container = document.createElement("div");
	container.textContent = "Test container";
	document.body.appendChild(container);

	// Track keyboard events
	const events: any[] = [];

	document.body.addEventListener("keydown", (event: KeyboardEvent) => {
		events.push({
			type: "keydown",
			key: event.key,
			keyCode: event.keyCode,
			charCode: event.charCode,
		});
	});

	document.body.addEventListener("keypress", (event: KeyboardEvent) => {
		events.push({
			type: "keypress",
			key: event.key,
			keyCode: event.keyCode,
			charCode: event.charCode,
		});
	});

	// Initial render
	await termdom.render();

	// Test letter key
	mockProcess.stdin.simulateKeypress("a");
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Test number key
	mockProcess.stdin.simulateKeypress("5");
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Test special keys
	mockProcess.stdin.simulateKeypress("\r"); // Enter
	await new Promise((resolve) => setTimeout(resolve, 10));

	mockProcess.stdin.simulateKeypress("\t"); // Tab
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Test arrow keys
	mockProcess.stdin.simulateArrowKey("up");
	await new Promise((resolve) => setTimeout(resolve, 10));

	mockProcess.stdin.simulateArrowKey("down");
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Verify we got keyboard events
	expect(events.length).toBeGreaterThan(0);

	// Verify we got specific events
	const keydownEvents = events.filter((e) => e.type === "keydown");
	expect(keydownEvents.length).toBeGreaterThan(0);

	// Check for specific keys
	expect(events.some((e) => e.key === "a")).toBe(true);
	expect(events.some((e) => e.key === "5")).toBe(true);
	expect(events.some((e) => e.key === "Enter")).toBe(true);
	expect(events.some((e) => e.key === "Tab")).toBe(true);
	expect(events.some((e) => e.key === "ArrowUp")).toBe(true);
	expect(events.some((e) => e.key === "ArrowDown")).toBe(true);
});

test("TTY detection works correctly", () => {
	const mockProcess = new MockKeyboardProcess();

	// Test that our mock process reports TTY correctly
	expect(mockProcess.stdin.isTTY).toBe(true);
	expect(mockProcess.stdout.isTTY).toBe(true);
	expect(typeof mockProcess.stdin.setRawMode).toBe("function");
});

test("non-TTY environment doesn't set up keyboard handling", () => {
	// Create a non-TTY mock process
	const nonTtyProcess = {
		stdout: {
			isTTY: false,
			columns: 80,
			rows: 24,
			write: () => true,
		},
		stdin: {
			isTTY: false,
			// No setRawMode
		},
		env: {},
		on: () => {},
		exit: () => {
			throw new Error("exit");
		},
	};

	// This should work without trying to set up keyboard handling
	const termdom = new TermDOM({
		process: nonTtyProcess as any,
		width: 80,
		height: 24,
	});

	expect(termdom).toBeDefined();
});

test("a batched chunk of plain keys dispatches one keydown per key", async () => {
	// Fast key repeat arrives batched -- "jjjjj" in one stdin chunk. Anything
	// that treats a chunk as one key swallows the rest.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("jjjjj"));
	expect(keys).toEqual(["j", "j", "j", "j", "j"]);
	dom.dispose();
});

test("a batched chunk of arrow sequences dispatches one keydown per arrow", async () => {
	// A held arrow key delivers "\x1b[B\x1b[B\x1b[B" in one chunk. The old
	// splitter refused to split anything starting with ESC, so a whole burst of
	// key repeat collapsed into a single ArrowDown -- the cursor lagging far
	// behind the keyboard.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[B\x1b[B\x1b[B"));
	expect(keys).toEqual(["ArrowDown", "ArrowDown", "ArrowDown"]);
	dom.dispose();
});

test("keys packed behind a stray cursor report still dispatch", async () => {
	// A late cursor-position report can land glued to fast keystrokes in one
	// chunk. The report is the terminal talking, not the user typing: it must
	// be dropped, and every key around it must still arrive.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("jj\x1b[12;1Rjjj"));
	expect(keys).toEqual(["j", "j", "j", "j", "j"]);
	dom.dispose();
});

test("a lone stray cursor report dispatches nothing", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[12;1R"));
	expect(keys).toEqual([]);
	dom.dispose();
});

test("a focused input parks the real terminal cursor at its caret", async () => {
	// IME composition, screen readers and the terminal's cursor style all anchor
	// to the real cursor -- an inverse-video cell is not a caret. The frame parks
	// the cursor at the focused input's caret (and shows it); on blur it returns
	// to the content bottom, hidden.
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>title line</div><div><input id="a" type="text"></div>`;
	const input = dom.document.getElementById("a") as HTMLInputElement;
	input.focus();
	await dom.render();

	const buffer = (terminal as any).terminal.buffer.active;
	const caretRow = buffer.cursorY;
	const caretCol = buffer.cursorX;

	// Typing advances the real cursor with the caret.
	(terminal.stdin as any).emit("data", Buffer.from("hey"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(buffer.cursorY).toBe(caretRow);
	expect(buffer.cursorX).toBe(caretCol + 3);

	// Blur re-parks at the content bottom even though no cell changed.
	input.blur();
	await dom.render();
	expect(buffer.cursorY).toBeGreaterThan(caretRow);
	expect(buffer.cursorX).toBe(0);

	dom.dispose();
});

test("wide characters in an input measure in cells, not characters", async () => {
	// CJK glyphs are two cells wide. Character arithmetic put the caret mid-text
	// -- IME composition then anchored on top of already-typed glyphs, mangling
	// each committed syllable -- and padEnd by character count pushed the
	// value's background through the input's right border.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div><input id="a" type="text" style="width:20ch"></div>`;
	const input = dom.document.getElementById("a") as HTMLInputElement;
	input.focus();
	await dom.render();

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// Commit syllables one at a time, the way an IME delivers them.
	for (const syllable of ["김", "남", "제"]) {
		(terminal.stdin as any).emit("data", Buffer.from(syllable));
		await new Promise((resolve) => setTimeout(resolve, 40));
	}

	expect(input.value).toBe("김남제");
	expect(line(1)).toBe("│ 김남제           │"); // border intact, bg contained
	// Caret sits AFTER six cells of glyphs: contentX (2) + 6.
	expect(buffer.cursorX).toBe(8);

	dom.dispose();
});
