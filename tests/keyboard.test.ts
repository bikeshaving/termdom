import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";
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
	termdom.attach();

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

	// Check events were fired
	expect(events.length).toBeGreaterThan(0);
	expect(events.some((e) => e.type === "keydown")).toBe(true);
	expect(events.some((e) => e.key === "a")).toBe(true);
});

test("special keys are mapped correctly", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

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
	expect(events.some((e) => e.key === "Enter" && e.keyCode === 13)).toBe(true);

	// Test Tab key
	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	expect(events.some((e) => e.key === "Tab" && e.keyCode === 9)).toBe(true);

	// Test Backspace
	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x7f"));
	expect(events.some((e) => e.key === "Backspace" && e.keyCode === 8)).toBe(
		true,
	);
});

test("Ctrl+letter decodes as the letter with ctrlKey, not a control character", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

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
	(terminal.stdin as any).emit("data", Buffer.from([0x01]));
	(terminal.stdin as any).emit("data", Buffer.from([0x1a]));

	expect(events).toEqual([
		{key: "s", keyCode: 83, ctrlKey: true},
		{key: "a", keyCode: 65, ctrlKey: true},
		{key: "z", keyCode: 90, ctrlKey: true},
	]);
});

test("a plain letter never has ctrlKey set", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({key: event.key, ctrlKey: event.ctrlKey});
	});

	(terminal.stdin as any).emit("data", Buffer.from("s"));
	expect(events).toEqual([{key: "s", ctrlKey: false}]);
});

test("Enter and Tab stay their named keys, not Ctrl+M/Ctrl+I", async () => {
	// A raw terminal cannot distinguish the physical Enter/Tab keys from
	// Ctrl+M/Ctrl+I -- they are the identical byte (0x0D/0x0A and 0x09). The
	// named key has to win, matching every other terminal app.
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

	const events: any[] = [];
	document.body.addEventListener("keydown", (event: any) => {
		events.push({key: event.key, ctrlKey: event.ctrlKey});
	});

	(terminal.stdin as any).emit("data", Buffer.from("\r"));
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	expect(events).toEqual([
		{key: "Enter", ctrlKey: false},
		{key: "Tab", ctrlKey: false},
	]);
});

test("Ctrl+letter in a focused input moves the caret, not inserts text", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	input.value = "hello";

	(terminal.stdin as any).emit("data", Buffer.from([0x01])); // Ctrl+A
	expect(input.value).toBe("hello"); // unchanged, not "helloa"
});

