import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {transportFromProcess} from "../src/internal/terminalsession.js";
import {MockProcess, nextFrame} from "./test-utils.js";
import {EventEmitter} from "events";

// Mock TTY stream that simulates a real terminal
class MockTTYStream extends EventEmitter {
	isTTY: boolean;
	readable: boolean;
	readableObjectMode: boolean;

	constructor() {
		super();
		this.isTTY = true;
		this.readable = true;
		this.readableObjectMode = false;
	}

	setRawMode(_mode: boolean): this {
		return this;
	}

	resume(): this {
		return this;
	}

	pause(): this {
		return this;
	}

	// Simulate keyboard input
	simulateKeypress(key: string): Promise<void> {
		const buffer = Buffer.from(key);
		this.emit("data", buffer);
		// Input rides the transport's readable: delivery is a microtask away.
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	simulateArrowKey(direction: "up" | "down" | "left" | "right"): Promise<void> {
		const sequences = {
			up: "\x1b[A",
			down: "\x1b[B",
			right: "\x1b[C",
			left: "\x1b[D",
		};
		return this.simulateKeypress(sequences[direction]);
	}
}

// Mock process that has a TTY
class MockKeyboardProcess extends EventEmitter {
	constructor(...args: ConstructorParameters<typeof EventEmitter>) {
		super(...args);
		this.stdin = new MockTTYStream();
		this.env = {
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		};
		this.stdout = {
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
	}

	stdout: {
		isTTY: boolean;
		columns: number;
		rows: number;
		write: (chunk: any, encoding?: any, callback?: any) => boolean;
	};

	stdin: MockTTYStream;

	env: {TERM: string; COLORTERM: string};

	exit(_code?: number): never {
		throw new Error("Process exit");
	}
}

test("keyboard events are dispatched to elements", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

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
	(terminal.stdin as any).emit("data", chunk);
	await new Promise((r) => setTimeout(r, 0));

	// Check events were fired
	expect(events.length).toBeGreaterThan(0);
	expect(events.some((e) => e.type === "keydown")).toBe(true);
	expect(events.some((e) => e.key === "a")).toBe(true);
});

test("special keys are mapped correctly", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

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
	(terminal.stdin as any).emit("data", Buffer.from("\r"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "Enter" && e.keyCode === 13)).toBe(true);

	// Test Tab key
	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "Tab" && e.keyCode === 9)).toBe(true);

	// Test Backspace
	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x7f"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "Backspace" && e.keyCode === 8)).toBe(
		true,
	);
});

test("Ctrl+letter decodes as the letter with ctrlKey, not a control character", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({
			key: event.key,
			keyCode: event.keyCode,
			ctrlKey: event.ctrlKey,
		});
	});

	// Ctrl+S = 0x13, Ctrl+A = 0x01, Ctrl+Z = 0x1A -- raw ASCII control bytes,
	// no escape sequence.
	(terminal.stdin as any).emit("data", Buffer.from([0x13]));
	await new Promise((r) => setTimeout(r, 0));
	(terminal.stdin as any).emit("data", Buffer.from([0x01]));
	await new Promise((r) => setTimeout(r, 0));
	(terminal.stdin as any).emit("data", Buffer.from([0x1a]));
	await new Promise((r) => setTimeout(r, 0));

	expect(events).toEqual([
		{key: "s", keyCode: 83, ctrlKey: true},
		{key: "a", keyCode: 65, ctrlKey: true},
		{key: "z", keyCode: 90, ctrlKey: true},
	]);
});

test("a plain letter never has ctrlKey set", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({key: event.key, ctrlKey: event.ctrlKey});
	});

	(terminal.stdin as any).emit("data", Buffer.from("s"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(events).toEqual([{key: "s", ctrlKey: false}]);
});

test("Enter and Tab stay their named keys, not Ctrl+M/Ctrl+I", async () => {
	// A raw terminal cannot distinguish the physical Enter/Tab keys from
	// Ctrl+M/Ctrl+I -- they are the identical byte (0x0D/0x0A and 0x09). The
	// named key has to win, matching every other terminal app.
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({key: event.key, ctrlKey: event.ctrlKey});
	});

	(terminal.stdin as any).emit("data", Buffer.from("\r"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events).toEqual([
		{key: "Enter", ctrlKey: false},
		{key: "Tab", ctrlKey: false},
	]);
});

test("Ctrl+letter in a focused input moves the caret, not inserts text", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	input.value = "hello";

	(terminal.stdin as any).emit("data", Buffer.from([0x01]));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0)); // Ctrl+A
	expect(input.value).toBe("hello"); // unchanged, not "helloa"
});

test("arrow keys are parsed correctly", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

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
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[A"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "ArrowUp" && e.keyCode === 38)).toBe(
		true,
	);

	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[B"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "ArrowDown" && e.keyCode === 40)).toBe(
		true,
	);

	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[C"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "ArrowRight" && e.keyCode === 39)).toBe(
		true,
	);

	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[D"));
	await new Promise((r) => setTimeout(r, 0));
	expect(events.some((e) => e.key === "ArrowLeft" && e.keyCode === 37)).toBe(
		true,
	);
});

test("modified arrow keys decode xterm's CSI 1;<mod> encoding", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({
			key: event.key,
			keyCode: event.keyCode,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
		});
	});

	const send = async (bytes: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(bytes));
		await new Promise((r) => setTimeout(r, 0));
	};

	await send("\x1b[1;3A"); // Alt+Up (mod 3 = 1 + 2)
	await send("\x1b[1;5B"); // Ctrl+Down (mod 5 = 1 + 4)
	await send("\x1b[1;2C"); // Shift+Right (mod 2 = 1 + 1)
	await send("\x1b[1;7D"); // Ctrl+Alt+Left (mod 7 = 1 + 2 + 4)

	expect(events).toEqual([
		{
			key: "ArrowUp",
			keyCode: 38,
			shiftKey: false,
			altKey: true,
			ctrlKey: false,
			metaKey: false,
		},
		{
			key: "ArrowDown",
			keyCode: 40,
			shiftKey: false,
			altKey: false,
			ctrlKey: true,
			metaKey: false,
		},
		{
			key: "ArrowRight",
			keyCode: 39,
			shiftKey: true,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
		},
		{
			key: "ArrowLeft",
			keyCode: 37,
			shiftKey: false,
			altKey: true,
			ctrlKey: true,
			metaKey: false,
		},
	]);
});

test("an unmodified arrow key has no modifiers set", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({
			key: event.key,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			ctrlKey: event.ctrlKey,
		});
	});

	(terminal.stdin as any).emit("data", Buffer.from("\x1b[A"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(events).toEqual([
		{key: "ArrowUp", shiftKey: false, altKey: false, ctrlKey: false},
	]);
});

test("keyboard events bubble up the DOM", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const parent = document.createElement("div");
	const child = document.createElement("span");
	parent.appendChild(child);
	document.body.appendChild(parent);

	const parentEvents: string[] = [];
	const childEvents: string[] = [];

	parent.addEventListener("keydown", () => parentEvents.push("parent"));
	child.addEventListener("keydown", () => childEvents.push("child"));

	// Simulate keydown on child
	(terminal.stdin as any).emit("data", Buffer.from("a"));
	await new Promise((r) => setTimeout(r, 0));

	// Events should bubble from child to parent
	expect(childEvents.length).toBe(0); // No direct events on child since we target document.body
	expect(parentEvents.length).toBe(0); // No direct events on parent either

	// Events go to document.body by default in our implementation
	const bodyEvents: string[] = [];
	document.body.addEventListener("keydown", () => bodyEvents.push("body"));

	(terminal.stdin as any).emit("data", Buffer.from("b"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(bodyEvents.length).toBe(1);
});

test("can create keyboard event manually", () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
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
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
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
		transport: transportFromProcess(mockProcess as any),
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
	await nextFrame(termdom);

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
	const nonTTYProcess = {
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
		transport: transportFromProcess(nonTTYProcess as any),
	});

	expect(termdom).toBeDefined();
});

test("a batched chunk of plain keys dispatches one keydown per key", async () => {
	// Fast key repeat arrives batched -- "jjjjj" in one stdin chunk. Anything
	// that treats a chunk as one key swallows the rest.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	await new Promise((r) => setTimeout(r, 0));
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("jjjjj"));
	await new Promise((r) => setTimeout(r, 0));
	expect(keys).toEqual(["j", "j", "j", "j", "j"]);
	dom.dispose();
});

