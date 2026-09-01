/**
 * Basic HTML-to-Terminal Tests
 */

import {expect, test} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils";

test("TermDOM provides HTML document with terminal capabilities", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	expect(document).toBeDefined();
	expect(document.createElement).toBeDefined();
	expect(typeof dom.dispose).toBe("function");

	dom.dispose();
});

test("can create standard HTML elements", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	const span = document.createElement("span");
	const button = document.createElement("button");

	expect(div.tagName).toBe("DIV");
	expect(span.tagName).toBe("SPAN");
	expect(button.tagName).toBe("BUTTON");

	dom.dispose();
});

test("can build HTML DOM tree", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	const span = document.createElement("span");

	span.textContent = "Hello HTML Terminal!";
	container.appendChild(span);
	document.body.appendChild(container);

	expect(container.children.length).toBe(1);
	expect(container.children[0]).toBe(span);
	expect(span.textContent).toBe("Hello HTML Terminal!");
	expect(document.body.children.length).toBe(1);
	expect(document.body.children[0]).toBe(container);

	dom.dispose();
});

test("HTML elements have CSS styling", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const element = document.createElement("div");

	// Test that element has proper HTML styling APIs
	expect(element).toBeDefined();
	expect(element.tagName).toBe("DIV");
	expect(element.style).toBeDefined();
	expect(typeof element.style.setProperty).toBe("function");

	// Set CSS styles using standard CSSStyleDeclaration API
	element.style.setProperty("background-color", "red");
	element.style.setProperty("color", "white");
	element.style.setProperty("padding", "10px");

	// Test that CSS styles were set
	expect(element.style.getPropertyValue("background-color")).toBe("red");
	expect(element.style.getPropertyValue("color")).toBe("white");
	expect(element.style.getPropertyValue("padding")).toBe("10px");

	dom.dispose();
});

test("TermDOM provides correct terminal dimensions", () => {
	const terminal = new MockProcess({cols: 100, rows: 50});
	const dom = new TermDOM({
		transport: terminal.transport,
	});

	expect(dom.window.innerWidth).toBe(100);
	expect(dom.window.innerHeight).toBe(50);

	dom.dispose();
});

test("HTML elements support layout APIs", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Test that standard HTML elements have layout APIs
	const div = document.createElement("div");
	const span = document.createElement("span");
	const p = document.createElement("p");

	// All elements should have layout APIs
	expect(typeof div.getBoundingClientRect).toBe("function");
	expect(typeof span.offsetWidth).toBe("number");
	expect(typeof p.clientHeight).toBe("number");

	// Initially should return zero (no layout computed yet)
	expect(div.getBoundingClientRect().width).toBe(0);
	expect(span.offsetWidth).toBe(0);
	expect(p.clientHeight).toBe(0);

	dom.dispose();
});

test("can render HTML to terminal without errors", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Test content";
	div.style.setProperty("color", "blue");
	document.body.appendChild(div);

	await nextFrame(dom);

	// The text reaches the screen, and the color it was given reaches it too.
	expect(terminal.getVisibleText()).toContain("Test content");
	expect(terminal.getStaticANSI()).toContain("38;2;0;0;255m");
	dom.dispose();
});

