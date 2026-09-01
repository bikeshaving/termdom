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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<div>first row</div><div>second row</div>";
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
// projection rides on the DOM's live slot assignment (assignedSlot /
// assignedNodes) rather than any cached mapping.

test("default slot projects light children between shadow siblings", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<div>HEADER</div><slot></slot><div>FOOTER</div>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	// Shadow order reverses the light order: the slot's position wins.
	root.innerHTML = "<div><slot name=\"second\"></slot></div><div><slot name=\"first\"></slot></div>";
	host.innerHTML = "<span slot=\"first\">ALPHA</span><span slot=\"second\">BETA</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<slot>FALLBACK</slot>";
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("FALLBACK");

	dom.dispose();
});

test("assigned content replaces fallback; unassigned light children don't render", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<slot name=\"a\">FALLBACK</slot>";
	host.innerHTML = "<span slot=\"a\">ASSIGNED</span><span slot=\"nowhere\">ORPHAN</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span>[</span><slot></slot><span>]</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	host.textContent = "KEPT";
	document.body.appendChild(host);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("KEPT");

	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span>&lt;</span><slot></slot><span>&gt;</span>";
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("<KEPT>");

	dom.dispose();
});

test("reassigning a slot attribute reprojects on the next frame", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<div>A:<slot name=\"a\"></slot></div><div>B:<slot name=\"b\"></slot></div>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.head.innerHTML = "<style>span { text-transform: uppercase }</style>";
	const light = document.createElement("span");
	light.textContent = "light";
	document.body.appendChild(light);
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span>shadow</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const light = document.createElement("span");
	light.textContent = "light";
	document.body.appendChild(light);
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<style>span { text-transform: uppercase }</style><span>shadow</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<style>:host { text-transform: uppercase }</style><span>shadow</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	host.style.textTransform = "uppercase";
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span>shadow</span>";
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
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<style>.wrap { text-transform: uppercase }</style><div class=\"wrap\"><slot></slot></div>";
	host.appendChild(document.createTextNode("slotted"));
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("SLOTTED");

	dom.dispose();
});

// Input internals as a UA shadow tree: the widget painter's content model
// is real (UA-hidden) DOM in the symbol slot, styled by a real scoped
// stylesheet -- while staying exactly as closed as a browser input's own
// internals.

test("input internals are a UA shadow tree, closed to authors", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const input = document.createElement("input");
	input.value = "typed";
	document.body.appendChild(input);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("typed");
	// The UA tree never leaks: no author-visible root, and attachShadow on
	// an input keeps throwing exactly as the spec demands for form controls.
	expect(input.shadowRoot).toBeNull();
	expect(() => input.attachShadow({mode: "open"})).toThrow();

	dom.dispose();
});

test("the field design survives the round-trip through the UA stylesheet", async () => {
	// The field design is scoped CSS on real parts, not painter constants:
	// the placeholder is the UA gray ghost, and the focus affordance is an
	// `outline` the painter renders as a box-model-aware underline across the
	// whole field. This pins the whole pipeline: UA sheet parsing, scope
	// gating, :host(:focus) matching, focus invalidation, and the outline pass.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const input = document.createElement("input");
	input.setAttribute("placeholder", "hint");
	document.body.appendChild(input);
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);

	// Blurred: the placeholder shows as the UA gray ghost, no chrome of its own.
	expect(cellAt(0, 0).getFgColor()).toBe(0x808080);
	expect(cellAt(0, 0).isUnderline()).toBeFalsy();

	input.focus();
	await nextFrame(dom);
	// Focused: the :host(:focus) outline renders as a solid underline across
	// the whole field -- the value/placeholder AND the empty tail past it, the
	// box-model-aware fill a plain text-decoration could never reach.
	expect(cellAt(0, 0).isUnderline()).toBeTruthy();
	expect(cellAt(0, 5).isUnderline()).toBeTruthy();
	expect(cellAt(0, 0).isDim()).toBeFalsy();

	input.blur();
	await nextFrame(dom);
	// Blurred again: the outline is gone, the field is plain.
	expect(cellAt(0, 0).isUnderline()).toBeFalsy();

	dom.dispose();
});

test("::placeholder is author-styleable and cascades over the UA gray", async () => {
	// input::placeholder resolves onto the UA tree's [part="placeholder"]
	// span. Author rules beat the UA sheet by cascade ORIGIN, not
	// specificity -- the UA attribute selector would otherwise outrank
	// every plain author selector.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.head.innerHTML = "<style>input::placeholder { color: #ff0000 }</style>";
	const input = document.createElement("input");
	input.setAttribute("placeholder", "hint");
	document.body.appendChild(input);
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// The author color wins; a blurred field carries no chrome of its own.
	expect(cellAt(0, 0).getFgColor()).toBe(0xff0000);
	expect(cellAt(0, 0).isUnderline()).toBeFalsy();

	dom.dispose();
});

test("::selection colors replace the inverse-video default", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	document.head.innerHTML = "<style>input::selection { background-color: #0000ff; color: #ffffff }</style>";
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("abc"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	// Shift+Left selects "c".
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2D"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	expect(cellAt(0, 2).isInverse()).toBeFalsy();
	expect(cellAt(0, 2).getBgColor()).toBe(0x0000ff);
	expect(cellAt(0, 2).getFgColor()).toBe(0xffffff);

	dom.dispose();
});