test("a batched chunk of arrow sequences dispatches one keydown per arrow", async () => {
	// A held arrow key delivers "\x1b[B\x1b[B\x1b[B" in one chunk. The old
	// splitter refused to split anything starting with ESC, so a whole burst of
	// key repeat collapsed into a single ArrowDown -- the cursor lagging far
	// behind the keyboard.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	await new Promise((r) => setTimeout(r, 0));
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[B\x1b[B\x1b[B"));
	await new Promise((r) => setTimeout(r, 0));
	expect(keys).toEqual(["ArrowDown", "ArrowDown", "ArrowDown"]);
	dom.dispose();
});

test("keys packed behind a stray cursor report still dispatch", async () => {
	// A late cursor-position report can land glued to fast keystrokes in one
	// chunk. The report is the terminal talking, not the user typing: it must
	// be dropped, and every key around it must still arrive.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	await new Promise((r) => setTimeout(r, 0));
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("jj\x1b[12;1Rjjj"));
	await new Promise((r) => setTimeout(r, 0));
	expect(keys).toEqual(["j", "j", "j", "j", "j"]);
	dom.dispose();
});

test("a lone stray cursor report dispatches nothing", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach(); // stdin listeners live behind attach(), not the constructor
	await new Promise((r) => setTimeout(r, 0));
	const keys: string[] = [];
	dom.document.addEventListener("keydown", (e: Event) =>
		keys.push((e as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[12;1R"));
	await new Promise((r) => setTimeout(r, 0));
	expect(keys).toEqual([]);
	dom.dispose();
});

test("a focused empty input still shows its placeholder, caret at the field start", async () => {
	// Browsers show the placeholder in a focused empty input -- the caret
	// just sits at position 0 over the dimmed text, and the first keystroke
	// replaces it. This regressed invisibly for as long as autofocus was
	// unimplemented: no input ever STARTED focused, so the old
	// hide-on-focus condition never had a first paint to ruin.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<div><input id=\"a\" type=\"text\" placeholder=\"What needs doing?\" autofocus></div>";
	const input = dom.document.getElementById("a") as HTMLInputElement;
	await nextFrame(dom);

	expect(dom.document.activeElement).toBe(input); // autofocus took
	expect(terminal.getPlainText()).toContain("What needs doing?");
	const buffer = (terminal as any).terminal.buffer.active;
	expect(buffer.cursorX).toBe(0); // caret at the start, over the placeholder

	// Typing replaces the placeholder with the value.
	(terminal.stdin as any).emit("data", Buffer.from("x"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("What needs doing?");
	expect(terminal.getPlainText()).toContain("x");

	dom.dispose();
});

test("backspace works after a framework resets .value out from under the caret", async () => {
	// TodoMVC submits by assigning input.value = "" -- nothing notifies the
	// tracked caret, which stayed at the old length. Typing then pushed the
	// phantom caret further past the end, and Backspace's
	// slice(0, cursor-1) + slice(cursor) returned the value UNCHANGED for a
	// cursor beyond the end: a silent no-op per press until the stale caret
	// happened to walk back into range. Clamping the caret to the current
	// value at read fixes every edit key at once.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("12345678"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(input.value).toBe("12345678");

	input.value = ""; // the framework's submit reset
	(terminal.stdin as any).emit("data", Buffer.from("abc"));
	await new Promise((r) => setTimeout(r, 0));
	expect(input.value).toBe("abc");

	(terminal.stdin as any).emit("data", Buffer.from("\x7f"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0)); // Backspace
	expect(input.value).toBe("ab");

	dom.dispose();
});

test("deleting at the end of an overflowed input scrolls earlier text back into view", async () => {
	// With more text than the field holds, the window follows the caret
	// right. On backspace it used to stay put: the tail shrank inside the
	// window while the earlier characters sat hidden off the left edge. A
	// browser's field scrolls back to keep the field full -- the previous
	// letters reappear as you delete.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	input.style.width = "10ch";
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("abcdefghijklmno"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	// Window follows the caret: the last 9 chars + the caret cell.
	expect(terminal.getPlainText()).toContain("ghijklmno");

	for (let i = 0; i < 4; i++) {
		(terminal.stdin as any).emit("data", Buffer.from("\x7f"));
		await new Promise((r) => setTimeout(r, 0));
	}
	await nextFrame(dom);
	expect(input.value).toBe("abcdefghijk");
	// The window scrolled back to stay full: c..k visible, not a shrunken
	// "ghijk" tail with abcdef still hidden.
	expect(terminal.getPlainText()).toContain("cdefghijk");

	dom.dispose();
});

test("the input caret IS selectionStart/End -- visible to and drivable by the standard API", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	// Typing moves the standard selection, not a private shadow of it.
	(terminal.stdin as any).emit("data", Buffer.from("hello"));
	await new Promise((r) => setTimeout(r, 0));
	expect(input.selectionStart).toBe(5);
	expect(input.selectionEnd).toBe(5);

	// ArrowLeft is observable through the API too.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[D\x1b[D"));
	await new Promise((r) => setTimeout(r, 0));
	expect(input.selectionStart).toBe(3);

	// And the API drives the rendered caret: reposition programmatically,
	// the real terminal cursor parks there on the next frame.
	input.setSelectionRange(1, 1);
	await nextFrame(dom);
	const buffer = (terminal as any).terminal.buffer.active;
	expect(buffer.cursorX).toBe(1);

	// Typing lands at the API-set caret.
	(terminal.stdin as any).emit("data", Buffer.from("X"));
	await new Promise((r) => setTimeout(r, 0));
	expect(input.value).toBe("hXello");

	dom.dispose();
});

test("Shift+arrows extend a selection with the browser's anchor/focus model", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("abcdef"));
	await new Promise((r) => setTimeout(r, 0));

	// Shift+Left twice from the end: focus walks left, anchor stays.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2D\x1b[1;2D"));
	await new Promise((r) => setTimeout(r, 0));
	expect([input.selectionStart, input.selectionEnd]).toEqual([4, 6]);
	expect(input.selectionDirection).toBe("backward");

	// Shift+Right SHRINKS the backward selection instead of flipping it.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2C"));
	await new Promise((r) => setTimeout(r, 0));
	expect([input.selectionStart, input.selectionEnd]).toEqual([5, 6]);

	// A plain arrow collapses to the matching edge, not one past it.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[D"));
	await new Promise((r) => setTimeout(r, 0));
	expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);

	// Shift+Home selects back to the start; typing replaces the selection.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2H"));
	await new Promise((r) => setTimeout(r, 0));
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
	(terminal.stdin as any).emit("data", Buffer.from("Z"));
	await new Promise((r) => setTimeout(r, 0));
	expect(input.value).toBe("Zf");
	expect(input.selectionStart).toBe(1);

	dom.dispose();
});

test("a number field paints its selection exactly as a text field does", async () => {
	// selectionStart/End answer null on number/email/date per spec, but browsers
	// still highlight a selection in them -- the painter asks the field for the
	// range it renders, not for the API the author is gated out of.
	const inverseCells = async (type: string): Promise<string> => {
		const terminal = new MockProcess({rows: 6, cols: 40});
		const dom = new TermDOM({
			transport: transportFromProcess(terminal as any),
		});
		dom.attach();
		await new Promise((r) => setTimeout(r, 0));
		const input = dom.document.createElement("input");
		input.type = type;
		dom.document.body.appendChild(input);
		input.focus();
		await nextFrame(dom);
		(terminal.stdin as any).emit("data", Buffer.from("12345"));
		await new Promise((r) => setTimeout(r, 0));
		(terminal.stdin as any).emit(
			"data",
			Buffer.from("\x1b[1;2D\x1b[1;2D\x1b[1;2D"),
		);
		await new Promise((r) => setTimeout(r, 0));
		await nextFrame(dom);

		const buffer = (terminal as any).terminal.buffer.active;
		const marked: string[] = [];
		for (let row = 0; row < 6; row++) {
			const line = buffer.getLine(row);
			if (!line) {
				continue;
			}
			for (let col = 0; col < 40; col++) {
				const cell = line.getCell(col);
				if (cell?.isInverse()) {
					marked.push(`${row},${col}:${cell.getChars()}`);
				}
			}
		}
		dom.dispose();
		return marked.join(" ");
	};

	const text = await inverseCells("text");
	// Three characters selected, so three highlighted cells.
	expect(text.split(" ").filter(Boolean).length).toBe(3);
	expect(text).toContain("3");
	expect(await inverseCells("number")).toBe(text);
});

test("the readline chords move and cut, as a terminal user expects", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	const send = async (bytes: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(bytes));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	};

	await send("some text");
	// Ctrl+A is the beginning of the line, not a selection of everything.
	await send("\x01");
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0]);
	expect(input.value).toBe("some text");
	// Ctrl+E returns to the end; Ctrl+F and Ctrl+B step a character.
	await send("\x05");
	expect(input.selectionStart).toBe(9);
	await send("\x02");
	expect(input.selectionStart).toBe(8);
	await send("\x06");
	expect(input.selectionStart).toBe(9);
	// Ctrl+W cuts the word behind the caret, Ctrl+U everything before it.
	await send("\x17");
	expect(input.value).toBe("some ");
	await send("\x15");
	expect(input.value).toBe("");

	await send("abc");
	await send("\x01");
	// Ctrl+D deletes forward, Ctrl+K to the end of the line.
	await send("\x04");
	expect(input.value).toBe("bc");
	await send("\x0b");
	expect(input.value).toBe("");

	dom.dispose();
});