test("pseudo-element CSS content is available immediately after render", async () => {
	// Pseudo-element content is there on the first render, not the second.

	const terminal = new MockProcess();
	const termDOM = new TermDOM({transport: terminal.transport});

	// Set up HTML with pseudo-element CSS
	termDOM.document.body.innerHTML = `
		<style>
			li::marker { content: "🎯 "; color: red; }
			li::before { content: "PREFIX: "; color: blue; }
		</style>
		<ul>
			<li>Test item</li>
		</ul>
	`;

	// Call render once
	await nextFrame(termDOM);

	// Test that pseudo-element styles are immediately available
	const li = termDOM.document.querySelector("li")!;
	const markerStyle = termDOM.window.getComputedStyle(li, "::marker");
	const beforeStyle = termDOM.window.getComputedStyle(li, "::before");

	// These should have content immediately, not be empty
	expect(markerStyle.getPropertyValue("content")).toBe('"🎯 "');
	expect(markerStyle.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
	expect(beforeStyle.getPropertyValue("content")).toBe('"PREFIX: "');
	expect(beforeStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	termDOM.dispose();
});

test("lists render correctly without requiring double-rendering", async () => {
	// Test the actual user-facing behavior that was broken:
	// Lists should render with proper markers on the first render

	const terminal = new MockProcess();
	const termDOM = new TermDOM({transport: terminal.transport});

	// Set up a list with custom markers
	termDOM.document.body.innerHTML = `
		<style>
			ul { list-style: none; }
			li::marker { content: "→ "; color: green; }
		</style>
		<ul>
			<li>First item</li>
			<li>Second item</li>
		</ul>
	`;

	// Render once and verify markers are present
	await nextFrame(termDOM);

	// Check that markers are available immediately
	const items = termDOM.document.querySelectorAll("li");
	for (const item of items) {
		const markerStyle = termDOM.window.getComputedStyle(item, "::marker");
		expect(markerStyle.getPropertyValue("content")).toBe('"→ "');
		expect(markerStyle.getPropertyValue("color")).toBe("rgb(0, 128, 0)");
	}

	termDOM.dispose();
});

test("pseudo-elements resolve on the very first render", async () => {
	// Nothing paints before attach(), so a document built first meets the
	// renderer exactly once -- no earlier observer-driven frame can mask a
	// first-render pipeline bug by accident.
	const terminal = new MockProcess();
	const termDOM = new TermDOM({transport: terminal.transport});

	const style = termDOM.document.createElement("style");
	style.textContent = 'li::marker { content: "★ "; color: purple; }';
	termDOM.document.head.appendChild(style);

	const ul = termDOM.document.createElement("ul");
	const li = termDOM.document.createElement("li");
	li.textContent = "Manual item";
	ul.appendChild(li);
	termDOM.document.body.appendChild(ul);

	termDOM.attach();
	await nextFrame(termDOM);

	// Test that pseudo-element content is available immediately
	const markerStyle = termDOM.window.getComputedStyle(li, "::marker");

	// With the broken pipeline, this should fail because CSS wasn't parsed before pseudo-element attachment
	expect(markerStyle.getPropertyValue("content")).toBe('"★ "');
	expect(markerStyle.getPropertyValue("color")).toBe("rgb(128, 0, 128)");

	termDOM.dispose();
});

test("fullscreen owns the alternate screen from row zero, whatever the anchor", async () => {
	// A real session's document anchors below prior shell output; the
	// fullscreen frame must ignore that anchor entirely -- paint at row 0
	// of the alternate screen, never push index-scrolls into it.
	const terminal = new MockProcess({rows: 8, cols: 40});
	(terminal as any).terminal.write("one\r\ntwo\r\nthree\r\nfour\r\n");
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	document.body.innerHTML = "<div>doc row</div><div id=\"fs\">STAGE</div>";
	await nextFrame(dom);
	await document.getElementById("fs")!.requestFullscreen();
	await nextFrame(dom);
	const buffer = (terminal as any).terminal.buffer.active;
	expect(buffer.getLine(0).translateToString(true)).toContain("STAGE");

	await document.exitFullscreen();
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("doc row");
	dom.dispose();
});

test("entering fullscreen hides the cursor on the screen it takes", async () => {
	// The session records the cursor as hidden before its first frame,
	// because frames hide it as they paint. Entry cannot read that record as
	// "the bytes are on the wire": the alternate screen it just switched to
	// has had none of them.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<div id=\"fs\">STAGE</div>";
	await dom.attach();

	let written = "";
	const original = terminal.stdout.write.bind(terminal.stdout);
	terminal.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		written += String(chunk);
		return original(chunk as never, ...(rest as never[]));
	}) as typeof terminal.stdout.write;

	await document.getElementById("fs")!.requestFullscreen();
	await nextFrame(dom);
	// The switch, then the hide, then the clear: a cursor the entry left
	// visible would sit blinking on the screen it just took, and a frame's
	// own hide arrives no earlier than the frame does.
	const entry = written.indexOf("\x1b[?1049h");
	const hide = written.indexOf("\x1b[?25l");
	const clear = written.indexOf("\x1b[2J");
	expect(entry).toBeGreaterThan(-1);
	expect(hide).toBeGreaterThan(entry);
	expect(hide).toBeLessThan(clear);
	await dom.dispose();
});