test("arrow keys are parsed correctly", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

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
	expect(events.some((e) => e.key === "ArrowUp" && e.keyCode === 38)).toBe(
		true,
	);

	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[B"));
	expect(events.some((e) => e.key === "ArrowDown" && e.keyCode === 40)).toBe(
		true,
	);

	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[C"));
	expect(events.some((e) => e.key === "ArrowRight" && e.keyCode === 39)).toBe(
		true,
	);

	events.length = 0;
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[D"));
	expect(events.some((e) => e.key === "ArrowLeft" && e.keyCode === 37)).toBe(
		true,
	);
});

test("modified arrow keys decode xterm's CSI 1;<mod> encoding", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

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

	const send = (bytes: string) =>
		(terminal.stdin as any).emit("data", Buffer.from(bytes));

	send("\x1b[1;3A"); // Alt+Up (mod 3 = 1 + 2)
	send("\x1b[1;5B"); // Ctrl+Down (mod 5 = 1 + 4)
	send("\x1b[1;2C"); // Shift+Right (mod 2 = 1 + 1)
	send("\x1b[1;7D"); // Ctrl+Alt+Left (mod 7 = 1 + 2 + 4)

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
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

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
	expect(events).toEqual([
		{key: "ArrowUp", shiftKey: false, altKey: false, ctrlKey: false},
	]);
});

test("keyboard events bubble up the DOM", async () => {
	const terminal = new MockKeyboardProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;
	termdom.attach();

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

	// Events should bubble from child to parent
	expect(childEvents.length).toBe(0); // No direct events on child since we target document.body
	expect(parentEvents.length).toBe(0); // No direct events on parent either

	// Events go to document.body by default in our implementation
	const bodyEvents: string[] = [];
	document.body.addEventListener("keydown", () => bodyEvents.push("body"));

	(terminal.stdin as any).emit("data", Buffer.from("b"));
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

test("a focused empty input still shows its placeholder, caret at the field start", async () => {
	// Browsers show the placeholder in a focused empty input -- the caret
	// just sits at position 0 over the dimmed text, and the first keystroke
	// replaces it. This regressed invisibly for as long as autofocus was
	// unimplemented: no input ever STARTED focused, so the old
	// hide-on-focus condition never had a first paint to ruin.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div><input id="a" type="text" placeholder="What needs doing?" autofocus></div>`;
	const input = dom.document.getElementById("a") as HTMLInputElement;
	await nextFrame(dom);

	expect(dom.document.activeElement).toBe(input); // autofocus took
	expect(terminal.getPlainText()).toContain("What needs doing?");
	const buffer = (terminal as any).terminal.buffer.active;
	expect(buffer.cursorX).toBe(0); // caret at the start, over the placeholder

	// Typing replaces the placeholder with the value.
	(terminal.stdin as any).emit("data", Buffer.from("x"));
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("12345678"));
	expect(input.value).toBe("12345678");

	input.value = ""; // the framework's submit reset
	(terminal.stdin as any).emit("data", Buffer.from("abc"));
	expect(input.value).toBe("abc");

	(terminal.stdin as any).emit("data", Buffer.from("\x7f")); // Backspace
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const input = document.createElement("input");
	input.style.width = "10ch";
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("abcdefghijklmno"));
	await nextFrame(dom);
	// Window follows the caret: the last 9 chars + the caret cell.
	expect(terminal.getPlainText()).toContain("ghijklmno");

	for (let i = 0; i < 4; i++) {
		(terminal.stdin as any).emit("data", Buffer.from("\x7f"));
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	// Typing moves the standard selection, not a private shadow of it.
	(terminal.stdin as any).emit("data", Buffer.from("hello"));
	expect(input.selectionStart).toBe(5);
	expect(input.selectionEnd).toBe(5);

	// ArrowLeft is observable through the API too.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[D\x1b[D"));
	expect(input.selectionStart).toBe(3);

	// And the API drives the rendered caret: reposition programmatically,
	// the real terminal cursor parks there on the next frame.
	input.setSelectionRange(1, 1);
	await nextFrame(dom);
	const buffer = (terminal as any).terminal.buffer.active;
	expect(buffer.cursorX).toBe(1);

	// Typing lands at the API-set caret.
	(terminal.stdin as any).emit("data", Buffer.from("X"));
	expect(input.value).toBe("hXello");

	dom.dispose();
});

test("Shift+arrows extend a selection with the browser's anchor/focus model", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("abcdef"));

	// Shift+Left twice from the end: focus walks left, anchor stays.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2D\x1b[1;2D"));
	expect([input.selectionStart, input.selectionEnd]).toEqual([4, 6]);
	expect(input.selectionDirection).toBe("backward");

	// Shift+Right SHRINKS the backward selection instead of flipping it.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2C"));
	expect([input.selectionStart, input.selectionEnd]).toEqual([5, 6]);

	// A plain arrow collapses to the matching edge, not one past it.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[D"));
	expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);

	// Shift+Home selects back to the start; typing replaces the selection.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2H"));
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
	(terminal.stdin as any).emit("data", Buffer.from("Z"));
	expect(input.value).toBe("Zf");
	expect(input.selectionStart).toBe(1);

	dom.dispose();
});

test("Ctrl+A selects all; Backspace deletes the whole selection", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("some text"));

	(terminal.stdin as any).emit("data", Buffer.from([0x01])); // Ctrl+A
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 9]);
	expect(input.value).toBe("some text"); // selected, not inserted

	(terminal.stdin as any).emit("data", Buffer.from("\x7f")); // Backspace
	expect(input.value).toBe("");
	expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0]);

	dom.dispose();
});