test("a selection paints as inverse video over the selected cells", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("abcdef"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(terminal.getScreenContents()).not.toMatch(/\x1b\[[\d;]*7m/);

	// Select "ef" and the frame carries SGR 7 (inverse) for those cells.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2D\x1b[1;2D"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toMatch(/\x1b\[[\d;]*7m/);

	dom.dispose();
});

test("a focused input parks the real terminal cursor at its caret", async () => {
	// IME composition, screen readers and the terminal's cursor style all anchor
	// to the real cursor -- an inverse-video cell is not a caret. The frame parks
	// the cursor at the focused input's caret (and shows it); on blur it returns
	// to the content bottom, hidden.
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	// The footer line keeps the content bottom below the input's row, so the
	// blur assertion can tell "re-parked at the bottom" apart from "never
	// moved" -- a flat one-row input at the end of the document would park
	// in place.
	dom.document.body.innerHTML = "<div>title line</div><div><input id=\"a\" type=\"text\"></div><div>footer line</div>";
	const input = dom.document.getElementById("a") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const caretRow = buffer.cursorY;
	const caretCol = buffer.cursorX;

	// Typing advances the real cursor with the caret.
	(terminal.stdin as any).emit("data", Buffer.from("hey"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(buffer.cursorY).toBe(caretRow);
	expect(buffer.cursorX).toBe(caretCol + 3);

	// Blur re-parks at the content bottom even though no cell changed.
	input.blur();
	await nextFrame(dom);
	expect(buffer.cursorY).toBeGreaterThan(caretRow);
	expect(buffer.cursorX).toBe(0);

	dom.dispose();
});

test("Space toggles a focused checkbox and fires change; other keys are no-ops", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	document.body.appendChild(checkbox);
	checkbox.focus();
	await nextFrame(dom);

	const changes: boolean[] = [];
	checkbox.addEventListener("change", () => changes.push(checkbox.checked));

	(terminal.stdin as any).emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);

	// Checkboxes don't accept typed text -- every key but the two that
	// activate is a no-op.
	(terminal.stdin as any).emit("data", Buffer.from("abc\x7f"));
	await new Promise((r) => setTimeout(r, 0));
	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);

	(terminal.stdin as any).emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(checkbox.checked).toBe(false);
	expect(changes).toEqual([true, false]);

	dom.dispose();
});

test("Enter activates a checkbox and a radio, as Space does", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;

	document.body.innerHTML =
		"<input type=\"checkbox\" id=\"box\">" +
		"<input type=\"radio\" id=\"dot\">";
	const checkbox = document.getElementById("box") as HTMLInputElement;
	const radio = document.getElementById("dot") as HTMLInputElement;
	const changes: string[] = [];
	checkbox.addEventListener("change", () =>
		changes.push(`box:${checkbox.checked}`),
	);
	radio.addEventListener("change", () => changes.push(`dot:${radio.checked}`));
	checkbox.focus();
	await nextFrame(dom);

	const press = async (data: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(data));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	};

	await press("\r");
	expect(checkbox.checked).toBe(true);
	await press("\r");
	expect(checkbox.checked).toBe(false);
	// The two keys reach the same activation, so they alternate on one control.
	await press(" ");
	expect(checkbox.checked).toBe(true);
	await press("\r");
	expect(checkbox.checked).toBe(false);

	radio.focus();
	await nextFrame(dom);
	await press("\r");
	expect(radio.checked).toBe(true);

	expect(changes).toEqual([
		"box:true",
		"box:false",
		"box:true",
		"box:false",
		"dot:true",
	]);

	dom.dispose();
});

test("a canceled click puts a checkbox's checkedness back, whichever key pressed it", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	document.body.appendChild(checkbox);
	// The click's default action is what toggles; canceling it reverts the
	// checkedness the pre-activation behavior had already flipped.
	checkbox.addEventListener("click", (event) => event.preventDefault());
	const changes: boolean[] = [];
	checkbox.addEventListener("change", () => changes.push(checkbox.checked));
	checkbox.focus();
	await nextFrame(dom);

	const press = async (data: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(data));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	};

	await press("\r");
	expect(checkbox.checked).toBe(false);
	await press(" ");
	expect(checkbox.checked).toBe(false);
	expect(changes).toEqual([]);

	dom.dispose();
});

test("radios render as ( )/(x); Space checks but never unchecks; groups are exclusive", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;

	const a = document.createElement("input");
	a.type = "radio";
	a.name = "choice";
	const b = document.createElement("input");
	b.type = "radio";
	b.name = "choice";
	const row = document.createElement("div");
	row.append(a, b);
	document.body.appendChild(row);
	a.focus();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("( )( )");

	// Space checks the focused radio...
	(terminal.stdin as any).emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(a.checked).toBe(true);
	expect(terminal.getPlainText()).toContain("(x)( )");

	// ...but never unchecks it (the browser default; only another group
	// member can take the check away).
	(terminal.stdin as any).emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));
	expect(a.checked).toBe(true);

	// Checking the sibling unchecks this one -- the DOM's own radio-group
	// exclusivity, surfaced through the same Space path.
	b.focus();
	(terminal.stdin as any).emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(b.checked).toBe(true);
	expect(a.checked).toBe(false);
	expect(terminal.getPlainText()).toContain("( )(x)");

	dom.dispose();
});

test("an autofocus element focuses itself as soon as it's connected, including nested", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;

	const input = document.createElement("input");
	input.setAttribute("autofocus", "");
	document.body.appendChild(input);
	await nextFrame(dom);
	expect(document.activeElement).toBe(input);

	// Also works via the JS property, and when buried in a subtree added in
	// one shot (not itself the direct addedNode).
	const wrapper = document.createElement("div");
	const nested = document.createElement("input");
	nested.autofocus = true;
	wrapper.appendChild(nested);
	document.body.appendChild(wrapper);
	await nextFrame(dom);
	expect(document.activeElement).toBe(nested);

	dom.dispose();
});

test("Escape, navigation, and function keys map to their named keys", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const events: Array<{key: string; keyCode: number}> = [];
	dom.document.addEventListener("keydown", (e: any) =>
		events.push({key: e.key, keyCode: e.keyCode}),
	);

	const send = async (bytes: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(bytes));
		await new Promise((r) => setTimeout(r, 0));
	};

	await send("\x1b");
	await send("\x1b[H");
	await send("\x1b[1~");
	await send("\x1b[F");
	await send("\x1b[4~");
	await send("\x1b[2~");
	await send("\x1b[3~");
	await send("\x1b[5~");
	await send("\x1b[6~");
	await send("\x1bOP");
	await send("\x1bOQ");
	await send("\x1bOR");
	await send("\x1bOS");
	await send("\x1b[15~");
	await send("\x1b[17~");
	await send("\x1b[18~");
	await send("\x1b[19~");
	await send("\x1b[20~");
	await send("\x1b[21~");
	await send("\x1b[23~");
	await send("\x1b[24~");

	expect(events).toEqual([
		{key: "Escape", keyCode: 27},
		{key: "Home", keyCode: 36},
		{key: "Home", keyCode: 36},
		{key: "End", keyCode: 35},
		{key: "End", keyCode: 35},
		{key: "Insert", keyCode: 45},
		{key: "Delete", keyCode: 46},
		{key: "PageUp", keyCode: 33},
		{key: "PageDown", keyCode: 34},
		{key: "F1", keyCode: 112},
		{key: "F2", keyCode: 113},
		{key: "F3", keyCode: 114},
		{key: "F4", keyCode: 115},
		{key: "F5", keyCode: 116},
		{key: "F6", keyCode: 117},
		{key: "F7", keyCode: 118},
		{key: "F8", keyCode: 119},
		{key: "F9", keyCode: 120},
		{key: "F10", keyCode: 121},
		{key: "F11", keyCode: 122},
		{key: "F12", keyCode: 123},
	]);
	dom.dispose();
});

