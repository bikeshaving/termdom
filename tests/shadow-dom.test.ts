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

// Slot projection: the composed tree interleaves shadow chrome with light
// children pulled through <slot>s. The walker's hops are stateless, so
// projection rides on jsdom's live slot assignment (assignedSlot /
// assignedNodes) rather than any cached mapping.

test("default slot projects light children between shadow siblings", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<div>HEADER</div><slot></slot><div>FOOTER</div>`;
	const light = document.createElement("div");
	light.textContent = "PROJECTED";
	host.appendChild(light);
	document.body.appendChild(host);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["HEADER", "PROJECTED", "FOOTER"]);

	dom.dispose();
});

test("named slots project by slot attribute, in shadow-tree order", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	// Shadow order reverses the light order: the slot's position wins.
	root.innerHTML = `<div><slot name="second"></slot></div><div><slot name="first"></slot></div>`;
	host.innerHTML = `<span slot="first">ALPHA</span><span slot="second">BETA</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["BETA", "ALPHA"]);

	dom.dispose();
});

test("a slot with nothing assigned renders its fallback content", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<slot>FALLBACK</slot>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("FALLBACK");

	dom.dispose();
});

test("assigned content replaces fallback; unassigned light children don't render", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<slot name="a">FALLBACK</slot>`;
	host.innerHTML = `<span slot="a">ASSIGNED</span><span slot="nowhere">ORPHAN</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("ASSIGNED");
	expect(output).not.toContain("FALLBACK");
	expect(output).not.toContain("ORPHAN");

	dom.dispose();
});

test("bare text light children project through the default slot", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<span>[</span><slot></slot><span>]</span>`;
	host.appendChild(document.createTextNode("TEXTCHILD"));
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("[TEXTCHILD]");

	dom.dispose();
});

test("attachShadow on a connected, already-rendered host replaces its content", async () => {
	// The standard web-component order is attach-then-populate-then-connect,
	// but nothing stops an author upgrading an element that is already on
	// screen -- the light-children layout must be torn down and the composed
	// tree take over, immediately for the (empty) root and on population.
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	host.textContent = "LIGHT";
	document.body.appendChild(host);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("LIGHT");

	const root = host.attachShadow({mode: "open"});
	const inner = document.createElement("div");
	inner.textContent = "UPGRADED";
	root.appendChild(inner);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("UPGRADED");
	expect(output).not.toContain("LIGHT");

	dom.dispose();
});

test("attachShadow alone blanks a connected host: an empty root has no composed content", async () => {
	// attachShadow is not a DOM mutation -- no observer record fires -- but
	// the composed tree changed all the same: an empty shadow root renders
	// NOTHING, exactly as in a browser.
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	host.textContent = "LIGHT";
	document.body.appendChild(host);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("LIGHT");

	host.attachShadow({mode: "open"});
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("LIGHT");

	dom.dispose();
});

test("attachShadow on a connected host with slots reprojects its light children", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	host.textContent = "KEPT";
	document.body.appendChild(host);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("KEPT");

	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<span>&lt;</span><slot></slot><span>&gt;</span>`;
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("<KEPT>");

	dom.dispose();
});

test("reassigning a slot attribute reprojects on the next frame", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<div>A:<slot name="a"></slot></div><div>B:<slot name="b"></slot></div>`;
	const item = document.createElement("span");
	item.setAttribute("slot", "a");
	item.textContent = "ITEM";
	host.appendChild(item);
	document.body.appendChild(host);
	await nextFrame(dom);
	let lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["A:ITEM", "B:"]);

	item.setAttribute("slot", "b");
	await nextFrame(dom);
	lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["A:", "B:ITEM"]);

	dom.dispose();
});

// Style scoping: a shadow tree is a separate tree scope for the cascade.
// Document rules stop at the boundary, a shadow root's own <style> rules
// never escape it, :host styles the host from inside, and INHERITED
// properties flow across the boundary along the flat tree -- host to
// shadow text, slot chain to slotted content -- exactly as in a browser.

test("document rules do not leak into shadow trees", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	document.head.innerHTML = `<style>span { text-transform: uppercase }</style>`;
	const light = document.createElement("span");
	light.textContent = "light";
	document.body.appendChild(light);
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<span>shadow</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("LIGHT");
	expect(output).toContain("shadow");
	expect(output).not.toContain("SHADOW");

	dom.dispose();
});

test("a shadow root's <style> styles its own tree only", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const light = document.createElement("span");
	light.textContent = "light";
	document.body.appendChild(light);
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<style>span { text-transform: uppercase }</style><span>shadow</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("SHADOW");
	expect(output).toContain("light");
	expect(output).not.toContain("LIGHT");

	dom.dispose();
});

test(":host rules style the host from inside its own shadow tree", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<style>:host { text-transform: uppercase }</style><span>shadow</span>`;
	document.body.appendChild(host);
	// A sibling the :host rule must NOT touch.
	const other = document.createElement("div");
	other.textContent = "other";
	document.body.appendChild(other);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("SHADOW"); // inherited from the host
	expect(output).toContain("other");

	dom.dispose();
});

test(":host(selector) applies conditionally", async () => {
	const terminal = new MockProcess({rows: 8, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const make = (className: string, label: string) => {
		const host = document.createElement("div");
		host.className = className;
		const root = host.attachShadow({mode: "open"});
		root.innerHTML = `<style>:host(.loud) { text-transform: uppercase }</style><span>${label}</span>`;
		document.body.appendChild(host);
	};
	make("loud", "first");
	make("quiet", "second");
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("FIRST");
	expect(output).toContain("second");
	expect(output).not.toContain("SECOND");

	dom.dispose();
});

test("inherited properties cross the shadow boundary from the host", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	host.style.textTransform = "uppercase";
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<span>shadow</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("SHADOW");

	dom.dispose();
});

test("slotted content inherits through the slot's shadow-tree chain", async () => {
	// In the flat tree the projected node's parent is the SLOT, so inherited
	// properties flow from the shadow chrome it lands in -- not (only) from
	// the host it came from.
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<style>.wrap { text-transform: uppercase }</style><div class="wrap"><slot></slot></div>`;
	host.appendChild(document.createTextNode("slotted"));
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("SLOTTED");

	dom.dispose();
});