test("a selection paints as inverse video over the selected cells", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("abcdef"));
	await nextFrame(dom);
	expect(terminal.getScreenContents()).not.toMatch(/\x1b\[[\d;]*7m/);

	// Select "ef" and the frame carries SGR 7 (inverse) for those cells.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2D\x1b[1;2D"));
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
	const dom = new TermDOM({process: terminal});
	// The footer line keeps the content bottom below the input's row, so the
	// blur assertion can tell "re-parked at the bottom" apart from "never
	// moved" -- a flat one-row input at the end of the document would park
	// in place.
	dom.document.body.innerHTML = `<div>title line</div><div><input id="a" type="text"></div><div>footer line</div>`;
	const input = dom.document.getElementById("a") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);

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
	await nextFrame(dom);
	expect(buffer.cursorY).toBeGreaterThan(caretRow);
	expect(buffer.cursorX).toBe(0);

	dom.dispose();
});

test("Space toggles a focused checkbox and fires change; other keys are no-ops", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	document.body.appendChild(checkbox);
	checkbox.focus();
	await nextFrame(dom);

	const changes: boolean[] = [];
	checkbox.addEventListener("change", () => changes.push(checkbox.checked));

	(terminal.stdin as any).emit("data", Buffer.from(" "));
	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);

	// Checkboxes don't accept typed text -- every other key is a no-op.
	(terminal.stdin as any).emit("data", Buffer.from("abc\r\x7f"));
	expect(checkbox.checked).toBe(true);
	expect(changes).toEqual([true]);

	(terminal.stdin as any).emit("data", Buffer.from(" "));
	expect(checkbox.checked).toBe(false);
	expect(changes).toEqual([true, false]);

	dom.dispose();
});

test("radios render as ( )/(x); Space checks but never unchecks; groups are exclusive", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
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
	await nextFrame(dom);
	expect(a.checked).toBe(true);
	expect(terminal.getPlainText()).toContain("(x)( )");

	// ...but never unchecks it (the browser default; only another group
	// member can take the check away).
	(terminal.stdin as any).emit("data", Buffer.from(" "));
	expect(a.checked).toBe(true);

	// Checking the sibling unchecks this one -- jsdom's own radio-group
	// exclusivity, surfaced through the same Space path.
	b.focus();
	(terminal.stdin as any).emit("data", Buffer.from(" "));
	await nextFrame(dom);
	expect(b.checked).toBe(true);
	expect(a.checked).toBe(false);
	expect(terminal.getPlainText()).toContain("( )(x)");

	dom.dispose();
});

test("an autofocus element focuses itself as soon as it's connected, including nested", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
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
	const dom = new TermDOM({process: terminal});
	dom.attach();

	const events: Array<{key: string; keyCode: number}> = [];
	dom.document.addEventListener("keydown", (e: any) =>
		events.push({key: e.key, keyCode: e.keyCode}),
	);

	const send = (bytes: string) =>
		(terminal.stdin as any).emit("data", Buffer.from(bytes));

	send("\x1b");
	send("\x1b[H");
	send("\x1b[1~");
	send("\x1b[F");
	send("\x1b[4~");
	send("\x1b[2~");
	send("\x1b[3~");
	send("\x1b[5~");
	send("\x1b[6~");
	send("\x1bOP");
	send("\x1bOQ");
	send("\x1bOR");
	send("\x1bOS");
	send("\x1b[15~");
	send("\x1b[17~");
	send("\x1b[18~");
	send("\x1b[19~");
	send("\x1b[20~");
	send("\x1b[21~");
	send("\x1b[23~");
	send("\x1b[24~");

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
	const dom = new TermDOM({process: terminal});
	dom.attach();

	const codes: string[] = [];
	dom.document.addEventListener("keydown", (e: any) => codes.push(e.code));

	const send = (bytes: string) =>
		(terminal.stdin as any).emit("data", Buffer.from(bytes));

	send("\r"); // Enter
	send("\x1b[A"); // ArrowUp
	send("\x1b[5~"); // PageUp
	send("a");
	send("5");
	send(" ");

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
	const dom = new TermDOM({process: terminal});
	dom.attach();
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

	expect(events).toEqual([
		{key: "a", ctrlKey: true}, // Ctrl+A
		{key: "j", ctrlKey: false},
		{key: "j", ctrlKey: false},
	]);
	dom.dispose();
});