test("KeyboardEvent.code reports the physical key, not a formula off .key", async () => {
	// code used to be `Key${key.toUpperCase()}` for every key, including named
	// ones -- Enter reported code "KeyENTER" instead of "Enter", ArrowUp
	// reported "KeyARROWUP" instead of "ArrowUp".
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));

	const codes: string[] = [];
	dom.document.addEventListener("keydown", (e: any) => codes.push(e.code));

	const send = async (bytes: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(bytes));
		await new Promise((r) => setTimeout(r, 0));
	};

	await send("\r"); // Enter
	await send("\x1b[A"); // ArrowUp
	await send("\x1b[5~"); // PageUp
	await send("a");
	await send("5");
	await send(" ");

	expect(codes).toEqual([
		"Enter",
		"ArrowUp",
		"PageUp",
		"KeyA",
		"Digit5",
		"Space",
	]);
	dom.dispose();
});

test("fullscreen routes keydown through the general pipeline: tokenization, mouse filtering, and modifiers all apply", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const container = document.createElement("div");
	document.body.appendChild(container);
	await container.requestFullscreen();

	const events: Array<{key: string; ctrlKey: boolean}> = [];
	container.addEventListener("keydown", (e: any) =>
		events.push({key: e.key, ctrlKey: e.ctrlKey}),
	);

	// A batched chunk with a stray mouse report glued in -- the old fullscreen
	// pipeline had no tokenizer and no mouse-report filter, so this would have
	// dispatched one garbage "keydown" for the whole chunk.
	(terminal.stdin as any).emit(
		"data",
		Buffer.from([
			0x01,
			..."j\x1b[<65;4;7Mj".split("").map((c) => c.charCodeAt(0)),
		]),
	);
	await new Promise((r) => setTimeout(r, 0));

	expect(events).toEqual([
		{key: "a", ctrlKey: true}, // Ctrl+A
		{key: "j", ctrlKey: false},
		{key: "j", ctrlKey: false},
	]);
	dom.dispose();
});

test("Escape is the app's key in fullscreen: dispatched, and the screen stays", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const container = document.createElement("div");
	document.body.appendChild(container);
	await container.requestFullscreen();
	expect(document.fullscreenElement).toBe(container);

	const escapeSeenByContainer: string[] = [];
	container.addEventListener("keydown", (e: any) =>
		escapeSeenByContainer.push(e.key),
	);

	(terminal.stdin as any).emit("data", Buffer.from("\x1b"));
	await new Promise((r) => setTimeout(r, 10));

	expect(escapeSeenByContainer).toEqual(["Escape"]);
	expect(document.fullscreenElement).toBe(container);

	await document.exitFullscreen();
	expect(document.fullscreenElement).toBe(null);
	dom.dispose();
});

test("Tab rests on nothing past the last focusable, and re-enters at the ends", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.body.innerHTML =
		"<input id=\"a\"><input id=\"b\">";
	const press = async (key: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(key));
		await new Promise((r) => setTimeout(r, 10));
	};

	// Forward: enter at the first, walk to the last, rest on nothing.
	await press("\t");
	expect(document.activeElement?.id).toBe("a");
	await press("\t");
	expect(document.activeElement?.id).toBe("b");
	await press("\t");
	expect(document.activeElement).toBe(document.body);
	await press("\t");
	expect(document.activeElement?.id).toBe("a");

	// Backward from nothing enters at the last; before the first, the
	// blurred stop again. A lone focusable element stays escapable.
	await press("\x1b[Z"); // Shift+Tab
	expect(document.activeElement).toBe(document.body);
	await press("\x1b[Z");
	expect(document.activeElement?.id).toBe("b");
	dom.dispose();
});

test("focusing a field inside a fullscreen element leaves the camera alone", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document, window} = dom;
	const container = document.createElement("div");
	const style = document.createElement("style");
	style.textContent = "input { margin-top: 5px; }";
	document.head.appendChild(style);
	const input = document.createElement("input");
	container.appendChild(input);
	document.body.appendChild(container);
	await container.requestFullscreen();

	// The fullscreen element left the flow, so body.scrollHeight measures
	// next to nothing; a reveal sized by it scrolled the camera by the
	// field's whole row and carried the caret off the screen.
	input.focus();
	(terminal.stdin as any).emit("data", Buffer.from("x"));
	await new Promise((r) => setTimeout(r, 10));
	expect(window.scrollY).toBe(0);
	dom.dispose();
});

async function numberInput(): Promise<{
	terminal: MockProcess;
	dom: TermDOM;
	input: HTMLInputElement;
	press: (data: string) => Promise<void>;
}> {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const input = dom.document.createElement("input") as HTMLInputElement;
	input.type = "number";
	dom.document.body.appendChild(input);
	input.focus();
	const press = async (data: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(data));
		await new Promise((r) => setTimeout(r, 10));
	};
	return {terminal, dom, input, press};
}

test("a number input's text stays a prefix of a valid float", async () => {
	const {dom, input, press} = await numberInput();

	// Letters and punctuation outside the grammar never land.
	await press("4a2!");
	expect(input.value).toBe("42");

	// The states a float passes through are all reachable...
	await press(".5e-1");
	expect(input.value).toBe("42.5e-1");

	// ...but a second decimal point or exponent is refused whole.
	await press(".");
	await press("e3");
	expect(input.value).toBe("42.5e-13");

	dom.dispose();
});

test("a number input's value reports nothing until the text is a number", async () => {
	const {dom, input, press} = await numberInput();

	// "-", "-4", "-4." -- the value gate opens exactly when the grammar does.
	await press("-");
	expect(input.value).toBe("");
	await press("4");
	expect(input.value).toBe("-4");
	await press(".");
	expect(input.value).toBe("");
	await press("2");
	expect(input.value).toBe("-4.2");

	// A deletion may strand the text outside the grammar -- Ctrl+A to the
	// start, Ctrl+D deleting the "-" leaves "4.2"; deleting again leaves
	// ".2", still a number; deleting once more strands "2"... clear with
	// Ctrl+E then Ctrl+U and the field takes text again.
	await press("\x01\x04");
	expect(input.value).toBe("4.2");
	await press("\x05\x15");
	expect(input.value).toBe("");
	await press("7");
	expect(input.value).toBe("7");

	dom.dispose();
});

test("arrows step a number input along its grid, inside min and max", async () => {
	const {dom, input, press} = await numberInput();
	input.setAttribute("min", "1");
	input.setAttribute("max", "6");
	input.setAttribute("step", "2");
	const events: string[] = [];
	input.addEventListener("input", () => events.push("input"));
	input.addEventListener("change", () => events.push("change"));

	// Up from empty lands on the grid's first point inside the range.
	await press("\x1b[A");
	expect(input.value).toBe("1");
	expect(events).toEqual(["input", "change"]);
	await press("\x1b[A");
	expect(input.value).toBe("3");
	await press("\x1b[A");
	expect(input.value).toBe("5");
	// The next point is past max, so the field stays and nothing fires.
	events.length = 0;
	await press("\x1b[A");
	expect(input.value).toBe("5");
	expect(events).toEqual([]);
	await press("\x1b[B");
	expect(input.value).toBe("3");

	dom.dispose();
});

test("a decimal step writes its grid without float dust", async () => {
	const {dom, input, press} = await numberInput();
	input.setAttribute("step", "0.1");
	await press("\x1b[A");
	await press("\x1b[A");
	await press("\x1b[A");
	expect(input.value).toBe("0.3");
	await press("\x1b[B");
	expect(input.value).toBe("0.2");
	dom.dispose();
});

test("valueAsNumber and the step methods", async () => {
	const {dom, input} = await numberInput();

	input.value = "1.5e1";
	expect(input.valueAsNumber).toBe(15);
	input.valueAsNumber = 42;
	expect(input.value).toBe("42");
	input.valueAsNumber = NaN;
	expect(input.value).toBe("");
	expect(() => {
		input.valueAsNumber = Infinity;
	}).toThrow(TypeError);

	// The methods step silently -- no input or change events.
	const events: string[] = [];
	input.addEventListener("input", () => events.push("input"));
	input.stepUp(3);
	expect(input.value).toBe("3");
	input.stepDown();
	expect(input.value).toBe("2");
	expect(events).toEqual([]);

	input.setAttribute("step", "any");
	expect(() => input.stepUp()).toThrow(/any/);

	const text = dom.document.createElement("input") as HTMLInputElement;
	expect(text.valueAsNumber).toBeNaN();
	expect(() => text.stepUp()).toThrow(/step/);

	dom.dispose();
});