test("closing while fullscreen leaves no trace, and the shell lands below", async () => {
	// An alt-screen program vanishes on exit: the switch restores what the
	// screen held before entry, and that is the record. The payout belongs
	// to flow mode -- an app that wants its final state in scrollback exits
	// fullscreen first. The restore also puts the cursor back on the flow
	// content's bottom row, so teardown steps below it, or the shell's next
	// prompt overwrites our last line.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	document.body.innerHTML = "<div>flow row</div><div id=\"fs\">STAGE</div>";
	await nextFrame(dom);
	await document.getElementById("fs")!.requestFullscreen();
	await nextFrame(dom);

	let written = "";
	const original = terminal.stdout.write.bind(terminal.stdout);
	terminal.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		written += String(chunk);
		return original(chunk as never, ...(rest as never[]));
	}) as typeof terminal.stdout.write;

	await dom.dispose();
	// The alt screen exits, nothing pays out after it, and the cursor
	// steps to a fresh line.
	const restoreAt = written.indexOf("\x1b[?1049l");
	expect(restoreAt).toBeGreaterThan(-1);
	const after = written.slice(restoreAt + "\x1b[?1049l".length);
	expect(after).not.toContain("STAGE");
	expect(after).not.toContain("flow row");
	expect(after).toContain("\r\n");
});

test("no frame straddles a screen switch, even mid-animation", async () => {
	// An in-flight render finishing its stdout write AFTER ?1049l paints
	// alternate-screen geometry onto the restored main screen. Transitions
	// drain the in-flight frame and hold new ones until the switch lands.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	document.body.innerHTML = "<div>alpha doc row</div><div id=\"fs\">STAGE</div>";
	await nextFrame(dom);
	const stage = document.getElementById("fs")!;
	await stage.requestFullscreen();
	await nextFrame(dom);

	// Rapid mutations schedule frames; exit immediately, awaiting nothing.
	stage.textContent = "STAGE tick 1";
	stage.textContent = "STAGE tick 2";
	const exited = document.exitFullscreen();
	stage.textContent = "STAGE tick 3";
	await exited;
	await nextFrame(dom);

	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("alpha doc row"); // main screen, coherent
	expect(rows[1]).toContain("STAGE tick 3"); // trailing frame landed AFTER, correctly
	dom.dispose();
});

test("exiting fullscreen restores a coherent document frame", async () => {
	// Fullscreen swaps screens under the renderer: entering clears to the
	// alternate screen, exiting restores the main one. The diff model must
	// reset on BOTH transitions -- diffing the restored main screen against
	// the last alternate-screen frame patches cells that never matched.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	document.body.innerHTML = "<div>alpha document row</div><div>beta document row</div><div id=\"fs\">stage content</div>";
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("alpha document row");

	const stage = document.getElementById("fs")!;
	await stage.requestFullscreen();
	await nextFrame(dom);
	// Fullscreen: the stage fills the alternate screen; the document rows
	// are not part of it.
	expect(terminal.getPlainText()).toContain("stage content");
	expect(terminal.getPlainText()).not.toContain("alpha document row");

	await document.exitFullscreen();
	await nextFrame(dom);
	// Back on the main screen: the whole document, coherently.
	const text = terminal.getPlainText();
	expect(text).toContain("alpha document row");
	expect(text).toContain("beta document row");
	expect(text).toContain("stage content");

	dom.dispose();
});

test("a headless TermDOM binds its terminal at attach(), re-deriving size", async () => {
	// Construct with no process -- the global process stands in until attach.
	const dom = new TermDOM();

	// Rebind to a specific terminal before the first render: its size, not the
	// stand-in's, must reach the document (window.innerWidth and layout).
	const terminal = new MockProcess({rows: 12, cols: 50});
	dom.attach(terminal.transport);
	dom.document.body.innerHTML = "<p>bound late</p>";
	await nextFrame(dom);

	expect(dom.window.innerWidth).toBe(50);
	expect(dom.window.innerHeight).toBe(12);
	expect(terminal.getPlainText()).toContain("bound late");

	dom.dispose();
});

test("attach() is idempotent for its process but rejects a different one", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});

	dom.attach(); // first attach

	await new Promise((r) => setTimeout(r, 0));
	dom.attach(); // same transport -> no-op, no throw
	await new Promise((r) => setTimeout(r, 0));
	dom.attach(terminal.transport); // still the same transport -> no-op

	// Re-attaching a live instance to a different terminal is not supported.
	expect(() =>
		dom.attach(new MockProcess({rows: 5, cols: 5}).transport),
	).toThrow(/different transport/);

	dom.dispose();
});