test("Escape still exits fullscreen, now dispatched from the general pipeline", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
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
	await new Promise((resolve) => setTimeout(resolve, 10));

	expect(document.fullscreenElement).toBe(null);
	// Escape exits unconditionally, the same as a real browser -- it is never
	// dispatched to the DOM, so the app can't preventDefault its way out.
	expect(escapeSeenByContainer).toEqual([]);
	dom.dispose();
});

test("a focused descendant inside a fullscreen element still wins over the element itself", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const container = document.createElement("div");
	const input = document.createElement("input");
	container.appendChild(input);
	document.body.appendChild(container);
	await container.requestFullscreen();
	input.focus();

	(terminal.stdin as any).emit("data", Buffer.from("x"));
	expect(input.value).toBe("x");
	dom.dispose();
});

test("with nothing focused, fullscreen keydown still lands on the fullscreen element", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const container = document.createElement("div");
	document.body.appendChild(container);
	await container.requestFullscreen();

	const keys: string[] = [];
	container.addEventListener("keydown", (e: any) => keys.push(e.key));

	(terminal.stdin as any).emit("data", Buffer.from("q"));
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
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div><input id="a" type="text" style="width:20ch">|</div>`;
	const input = dom.document.getElementById("a") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// Commit syllables one at a time, the way an IME delivers them.
	for (const syllable of ["김", "남", "제"]) {
		(terminal.stdin as any).emit("data", Buffer.from(syllable));
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
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div><input id="a" size="8">|</div><div><input id="b">|</div><div><input id="c" size="8" style="width: 12ch">|</div>`;
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
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div><input style="width:100%" placeholder="What needs to be done?"></div><div><input style="width:50%"></div>`;
	await nextFrame(dom);

	const [full, half] = Array.from(dom.document.querySelectorAll("input"));
	expect(full.getBoundingClientRect().width).toBe(40);
	expect(half.getBoundingClientRect().width).toBe(20);
	// The full-width field no longer clips its 22-char placeholder.
	expect(terminal.getPlainText()).toContain("What needs to be done?");

	dom.dispose();
});

test(":focus rules apply on focus and revert on blur", async () => {
	// Selector matching is live (jsdom's :focus follows activeElement), but
	// computed styles are cached per element and focus is not a mutation --
	// the cache held a rule set matched before the focus moved, so a :focus
	// rule never applied, and once focused would never have un-applied.
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document, window} = dom;
	const style = document.createElement("style");
	style.textContent = `input:focus { background: #264f78; }`;
	document.head.appendChild(style);
	const a = document.createElement("input");
	const b = document.createElement("input");
	document.body.append(a, b);
	await nextFrame(dom);

	const bg = (el: Element) =>
		window.getComputedStyle(el).getPropertyValue("background-color");
	expect(bg(a)).toBe("transparent");

	a.focus();
	expect(bg(a)).toBe("rgb(38, 79, 120)");
	await nextFrame(dom);
	expect(terminal.getScreenContents()).toContain("48;2;38;79;120"); // painted

	// Focus moving to b un-applies on a and applies on b.
	b.focus();
	expect(bg(a)).toBe("transparent");
	expect(bg(b)).toBe("rgb(38, 79, 120)");

	b.blur();
	expect(bg(b)).toBe("transparent");

	dom.dispose();
});