test("a focused descendant inside a fullscreen element still wins over the element itself", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const container = document.createElement("div");
	const input = document.createElement("input");
	container.appendChild(input);
	document.body.appendChild(container);
	await container.requestFullscreen();
	input.focus();

	(terminal.stdin as any).emit("data", Buffer.from("x"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(input.value).toBe("x");
	dom.dispose();
});

test("with nothing focused, fullscreen keydown still lands on the fullscreen element", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const container = document.createElement("div");
	document.body.appendChild(container);
	await container.requestFullscreen();

	const keys: string[] = [];
	container.addEventListener("keydown", (e: any) => keys.push(e.key));

	(terminal.stdin as any).emit("data", Buffer.from("q"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	expect(keys).toEqual(["q"]);
	dom.dispose();
});

test("wide characters in an input measure in cells, not characters", async () => {
	// CJK glyphs are two cells wide. Character arithmetic put the caret mid-text
	// -- IME composition then anchored on top of already-typed glyphs, mangling
	// each committed syllable -- and padEnd by character count pushed the
	// value's cells past the field's 20-cell extent. The "|" right after the
	// input is the containment witness: it sits at cell 20 exactly when the
	// field occupies exactly 20 cells.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<div><input id=\"a\" type=\"text\" style=\"width:20ch\">|</div>";
	const input = dom.document.getElementById("a") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// Commit syllables one at a time, the way an IME delivers them.
	for (const syllable of ["김", "남", "제"]) {
		(terminal.stdin as any).emit("data", Buffer.from(syllable));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((resolve) => setTimeout(resolve, 40));
	}

	expect(input.value).toBe("김남제");
	// 3 glyphs = 6 cells, padded to the 20-cell field, marker at cell 20.
	expect(line(0)).toBe("김남제              |");
	// Caret sits AFTER six CELLS of glyphs, not three characters.
	expect(buffer.cursorX).toBe(6);

	dom.dispose();
});

test("the size attribute sets a text input's default width, as in a browser", async () => {
	// A browser sizes an unstyled input from size="..." (spec default 20) --
	// its width never comes from the containing block. CSS width still wins
	// over the attribute, as it does in a browser.
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<div><input id=\"a\" size=\"8\">|</div><div><input id=\"b\">|</div><div><input id=\"c\" size=\"8\" style=\"width: 12ch\">|</div>";
	await nextFrame(dom);

	const lines = terminal.getPlainText().split("\n");
	expect(lines[0].indexOf("|")).toBe(8); // size=8 -> 8 cells
	expect(lines[1].indexOf("|")).toBe(20); // spec default 20
	expect(lines[2].indexOf("|")).toBe(12); // CSS width beats the attribute

	dom.dispose();
});

test("width:100% on an input fills its container instead of collapsing", async () => {
	// The official TodoMVC stylesheet sizes its header input with width:100%.
	// getBoxModel only carries absolute widths, so the percentage used to
	// fall through to content sizing -- and a void input has no content:
	// zero cells, invisible. Percentages now resolve against the inline
	// run's available width.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<div><input style=\"width:100%\" placeholder=\"What needs to be done?\"></div><div><input style=\"width:50%\"></div>";
	await nextFrame(dom);

	const [full, half] = Array.from(dom.document.querySelectorAll("input"));
	expect(full.getBoundingClientRect().width).toBe(40);
	expect(half.getBoundingClientRect().width).toBe(20);
	// The full-width field no longer clips its 22-char placeholder.
	expect(terminal.getPlainText()).toContain("What needs to be done?");

	dom.dispose();
});

test(":focus rules apply on focus and revert on blur", async () => {
	// Selector matching is live (:focus follows activeElement), but
	// computed styles are cached per element and focus is not a mutation --
	// the cache held a rule set matched before the focus moved, so a :focus
	// rule never applied, and once focused would never have un-applied.
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	const {document, window} = dom;
	const style = document.createElement("style");
	style.textContent = "input:focus { background: #264f78; }";
	document.head.appendChild(style);
	const a = document.createElement("input");
	const b = document.createElement("input");
	document.body.append(a, b);
	await nextFrame(dom);

	const bg = (el: Element) =>
		window.getComputedStyle(el).getPropertyValue("background-color");
	expect(bg(a)).toBe("rgba(0, 0, 0, 0)");

	a.focus();
	expect(bg(a)).toBe("rgb(38, 79, 120)");
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toContain("48;2;38;79;120"); // painted

	// Focus moving to b un-applies on a and applies on b.
	b.focus();
	expect(bg(a)).toBe("rgba(0, 0, 0, 0)");
	expect(bg(b)).toBe("rgb(38, 79, 120)");

	b.blur();
	expect(bg(b)).toBe("rgba(0, 0, 0, 0)");

	dom.dispose();
});

test("a blurred field is plain; the focused field carries an underline across its extent", async () => {
	// The focus affordance is an `outline` the painter renders as a
	// box-model-aware underline: a blurred field is plain, and focusing draws
	// a solid underline across the WHOLE field -- the value AND the empty tail
	// past it, the fill a glyph-only text-decoration could never reach.
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	const {document} = dom;
	const a = document.createElement("input");
	a.value = "hi";
	const b = document.createElement("input");
	document.body.append(a, b);
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);

	// Blurred: plain, both the value and the blank tail past it.
	expect(cellAt(0, 0).isUnderline()).toBeFalsy();
	expect(cellAt(0, 5).isUnderline()).toBeFalsy();
	// The neighbouring empty field (input b, cols 20-39) is plain too.
	expect(cellAt(0, 25).isUnderline()).toBeFalsy();

	// Focused: a solid underline across the whole extent -- value and tail --
	// and not dim.
	a.focus();
	await nextFrame(dom);
	expect(cellAt(0, 0).isUnderline()).toBeTruthy();
	expect(cellAt(0, 0).isDim()).toBeFalsy();
	expect(cellAt(0, 5).isUnderline()).toBeTruthy();
	// The other field, still blurred, stays plain.
	expect(cellAt(0, 25).isUnderline()).toBeFalsy();

	dom.dispose();
});

test("author CSS text-decoration-style: double emits SGR 4 then 4:2", async () => {
	// The engine feature stands for authors targeting terminals they know
	// support styled underlines -- the UA defaults just never use it. Plain
	// 4 precedes 4:2 so a DIRECTLY connected non-supporting terminal keeps
	// the single underline (an intermediary like tmux may still collapse
	// the pair -- that is why it is opt-in).
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	const {document} = dom;
	let raw = "";
	const originalWrite = terminal.stdout.write.bind(terminal.stdout);
	(terminal.stdout as any).write = (chunk: any, enc?: any, cb?: any) => {
		raw += String(chunk);
		return originalWrite(chunk, enc, cb);
	};
	const span = document.createElement("span");
	span.textContent = "double";
	span.style.setProperty("text-decoration", "underline");
	span.style.setProperty("text-decoration-style", "double");
	document.body.appendChild(span);
	await nextFrame(dom);

	expect(raw).toMatch(/\x1b\[[\d;]*4;4:2[;m]/);

	dom.dispose();
});

test("display:none subtrees neither render, ghost, nor take tab focus", async () => {
	// A stylesheet arriving in the same batch as its markup used to leave
	// the hidden subtree's stale boxes ghost-painting at old coordinates,
	// and its controls silently swallowed Tab presses. Rules can change
	// layout, so a stylesheet refresh rebuilds from the root; tab order
	// includes only rendered elements, as in browsers.
	const terminal = new MockProcess({rows: 8, cols: 50});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.head.innerHTML = "<style>.editing .view { display: none } .view { display: flex; flex-direction: row }</style>";
	document.body.innerHTML =
		"<div>before</div>" +
		"<li class=\"editing\"><div class=\"view\"><input type=\"checkbox\"><label>todo</label><button>x</button></div><input class=\"edit\"></li>" +
		"<div>after</div>";
	await nextFrame(dom);

	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toBe("before"); // no ghost row above
	expect(terminal.getPlainText()).not.toContain("todo"); // hidden stays hidden

	(document.querySelector(".edit") as HTMLElement).focus();
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	// The hidden checkbox and button are not in tab order: past the edit
	// input -- the only rendered focusable -- Tab rests on nothing, and
	// another Tab re-enters at the edit input, never a hidden control.
	expect(document.activeElement).toBe(document.body);
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect((document.activeElement as HTMLElement).className).toBe("edit");

	dom.dispose();
});

test("a runtime class flip swaps a row for its editor, in place", async () => {
	// The TodoMVC edit cycle as Crank drives it: the li GAINS .editing
	// after mount. Descendant rules (.editing .view) must recompute for
	// the subtree, layout must rebuild for the display flip, and the
	// hidden container's descendants must not smuggle back into layout --
	// three separate bugs once lived in this one interaction.
	const terminal = new MockProcess({rows: 8, cols: 50});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.head.innerHTML = "<style>.editing .view { display: none } .view { display: flex; flex-direction: row; gap: 1ch }</style>";
	document.body.innerHTML =
		"<div>before</div>" +
		"<li id=\"item\"><div class=\"view\"><input type=\"checkbox\"><label>Finish TermDOM</label><button>x</button></div></li>" +
		"<div>after</div>";
	await nextFrame(dom);

	const li = document.getElementById("item")!;
	li.classList.add("editing");
	const edit = document.createElement("input");
	edit.className = "edit";
	edit.value = "Finish TermDOM";
	li.appendChild(edit);
	await nextFrame(dom);

	let rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toBe("before");
	expect(rows[1]).toContain("Finish TermDOM"); // the editor, on the todo row
	expect(rows[2]).toContain("after"); // and nothing ghosts between

	li.classList.remove("editing");
	li.removeChild(edit);
	await nextFrame(dom);
	rows = terminal.getPlainText().split("\n");
	expect(rows[1]).toContain("[ ] Finish TermDOM");
	expect(rows[2]).toContain("after");
	expect(rows.length).toBeLessThanOrEqual(4); // no stray rows below

	dom.dispose();
});

test("typing in a width:auto input never clips the lead character", async () => {
	// A shrink-wrapped field grows with its value, but the growth used to
	// land a frame late: the keystroke painted at the stale width, the
	// caret did not fit, and the scroll-window shoved the first character
	// off the field for one frame. The edit path now syncs the UA tree
	// before layout flushes, so the very first frame shows the full value.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<div><input style=\"width: auto\" value=\"abc\"></div>";
	await nextFrame(dom);
	const input = dom.document.querySelector("input") as HTMLInputElement;
	input.focus();
	input.setSelectionRange(3, 3);
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("d"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom); // the FIRST frame after the keystroke
	expect(terminal.getPlainText().split("\n")[0]).toContain("abcd");
	dom.dispose();
});

test("an empty width:auto input keeps a single caret cell", async () => {
	// With no value the field still reserves one cell (min-width) instead of
	// collapsing to zero width and vanishing from the row. Blurred it is plain;
	// focusing draws the outline underline over that single cell.
	const terminal = new MockProcess({rows: 4, cols: 30});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML =
		"<div style=\"display:flex; flex-direction:row; gap:1ch\">" +
		"<span>a:</span><input style=\"width: auto\"><span>z</span></div>";
	await nextFrame(dom);

	const line = () => (terminal as any).terminal.buffer.active.getLine(0);
	expect(line().translateToString(false).trimEnd()).toBe("a:   z");
	expect(line().getCell(3).isUnderline()).toBeFalsy(); // blurred: plain

	// Focused: the outline underlines the single reserved cell.
	const input = dom.document.querySelector("input") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);
	expect(line().getCell(3).isUnderline()).toBeTruthy();

	// Typing grows the field; deleting back to empty returns to the single
	// cell rather than zero width, and the outline still marks it.
	(terminal.stdin as any).emit("data", Buffer.from("hi"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(line().translateToString(false).trimEnd()).toBe("a: hi z");
	(terminal.stdin as any).emit("data", Buffer.from("\x7f\x7f"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(line().translateToString(false).trimEnd()).toBe("a:   z");
	expect(line().getCell(3).isUnderline()).toBeTruthy();
	dom.dispose();
});

test("non-mouse nav: a link underlines at rest and inverts on Tab focus", async () => {
	// The keyboard-nav affordances are per-type: a link is underlined so it
	// reads as a link (the monochrome-safe signal), so it can't use underline
	// for FOCUS too -- Tab focus inverts it instead, a distinct attribute.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<a href=\"/x\">link</a>";
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// At rest: underlined, not inverse.
	expect(cellAt(0, 0).isUnderline()).toBeTruthy();
	expect(cellAt(0, 0).isInverse()).toBeFalsy();

	// Tab moves focus to the link and inverts it.
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.document.activeElement?.tagName).toBe("A");
	expect(cellAt(0, 0).isInverse()).toBeTruthy();
	dom.dispose();
});

test("an author-colored link keeps its focus ring", async () => {
	// The UA ring is background-color: Highlight; the background alone
	// carries the inverse signal, so an author restyling the link's color
	// (every TodoMVC does) must not defeat it.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.head.innerHTML = "<style>.filters a { color: #777 }</style>";
	dom.document.body.innerHTML = "<input id=\"i\"><div class=\"filters\"><a href=\"#/\">All</a></div>";
	dom.document.getElementById("i")!.focus();
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.document.activeElement?.textContent).toBe("All");
	const cell = (terminal as any).terminal.buffer.active.getLine(1).getCell(0);
	expect(cell.isInverse()).toBeTruthy();
	dom.dispose();
});

test("non-mouse nav: a button takes the outline underline across its whole box on focus", async () => {
	// A button isn't underlined at rest (it wears [ ] brackets), so it uses the
	// same `outline` focus as a field -- and the merge op lines the WHOLE box,
	// brackets included, where an inverse FILL misses the ::before/::after.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<button>go</button>";
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	const line0 = () =>
		(terminal as any).terminal.buffer.active
			.getLine(0)
			.translateToString(false)
			.trimEnd();
	expect(line0()).toBe("[ go ]");
	// At rest: no underline on the bracket.
	expect(cellAt(0, 0).isUnderline()).toBeFalsy();

	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.document.activeElement?.tagName).toBe("BUTTON");
	// The whole box is underlined, the opening bracket and closing bracket too.
	expect(cellAt(0, 0).isUnderline()).toBeTruthy(); // "["
	expect(cellAt(0, 5).isUnderline()).toBeTruthy(); // "]"
	dom.dispose();
});

test("bracketed paste into an input strips newlines and never replays as keys", async () => {
	// A paste is ONE atomic insert, not a burst of keystrokes: a pasted newline
	// must not fire Enter (submit), a pasted 'q' must not trigger a shortcut, and
	// a single-line input drops the line breaks per HTML value sanitization.
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<input>";
	const input = dom.document.querySelector("input") as HTMLInputElement;
	let keydowns = 0;
	input.addEventListener("keydown", () => keydowns++);
	await nextFrame(dom);
	input.focus();
	await nextFrame(dom);

	(terminal.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from("\x1b[200~foo\nbar\r\nqbaz\x1b[201~"),
	);
	await nextFrame(dom);

	expect(input.value).toBe("foobarqbaz"); // newlines gone, one line
	expect(keydowns).toBe(0); // not replayed as keystrokes
	dom.dispose();
});

test("bracketed paste into a textarea keeps its newlines", async () => {
	// A terminal sends a pasted line break as CR, the byte Enter sends -- not
	// LF. The paste must reach the field with LF newlines regardless, or the
	// textarea inserts bare CRs that break no line and the paste renders as
	// one run-together row.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<textarea></textarea>";
	const ta = dom.document.querySelector("textarea") as HTMLTextAreaElement;
	await nextFrame(dom);
	ta.focus();
	await nextFrame(dom);

	(terminal.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from("\x1b[200~line one\rline two\r\nline three\x1b[201~"),
	);
	await nextFrame(dom);

	expect(ta.value).toBe("line one\nline two\nline three");
	dom.dispose();
});

test("non-mouse nav: the focus ring is keyboard-only (:focus-visible)", async () => {
	// A ring on Tab, none on a mouse press -- the :focus-visible behaviour,
	// driven off the last input modality since the platform gives no signal for
	// it. The link stays focused either way; only the ring differs.
	const terminal = new MockProcess({rows: 4, cols: 20});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<a href=\"/x\">link</a>";
	await nextFrame(dom);
	const inverse = () =>
		(terminal as any).terminal.buffer.active.getLine(0).getCell(0).isInverse();

	// Tab (keyboard) focuses the link WITH the ring.
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.document.activeElement?.tagName).toBe("A");
	expect(inverse()).toBeTruthy();

	// A mouse press keeps the link focused but drops the ring.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;1;1M"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.document.activeElement?.tagName).toBe("A");
	expect(inverse()).toBeFalsy();
	dom.dispose();
});

test("a click in a text input parks the caret at the pressed character", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<div><input value=\"hello world\"></div>";
	await nextFrame(dom);
	const input = dom.document.querySelector("input") as HTMLInputElement;

	// Column 7 (1-based) is the second 'o' region: offset 6.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;7;1M\x1b[<0;7;1m"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.document.activeElement).toBe(input);
	expect(input.selectionStart).toBe(6);
	expect(input.selectionEnd).toBe(6);
	dom.dispose();
});