// The UA document stylesheet: the engine's own html.css. The architectural
// rule it enforces: NO painter emits a terminal attribute that didn't come
// from a computed style -- even the selection's inverse video is declared,
// as the system-color pair every browser's UA sheet uses.

test("the selection default is a real UA rule, visible through getComputedStyle", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	await nextFrame(dom);

	// The declared pair is the CSS spelling of "swap fg/bg": deleting this
	// rule would leave selections unpainted, which is the point -- the rule
	// is load-bearing, not decorative.
	const declaration = dom.window.getComputedStyle(input, "::selection");
	expect(declaration.getPropertyValue("background-color").toLowerCase()).toBe(
		"highlight",
	);
	expect(declaration.getPropertyValue("color").toLowerCase()).toBe(
		"highlighttext",
	);

	dom.dispose();
});

test("selection still paints inverse via the UA rule's system colors", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("abc"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[1;2D"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	expect(cellAt(0, 2).isInverse()).toBeTruthy();

	dom.dispose();
});

test("a focused textarea's outline repaints its border in the outline color", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const textarea = document.createElement("textarea");
	textarea.setAttribute("rows", "1");
	document.body.appendChild(textarea);
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// Blurred: the UA border paints in the default foreground, not the accent.
	expect(cellAt(0, 0).getChars()).toBe("┌");
	expect(cellAt(0, 0).getFgColor()).not.toBe(0x5fafff);

	textarea.focus();
	await nextFrame(dom);
	// Focused: the border ring carries the outline color; the bottom border
	// row is glyphs, not an underline.
	expect(cellAt(0, 0).getFgColor()).toBe(0x5fafff);
	expect(cellAt(2, 0).getFgColor()).toBe(0x5fafff);
	expect(cellAt(2, 0).isUnderline()).toBeFalsy();

	dom.dispose();
});

test("a focused input's outline underline carries the outline color on unclaimed cells", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const {document} = dom;
	const input = document.createElement("input");
	input.setAttribute("placeholder", "hint");
	document.body.appendChild(input);
	input.focus();
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// A blank cell of the field row: underlined, in the accent.
	expect(cellAt(0, 19).isUnderline()).toBeTruthy();
	expect(cellAt(0, 19).getFgColor()).toBe(0x5fafff);
	// The placeholder's explicit gray wins over the outline's default.
	expect(cellAt(0, 0).getFgColor()).toBe(0x808080);

	dom.dispose();
});

test("border color resolves through CSS: border-color, then currentColor, then default", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `
		<div id="a" style="border: 1px solid; border-color: #0000ff">x</div>
		<div id="b" style="border: 1px solid; color: #ff0000">x</div>
		<div id="c" style="border: 1px solid">x</div>
	`;
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// Explicit border-color wins.
	expect(cellAt(0, 0).getFgColor()).toBe(0x0000ff);
	// No border-color: currentColor, the element's own color.
	expect(cellAt(3, 0).getFgColor()).toBe(0xff0000);
	// Nothing authored: the terminal's DEFAULT foreground -- never a
	// hardcoded white, which would break on light themes.
	expect(cellAt(6, 0).isFgDefault()).toBeTruthy();

	dom.dispose();
});

test("an inline-block host measures its shadow content, not its light children", async () => {
	// Inline-block measurement used to read element.firstChild -- the LIGHT
	// tree -- so any inline-block shadow host measured zero and vanished.
	const terminal = new MockProcess({rows: 4, cols: 60});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const host = document.createElement("span");
	host.style.display = "inline-block";
	host.textContent = "LIGHT-IGNORED";
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<style>b { font-weight: bold }</style><b>WIDE-SHADOW-CONTENT</b>";
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("WIDE-SHADOW-CONTENT");
	expect(host.getBoundingClientRect().width).toBe("WIDE-SHADOW-CONTENT".length);

	dom.dispose();
});

test("::part() styles an exposed shadow part from the document, per spec", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document, window} = dom;

	const style = document.createElement("style");
	style.textContent = "my-card::part(title) { font-weight: bold; color: rgb(9, 8, 7); }";
	document.head.appendChild(style);

	const Base = window.HTMLElement as unknown as typeof HTMLElement;

	class Card extends Base {
		connectedCallback(): void {
			const root = this.attachShadow({mode: "open"});
			const title = document.createElement("span");
			title.setAttribute("part", "title");
			title.textContent = "Heading";
			const body = document.createElement("span");
			body.setAttribute("part", "body");
			body.textContent = "text";
			root.append(title, body);
		}
	}

	window.customElements.define("my-card", Card);

	const card = document.createElement("my-card");
	document.body.appendChild(card);
	await nextFrame(dom);

	const root = (card as unknown as {shadowRoot: ShadowRoot}).shadowRoot;
	const title = root.querySelector('[part="title"]')!;
	const body = root.querySelector('[part="body"]')!;
	// The rule reaches the exposed part -- and only that part.
	expect(window.getComputedStyle(title).fontWeight).toBe("bold");
	expect(window.getComputedStyle(title).color).toBe("rgb(9, 8, 7)");
	expect(window.getComputedStyle(body).fontWeight).not.toBe("bold");

	dom.dispose();
});