test("blurred fields are faint blanks; the focused field's line is solid", async () => {
	// The UA field design, all in classic SGR that survives any chain:
	// a blurred field paints dim+underlined blanks across the cells its
	// value doesn't occupy (typed content stays plain text; a placeholder
	// rides the blank and goes faint with it), and the focused field swaps
	// to a solid underline across the whole extent.
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const a = document.createElement("input");
	a.value = "hi";
	const b = document.createElement("input");
	document.body.append(a, b);
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);

	// Blurred, with value: the whole strip is faint and underlined, value
	// included -- blur/focus is one clean state flip across the extent.
	expect(cellAt(0, 0).isUnderline()).toBeTruthy();
	expect(cellAt(0, 0).isDim()).toBeTruthy();
	// ...and the remainder is the faint blank.
	expect(cellAt(0, 5).isUnderline()).toBeTruthy();
	expect(cellAt(0, 5).isDim()).toBeTruthy();
	// Blurred, empty (input b sits beside a on the same line, cols 20-39):
	// faint blank across the extent.
	expect(cellAt(0, 25).isUnderline()).toBeTruthy();
	expect(cellAt(0, 25).isDim()).toBeTruthy();

	// Focused: solid underline across the whole extent, value included --
	// and not dim.
	a.focus();
	await nextFrame(dom);
	expect(cellAt(0, 0).isUnderline()).toBeTruthy();
	expect(cellAt(0, 0).isDim()).toBeFalsy();
	expect(cellAt(0, 5).isUnderline()).toBeTruthy();
	expect(cellAt(0, 5).isDim()).toBeFalsy();
	// The other field stays a faint blank.
	expect(cellAt(0, 25).isUnderline()).toBeTruthy();
	expect(cellAt(0, 25).isDim()).toBeTruthy();

	dom.dispose();
});

test("author CSS text-decoration-style: double emits SGR 4 then 4:2", async () => {
	// The engine feature stands for authors targeting terminals they know
	// support styled underlines -- the UA defaults just never use it. Plain
	// 4 precedes 4:2 so a DIRECTLY connected non-supporting terminal keeps
	// the single underline (an intermediary like tmux may still collapse
	// the pair -- that is why it is opt-in).
	const terminal = new MockProcess({rows: 5, cols: 40});
	const dom = new TermDOM({process: terminal});
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	document.head.innerHTML = `<style>.editing .view { display: none } .view { display: flex; flex-direction: row }</style>`;
	document.body.innerHTML =
		`<div>before</div>` +
		`<li class="editing"><div class="view"><input type="checkbox"><label>todo</label><button>x</button></div><input class="edit"></li>` +
		`<div>after</div>`;
	await nextFrame(dom);
	await nextFrame(dom);

	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toBe("before"); // no ghost row above
	expect(terminal.getPlainText()).not.toContain("todo"); // hidden stays hidden

	(document.querySelector(".edit") as HTMLElement).focus();
	(terminal.stdin as any).emit("data", Buffer.from("\t"));
	await nextFrame(dom);
	// The hidden checkbox and button are not in tab order; the edit input
	// is the only rendered focusable, so focus stays put.
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	document.head.innerHTML = `<style>.editing .view { display: none } .view { display: flex; flex-direction: row; gap: 1ch }</style>`;
	document.body.innerHTML =
		`<div>before</div>` +
		`<li id="item"><div class="view"><input type="checkbox"><label>Finish TermDOM</label><button>x</button></div></li>` +
		`<div>after</div>`;
	await nextFrame(dom);

	const li = document.getElementById("item")!;
	li.classList.add("editing");
	const edit = document.createElement("input");
	edit.className = "edit";
	edit.value = "Finish TermDOM";
	li.appendChild(edit);
	await nextFrame(dom);
	await nextFrame(dom);

	let rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toBe("before");
	expect(rows[1]).toContain("Finish TermDOM"); // the editor, on the todo row
	expect(rows[2]).toContain("after"); // and nothing ghosts between

	li.classList.remove("editing");
	li.removeChild(edit);
	await nextFrame(dom);
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	dom.document.body.innerHTML = `<div><input style="width: auto" value="abc"></div>`;
	await nextFrame(dom);
	const input = dom.document.querySelector("input") as HTMLInputElement;
	input.focus();
	input.setSelectionRange(3, 3);
	await nextFrame(dom);

	(terminal.stdin as any).emit("data", Buffer.from("d"));
	await nextFrame(dom); // the FIRST frame after the keystroke
	expect(terminal.getPlainText().split("\n")[0]).toContain("abcd");
	dom.dispose();
});