test("a drag inside an input selects within the field, bounded to its value", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<div><input value=\"hello world\"></div>";
	await nextFrame(dom);
	const input = dom.document.querySelector("input") as HTMLInputElement;

	// Press at col 2 (offset 1), drag far past the value's end, release:
	// the selection clamps to the value -- the field's own world, not the
	// document selection.
	(terminal.stdin as any).emit(
		"data",
		Buffer.from("\x1b[<0;2;1M\x1b[<32;30;1M\x1b[<0;30;1m"),
	);
	await nextFrame(dom);
	expect(input.selectionStart).toBe(1);
	expect(input.selectionEnd).toBe(11);
	expect(input.selectionDirection).toBe("forward");
	expect(dom.window.getSelection()?.isCollapsed ?? true).toBe(true);

	// A backward drag flips direction, per the anchor/focus model.
	(terminal.stdin as any).emit(
		"data",
		Buffer.from("\x1b[<0;7;1M\x1b[<32;3;1M\x1b[<0;3;1m"),
	);
	await nextFrame(dom);
	expect(input.selectionStart).toBe(2);
	expect(input.selectionEnd).toBe(6);
	expect(input.selectionDirection).toBe("backward");
	dom.dispose();
});

test("clicking into a field clears the document selection's highlight", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<div id=\"p\">page text here</div><div><input value=\"hello\"></div>";
	await nextFrame(dom);

	// Select the page text by drag, then press inside the input: the
	// document selection collapses away; the field's world takes over.
	(terminal.stdin as any).emit(
		"data",
		Buffer.from("\x1b[<0;1;1M\x1b[<32;9;1M\x1b[<0;9;1m"),
	);
	await nextFrame(dom);
	expect(dom.window.getSelection()?.toString()).toBe("page tex");

	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;3;2M\x1b[<0;3;2m"));
	await new Promise((r) => setTimeout(r, 0));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(dom.window.getSelection()?.isCollapsed ?? true).toBe(true);
	const input = dom.document.querySelector("input") as HTMLInputElement;
	expect(dom.document.activeElement).toBe(input);
	// And getSelection never exposes the field's own selection, per spec.
	input.setSelectionRange(0, 5);
	await nextFrame(dom);
	expect(dom.window.getSelection()?.toString() ?? "").toBe("");
	dom.dispose();
});

