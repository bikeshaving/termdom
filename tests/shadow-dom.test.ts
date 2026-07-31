/**
 * Native Shadow DOM, end to end: attachShadow() content through layout and
 * paint. The walker understood shadow roots for years, but only via
 * termdom's private symbol -- native attachShadow content CRASHED layout
 * (a shadow child's parentElement is null; the inline-run machinery threw)
 * and the symbol path never rendered end-to-end at all. Now the two
 * mechanisms have distinct jobs: native attachShadow is the AUTHOR path
 * (standard web components), the symbol slot is reserved for UA-internal
 * widget trees (closed to DOM APIs, like a browser input's own internals).
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("attachShadow content renders, replacing the host's light children", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	host.textContent = "LIGHT";
	const root = host.attachShadow({mode: "open"});
	const inner = document.createElement("span");
	inner.textContent = "SHADOW-CONTENT";
	root.appendChild(inner);
	document.body.appendChild(host);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("SHADOW-CONTENT");
	expect(output).not.toContain("LIGHT"); // composed tree wins, as in a browser

	dom.dispose();
});

test("mutations inside a shadow root invalidate and repaint", async () => {
	// Per spec a document-rooted MutationObserver never sees into shadow
	// trees; each attached root is enrolled in the observer at attachShadow
	// time.
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	const inner = document.createElement("span");
	inner.textContent = "BEFORE";
	root.appendChild(inner);
	document.body.appendChild(host);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("BEFORE");

	inner.textContent = "AFTER";
	await nextFrame(dom);
	const output = terminal.getPlainText();
	expect(output).toContain("AFTER");
	expect(output).not.toContain("BEFORE");

	dom.dispose();
});

test("block structure inside a shadow root lays out normally", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<div>first row</div><div>second row</div>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["first row", "second row"]);

	dom.dispose();
});

test.todo(
	"slot projection through a native shadow root (walker's stateless slot navigation predates native roots; hosts with slots currently render empty)",
);