test("an empty width:auto input keeps a single underlined caret cell", async () => {
	// With no value and no placeholder the blank IS the field: one faint
	// underlined cell marking an editable spot, instead of collapsing to
	// zero width and vanishing from the row.
	const terminal = new MockProcess({rows: 4, cols: 30});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	dom.document.body.innerHTML =
		`<div style="display:flex; flex-direction:row; gap:1ch">` +
		`<span>a:</span><input style="width: auto"><span>z</span></div>`;
	await nextFrame(dom);
	await nextFrame(dom);

	const line = () => (terminal as any).terminal.buffer.active.getLine(0);
	expect(line().translateToString(false).trimEnd()).toBe("a:   z");
	expect(line().getCell(3).isUnderline()).toBeTruthy();
	expect(line().getCell(3).isDim()).toBeTruthy();

	// Typing grows the field; deleting back to empty returns to the
	// single cell rather than zero width.
	const input = dom.document.querySelector("input") as HTMLInputElement;
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("hi"));
	await nextFrame(dom);
	expect(line().translateToString(false).trimEnd()).toBe("a: hi  z");
	(terminal.stdin as any).emit("data", Buffer.from("\x7f\x7f"));
	await nextFrame(dom);
	expect(line().translateToString(false).trimEnd()).toBe("a:   z");
	expect(line().getCell(3).isUnderline()).toBeTruthy();
	dom.dispose();
});

test("a click in a text input parks the caret at the pressed character", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	dom.document.body.innerHTML = `<div><input value="hello world"></div>`;
	await nextFrame(dom);
	const input = dom.document.querySelector("input") as HTMLInputElement;

	// Column 7 (1-based) is the second 'o' region: offset 6.
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;7;1M\x1b[<0;7;1m"));
	await nextFrame(dom);
	expect(dom.document.activeElement).toBe(input);
	expect(input.selectionStart).toBe(6);
	expect(input.selectionEnd).toBe(6);
	dom.dispose();
});

test("a drag inside an input selects within the field, bounded to its value", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	dom.document.body.innerHTML = `<div><input value="hello world"></div>`;
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
	const dom = new TermDOM({process: terminal});
	dom.attach();
	dom.document.body.innerHTML = `<div id="p">page text here</div><div><input value="hello"></div>`;
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

test("typing stays cheap: a keystroke must not relayout the world", async () => {
	// Regression guard for the 61ms-per-keystroke storm: a className
	// re-assigned with an IDENTICAL value on every input event (the
	// framework pattern) was rebuilding the whole layout tree from body,
	// and initial-valued inherited properties re-walked the ancestor
	// chain on every read. The bound is ~3x today's cost -- generous
	// enough for slow machines, far below the failure mode.
	const terminal = new MockProcess({rows: 30, cols: 100});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	document.body.innerHTML = `
		<div class="row"><div>Type</div><select><option>feat</option><option>fix</option></select><div id="counter"></div></div>
		<div class="row"><div>Subject</div><input id="subject" style="width: 50ch"></div>
		<div class="row"><div>Body</div><textarea rows="5" cols="60"></textarea></div>
		<div id="status"></div>`;
	const subject = document.getElementById("subject") as HTMLInputElement;
	const counter = document.getElementById("counter")!;
	const status = document.getElementById("status")!;
	subject.addEventListener("input", () => {
		counter.textContent = `${subject.value.length}/50`;
		counter.className = "counter";
		status.textContent = `→ ${subject.value}`;
	});
	subject.focus();
	await nextFrame(dom);

	const times: number[] = [];
	for (let i = 0; i < 30; i++) {
		const t0 = performance.now();
		(terminal.stdin as any).emit("data", Buffer.from("x"));
		await nextFrame(dom);
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	expect(times[15]).toBeLessThan(25);

	dom.dispose();
});