test("an input preceded by text in its run positions on its own row", async () => {
	// The most ordinary form markup there is: label text and the input in
	// ONE inline run. A run member owns no layout node, and its rect
	// fallback returned run-relative coordinates as document ones -- every
	// such input painted at row 0, over whatever lived there.
	const terminal = new MockProcess({rows: 6, cols: 50});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML =
		"<div>Name: <input value=\"Ada\"></div>" +
		"<div>Email: <input placeholder=\"you@example.com\"></div>";
	await nextFrame(dom);

	const lines = terminal.getPlainText().split("\n");
	expect(lines[0]).toContain("Name: Ada");
	expect(lines[1]).toContain("Email: you@example.com");
	expect(lines[0]).not.toContain("you@example.com");

	const inputs = dom.document.querySelectorAll("input");
	expect(inputs[1].getBoundingClientRect().y).toBe(1);
	dom.dispose();
});

test("a focused button activates on Enter and on Space", async () => {
	// A button that takes focus and paints :focus while doing nothing is
	// advertising an affordance it does not have. HTML gives buttons an
	// activation behavior on both keys; input[type=submit|button] is a button
	// too, and was previously excluded from every keyboard path.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.body.innerHTML = `
		<button id="btn">Clear completed</button>
		<input type="submit" id="submit" value="Save">`;
	await nextFrame(dom);

	const seen: string[] = [];
	document.getElementById("btn")!.addEventListener("click", () => {
		seen.push("btn");
	});
	document.getElementById("submit")!.addEventListener("click", (ev) => {
		// No form to submit to; submission would try to navigate.
		ev.preventDefault();
		seen.push("submit");
	});

	(document.getElementById("btn") as HTMLElement).focus();
	terminal.stdin.emit("data", Buffer.from("\r"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	terminal.stdin.emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	(document.getElementById("submit") as HTMLElement).focus();
	terminal.stdin.emit("data", Buffer.from("\r"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	terminal.stdin.emit("data", Buffer.from(" "));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	expect(seen).toEqual(["btn", "btn", "submit", "submit"]);
	dom.dispose();
});

test("a keydown listener can cancel a button's activation", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.body.innerHTML = "<button id=\"btn\">Go</button>";
	await nextFrame(dom);

	let clicks = 0;
	const button = document.getElementById("btn") as HTMLElement;
	button.addEventListener("click", () => clicks++);
	button.addEventListener("keydown", (ev) => ev.preventDefault());
	button.focus();

	terminal.stdin.emit("data", Buffer.from("\r"));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	expect(clicks).toBe(0);
	dom.dispose();
});

test("links are focusable, and activate on Enter but not Space", async () => {
	// An <a> WITH an href is sequentially focusable per HTML; one without is
	// not. Space scrolls rather than following the link, so a link is not
	// simply a button.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.body.innerHTML = `
		<input id="text">
		<a href="#/" id="all">All</a>
		<a id="nohref">Not a link</a>
		<a href="#/active" id="active">Active</a>`;
	await nextFrame(dom);

	// Tab order includes both hrefs, in document order, and skips the anchor
	// with no href. Past the last, the blurred stop, then the cycle again.
	const order: string[] = [];
	(document.getElementById("text") as HTMLElement).focus();
	for (let i = 0; i < 4; i++) {
		terminal.stdin.emit("data", Buffer.from("\t"));
		await new Promise((r) => setTimeout(r, 0));
		await nextFrame(dom);
		order.push(document.activeElement?.id ?? "");
	}
	expect(order).toEqual(["all", "active", "", "text"]);

	let clicks = 0;
	const all = document.getElementById("all") as HTMLElement;
	all.addEventListener("click", (ev) => {
		ev.preventDefault();
		clicks++;
	});
	all.focus();

	terminal.stdin.emit("data", Buffer.from("\r"));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(clicks).toBe(1);

	terminal.stdin.emit("data", Buffer.from(" "));

	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(clicks).toBe(1);

	dom.dispose();
});

test("caret motion and deletion move by grapheme, not code unit", async () => {
	// selectionStart/End stay code-unit indices (the DOM API), but a single
	// Backspace/Delete/arrow must step over a whole grapheme -- an emoji is a
	// surrogate pair, a family emoji a ZWJ join, an accented letter a base plus
	// a combining mark. Editing by code unit corrupts all three.
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();

	const type = async (seq: string) => {
		(terminal.stdin as any).emit("data", Buffer.from(seq));
		await new Promise((r) => setTimeout(r, 0));
	};
	const BS = "\x7f";
	const DEL = "\x1b[3~";
	const LEFT = "\x1b[D";
	const RIGHT = "\x1b[C";

	// Backspace deletes a whole emoji (surrogate pair), not half of it.
	input.value = "ab\u{1F600}"; // "ab😀"
	input.setSelectionRange(input.value.length, input.value.length);
	await type(BS);
	expect(input.value).toBe("ab");
	expect(input.selectionStart).toBe(2);

	// Backspace deletes a whole ZWJ family emoji as one unit.
	input.value = "x\u{1F468}‍\u{1F469}‍\u{1F467}"; // "x👨‍👩‍👧"
	input.setSelectionRange(input.value.length, input.value.length);
	await type(BS);
	expect(input.value).toBe("x");
	expect(input.selectionStart).toBe(1);

	// Backspace deletes a base letter plus its combining mark together.
	input.value = "é"; // "é" as e + COMBINING ACUTE
	input.setSelectionRange(input.value.length, input.value.length);
	await type(BS);
	expect(input.value).toBe("");

	// Left arrow steps over an emoji to its leading boundary, then Delete
	// forward removes the whole emoji.
	input.value = "\u{1F600}z"; // "😀z"
	input.setSelectionRange(input.value.length, input.value.length); // after z
	await type(LEFT); // between emoji and z (code unit 2)
	expect(input.selectionStart).toBe(2);
	await type(LEFT); // before the emoji (code unit 0), not mid-pair
	expect(input.selectionStart).toBe(0);
	await type(DEL); // delete the whole emoji forward
	expect(input.value).toBe("z");

	// Right arrow steps over the emoji as one unit.
	input.value = "\u{1F600}z";
	input.setSelectionRange(0, 0);
	await type(RIGHT);
	expect(input.selectionStart).toBe(2); // past the pair, not into it

	termdom.dispose();
});

test("a password input paints masked bullets, never the real value", async () => {
	const terminal = new MockProcess({rows: 3, cols: 20});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<input type=\"password\" value=\"secret\">";
	await nextFrame(dom);

	const input = dom.document.querySelector("input")! as HTMLInputElement;
	// The screen shows one bullet per character; the secret never reaches it.
	expect(terminal.getPlainText()).toContain("••••••");
	expect(terminal.getPlainText()).not.toContain("secret");
	// The real value stays intact on the element -- masking is display-only.
	expect(input.value).toBe("secret");

	// Typing extends the mask, and .value stays real (position aside).
	input.focus();
	(terminal.stdin as any).emit("data", Buffer.from("x"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(input.value.length).toBe(7);
	expect(input.value).toContain("secret");
	expect(terminal.getPlainText()).toContain("•••••••");
	expect(terminal.getPlainText()).not.toContain("secret");

	dom.dispose();
});

test("a constrained input scrolls horizontally to follow the caret", async () => {
	// Typing past a fixed-width field's width windows the value so the caret
	// stays in view: the box clips to its width (max-width on the value part),
	// and the value scrolls under it.
	const terminal = new MockProcess({rows: 4, cols: 30});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<input id=\"i\" style=\"width:10ch\">";
	const input = dom.document.getElementById("i") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);

	for (const c of "abcdefghijklmnop") {
		(terminal.stdin as any).emit("data", Buffer.from(c));
		await new Promise((r) => setTimeout(r, 0));
		await nextFrame(dom);
	}

	// The field shows the last ten cells, caret at the trailing edge -- not the
	// leading "abcdef", and never wider than the field.
	const row = terminal.getPlainText().split("\n")[0];
	expect(row.startsWith("ghijklmnop")).toBe(true);
	expect(row).not.toContain("abcdef");
	dom.dispose();
});

test("a printable key runs keydown, keypress, input, keyup in that order", async () => {
	// The browser's order: the character is inserted as the keypress default
	// action, so `input` follows keypress rather than landing between keydown
	// and it. Each step reads the live value, which is the old one until the
	// insertion has run.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<input id=\"a\" type=\"text\" value=\"a\" autofocus>";
	const input = dom.document.getElementById("a") as HTMLInputElement;
	await nextFrame(dom);

	input.setSelectionRange(1, 1);
	const seen: Array<[string, string]> = [];
	for (const type of ["keydown", "keypress", "input", "keyup"]) {
		input.addEventListener(type, () => seen.push([type, input.value]));
	}

	(terminal.stdin as any).emit("data", Buffer.from("b"));
	await new Promise((r) => setTimeout(r, 0));

	expect(seen).toEqual([
		["keydown", "a"],
		["keypress", "a"],
		["input", "ab"],
		["keyup", "ab"],
	]);

	dom.dispose();
});

test("a canceled keypress inserts nothing", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<input id=\"a\" type=\"text\" value=\"a\" autofocus>";
	const input = dom.document.getElementById("a") as HTMLInputElement;
	await nextFrame(dom);

	input.addEventListener("keypress", (event) => event.preventDefault());
	(terminal.stdin as any).emit("data", Buffer.from("b"));
	await new Promise((r) => setTimeout(r, 0));

	expect(input.value).toBe("a");

	dom.dispose();
});

test("a non-ASCII printable key fires keypress and is inserted", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<input id=\"a\" type=\"text\" autofocus>";
	const input = dom.document.getElementById("a") as HTMLInputElement;
	await nextFrame(dom);

	const seen: string[] = [];
	input.addEventListener("keypress", (event) =>
		seen.push((event as KeyboardEvent).key),
	);
	(terminal.stdin as any).emit("data", Buffer.from("é"));
	await new Promise((r) => setTimeout(r, 0));

	expect(seen).toEqual(["é"]);
	expect(input.value).toBe("é");

	dom.dispose();
});

test("an onkeydown handler assigned by property runs, and can cancel the edit", async () => {
	// A framework that probes `"onkeydown" in node` assigns the property
	// instead of calling addEventListener; the handler has to be a real
	// listener, cancellation and all.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.document.body.innerHTML = "<input id=\"a\" type=\"text\" autofocus>";
	const input = dom.document.getElementById("a") as any;
	await nextFrame(dom);

	expect("onkeydown" in input).toBe(true);
	const keys: string[] = [];
	input.onkeydown = (event: KeyboardEvent) => {
		keys.push(event.key);
		return false;
	};
	(terminal.stdin as any).emit("data", Buffer.from("x"));
	await new Promise((r) => setTimeout(r, 0));

	expect(keys).toEqual(["x"]);
	// Returning false canceled keydown, and a canceled keydown fires no
	// keypress, so nothing was typed.
	expect(input.value).toBe("");

	dom.dispose();
});

test("line feed is the Ctrl+J chord, not Enter", async () => {
	// A terminal sends carriage return for Enter and line feed for Ctrl+J.
	// Reporting both as Enter leaves an application no way to bind a soft
	// newline where Enter already means something else.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	dom.document.body.innerHTML = "<textarea id=\"t\"></textarea>";
	const field = dom.document.getElementById("t") as HTMLTextAreaElement;
	field.focus();
	await nextFrame(dom);

	const keys: string[] = [];
	dom.document.addEventListener("keydown", (event) => {
		const e = event as KeyboardEvent;
		keys.push(`${e.key}${e.ctrlKey ? "+ctrl" : ""}`);
	});

	(terminal.stdin as any).emit("data", Buffer.from("\r"));
	await new Promise((r) => setTimeout(r, 0));
	(terminal.stdin as any).emit("data", Buffer.from("\n"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	expect(keys).toEqual(["Enter", "j+ctrl"]);
	// Both insert a newline in a textarea: the chord is what reaches a field
	// whose Enter an application has taken for itself.
	expect(field.value).toBe("\n\n");

	dom.dispose();
});

test("moving focus and opening a disclosure bring their target into view", async () => {
	// A terminal shows one screen of a document, so a control the camera is not
	// looking at cannot be used: tabbing to it, and opening a disclosure whose
	// contents were below the fold, both have to move the camera.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document, window} = dom;
	document.body.innerHTML =
		"<input id=\"first\">" +
		Array.from({length: 40}, (_, i) => `<div>line ${i}</div>`).join("") +
		"<input id=\"last\">" +
		"<details id=\"d\"><summary>Show</summary>" +
		Array.from({length: 20}, (_, i) => `<div>hidden ${i}</div>`).join("") +
		"</details>";
	(document.getElementById("first") as HTMLElement).focus();
	await nextFrame(dom);
	expect(window.scrollY).toBe(0);

	// Tab past the lines to the far input: the camera follows.
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(document.activeElement?.id).toBe("last");
	expect(window.scrollY).toBeGreaterThan(0);

	// Opening the disclosure reveals what it added.
	const scrolledBefore = window.scrollY;
	const details = document.getElementById("d") as HTMLDetailsElement;
	details
		.querySelector("summary")!
		.dispatchEvent(
			new window.MouseEvent("click", {bubbles: true, cancelable: true}),
		);
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(details.open).toBe(true);
	expect(window.scrollY).toBeGreaterThanOrEqual(scrolledBefore);

	dom.dispose();
});

test("a decoded keystroke is trusted; a constructed event is not", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({
		transport: transportFromProcess(terminal as any),
	});
	const {document, window} = termdom;
	termdom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const trust: Array<{type: string; isTrusted: boolean}> = [];
	for (const type of ["keydown", "keypress", "keyup"]) {
		document.body.addEventListener(type, (event: any) => {
			trust.push({type: event.type, isTrusted: event.isTrusted});
		});
	}

	await (terminal.stdin as any).simulateKeypress("a");
	expect(trust).toEqual([
		{type: "keydown", isTrusted: true},
		{type: "keypress", isTrusted: true},
		{type: "keyup", isTrusted: true},
	]);

	// The same event type, constructed by an app and dispatched by it: the
	// engine never fired it, so nothing about it is the user's.
	trust.length = 0;
	document.body.dispatchEvent(
		new window.KeyboardEvent("keydown", {key: "a", bubbles: true}),
	);
	expect(trust).toEqual([{type: "keydown", isTrusted: false}]);

	termdom.dispose();
});

test("a mouse report is trusted, and so is the focus move it causes", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: transportFromProcess(terminal as any)});
	const {document} = dom;
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	document.body.innerHTML = "<button id=\"b\">press</button>";
	await nextFrame(dom);
	const trust: Array<{type: string; isTrusted: boolean}> = [];
	for (const type of ["mousedown", "mouseup", "click", "focus"]) {
		document
			.getElementById("b")!
			.addEventListener(type, (event: any) =>
				trust.push({type: event.type, isTrusted: event.isTrusted}),
			);
	}

	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;1;1M"));
	await new Promise((r) => setTimeout(r, 0));
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;1;1m"));
	await new Promise((r) => setTimeout(r, 0));
	expect(trust.every((entry) => entry.isTrusted)).toBe(true);
	expect(trust.map((entry) => entry.type)).toContain("click");

	dom.dispose();
});
